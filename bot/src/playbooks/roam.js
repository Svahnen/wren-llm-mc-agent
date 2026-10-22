// ROAM1: ops for the data playbooks `roam`, `make_camp` and `new_home` (library/roam.json, make_camp.json, new_home.json).
// observed: the area around home is used up, she is short of food, and the before_dusk rule drags her home every evening, so her range is small.
// MEANS she may choose: walk out for a day or more toward food-rich ground, forage / hunt / pick grass seeds on the way, remember good places,
// make a night camp where dusk finds her (instead of going home), carry a kit, and optionally make a much better area her new home.
// Hook: catalog.js imports this file for its side effect (cycle-safe like expedition.js).
import { OPS, hopTo } from './ops.js'
import { PRED } from './predicates.js'
import { daylight, rankDestinations, EXP_RES } from './expedition.js'
import { inventoryFacts } from '../habits/needs.js'
import { duskFacts, duskLine, CAMP_LEAD_S, WALK_BPS, DUSK_START, SHELTER_BLOCKS } from '../habits/safety.js'
import { grassNear, seedCount } from '../skills/roam.js'

const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const ok = (extra = {}) => ({ status: 'done', ...extra })
const fail = (reason, extra = {}) => ({ status: 'failed', reason, ...extra })
const PREEMPT = /preempt|reflex|superseded|unstuck/
const isInt = (r) => (r.status === 'aborted' && PREEMPT.test(r.reason ?? '')) || (r.status === 'rejected' && /busy|unstuck/.test(r.reason ?? ''))
const hereOf = (x) => { const p = x.bot().entity.position; return { x: p.x, y: p.y, z: p.z } }
const ANIMAL = /^(cow|pig|sheep|chicken|rabbit)$/
export const ROAM = { foodGoal: 14, seedGoal: 4, kitBlocks: 16, kitTorches: 4, hopM: 24, maxDays: 4 }
const BEARING = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }

const homeOf = (x) => x.env?.landmarks?.get?.('home') ?? x.env?.landmarks?.home ?? null
const ticksOf = (bot) => daylight(bot).ticks
const factsNow = (x, roaming = true) => {
  const bot = x.bot(), home = homeOf(x), me = bot.entity.position
  const c = { ticks: ticksOf(bot), hasHome: !!home, homeDist: home ? dxz(home, me) : 0, roaming }
  return { c, f: duskFacts(c), line: duskLine(c) }
}

/** keep at most `cap` remembered places of a kind (oldest dropped), merge within 40 m; the note says what is there. */
export function rememberPlace(env, kind, p, note, { cap = 4, res = null } = {}) {
  const lm = env.landmarks; if (!lm?.set || !lm.list) return null
  const near = lm.list().find((l) => l.kind === kind && dxz(l, p) < 40)
  let id
  if (near) id = near.id
  else {
    const same = lm.list().filter((l) => l.kind === kind).sort((a, b) => a.t - b.t)
    while (same.length >= cap) lm.forget(same.shift().id)
    const base = `${kind}_${Date.now().toString(36)}`; id = base
    for (let n = 2; lm.get(id); n++) id = `${base}_${n}`
  }
  const rec = lm.set(id, p, kind); rec.note = note; if (res) rec.res = res; lm.save?.()
  return { id, note }
}

/** what the spot looks like (pure on the bot): animals, grass, water, trees. Scored for 'good_site' (food + water + trees + grass). */
export function surroundings(bot) {
  const me = bot.entity.position
  const animals = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && ANIMAL.test(e.name ?? '') && e.isValid !== false && dxz(e.position, me) < 32).length
  const grass = (() => { try { return grassNear(bot, 12, 12).length } catch { return 0 } })()
  let water = false, logs = 0
  try { water = !!bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 16 }) } catch { /* unloaded */ }
  try { const ids = Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_log')).map((b) => b.id); logs = (bot.findBlocks?.({ matching: ids, maxDistance: 24, count: 12 }) ?? []).length } catch { /* unloaded */ }
  const score = (animals >= 2 ? 1 : 0) + (grass >= 8 ? 1 : 0) + (water ? 1 : 0) + (logs >= 6 ? 1 : 0)
  return { animals, grass, water, logs, score }
}

