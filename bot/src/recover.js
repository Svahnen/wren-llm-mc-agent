// REC2: body-level recovery routine ("recover" playbook, S1 executes; S2 only gets events). Like eating when starving it is an
// interruption-level routine: when hp <= 6 for > 2 min and she is in cover (or no hostile is within 16 m), the body itself
//   (1) eats any edible food until food >= 18, else
//   (2) cooks raw food (kelp ...) in a wall niche of her cover (cook.js / STUCK3 path) and eats it, else
//   (3) waits in cover until daylight and then hands back to get_food (habits / S2).
// While it runs: the habit layer, S1 goal steps and non-urgent S2 skills are held ('busy'), the stuck monitor does not start the escape
// ladder (except drowning / suffocation / fire / lava). S2 can override with an explicit urgent intent (intent.urgent, or one of the
// needs/safety acts eat, cook, flee, fight, defend, sleep). Every decision is traced (rec2_*), S2 gets events ('recovering: ...').
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { fullyEnclosed, inOwnShelter } from './detect/stuck.js'
import { isNightTicks } from './detect/confined.js'
import { sealedWithLeak } from './skills/leak.js'
import { HOSTILE } from './habits/needs.js'
import { MOBS, relevantThreat } from './reflex/threats.js'
import { RAW_RE, COOKED_OF, planFuel } from './skills/cook.js'
import { countItem, countMatch, items } from './skills/lib.js'
import { edibles, needsBadFood } from './skills/survival.js'
import { daylight } from './playbooks/expedition.js'
import { plantTargets } from './skills/forageplants.js'

export const REC = Object.freeze({ lowHp: 6, lowForMs: 120000, doneHp: 10, eatTo: 18, hostileM: 16, tickMs: 2000, busyMs: 1500, maxMs: 600000, forageMinDusk: 2, forageMaxMs: 540000, animalM: 48 })
/** S2 acts that are themselves needs/safety: they never get held by the recover routine */
export const URGENT_ACTS = new Set(['eat', 'cook', 'flee', 'fight', 'defend', 'sleep', 'take_cover', 'dig_in', 'shelter'])

export const hostilesNear = (bot, r = REC.hostileM) => {
  const me = bot.entity?.position; if (!me) return 0
  return Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && HOSTILE.has(e.name) && e.position.distanceTo(me) < r && (!MOBS[e.name] || relevantThreat(bot, e))).length
}
export function inCover(bot) {
  try {
    const p = bot.entity.position, S = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    return fullyEnclosed(bot) || sealedWithLeak(bot, S) || inOwnShelter(bot)
  } catch { return false }
}
/** drowning / suffocation / fire / lava: the only things that still may break the cover */
export function lifeThreat(bot) {
  try {
    if (bot.__suffocating) return true
    const p = bot.entity.position
    const feet = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    if (feet && /lava|fire/.test(feet.name)) return true
    if (bot.entity.onFire) return true
    const head = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 1.6), Math.floor(p.z)))
    if (head && head.name === 'water' && (bot.oxygenLevel ?? 20) < 8) return true
  } catch { /* ignore */ }
  return false
}
const hasFurnaceOrMaterials = (bot) => {
  if (countItem(bot, 'furnace') > 0 || countMatch(bot, /^(cobblestone|cobbled_deepslate|blackstone)$/) >= 8) return true
  try { const id = bot.registry.blocksByName.furnace?.id; return id !== undefined && !!bot.findBlock({ matching: id, maxDistance: 24 }) } catch { return false }
}
/** What the routine does now. Pure on the bot: -> {kind:'eat'|'cook'|'wait'|'get_food'|'none', ...} */
export function recoverPlan(bot, { cookBlocked = false, forageBlocked = false } = {}) {
  const food = bot.food ?? 20
  if (food < REC.eatTo && edibles(bot, { allowBad: needsBadFood(bot) }).length) return { kind: 'eat' }
  const raw = items(bot).filter((i) => RAW_RE.test(i.name)).sort((a, b) => (a.name === 'kelp') - (b.name === 'kelp') || b.count - a.count)[0]
  const cookable = food < REC.eatTo && raw && planFuel(bot, Math.min(raw.count, 4)) && hasFurnaceOrMaterials(bot)
  if (cookable && !cookBlocked) return { kind: 'cook', raw: raw.name, count: Math.min(raw.count, 8), cooked: COOKED_OF[raw.name] }
  if (cookable && cookBlocked) return { kind: 'wait', why: 'cook_retry' }   // cook failed just now: rest in cover, retry when the block expires (never hand back while something is cookable)
  // DAY1: a thunderstorm counts as night for her (mobs spawn, sleep is allowed): shelter is right, no foraging
  if (isNightTicks(bot) || (bot.thunderState ?? 0) > 0.5) return { kind: 'wait' }   // waiting never heals (regen needs food >= 18): it only gets her through the night, then forage
  if (forageBlocked) return { kind: 'wait', why: 'forage_retry' }
  const dl = daylight(bot)
  if (dl.minToDusk < REC.forageMinDusk) return { kind: 'wait', why: 'dusk' }   // too late to go out; she shelters and forages at dawn
  return { kind: 'forage', minToDusk: dl.minToDusk }
}

