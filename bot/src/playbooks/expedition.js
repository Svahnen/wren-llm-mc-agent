// EXP1: ops for the data playbook `resource_expedition` (library/resource_expedition.json).
// observed: gather_wood / gather_stone found nothing 8x because the area around her home is depleted. This playbook walks to a
// remembered place (or the most promising unexplored direction) in daylight, gathers there, remembers the place and walks home with a plain RESULT.
// Hook: catalog.js imports this file for its side effect; it adds to the exported OPS table (cycle-safe like predicates-pb4.js).
import { OPS, hopTo } from './ops.js'
import { PRED } from './predicates.js'
import { inventoryFacts } from '../habits/needs.js'
import { countMatch } from '../skills/lib.js'

const DUSK = 12542, DAWN = 23460, TPM = 1200
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const ok = (extra = {}) => ({ status: 'done', ...extra })
const fail = (reason, extra = {}) => ({ status: 'failed', reason, ...extra })
const PREEMPT = /preempt|reflex|superseded|unstuck/

/** resource table: skill, how many per skill call, target count, how it is counted, place kind, name hints, biome hints */
export const EXP_RES = {
  wood: { reach: 112, skill: 'gather_wood', per: 8, target: 16, label: 'logs', kind: 'forest', count: (b) => countMatch(b, /_log$/), tag: /(?<![a-z])(forests?|trees?|woods?|woodland|groves?|taiga|lumber|timber)/i, good: /forest|taiga|grove|jungle|cherry|birch|woods|swamp|savanna|old_growth/i, bad: /desert|badlands|ocean|river|beach|ice_spikes|frozen_peaks|snowy_plains/i },
  stone: { reach: 64, skill: 'gather_stone', per: 8, target: 16, label: 'cobblestone', kind: 'stone_area', count: (b) => countMatch(b, /^(cobblestone|andesite|diorite|granite|stone)$/), tag: /(?<![a-z])(stone|quarry|caves?|hills?|mountains?|cliffs?|mine|rocks?|ores?|peaks?)(?![a-z])/i, good: /hills|mountain|peaks|stony|badlands|windswept|slopes|jagged|grove|cave/i, bad: /ocean|river|beach|swamp|mushroom/i },
  food: { reach: 50, skill: 'hunt', per: 3, target: 6, label: 'food items', kind: 'food_area', count: (b) => inventoryFacts(b).food, tag: /(?<![a-z])(cows?|sheep|pigs?|chickens?|animals?|herds?|farm|berr|fish|food|meadow|pasture|rabbits?)/i, good: /plains|meadow|forest|savanna|taiga|sunflower|birch/i, bad: /desert|ocean|badlands|ice|frozen|mountain|peaks|jagged/i },
}
const SKIP_IDS = /^(home|bed)$|^(bed|home)_/

/** daylight facts from the game clock (no advice). minToDusk is in real minutes (1200 ticks). */
export function daylight(bot) {
  const t = (((bot.time?.timeOfDay ?? 1000) % 24000) + 24000) % 24000
  const night = t >= DUSK && t < DAWN
  const left = night ? 0 : t < DUSK ? DUSK - t : 24000 - t + DUSK
  return { ticks: t, night, thunder: (bot.thunderState ?? 0) > 0.5, minToDusk: night ? 0 : Math.max(1, Math.ceil(left / TPM)), minToDawn: night ? Math.max(1, Math.ceil((DAWN - t) / TPM)) : null, leftTicks: left }
}
/** real minutes a trip needs: out + back at ~2.5 m/s effective plus gathering time */
export const tripMinutes = (dist) => 2 + (2 * dist) / 150

export function biomeAt(bot, x, z) {
  try { const me = bot.entity.position; const b = bot.blockAt(me.offset(x - me.x, 0, z - me.z)); return b?.biome?.name ? String(b.biome.name).replace(/^minecraft:/, '') : null } catch { return null }
}

/** resolve 'any' to the resource she is shortest of */
export function pickResource(bot, want) {
  if (want && want !== 'any') return want
  const i = inventoryFacts(bot)
  if (i.logs + Math.floor(i.planks / 4) < 8) return 'wood'
  if (i.cobble < 8) return 'stone'
  if (i.food < 4) return 'food'
  return i.logs < 16 ? 'wood' : 'stone'
}

/**
 * Ranked destinations, best first: [{x,z,dist,source,label,biome,id?}].
 * 1. places she remembered (landmarks of the resource's kind or a name/note that fits, her own place notes; fresh food sightings for food), nearest first;
 * 2. the unexplored direction most likely to have it (heat map visits, loaded-chunk biome, earlier expeditions' dead ends).
 */
