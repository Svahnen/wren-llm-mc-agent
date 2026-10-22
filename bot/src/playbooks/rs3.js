// RS3: predicates and ops for the survival-strategy playbooks (RS2 section 3): seed_hunt, bootstrap_kit, make_torches, fish_session, fish_hit, chicken_loop,
// village_forage, bonemeal_grass, bonemeal_ripen. Means only: S2 chooses; every result line is counted from the pack, never claimed.
// Hook: catalog.js imports this file for its side effect (cycle-safe like roam.js).
import { OPS, hopTo } from './ops.js'
import { PRED, placePos } from './predicates.js'
import { inventoryFacts } from '../habits/needs.js'
import { countMatch, countItem } from '../skills/lib.js'
import { secsToDusk, WALK_BPS } from '../habits/safety.js'
import { isBaby } from '../skills/farm1.js'

const ok = (extra = {}) => ({ status: 'done', ...extra })
const fail = (reason, extra = {}) => ({ status: 'failed', reason, ...extra })
const PREEMPT = /preempt|reflex|superseded|unstuck/
const isInt = (r) => (r.status === 'aborted' && PREEMPT.test(r.reason ?? '')) || (r.status === 'rejected' && /busy|unstuck/.test(r.reason ?? ''))
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const RAW_FISH = /^(cod|salmon)$/, FISH_ANY = /^(cod|salmon|cooked_cod|cooked_salmon)$/
export const FISH_SESSION = { casts: 2, minMs: 60000, quitFood: 18 }

/** derived parameters for the data playbooks (called by catalog.derived): crafts = torch crafts (4 torches each), logs = logs to bring for the charcoal route. */
export function derivedRs3(def, params, out) {
  if (def.name === 'make_torches') {
    const n = params.count ?? 8, crafts = Math.min(12, Math.ceil(n / 4))
    out.torch_call = Math.min(16, n); out.crafts = crafts; out.logs = Math.min(32, Math.ceil(crafts / 0.6) + 2)   // charcoal needs ~1.7 logs each (logs are also the fuel) + sticks / table
  }
  if (def.name === 'seed_hunt') out.batch = Math.min(24, params.count ?? 9)
  if (def.name === 'bonemeal_grass') out.uses_call = Math.min(3, params.uses ?? 2)
  if (def.name === 'bootstrap_kit') {
    const kit = params.kit ?? 'stone_tools'
    out.torches = kit === 'torches' ? 8 : kit === 'farm_kit' ? 4 : 0
    out.crafts = Math.ceil(out.torches / 4)
    out.logs = kit === 'stone_tools' ? 5 : kit === 'farm_kit' ? 8 : 7
    out.cobble = kit === 'stone_tools' ? 10 : kit === 'farm_kit' ? 18 : 8
  }
}

/** what a kit target means, from the pack. Pure. -> { have:[], missing:[] } */
export function kitStatus(bot, kit) {
  const n = (re) => countMatch(bot, re)
  const have = [], missing = []
  const chk = (label, okk) => (okk ? have : missing).push(label)
  if (kit === 'stone_tools' || kit === 'farm_kit') {
    chk('stone pickaxe', n(/^(stone|iron|diamond)_pickaxe$/) > 0); chk('stone axe', n(/^(stone|iron|diamond)_axe$/) > 0); chk('stone sword', n(/^(stone|iron|diamond)_sword$/) > 0)
  }
  if (kit === 'farm_kit') { chk('hoe', n(/_hoe$/) > 0); chk('4 torches', n(/^torch$/) >= 4) }
  if (kit === 'torches') chk('8 torches', n(/^torch$/) >= 8)
  return { have, missing }
}

const snap = (bot, names) => Object.fromEntries(names.map((nm) => [nm, countItem(bot, nm)]))
const deltaText = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]).map((k) => `${k} ${before[k]} -> ${after[k]}`).join(', ')

const PRED_ADD = {
  coal_ge: (c, n = 1) => countMatch(c.bot, /^(coal|charcoal)$/) >= +n,
  chickens_near: (c, r = 16) => { const me = c.bot.entity?.position; return !!me && Object.values(c.bot.entities ?? {}).some((e) => e && e !== c.bot.entity && e.position && e.name === 'chicken' && Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z) <= +r) },
  bone_meal: (c) => countItem(c.bot, 'bone_meal') >= 1,
  grass_known_out: (c) => { const me = c.bot.entity?.position; return !!me && (c.env?.grassedOut ?? []).some((g) => Date.now() - g.t < 20 * 60000 && dxz(g, me) <= 24) },
}