export class Recover extends EventEmitter {
  /** deps: getBot, runner, arbiter, intents ({current}), trace, now, cfg */
  constructor({ getBot, runner, arbiter = null, intents = null, trace = null, now = Date.now, cfg = {}, playbooks = null, env = null }) {
    super()
    Object.assign(this, { getBot, runner, arbiter, intents, trace, now, playbooks, env })
    this.cfg = { ...REC, ...cfg }
    this.lowSince = null; this.active = false; this.seq = 0; this.timer = null
    this.overrideUntil = 0; this.cookBlockedUntil = 0; this.forageBlockedUntil = 0; this.phase = null; this.handedBack = false; this.cur = null
    this.stats = { runs: 0, ate: 0, cooked: 0, waited_ms: 0, overridden: 0, handed_back: 0, held: 0, foraged: 0, forage_rounds: 0 }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.trace?.event('rec2_error', { message: String(e?.message ?? e).slice(0, 160) })), this.cfg.tickMs); this.timer.unref?.() } return this }
  stop() { clearInterval(this.timer); this.timer = null; this.active = false }
  #log(ev, d = {}) { this.trace?.event(`rec2_${ev}`, d) }
  #say(text) { this.#log('event', { text }); this.emit('event', text) }

  /** hp <= 6 for > 2 min (lowSince is cleared once hp is above the line) */
  lowForMs() { return this.lowSince === null ? 0 : this.now() - this.lowSince }
  noteHealth(bot) {
    const hp = bot.health ?? 20
    if (hp > 0 && hp <= this.cfg.lowHp) this.lowSince ??= this.now()
    else { this.lowSince = null; this.handedBack = false }
  }
  /** an explicit urgent S2 intent (or a needs/safety act) is running: it wins, the routine yields */
  s2Override() {
    if (this.now() < this.overrideUntil) return true
    const c = this.intents?.current?.intent
    return !!c && (c.urgent === true || URGENT_ACTS.has(c.goal))
  }
  /** should the routine run now? -> {run:bool, why} */
  eligible(bot) {
    if (!bot?.entity || (bot.health ?? 20) <= 0) return { run: false, why: 'no_body' }
    this.noteHealth(bot)
    if (this.lowForMs() <= this.cfg.lowForMs) return { run: false, why: 'not_low_long_enough' }
    if ((bot.health ?? 20) >= this.cfg.doneHp) return { run: false, why: 'healthy' }
    const cover = inCover(bot), hostile = hostilesNear(bot)
    if (!cover && hostile) return { run: false, why: 'hostile_near_no_cover' }
    if (this.s2Override()) return { run: false, why: 's2_override' }
    return { run: true, cover, hostile }
  }
  /** ladder + unstuck must stay quiet while the routine runs (not for drowning / suffocation / fire / lava) */
  suppressLadder() {
    if (!this.active || this.phase === 'forage') return false   // DAY1: foraging walks in the open: the normal stuck ladder stays on
    const bot = this.getBot(); if (!bot?.entity) return false
    return !lifeThreat(bot)
  }
  /** runner gate: while active, habit/S1/non-urgent S2 skills are held. -> a rejected result or null */
  gate(name, o = {}) {
    if (!this.active) return null
    const owner = o.owner ?? 's1'
    if (owner === 'reflex' || String(o.intent_id ?? '').startsWith('rec2-')) return null
    if (/^(unstuck_|escape_)/.test(name)) { const b = this.getBot(); if (b && lifeThreat(b)) return null }
    if (owner === 's2' && (URGENT_ACTS.has(name) || o.urgent === true)) { this.#override(name); return null }
    this.stats.held++
    return { status: 'rejected', reason: 'busy', detail: 'recovering: the body is eating/cooking/resting in cover (say an urgent intent to override)', skill: name, intent_id: o.intent_id ?? null, ms: 0 }
  }
  #override(name) { this.stats.overridden++; this.overrideUntil = this.now() + 90000; this.#log('override', { by: name }); if (this.active) this.#say(`recovering paused: you chose ${name}`) }

  async tick() {
    if (this.active) return
    const bot = this.getBot()
    const e = this.eligible(bot)
    if (!e.run) return
    const plan = recoverPlan(bot, { cookBlocked: this.now() < this.cookBlockedUntil, forageBlocked: this.now() < this.forageBlockedUntil })
    if (plan.kind === 'none') return
    await this.#run(bot)
  }

  async #run(bot) {
    const id = `rec2-${++this.seq}`, t0 = this.now()
    this.active = true; this.stats.runs++
    this.#log('start', { id, hp: bot.health, food: bot.food, low_s: Math.round(this.lowForMs() / 1000), cover: inCover(bot), hostiles: hostilesNear(bot), night: isNightTicks(bot) })
    let lastKind = null, fails = 0, busy = 0, end = 'done', dug = false, cookSaid = false
    try {
      // take the body from whatever S1/S2 skill holds it (never from a reflex)
      if (this.arbiter && (this.arbiter.owner === 's1' || this.arbiter.owner === 's2')) { try { await this.runner.abort('recover') } catch { /* ignore */ } }
      for (let i = 0; i < 80; i++) {
        const b = this.getBot(); if (!b?.entity) { end = 'no_body'; break }
        this.noteHealth(b)
        if ((b.health ?? 20) >= this.cfg.doneHp) { end = 'recovered'; break }
        if (this.now() - t0 > this.cfg.maxMs) { end = 'max_ms'; break }
        if (this.s2Override()) { end = 'override'; break }
        if (!inCover(b) && hostilesNear(b)) { end = 'hostile'; break }
        const plan = recoverPlan(b, { cookBlocked: this.now() < this.cookBlockedUntil, forageBlocked: this.now() < this.forageBlockedUntil })
        this.phase = plan.kind
        if (plan.kind !== lastKind) {
          lastKind = plan.kind
          this.#log('step', { id, kind: plan.kind, hp: b.health, food: b.food })
          if (plan.kind === 'forage') this.#say(`recovering: no food to eat or cook and it is day (about ${plan.minToDusk} min of daylight): foraging now (hunt, remembered herds, fish, berries, expedition), back in cover before dusk`)
          if (plan.kind === 'wait') this.#say(plan.why === 'forage_retry' ? 'recovering: foraging found nothing just now, resting in cover and trying again shortly' : plan.why === 'dusk' ? 'recovering: too close to dusk to go out, waiting in cover (will forage at dawn)' : plan.why === 'cook_retry' ? 'recovering: cooking did not work, resting in cover and retrying shortly' : 'recovering: waiting in cover until daylight (no food I can eat or cook)')
          if (plan.kind === 'eat') this.#say(`recovering: eating (food ${b.food}/20, hp ${Math.round(b.health)})`)
        }
        if (!dug && plan.kind !== 'forage' && !inCover(b)) {   // REC2b: not sealed yet (live 01:34: wet open cell, cook no_spot): seal the cell first, best effort, once
          dug = true
          const r = await this.runner.run('dig_in', {}, { owner: 's1', intent_id: `${id}-dig` })
          this.#log('dig_in', { id, status: r.status, reason: r.reason ?? null, cover: inCover(this.getBot()) })
          continue
        }
        if (plan.kind === 'forage') {
          const r = await this.#forage(b, id, t0)
          if (r.stop) { end = r.stop; break }
          continue
        }
        if (plan.kind === 'wait') { await this.#sleep(this.cfg.tickMs); this.stats.waited_ms += this.cfg.tickMs; continue }
        if (plan.kind === 'eat') {
          const f0 = b.food ?? 0
          const r = await this.runner.run('eat', {}, { owner: 's1', intent_id: `${id}-eat${i}` })
          if (r.status === 'done' || (b.food ?? 0) > f0) { this.stats.ate++; fails = 0 }
          else if (r.reason === 'busy' || r.reason === 'unstuck_active' || r.status === 'aborted') { if (++busy > 40) { end = 'busy'; break } await this.#sleep(this.cfg.busyMs) }   // a reflex (eat, drowning) holds the body: wait for it, not a failure
          else { fails++; await this.#sleep(500) }
          if (fails >= 4) { end = 'eat_failed'; break }
          continue
        }
        if (plan.kind === 'cook') {
          const have0 = countItem(b, plan.cooked)
          if (!cookSaid) { cookSaid = true; this.#say(`recovering: cooking ${plan.raw} (0/${plan.count})`) }
          const r = await this.runner.run('cook', {}, { owner: 's1', intent_id: `${id}-cook${i}` })
          const got = countItem(this.getBot(), plan.cooked) - have0
          if (r.status === 'done' || got > 0) { this.stats.cooked += Math.max(got, 1); fails = 0; this.#say(`recovering: cooked ${plan.raw} (${got}/${plan.count}), eating next`) }
          else {
            this.#log('cook_failed', { id, reason: r.reason ?? r.status })
            if (r.reason === 'unstuck_active' || r.reason === 'busy' || (r.status === 'aborted' && /^preempted_by:reflex/.test(r.reason ?? ''))) { if (++busy > 40) { end = 'busy'; break } await this.#sleep(this.cfg.busyMs) }   // REC2b: live 01:36: the drowning reflex held the body 12 s at a time; wait for its release instead of failing 6x
            else {
              fails++; this.cookBlockedUntil = this.now() + 120000; this.#say(`recovering: could not cook (${r.reason ?? r.status}), resting in cover instead`) }
          }
          if (fails >= 6) { end = 'cook_failed'; break }
          continue
        }
        await this.#sleep(this.cfg.tickMs)
      }
    } finally {
      const b = this.getBot()
      this.#log('end', { id, end, ms: this.now() - t0, hp: b?.health, food: b?.food })
      if (end === 'recovered') this.#say(`recovering done: hp ${Math.round(b?.health ?? 0)}, food ${b?.food}`)
      this.active = false; this.phase = null
    }
  }
  /** DAY1: one foraging round in daylight, hard priority over idle/leisure. Order: animals in sight (hunt) -> remembered herd (get_food playbook walks there and hunts)
   *  -> fish (hit fish / rod, crafting a rod from 3 sticks + 2 string) -> ripe berries / crops / apple leaves -> resource_expedition food 120 m.
   *  Aborts at dusk, thunder, or a hostile within 16 m (she then returns to cover). -> {stop?:string, gained:boolean} */
  async #forage(b, id, t0) {
    this.stats.forage_rounds++
    const have = () => edibles(this.getBot(), { allowBad: needsBadFood(this.getBot()) }).length > 0
    const dayLeft = () => { const x = this.getBot(); return !isNightTicks(x) && (x.thunderState ?? 0) <= 0.5 && daylight(x).minToDusk >= this.cfg.forageMinDusk }
    const guard = () => { const x = this.getBot(); if (!x?.entity) return 'no_body'; if (have()) return 'food'; if (!dayLeft()) return 'dusk'; if (hostilesNear(x)) return 'hostile'; if (this.s2Override()) return 'override'; if ((x.health ?? 20) >= this.cfg.doneHp) return 'recovered'; if (this.now() - t0 > this.cfg.maxMs) return 'max_ms'; return null }
    const o = { owner: 's1' }
    const step = async (name, args, why) => {
      const g = guard(); if (g) return g
      this.#log('forage_step', { id, step: name, why, hp: this.getBot().health, food: this.getBot().food })
      const r = await this.runner.run(name, args, { ...o, intent_id: `${id}-f${this.stats.forage_rounds}-${name}` })
      this.#log('forage_result', { id, step: name, status: r.status, reason: r.reason ?? null })
      return guard()
    }
    const pb = async (name, args) => {
      const g = guard(); if (g) return g
      const pbk = this.playbooks?.(); if (!pbk) return null
      try { if (pbk.active?.()) await pbk.cancel('recover_forage') } catch { /* ignore */ }
      const st = pbk.start(name, args, { intent_id: `${id}-f${this.stats.forage_rounds}-${name}` })
      this.#log('forage_step', { id, step: `playbook:${name}`, ok: st.ok, why: st.ok ? null : String(st.errors?.[0] ?? '').slice(0, 120) })
      if (!st.ok) return null
      const watch = setInterval(() => { if (guard() && guard() !== 'food') pbk.cancel('recover_forage_stop').catch(() => {}) }, 2000)
      try { await st.promise } finally { clearInterval(watch) }
      return guard()
    }
    const near = (names, r) => { const x = this.getBot(); return Object.values(x.entities ?? {}).filter((e) => e && e !== x.entity && e.position && names.has(e.name) && e.position.distanceTo(x.entity.position) <= r) }
    const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']), FISH = new Set(['cod', 'salmon'])
    let stop = null
    try {
      stop = guard(); if (stop) return { stop: stop === 'food' ? null : this.#stopOf(stop) }
      // leave the sealed cell first (best effort; she emerged from a hole the same way)
      if (inCover(this.getBot())) { await this.runner.run('exit_hole', {}, { ...o, intent_id: `${id}-f-exit` }).catch(() => {}); }
      if (near(ANIMALS, this.cfg.animalM).length && (stop = await step('hunt', {}, 'animals_within_48m'))) return { stop: this.#stopOf(stop) }
      if (!have() && this.env?.foodSeen?.size && (stop = await pb('get_food', {}))) return { stop: this.#stopOf(stop) }
      if (!have()) {
        const x = this.getBot()
        if (near(FISH, 20).length && (stop = await step('hunt', { target: 'fish' }, 'fish_near'))) return { stop: this.#stopOf(stop) }
        const rod = countItem(x, 'fishing_rod') > 0, canRod = countItem(x, 'string') >= 2 && (countItem(x, 'stick') >= 3 || countMatch(x, /_planks$/) >= 2 || countMatch(x, /_log$/) >= 1)
        if (!have() && !rod && canRod && (stop = await step('craft', { item: 'fishing_rod' }, 'craft_rod'))) return { stop: this.#stopOf(stop) }
        if (!have() && countItem(this.getBot(), 'fishing_rod') > 0 && (stop = await step('fish', { catches: 2 }, 'rod_at_pond'))) return { stop: this.#stopOf(stop) }
      }
      if (!have() && plantTargets(this.getBot(), 40).length && (stop = await step('forage_plants', { count: 4 }, 'ripe_plants'))) return { stop: this.#stopOf(stop) }
      if (!have() && (stop = await pb('resource_expedition', { resource: 'food', max_dist: 120 }))) return { stop: this.#stopOf(stop) }
      if (!have() && (stop = await step('forage_plants', { count: 4 }, 'leaves_for_apples'))) return { stop: this.#stopOf(stop) }
      if (!have()) { this.forageBlockedUntil = this.now() + 60000; this.#log('forage_nothing', { id }); return { gained: false } }
      this.stats.foraged++; this.#say('recovering: found food, eating it next')
      return { gained: true }
    } finally { if (stop) this.#log('forage_stop', { id, why: stop }) }
  }
  #stopOf(g) { if (g === 'food') { this.stats.foraged++; this.#say('recovering: found food, eating it next') } return g === 'food' ? null : g === 'recovered' ? 'recovered' : g === 'dusk' ? 'dusk' : g === 'hostile' ? 'hostile' : g === 'override' ? 'override' : g }

  #sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() }) }
  view() { return { active: this.active, low_s: Math.round(this.lowForMs() / 1000), ...this.stats } }
}
export function createRecover(deps) { return new Recover(deps) }