export function rankDestinations(bot, env, res, maxDist, { skip = [], skipR = 30, heading = null } = {}) {
  const R = EXP_RES[res], me = bot.entity.position, now = Date.now(), out = []
  const dead = env.expDead ?? new Map()
  const tooNearSkip = (p) => skip.some((s) => dxz(s, p) < skipR)
  for (const l of env.landmarks?.list?.() ?? []) {
    if (SKIP_IDS.test(l.id) || l.kind === 'home' || l.kind === 'bed') continue
    const text = `${l.id} ${l.note ?? ''}`
    const fits = l.kind === R.kind || R.tag.test(text) || (Array.isArray(l.res) && l.res.includes(res))
    if (!fits || (dead.get(l.id) ?? 0) > now) continue
    const d = dxz(l, me)
    if (d < 28 || d > maxDist || tooNearSkip(l)) continue
    out.push({ x: l.x, z: l.z, dist: d, source: 'remembered', label: `${l.id}${l.note ? ` (${String(l.note).slice(0, 40)})` : ''}`, id: l.id, kind: l.kind })
  }
  if (res === 'food') for (const f of env.foodSeen?.values?.() ?? []) {
    const d = dxz(f, me)
    if (now - f.t > 30 * 60000 || d < 20 || d > maxDist || tooNearSkip(f)) continue
    out.push({ x: f.x, z: f.z, dist: d, source: 'food_seen', label: `${f.name} seen`, kind: 'food_seen' })
  }
  out.sort((a, b) => a.dist - b.dist)
  // unexplored directions: 8 bearings x 4 distances, the first just beyond what the gather skill already searched around her (wood 112 m, stone 64 m)
  const home = env.landmarks?.home
  const tried = env.expTried ?? []
  const cands = []
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI
    for (const d of [R.reach, R.reach + 30, R.reach + 60, R.reach + 90]) {
      if (d > maxDist) continue
      const x = Math.round(me.x + Math.cos(a) * d), z = Math.round(me.z + Math.sin(a) * d)
      if (home && dxz({ x, z }, home) > maxDist + 40) continue
      if (tooNearSkip({ x, z })) continue
      let visits = 0
      if (env.heatmap?.count) for (const [ox, oz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) visits += env.heatmap.count(x + ox, z + oz) / 5
      const biome = biomeAt(bot, x, z)
      let score = visits * 4 + d / 60
      if (heading) score -= 3 * Math.max(0, Math.cos(a - heading))   // keep going the way she was already heading
      if (biome) score += R.good.test(biome) ? -4 : R.bad.test(biome) ? 8 : 0
      if (/deep_ocean|^ocean|river/.test(biome ?? '')) score += 20
      if (tried.some((t) => now - t.t < 30 * 60000 && dxz(t, { x, z }) < 45 && t.res === res)) score += 10
      cands.push({ x, z, dist: d, source: 'unexplored', label: `${Math.round(d)} m ${bearing(a)}${biome ? ` (${biome.replace(/_/g, ' ')})` : ''}`, biome, score })
    }
  }
  cands.sort((a, b) => a.score - b.score)
  // one per bearing, best 4
  const seen = new Set(), pick = []
  for (const c of cands) { const key = bearing(Math.atan2(c.z - me.z, c.x - me.x)); if (seen.has(key)) continue; seen.add(key); pick.push(c); if (pick.length >= 4) break }
  return [...out.slice(0, 3), ...pick]
}
function bearing(a) { const n = ((Math.round((a / (2 * Math.PI)) * 8) % 8) + 8) % 8; return ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][n] }

/** keep at most 3 remembered places of a kind; merge a new record into one within 35 m. Note and tags survive a position refresh. */
export function rememberResourcePlace(env, res, p, gained) {
  const lm = env.landmarks; if (!lm?.set || !lm.list) return null
  const R = EXP_RES[res], kind = R.kind
  const word = res === 'wood' ? 'forest' : res === 'stone' ? 'stone' : 'food (animals)'
  const note = `${word} at ${Math.round(p.x)},${Math.round(p.z)} (${gained} ${R.label} taken)`
  const near = lm.list().find((l) => l.kind === kind && dxz(l, p) < 35)
  let id
  if (near) id = near.id
  else {
    const same = lm.list().filter((l) => l.kind === kind).sort((a, b) => a.t - b.t)
    while (same.length >= 3) lm.forget(same.shift().id)
    const base = `${kind === 'forest' ? 'forest' : kind === 'stone_area' ? 'stone' : 'food'}_${Date.now().toString(36)}`
    id = base; for (let n = 2; lm.get(id); n++) id = `${base}_${n}`
  }
  const rec = lm.set(id, p, kind); rec.note = note; rec.res = [res]; lm.save?.()
  ;(env.expDead ??= new Map()).delete(id)
  return { id, note }
}