const OPS_ADD = {
  /** remember what the pack held at the start (the RESULT line is a before/after count) */
  async rs3_begin(x, step, a) {
    const bot = x.bot(), names = [].concat(a.track ?? [])
    x.state.rs3 = { t0: x.now(), names, before: snap(bot, names), food0: bot.food ?? 20, hp0: bot.health ?? 20 }
    return ok()
  },
  /** the plain RESULT line: item deltas, food, and whether the goal is met. goal: { items:[names], n, or_food_gain? }. A missed goal fails with `reason` (cooldown-able). */
  async rs3_report(x, step, a) {
    const bot = x.bot(), R = x.state.rs3 ?? { names: [], before: {}, food0: bot.food ?? 20, t0: x.now() }
    const after = snap(bot, R.names), d = deltaText(R.before, after)
    const g = a.goal ?? null
    let met = true, why = ''
    if (g) {
      const have = g.gain ? g.gain.reduce((s, nm) => s + countItem(bot, nm) - (R.before[nm] ?? 0), 0) : (g.items ?? []).reduce((s, nm) => s + countItem(bot, nm), 0)
      const n = Number(g.n ?? 1)
      met = have >= n
      if (!met && g.or_food_gain != null && (bot.food ?? 20) - R.food0 >= Number(g.or_food_gain)) met = true
      if (!met) why = g.gain ? `gained ${have} of ${n} ${g.gain.join('/')}` : `holding ${have} of ${n} ${(g.items ?? []).join('/')}`
    }
    const mins = Math.max(0, Math.round((x.now() - R.t0) / 600) / 100)
    const notes = (x.state.rs3_notes ?? []).join('; ')
    x.state.result = `RESULT: ${a.what ?? 'done'}: ${d || 'no pack changes'}${notes ? `; ${notes}` : ''}; food ${R.food0} -> ${Math.round(bot.food ?? 0)}; ${met ? 'goal met' : `goal NOT met (${why})`}; ${mins} min.`
    return met ? ok() : fail(a.reason ?? 'goal_not_met', { detail: why })
  },
  /** bootstrap_kit's honest end: which parts of the kit exist now, which are missing */
  async kit_report(x, step, a) {
    const bot = x.bot(), R = x.state.rs3 ?? { names: [], before: {}, t0: x.now(), food0: bot.food ?? 20 }
    const ks = kitStatus(bot, a.kit)
    const d = deltaText(R.before, snap(bot, R.names))
    x.state.result = `RESULT: bootstrap_kit ${a.kit}: have ${ks.have.join(', ') || 'nothing yet'}; missing ${ks.missing.join(', ') || 'nothing'}; pack ${d || 'unchanged'}.`
    return ks.missing.length ? fail('kit_incomplete', { detail: `missing ${ks.missing.join(', ')}` }) : ok()
  },
  /** refuse honestly at night (wood / stone gathering in the dark is how she dies) unless the wood is already in the pack */
  async daylight_gate(x, step, a) {
    const bot = x.bot()
    if (PRED.day({ bot, env: x.env, params: x.params, state: x.state, now: x.now })) return ok()
    if (a.have_logs != null && countMatch(bot, /_log$/) >= Number(a.have_logs)) return ok({ detail: 'night, but the logs are already in the pack' })
    x.state.result = `RESULT: ${a.what ?? 'not started'}: it is not daylight; wood and stone are gathered by day.`
    return fail('night', { detail: 'not daylight' })
  },
  /** bake all wheat into bread */
  async bake_all(x) {
    const bot = x.bot(), wheat = countItem(bot, 'wheat')
    if (wheat < 3) return ok({ detail: `${wheat} wheat, bread needs 3` })
    const r = await x.runSkill('craft', { item: 'bread', count: Math.min(16, Math.floor(wheat / 3)) })
    if (isInt(r)) return { status: 'interrupted', reason: r.reason }
    return ok({ detail: r.status === 'done' ? 'baked' : `bread failed: ${r.reason}` })
  },

  /** fish_session: cast the rod in short rounds for `minutes` (or until food >= 18 / the rod is gone / night / danger). Honest about every stop. */
  async fish_session(x, step, a) {
    const bot = x.bot(), t0 = x.now(), budget = (a.minutes ?? 5) * 60000
    const S = (x.state.fish ??= { caught: 0, rounds: 0, stop: null })
    const before = countMatch(bot, FISH_ANY)
    const ctx = () => ({ bot: x.bot(), env: x.env, params: x.params, state: x.state, now: x.now })
    const stopWhy = () => {
      if (x.aborted()) return 'aborted'
      if (!PRED.has_rod(ctx())) return 'no_rod'
      if (!PRED.day(ctx()) || PRED.thunder(ctx())) return 'night'   // drowned spawn in dark water (RS2 entry 31)
      if (PRED.hostile_near(ctx())) return 'hostile_near'
      if ((x.bot().food ?? 20) >= FISH_SESSION.quitFood && S.rounds > 0) return 'food_full'
      return null
    }
    while (x.now() - t0 < budget && S.rounds < 40) {
      const why = stopWhy(); if (why) { S.stop = why; break }
      const r = await x.runSkill('fish', { catches: FISH_SESSION.casts })
      if (isInt(r)) return { status: 'interrupted', reason: r.reason }
      S.rounds++
      S.caught = countMatch(x.bot(), FISH_ANY) - before
      if (r.status !== 'done' && /no_water|cannot_reach_bank|no_rod/.test(r.reason ?? '')) { S.stop = r.reason; break }
      if (r.status !== 'done' && S.rounds >= 3 && S.caught === 0) { S.stop = 'no_bite'; break }
    }
    S.stop ??= 'time_up'
    S.caught = countMatch(x.bot(), FISH_ANY) - before
    ;(x.state.rs3_notes ??= []).push(`fished ${Math.round((x.now() - t0) / 600) / 100} min in ${S.rounds} round(s), ${S.caught} fish, stopped: ${S.stop}`)
    return S.caught > 0 ? ok({ detail: `${S.caught} fish` }) : fail(S.stop === 'time_up' ? 'no_catch' : S.stop, { detail: `no fish in ${S.rounds} round(s); stopped: ${S.stop}` })
  },

  /** chicken_loop: one pass of the egg economy at the pen (or at chickens near me): breed (guarded), collect eggs, throw some, take meat when the pen is big enough. */
  async chicken_run(x, step, a) {
    const bot = x.bot(), notes = (x.state.rs3_notes ??= [])
    const c = () => ({ bot: x.bot(), env: x.env, params: x.params, state: x.state, now: x.now })
    if (!PRED.day(c()) || PRED.hostile_near(c())) { x.state.result = 'RESULT: chicken_loop: not now (night or a hostile mob near).'; return fail('not_now') }
    const penKnown = !!x.env?.landmarks?.get?.('pen')
    if (!penKnown && !PRED.chickens_near(c(), 16)) { x.state.result = 'RESULT: chicken_loop: no pen and no chicken within 16 m.'; return fail('no_chickens') }
    const seeds = countMatch(bot, /_seeds$/), eggs0 = countItem(bot, 'egg')
    if (seeds < 2 && eggs0 < 1 && !countItem(bot, 'chicken')) { x.state.result = `RESULT: chicken_loop: ${seeds} seeds and ${eggs0} eggs held; chickens are bred with 2 seeds (grass_seeds / seed_hunt gets them).`; return fail('no_seeds') }
    let did = 0
    const run = async (label, skill, args) => {
      const r = await x.runSkill(skill, args)
      if (isInt(r)) return { int: r }
      notes.push(`${label}: ${r.status === 'done' ? (r.detail ?? r.reason ?? 'ok') : `${r.reason ?? r.status}${r.detail ? ' (' + r.detail + ')' : ''}`}`)
      if (r.status === 'done') did++
      return { r }
    }
    if (penKnown && !PRED.at_place(c(), 'pen', 6)) await x.runSkill('go_to', { place: 'pen' })
    if (seeds >= 2) { const o = await run('breed', 'breed_animals', {}); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    { const o = await run('eggs', 'collect_eggs', {}); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    const eggs = countItem(x.bot(), 'egg')
    if (eggs >= 1) { const o = await run('throw', 'throw_eggs', { count: Math.min(8, eggs) }); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    if (penKnown && ((x.bot().food ?? 20) <= 14 || inventoryFacts(x.bot()).food < 2)) { const o = await run('meat', 'pen_slaughter', {}); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    if (inventoryFacts(x.bot()).raw > 0 && inventoryFacts(x.bot()).fuel > 0) await run('cook', 'cook', {})
    const babies = Object.values(x.bot().entities ?? {}).filter((e) => e?.name === 'chicken' && isBaby(e)).length
    x.state.result = `RESULT: chicken_loop: ${notes.join('; ') || 'nothing happened'}; eggs ${eggs0} -> ${countItem(x.bot(), 'egg')}; ${babies} chick(s) in view.`
    return did ? ok() : fail('nothing_to_do', { detail: notes.join('; ') })
  },

  /** village_forage: walk to the village place, take hay (leaves bales standing), harvest only ripe crops, bake bread. */
  async village_run(x, step, a) {
    const bot = x.bot(), notes = (x.state.rs3_notes ??= [])
    const pos = placePos({ bot, env: x.env }, a.place)
    if (!pos) { x.state.result = `RESULT: village_forage: "${a.place}" is not a known place.`; return fail('unknown_place') }
    const c = () => ({ bot: x.bot(), env: x.env, params: x.params, state: x.state, now: x.now })
    if (!PRED.day(c()) || PRED.thunder(c())) { x.state.result = 'RESULT: village_forage: not now, it is night or thundering; go in the morning.'; return fail('night') }
    const dist = dxz(pos, bot.entity.position), ticks = ((bot.time?.timeOfDay ?? 1000) % 24000 + 24000) % 24000
    const need = dist / WALK_BPS + 90, left = secsToDusk(ticks)
    if (dist > 30 && need > left) { x.state.result = `RESULT: village_forage: ${Math.round(dist)} m away needs about ${Math.round(need / 60 * 10) / 10} min with the work, only ${Math.round(left / 60 * 10) / 10} min of daylight are left; go in the morning, or roam with a camp.`; return fail('dusk_too_close') }
    if (dist > 30) { const h = await hopTo(x, pos, { hop: 24, radius: 12 }); if (h.status === 'interrupted') return h; if (h.status !== 'done') { x.state.result = `RESULT: village_forage: could not walk to ${a.place} (${h.reason}).`; return fail(h.reason ?? 'unreachable') } }
    const before = snap(bot, ['hay_block', 'wheat', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'bread'])
    const step1 = async (label, skill, args) => { const r = await x.runSkill(skill, args); if (isInt(r)) return { int: r }; notes.push(`${label}: ${r.status === 'done' ? (r.detail ?? r.reason ?? 'ok') : `${r.reason ?? r.status}${r.detail ? ' (' + r.detail + ')' : ''}`}`); return { r } }
    for (const [label, skill, args] of [['hay', 'take_hay', { count: 3, keep: 1 }], ['crops', 'harvest_ripe', { count: 12 }]]) { const o = await step1(label, skill, args); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    const wheat = countItem(x.bot(), 'wheat')
    if (wheat >= 3) { const o = await step1('bread', 'craft', { item: 'bread', count: Math.min(16, Math.floor(wheat / 3)) }); if (o.int) return { status: 'interrupted', reason: o.int.reason } }
    const after = snap(x.bot(), Object.keys(before))
    const gained = (after.bread - before.bread) * 5 + (after.carrot - before.carrot) * 3 + (after.potato - before.potato) * 1 + (after.beetroot - before.beetroot)
    x.state.result = `RESULT: village_forage at ${a.place}: ${deltaText(before, after) || 'nothing gained'}; ${notes.join('; ')}.`
    return gained > 0 || after.wheat > before.wheat || after.hay_block > before.hay_block ? ok() : fail('nothing_gained', { detail: notes.join('; ') })
  },
}

const register = () => { Object.assign(PRED, PRED_ADD); Object.assign(OPS, OPS_ADD) }
try { register() } catch { queueMicrotask(register) }