async function ensurePlan(x) {
  if (x.state.roam) return null
  const r = await OPS_ADD.roam_plan(x, {}, x.params ?? {})
  return r.status === 'done' ? null : r
}
const refuse = (x, reason, detail) => { x.state.result = `RESULT: ${reason}${detail ? ` (${detail})` : ''}; nothing was started.`; return fail(reason, { detail }) }
const edible = (bot) => inventoryFacts(bot).food

/** the camp itself (also the make_camp playbook): torch, then the best shelter her inventory allows, wait for morning, remember it. */
export async function buildCamp(x, a = {}) {
  const bot = x.bot(), inv = inventoryFacts(bot), where = hereOf(x)
  const R = x.state.roam
  x.notify('camp_start', `Making a camp here (${Math.round(where.x)},${Math.round(where.z)}): ${inv.blocks} building blocks, ${inv.torches} torches${inv.beds ? ', a bed' : ''}. ${duskLine({ ticks: ticksOf(bot), hasHome: !!homeOf(x), homeDist: homeOf(x) ? dxz(homeOf(x), where) : 0 }) ?? ''}`.trim(), {})
  if (inv.torches > 0) await x.runSkill('place_torch', { force: true })
  const wantBed = String(a.bed ?? 'no') === 'yes' && inv.beds > 0
  const method = []
  let res = { status: 'failed', reason: 'no_method' }
  const tryIt = async (name, fn) => { method.push(name); res = await fn(); return res.status === 'done' }
  let done = false
  if (wantBed && inv.blocks >= 40) {
    done = await tryIt('hut_with_bed', async () => {
      const b = await x.runSkill('build', { plan: 'simple_hut', size: 4 }); if (isInt(b)) return { status: 'interrupted', reason: b.reason }
      if (b.status !== 'done') return { status: 'failed', reason: b.reason ?? 'hut_failed' }
      await x.runSkill('close_doors_nearby', { radius: 6 })
      // beds work from dusk; the sleep skill places the bed item next to her and sleeps; waking in the morning sets the spawn point (her choice: bed=yes)
      for (let i = 0; i < 400 && !x.aborted() && !daylight(bot).night; i++) await x.sleep(1500)
      const s = await x.runSkill('sleep', { max_stay_s: 600 })
      return s.status === 'done' ? { status: 'done' } : { status: 'failed', reason: s.reason ?? 'sleep_failed' }
    })
    if (res.status === 'interrupted') return res
  }
  if (!done && inv.blocks >= SHELTER_BLOCKS) {
    done = await tryIt('pillbox', async () => { const s = await x.runSkill('shelter', { max_wait_s: 760 }); return isInt(s) ? { status: 'interrupted', reason: s.reason } : s.status === 'done' ? { status: 'done' } : { status: 'failed', reason: s.reason ?? 'shelter_failed' } })
    if (res.status === 'interrupted') return res
  }
  if (!done) {
    done = await tryIt('hole', async () => {
      const h = await x.runSkill('hole_and_cap', {}); if (isInt(h)) return { status: 'interrupted', reason: h.reason }
      if (h.status !== 'done' && h.reason === 'already_sealed') {   // she is already enclosed (a hole, a hut, a cave pocket): that is the camp; wait for morning, the next move_to opens the way out
        const w0 = await OPS.wait_until(x, {}, { until: ['safe_to_leave'], max_s: 900, poll_ms: 2000 })
        return w0.status === 'done' ? { status: 'done' } : { status: 'failed', reason: w0.reason ?? 'still_unsafe' }
      }
      if (h.status !== 'done') return { status: 'failed', reason: h.reason ?? 'hole_failed' }
      const w = await OPS.wait_until(x, {}, { until: ['safe_to_leave'], max_s: 900, poll_ms: 2000 })
      if (w.status !== 'done') return { status: 'failed', reason: w.reason ?? 'still_unsafe_in_hole' }
      const e = await x.runSkill(inventoryFacts(bot).blocks >= 2 ? 'exit_hole' : 'dig_stairs_up', {})
      return e.status === 'done' ? { status: 'done' } : { status: 'failed', reason: e.reason ?? 'cannot_exit_hole' }
    })
    if (res.status === 'interrupted') return res
  }
  if (!done && (inv.blocks >= 6 || (inv.pickaxe > 0 && inv.blocks >= 1))) {
    done = await tryIt('dig_in', async () => { const d = await x.runSkill('dig_in', {}); return d.status === 'done' ? { status: 'done' } : { status: 'failed', reason: d.reason ?? 'dig_in_failed' } })
  }
  const at = hereOf(x)
  if (done) {
    const rec = rememberPlace(x.env, 'camp', at, `camp (${method.at(-1)}) at ${Math.round(at.x)},${Math.round(at.z)}`, { cap: 3 })
    if (R) { R.camps.push({ x: at.x, z: at.z, method: method.at(-1), t: x.now() }); R.lastCamp = rec }
    return ok({ detail: `camp via ${method.at(-1)}` })
  }
  return fail('no_camp_possible', { detail: `tried ${method.join(', ') || 'nothing'}: ${res.reason ?? '?'}; building blocks ${inv.blocks}` })
}