/** the plan lives in x.state.exp; after a bot restart (only the origin is persisted) the next step re-plans instead of failing */
async function ensureExp(x) {
  if (x.state.exp) return null
  const r = await OPS_ADD.expedition_plan(x, {}, x.params ?? {})
  return r.status === 'done' ? null : r
}
/** a refusal is a plain fact for S2 too: it ends the playbook with the RESULT line */
const refuse = (x, reason, detail) => { x.state.result = `RESULT: ${reason}${detail ? ` (${detail})` : ''}; nothing was started.`; return fail(reason, { detail }) }
const hereOf = (x) => { const p = x.bot().entity.position; return { x: p.x, y: p.y, z: p.z } }
const resourceNear = (bot, res) => {
  try {
    if (res === 'wood') { const ids = Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_log')).map((b) => b.id); return !!bot.findBlock({ matching: ids, maxDistance: 24 }) }
    if (res === 'stone') { const ids = ['stone', 'cobblestone', 'andesite', 'diorite', 'granite'].map((n) => bot.registry.blocksByName[n]?.id).filter((v) => v !== undefined); return !!bot.findBlock({ matching: ids, maxDistance: 20, useExtraInfo: (b) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([a, c, d]) => { const q = bot.blockAt(b.position.offset(a, c, d)); return q && q.boundingBox === 'empty' && q.name !== 'lava' }) }) }
    if (res === 'food') return PRED.animals_near({ bot })
  } catch { /* unloaded */ }
  return false
}
/** minutes of daylight she must keep for the walk home from where she is */
const returnMin = (x) => { const bot = x.bot(), home = x.env?.landmarks?.home ?? x.state.origin; return home ? 1 + (1 * dxz(home, bot.entity.position)) / 150 : 1 }