const OPS_ADD = {
  /** choose the heading and check daylight; refuses at night / thunder / dusk near. Sets env.roam (read by the habit layer: no march home at dusk, camp instead). */
  async roam_plan(x, step, a) {
    const bot = x.bot(), env = x.env, dl = daylight(bot)
    const days = Math.max(1, Math.min(ROAM.maxDays, Math.round(Number(a.days ?? 2)) || 2)), maxDist = Math.max(60, Math.min(800, Math.round(Number(a.max_dist ?? 400)) || 400))
    const atDusk = ['auto', 'camp', 'home'].includes(String(a.at_dusk)) ? String(a.at_dusk) : 'auto'
    const R = (x.state.roam = { days, maxDist, atDusk, bed: String(a.bed ?? 'no'), dayNo: 1, mode: 'out', origin: hereOf(x), startAt: x.now(), seeds0: seedCount(bot), food0: bot.food ?? 20, edible0: edible(bot),
      camps: [], places: [], hops: 0, fails: 0, heading: 0, dest: null, over: false, why: null, calls: { seeds: 0, hunt: 0 }, huntOffUntil: 0, lastNote: null, minutes: 0, siteOffered: false, rangeTurns: 0 })
    if (dl.night) return refuse(x, `not now: it is night, dawn in ${dl.minToDawn} min`)
    if (dl.thunder) return refuse(x, 'not now: thunderstorm')
    if (dl.minToDusk < 3) return refuse(x, `not now: dusk in ${dl.minToDusk} min`, 'a roam starts in the morning (make_camp is possible now)')
    // heading: her direction if she named one, else the best remembered food place or unexplored ground (plains/forest, few visits)
    const dir = String(a.direction ?? 'any').toLowerCase()
    const me = hereOf(x)
    let label
    if (dir in BEARING) { R.heading = BEARING[dir]; label = dir }
    else {
      const c = rankDestinations(bot, env, 'food', maxDist, {}).find((q) => q.dist >= 40 || q.source === 'remembered')
      if (c) { R.heading = Math.atan2(c.z - me.z, c.x - me.x); R.dest = c; label = c.label } else { R.heading = (x.now() % 628) / 100; label = 'unexplored ground' }
    }
    ;(env.roam = { active: true, since: x.now(), origin: R.origin, days }).camps = R.camps
    x.notify('roam_start', `Going roaming for up to ${days} day(s) toward ${label}. Home is ${homeOf(x) ? Math.round(dxz(homeOf(x), me)) : '?'} m away. Daylight left: about ${dl.minToDusk} min. At dusk away from home you can camp (a pit or pillbox) instead of walking back.`, { days })
    return ok({ detail: `roam ${days}d heading ${label}` })
  },

  /** top up the kit before leaving: building blocks, torches, food, a bed if she has the wool. Everything is best-effort and reported. */
  async roam_kit(x) {
    { const e = await ensurePlan(x); if (e) return e }
    const bot = x.bot(), R = x.state.roam, got = []
    let inv = inventoryFacts(bot)
    if (inv.blocks < ROAM.kitBlocks && inv.free >= 2) {
      const r = await x.runSkill('collect', { resource: 'dirt', count: Math.min(24, ROAM.kitBlocks - inv.blocks + 4) })
      if (isInt(r)) return { status: 'interrupted', reason: r.reason }
      inv = inventoryFacts(bot); got.push(`blocks ${inv.blocks}`)
    }
    if (inv.torches < ROAM.kitTorches && inv.coal > 0 && (inv.sticks > 0 || inv.planks >= 2)) {
      const r = await x.runSkill('craft', { item: 'torch' }); if (isInt(r)) return { status: 'interrupted', reason: r.reason }
      inv = inventoryFacts(bot)
    }
    if (inv.beds === 0 && inv.wool >= 3 && inv.planks >= 3) { const r = await x.runSkill('craft', { item: 'bed' }); if (isInt(r)) return { status: 'interrupted', reason: r.reason }; inv = inventoryFacts(bot) }
    R.kit = { blocks: inv.blocks, torches: inv.torches, food: inv.food, bed: inv.beds > 0, seeds: seedCount(bot) }
    const miss = []
    if (inv.blocks < SHELTER_BLOCKS) miss.push(`only ${inv.blocks} building blocks (a pillbox needs ${SHELTER_BLOCKS}; a hole needs none)`)
    if (!inv.torches) miss.push('no torches')
    x.notify('roam_kit', `Kit for the trip: ${inv.blocks} building blocks, ${inv.torches} torches, ${inv.food} food items, ${inv.beds ? 'a bed' : 'no bed'}${miss.length ? `; short: ${miss.join('; ')}` : ''}.`, {})
    return ok({ detail: `blocks ${inv.blocks} torches ${inv.torches} food ${inv.food}${inv.beds ? ' bed' : ''}` })
  },

  /** one stretch of the trip: walk (forage, hunt, seeds, remember places) until camp time or the end; camps at dusk when home is out of reach. Called in a loop until roam_over. */
  async roam_day(x) {
    { const e = await ensurePlan(x); if (e) return e }
    const R = x.state.roam, bot = () => x.bot()
    if (R.over) return ok({ detail: 'over' })
    let travelled = 0
    for (let guard = 0; guard < 120; guard++) {
      if (x.aborted()) return fail('aborted')
      const b = bot(), me = hereOf(x), home = homeOf(x), dl = daylight(b)
      const { f } = factsNow(x)
      const homeD = home ? dxz(home, me) : dxz(R.origin, me)
      // goals met / days used / range reached -> head home
      const seedsGot = seedCount(b) - R.seeds0, foodOk = (b.food ?? 0) >= ROAM.foodGoal
      if (R.mode === 'out') {
        const why = foodOk && seedsGot >= ROAM.seedGoal ? 'goals_met' : R.dayNo > R.days ? 'days_used' : R.rangeTurns >= 3 ? 'range' : R.fails >= 6 ? 'blocked' : null
        if (why) { R.mode = 'home'; R.why = why; x.notify('roam_turn', `Turning for home (${why.replace('_', ' ')}): food ${b.food}, ${seedsGot} seeds picked, ${R.camps.length} camp(s) made, ${Math.round(homeD)} m from home.`, {}) }
        else if (dxz(R.origin, me) >= R.maxDist) { R.rangeTurns++; R.heading += 1.9; x.notify('roam_range', `At the edge of the range (${Math.round(R.maxDist)} m from where you left); bending the route and looking around here.`, {}) }
      }
      if (R.mode === 'home' && homeD <= 12) { R.over = true; return ok({ detail: 'home' }) }
      // dusk: camp here or go home. Reported as a plain fact for S2 too.
      const campTime = dl.night || (dl.ticks >= DUSK_START && dl.ticks < 23460) || (dl.ticks < DUSK_START && f.secs <= CAMP_LEAD_S)
      const homeWorks = f.homeReachable && R.mode === 'home'
      if (campTime && !homeWorks && R.atDusk !== 'home') {
        x.notify('roam_dusk', `${Math.round(homeD)} m from home; ${dl.night ? 'it is dark' : `dusk in ${Math.max(1, Math.round(f.secs / 60 * 10) / 10)} min`}: camping here.`, {})
        const c = await buildCamp(x, { bed: R.bed })
        if (c.status === 'interrupted') return c
        if (!daylight(bot()).night) R.dayNo++
        if (c.status !== 'done') { R.over = true; R.why = 'camp_failed'; R.failDetail = c.detail ?? c.reason; return fail('no_camp_possible', { detail: R.failDetail }) }
        return ok({ detail: 'camp made, morning' })
      }
      if (campTime && R.atDusk === 'home' && dl.night) { R.over = true; R.why = 'night_on_the_way'; return fail('night_on_the_way', { detail: 'at_dusk=home and it got dark before home' }) }
      // forage on the spot (cheap checks first)
      const st = await forageHere(x, R, travelled)
      if (st) return st
      // walk one hop
      const target = R.mode === 'home' ? { x: (home ?? R.origin).x, z: (home ?? R.origin).z } : null
      const hop = (R.mode === 'out' && R.good) ? 10 : ROAM.hopM
      let wp
      if (target) { const d = dxz(target, me), k = Math.min(1, hop / Math.max(1, d)); wp = { x: me.x + (target.x - me.x) * k, z: me.z + (target.z - me.z) * k } }
      else wp = { x: me.x + Math.cos(R.heading) * hop, z: me.z + Math.sin(R.heading) * hop }
      const r = await x.runSkill('move_to', { x: Math.round(wp.x), y: Math.round(me.y), z: Math.round(wp.z), radius: 4 })
      if (isInt(r)) return { status: 'interrupted', reason: r.reason }
      if (r.status === 'aborted') return fail(r.reason ?? 'aborted')
      if (r.status === 'done') { R.fails = 0; R.hops++; travelled += hop }
      else {
        R.fails++
        if (R.mode === 'out') R.heading += (R.fails % 2 ? 0.7 : -1.4)   // blocked (water, cliff): bend the heading
        else if (R.fails >= 8) { R.over = true; R.why = 'cannot_get_home'; return fail('could_not_return', { detail: `${Math.round(homeD)} m from home` }) }
      }
    }
    return ok({ detail: 'stretch done' })
  },

  /** plain-fact RESULT; honest about what was not reached */
  async roam_report(x) {
    const R = x.state.roam; if (!R) return fail('no_plan')
    const bot = x.bot(), home = homeOf(x) ?? R.origin, back = Math.round(dxz(home, bot.entity.position))
    const seeds = Math.max(0, seedCount(bot) - R.seeds0), mins = Math.max(1, Math.round((x.now() - R.startAt) / 60000))
    if (x.env.roam) { x.env.roam.active = false }
    const places = x.env.landmarks?.list?.().filter((l) => ['food_area', 'forest', 'meadow', 'water', 'camp', 'good_site'].includes(l.kind)).length ?? 0
    const text = `RESULT: roamed ${R.dayNo > R.days ? R.days : R.dayNo} day(s) (${R.why ?? 'ended'}), ${R.camps.length} night camp(s)${R.camps.length ? ` (${R.camps.map((c) => c.method).join(', ')})` : ''}, food ${bot.food ?? '?'} (was ${R.food0}), ${seeds} seed(s) picked, ${places} place(s) remembered; ${back <= 12 ? 'back home' : `NOT back home (${back} m away)`} after ${mins} min.`
    x.state.result = text
    x.notify('roam_result', text, { camps: R.camps.length, seeds })
    if (R.why === 'camp_failed') return fail('camp_failed', { detail: text })
    return back <= 12 || R.why === 'cannot_get_home' ? ok({ detail: text }) : ok({ detail: text })
  },

  /** the make_camp playbook body */
  async camp_here(x, step, a) { return buildCamp(x, a) },

  /** new_home: remember the old home, set home here. Her choice only. */
  async relocate_home(x) {
    const lm = x.env?.landmarks, old = lm?.get?.('home'), here = hereOf(x)
    if (!lm) return fail('no_landmarks')
    if (old && dxz(old, here) > 20) { const o = lm.set('old_home', old, 'place'); o.note = `my previous home at ${Math.round(old.x)},${Math.round(old.z)}`; lm.save?.() }
    const r = await x.runSkill('set_home', {})
    if (r.status !== 'done') return fail(r.reason ?? 'set_home_failed')
    if (x.env.roam) x.env.roam.active = false
    x.notify('home_moved', `This spot (${Math.round(here.x)},${Math.round(here.z)}) is now your home${old ? `; your old home stays remembered as "old_home" (${Math.round(dxz(old, here))} m away)` : ''}.`, {})
    return ok({ detail: 'home moved' })
  },
}

/** forage cheaply between hops. Returns an interruption/failure result to pass up, or null to carry on. */
async function forageHere(x, R, travelled) {
  const b = x.bot(), me = hereOf(x), inv = inventoryFacts(b)
  const s = surroundings(b)
  // remember what is here (rate limited by merging within 40 m)
  const here = { x: me.x, y: me.y, z: me.z }
  if (s.animals >= 3) rememberPlace(x.env, 'food_area', here, `food (animals) at ${Math.round(me.x)},${Math.round(me.z)} (${s.animals} animals)`, { res: ['food'], cap: 4 })
  if (s.grass >= 8) rememberPlace(x.env, 'meadow', here, `tall grass at ${Math.round(me.x)},${Math.round(me.z)} (seeds)`, { res: ['seeds'], cap: 3 })
  if (s.water) rememberPlace(x.env, 'water', here, `water near ${Math.round(me.x)},${Math.round(me.z)}`, { cap: 3 })
  if (s.logs >= 6) rememberPlace(x.env, 'forest', here, `trees at ${Math.round(me.x)},${Math.round(me.z)} (${s.logs}+ logs)`, { res: ['wood'], cap: 3 })
  // pace: food-rich ground is worked slowly (short hops, up to 10), then she moves on (8 hops) so the trip does not stall in one meadow
  if ((s.animals >= 2 || s.grass >= 8) && !R.moveOn) { R.linger = (R.linger ?? 0) + 1; R.good = R.linger <= 10; if (R.linger > 10) { R.moveOn = 8; R.linger = 0 } }
  else { R.good = false; if (R.moveOn) R.moveOn-- }
  // a really good site far from home: offer it, never move her home by itself
  const home = homeOf(x)
  if (!R.siteOffered && s.score >= 4 && home && dxz(home, me) > 120) {
    R.siteOffered = true
    rememberPlace(x.env, 'good_site', here, `food, water, trees and grass together at ${Math.round(me.x)},${Math.round(me.z)}: a candidate for a new home (playbook new_home)`, { cap: 2 })
    x.notify('roam_site', `This place has animals, water, trees and tall grass together, ${Math.round(dxz(home, me))} m from your home. You could make it your new home (playbook new_home; the old home stays remembered) or keep roaming.`, {})
  }
  // eat when hungry
  if ((b.food ?? 20) <= ROAM.foodGoal && inv.food > 0) {
    const e = await x.runSkill('eat', {}); if (isInt(e)) return { status: 'interrupted', reason: e.reason }
  }
  // hunt when animals are near and food is short
  if (s.animals > 0 && ((b.food ?? 20) <= ROAM.foodGoal || inv.food < 4) && x.now() > R.huntOffUntil && inv.free >= 2) {
    R.calls.hunt++
    const h = await x.runSkill('hunt', {}); if (isInt(h)) return { status: 'interrupted', reason: h.reason }
    if (h.status !== 'done') R.huntOffUntil = x.now() + 4 * 60000
    if (h.status === 'done' && (b.food ?? 20) <= ROAM.foodGoal && inventoryFacts(b).food > 0) { const e = await x.runSkill('eat', {}); if (isInt(e)) return { status: 'interrupted', reason: e.reason } }
  }
  // plants (berries, crops, apples) when still short
  if ((b.food ?? 20) <= 12 && inv.food === 0 && !R.plantsOff) {
    const p = await x.runSkill('forage_plants', {}); if (isInt(p)) return { status: 'interrupted', reason: p.reason }
    if (p.status !== 'done') R.plantsOff = true
    else { R.plantsOff = false; if (inventoryFacts(b).food > 0) await x.runSkill('eat', {}) }
  }
  if (travelled > 0 && travelled % 120 < ROAM.hopM) R.plantsOff = false
  // seeds from tall grass (a farm_plot needs them)
  if (seedCount(b) - R.seeds0 < ROAM.seedGoal && s.grass >= 3 && R.calls.seeds < 8 && inv.free >= 1) {
    R.calls.seeds++
    const c = await x.runSkill('collect_seeds', { count: ROAM.seedGoal - (seedCount(b) - R.seeds0) + 2 }); if (isInt(c)) return { status: 'interrupted', reason: c.reason }
  }
  return null
}

const PRED_ADD = { roam_over: (c) => !!c.state?.roam?.over }
const register = () => { Object.assign(OPS, OPS_ADD); Object.assign(PRED, PRED_ADD) }
try { register() } catch { queueMicrotask(register) }