const OPS_ADD = {
  /** choose the resource and the destination; refuses with 'not now: ...' at night or when daylight is too short for the trip */
  async expedition_plan(x, step, a) {
    const bot = x.bot(), env = x.env
    const res = pickResource(bot, a.resource), maxDist = a.max_dist ?? 200, R = EXP_RES[res]
    const dl = daylight(bot)
    x.state.origin ??= hereOf(x)
    const exp = (x.state.exp = { res, maxDist, startAt: x.now(), base: R.count(bot), cands: [], idx: 0, moves: 0, stop: null, tried: [], lastGain: null })
    if (dl.night) return refuse(x, `not now: it is night, dawn in ${dl.minToDawn} min`, `game tick ${dl.ticks}`)
    if (dl.thunder) return refuse(x, 'not now: thunderstorm')
    exp.cands = rankDestinations(bot, env, res, maxDist)
    if (!exp.cands.length) return fail('no_destination', { detail: `no remembered ${res} place and no promising direction within ${maxDist} m` })
    const need = Math.ceil(tripMinutes(Math.min(exp.cands[0].dist, maxDist)))
    if (dl.minToDusk < need) return refuse(x, `not now: dusk in ${dl.minToDusk} min`, `a ${Math.round(exp.cands[0].dist)} m trip needs about ${need} min of daylight`)
    exp.dest = exp.cands[0]
    x.notify('expedition_start', `Going on a ${res} expedition: ${exp.dest.source === 'remembered' ? 'to your remembered place ' : exp.dest.source === 'food_seen' ? 'to where you saw ' : 'toward unexplored ground, '}${exp.dest.label}, ${Math.round(exp.dest.dist)} m away. Daylight left: about ${dl.minToDusk} min.`, { resource: res })
    return ok({ detail: `${res} -> ${exp.dest.label} ${Math.round(exp.dest.dist)} m` })
  },

  /** walk out to the destination in hops; stops early when the resource is in sight or daylight gets short. Tries the next candidate when one is unreachable. */
  async expedition_walk(x) {
    { const e = await ensureExp(x); if (e) return e }
    const exp = x.state.exp; if (!exp?.dest) return fail('no_plan')
    const bot = x.bot()
    for (let tries = 0; tries < 3; tries++) {
      const d = exp.dest
      const stopIf = async () => {
        const dl = daylight(x.bot())
        if (dl.night || dl.minToDusk < returnMin(x) + 0.5) { exp.stop = 'dusk'; return true }
        if (x.state.origin && dxz(x.state.origin, x.bot().entity.position) >= 40 && resourceNear(x.bot(), exp.res)) { exp.found = true; return true }   // a stray tree beside home does not count
        return false
      }
      const r = await hopTo(x, { x: d.x, y: bot.entity.position.y, z: d.z }, { hop: 24, radius: 10, stopIf })
      if (r.status === 'interrupted') return r
      if (r.status === 'done') { exp.arrived = hereOf(x); return ok({ detail: exp.stop ? `stopped (${exp.stop}) at ${Math.round(exp.arrived.x)},${Math.round(exp.arrived.z)}` : exp.found ? `resource in sight at ${Math.round(exp.arrived.x)},${Math.round(exp.arrived.z)}` : `arrived at ${Math.round(exp.arrived.x)},${Math.round(exp.arrived.z)}` }) }
      if (r.reason === 'aborted') return r
      // unreachable: mark this one, take the next candidate
      ;(x.env.expDead ??= new Map()).set(d.id ?? `${Math.round(d.x)},${Math.round(d.z)}`, Date.now() + 20 * 60000)
      exp.tried.push({ x: d.x, z: d.z, res: exp.res })
      exp.idx++
      if (exp.idx >= exp.cands.length) break
      exp.dest = exp.cands[exp.idx]
      x.notify('expedition_reroute', `The way to ${d.label} did not work (${r.reason}); trying ${exp.dest.label}.`, { resource: exp.res })
    }
    exp.arrived = hereOf(x)
    return fail('unreachable', { detail: 'no destination could be reached' })
  },

  /** gather until the target count, inventory nearly full, or daylight is short; moves on to fresh ground when a spot is empty */
  async expedition_gather(x) {
    { const e = await ensureExp(x); if (e) return e }
    const exp = x.state.exp; if (!exp) return fail('no_plan')
    const bot = () => x.bot(), R = EXP_RES[exp.res], target = R.target
    const gained = () => R.count(bot()) - exp.base
    const t0 = x.now()
    for (let round = 0; round < 14; round++) {
      if (x.aborted()) return fail('aborted')
      const dl = daylight(bot())
      if (dl.night || dl.minToDusk < returnMin(x) + 0.5) { exp.stop = 'dusk'; break }
      if (gained() >= target) { exp.stop = 'target'; break }
      if (inventoryFacts(bot()).free < 2) { exp.stop = 'full'; break }
      if (x.now() - t0 > 9 * 60000) { exp.stop = 'time'; break }
      const before = gained()
      const r = await x.runSkill(R.skill, { count: Math.max(1, Math.min(R.per, target - before)) })
      if ((r.status === 'aborted' && PREEMPT.test(r.reason ?? '')) || (r.status === 'rejected' && /busy|unstuck/.test(r.reason ?? ''))) return { status: 'interrupted', reason: r.reason }
      // the skill's own watchdog (no_progress / timeout / stuck: observed a 100 m tree-hopping walk) ends THIS round, not the expedition
      if (r.status === 'aborted' && !/no_progress|timeout|stuck|unreachable|path_failed/.test(r.reason ?? '')) return fail(r.reason ?? 'aborted')
      const g = gained()
      if (g > before) { exp.lastGain = hereOf(x); exp.noGainStreak = 0; continue }
      if (r.reason === 'inventory_full') { exp.stop = 'full'; break }
      if (r.reason === 'no_tool') { exp.stop = 'no_tool'; exp.failDetail = 'no tool and none could be made'; break }
      exp.failDetail = r.detail ?? r.reason
      // nothing here: walk to fresh ground (next candidate not tried, else a new bearing 70 m on)
      if (++exp.moves > 4) { exp.stop = 'nothing_found'; break }
      exp.tried.push({ x: hereOf(x).x, z: hereOf(x).z, res: exp.res })
      const me2 = hereOf(x), o2 = x.state.origin, heading = o2 && dxz(o2, me2) >= 40 ? Math.atan2(me2.z - o2.z, me2.x - o2.x) : null
      const next = rankDestinations(bot(), x.env, exp.res, exp.maxDist, { skip: [...exp.tried, ...(x.env.expTried ?? []).filter((q) => q.res === exp.res)], skipR: R.reach * 0.7, heading }).find((c) => c.dist >= 40 || c.source === 'remembered')
      if (!next) { exp.stop = 'nothing_found'; break }
      exp.dest = next
      x.notify('expedition_move_on', `Nothing to collect here (${String(exp.failDetail).slice(0, 80)}); moving on toward ${next.label}.`, { resource: exp.res })
      const w = await hopTo(x, { x: next.x, y: bot().entity.position.y, z: next.z }, { hop: 24, radius: 10, stopIf: async () => resourceNear(bot(), exp.res) })
      if (w.status === 'interrupted') return w
    }
    exp.gained = gained()
    exp.stop ??= 'rounds'
    exp.gainedAt = Date.now()
    return exp.gained > 0 ? ok({ detail: `${exp.gained} ${R.label} (${exp.stop})` }) : fail('found_nothing', { detail: exp.failDetail ?? exp.stop })
  },

  /** remember where the resource was found (landmark with resource tags) and mark dead ends so the next expedition goes elsewhere */
  async expedition_remember(x) {
    const exp = x.state.exp; if (!exp) return fail('no_plan')
    const R = EXP_RES[exp.res], g = R.count(x.bot()) - exp.base
    const at = exp.lastGain ?? exp.arrived ?? hereOf(x)
    ;(x.env.expTried ??= []).push({ x: at.x, z: at.z, res: exp.res, t: Date.now() })
    if (x.env.expTried.length > 12) x.env.expTried.shift()
    if (g > 0) { const rec = rememberResourcePlace(x.env, exp.res, at, g); exp.remembered = rec; return ok({ detail: rec?.note }) }
    const d = exp.dest; if (d) (x.env.expDead ??= new Map()).set(d.id ?? `${Math.round(d.x)},${Math.round(d.z)}`, Date.now() + 20 * 60000)
    return ok({ detail: 'nothing to remember' })
  },

  /** walk back home (or to where the expedition started when no home is set); falls back to the return_home skill */
  async expedition_home(x) {
    const home = x.env?.landmarks?.home ?? x.state.origin; if (!home) return fail('no_home')
    const near = () => dxz(x.bot().entity.position, home) <= 12
    if (near()) return ok({ detail: 'already home' })
    const r = await hopTo(x, { x: home.x, y: home.y ?? x.bot().entity.position.y, z: home.z }, { hop: 30, radius: 8 })
    if (r.status === 'interrupted') return r
    if (r.status === 'done' && near()) return ok()
    if (x.env?.landmarks?.home) {
      const rr = await x.runSkill('return_home', {})
      if ((rr.status === 'aborted' && PREEMPT.test(rr.reason ?? '')) || (rr.status === 'rejected' && /busy|unstuck/.test(rr.reason ?? ''))) return { status: 'interrupted', reason: rr.reason }
    }
    return near() ? ok() : fail('could_not_return', { detail: `${Math.round(dxz(x.bot().entity.position, home))} m from home` })
  },

  /** plain-fact RESULT for S2; fails (honestly) when nothing was collected or she is not back */
  async expedition_report(x) {
    const exp = x.state.exp; if (!exp) return fail('no_plan')
    const bot = x.bot(), R = EXP_RES[exp.res], home = x.env?.landmarks?.home ?? x.state.origin
    const g = Math.max(0, R.count(bot) - exp.base), back = home ? Math.round(dxz(home, bot.entity.position)) : null
    const mins = Math.max(1, Math.round((x.now() - exp.startAt) / 60000))
    const why = { target: 'target reached', full: 'inventory nearly full', dusk: 'daylight getting short', time: 'time limit', nothing_found: 'no more usable trees found after moving on 4 times', no_tool: 'no tool', rounds: 'round limit' }[exp.stop] ?? exp.stop
    const text = g > 0
      ? `RESULT: ${exp.res} expedition collected ${g} ${R.label}${g < R.target ? ` of ${R.target}` : ''} (${why ?? 'stopped'}); ${exp.remembered ? `remembered "${exp.remembered.id}": ${exp.remembered.note}; ` : ''}${back !== null && back <= 12 ? 'back home' : `NOT back home (${back} m away)`} after ${mins} min.`
      : `RESULT: ${exp.res} expedition found no ${R.label} (${exp.failDetail ?? why}); ${back !== null && back <= 12 ? 'back home' : `${back} m from home`} after ${mins} min. The searched places are marked as dead ends for 20 min.`
    x.state.result = text
    x.notify('expedition_result', text, { resource: exp.res, gained: g })
    if (g <= 0) return fail('found_nothing', { detail: text })
    if (back !== null && back > 12) return fail('not_home', { detail: text })
    return ok({ detail: text })
  },
}
const register = () => { Object.assign(OPS, OPS_ADD) }
try { register() } catch { queueMicrotask(register) }
