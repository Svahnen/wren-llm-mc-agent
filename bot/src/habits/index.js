// Habit layer (System 1 fallback): when there is no live intent, choose among habits by a deterministic utility
// from the needs, so she lives plausibly with NO LLM. mind/ interface:
//   habits.setDrives({hunger:0.3, ...})  levels 0..1 (1 fine) that override the body-derived ones
//   habits.setCostAt(fn)                 fn({x,y,z}) -> extra cost >= 0 for target selection (danger zones)
//   hasLiveIntent: () => boolean         passed at construction; habits run only while it returns false
import { isIgnoredPlayer } from '../ignore-players.js'
import { CATALOG } from './catalog.js'
import { scorerFromEnv } from './learned-scorer.js'   // TR1: WREN_SCORER=off|shadow|blend (default off = no behaviour change)
import { NeedState, inventoryFacts } from './needs.js'
import { surplus } from '../skills/inventory.js'
import { sleepRefusedNow } from '../skills/survival.js'
import { isNight, isThunder, openSky, dist3, standableY, timeOfDay } from '../skills/lib.js'
import { lightAt } from '../skills/survival.js'
import { confinedShared } from '../detect/confined.js'
import { steerRows, goalFeature } from './steer.js'
import { sealedWithLeak } from '../skills/leak.js'
import { depletedMap } from '../skills/depleted.js'
import { phase, rangedThreats, exposedTo, hungerTier, returnReason, openCells, campReason } from './safety.js'

const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const CRAFT_ORDER = [
  (i) => (i.wool >= 3 && i.beds === 0 && i.logs + i.planks / 4 >= 1 ? 'bed' : null),
  (i) => (i.logs + i.planks / 4 >= 2 && i.pickaxe === 0 ? 'wooden_pickaxe' : null),
  (i) => (i.logs + i.planks / 4 >= 2 && i.axe === 0 ? 'wooden_axe' : null),
  (i) => (i.logs + i.planks / 4 >= 2 && i.sword === 0 ? 'wooden_sword' : null),
  (i) => (i.cobble >= 3 && i.pickaxe > 0 && i.stonePickaxe === 0 ? 'stone_pickaxe' : null),
  (i) => (i.coal >= 1 && i.torches < 4 && i.logs + i.planks > 0 ? 'torch' : null),
  (i) => (i.logs + i.planks / 4 >= 3 && i.chest === 0 && i.free >= 6 && i.logs + i.planks / 4 >= 3 ? 'chest' : null),
  (i) => (i.cobble >= 12 && i.pickaxe > 0 ? 'furnace' : null),
]

const IDLE_SKILLS = new Set(['idle_activity', 'gesture', 'look_at'])
const HABIT_COMMIT = 0.9, HABIT_COMMIT_MAX = 2
const LEISURE_H = new Set(['explore', 'wander', 'idle', 'rest', 'pick_flowers', 'visit_player'])
export const IDLE_MAX_STREAK = 3

export function shannon(counts) {
  const tot = Object.values(counts).reduce((s, n) => s + n, 0)
  if (!tot) return 0
  return -Object.values(counts).filter((n) => n > 0).reduce((s, n) => s + (n / tot) * Math.log2(n / tot), 0) || 0
}

export function createHabits({ runner, arbiter, getBot, env, trace = null, decisionLog = null, rng = env.rng, now = Date.now, hasLiveIntent = () => false, isUp = () => true, catalog = CATALOG, pauseMs = { done: 400, fail: 1500 }, liveGraceMs = 3500, noise = 0.25, recencyHalfLifeMs = 90000, scorer = null }) {
  const lscorer = scorer ?? scorerFromEnv(process.env, trace)
  const needs = new NeedState({ now })
  const history = []           // [{habit, skill, status, reason, t, bucket}]
  const lock = new Map()       // habit|bucket -> {until, fails}
  const counts = {}            // habit -> n
  const skillCounts = {}
  const outcomes = {}          // habit -> {done, failed, aborted, rejected}
  const cells = new Set()
  let steer = () => null       // AI1: () => steer view | null (goal-conditioned steering, WREN_AUTONOMY=high)
  let graceFn = null           // G2: () => ms, overrides liveGraceMs (longer while an objective exists)
  let conversing = () => false // VINT: set by mindlink while a voice conversation with a human within 6 blocks is on
  let running = false, loop = Promise.resolve(), n = 0, lastNewCellCheck = 0, lastLiveAt = 0, waterAt = -Infinity, waterNear = false

  const bucketOf = (bot) => { const p = bot.entity.position; return `${Math.floor(p.x / 24)},${Math.floor(p.z / 24)}` }

  function situation(bot) {
    const me = bot.entity.position
    const nd = needs.read(bot, { heatmap: env.heatmap })
    const inv = inventoryFacts(bot)
    const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position)
    const animalEnts = ents.filter((e) => ANIMALS.has(e.name) && e.isValid !== false && !((env.huntBad?.get(e.id) ?? 0) > now()) && dist3(e.position, me) < 64)
    const animals = animalEnts.length
    const animalNear = animalEnts.reduce((m, e) => Math.min(m, dist3(e.position, me)), Infinity)
    const fish = ents.filter((e) => (e.name === 'cod' || e.name === 'salmon') && e.isValid !== false && !((env.huntBad?.get(e.id) ?? 0) > now()) && dist3(e.position, me) < 30).length
    const sheep = animalEnts.filter((e) => e.name === 'sheep').length
    const pls = ents.filter((e) => e.type === 'player' && e.username && !isIgnoredPlayer(e.username) && dist3(e.position, me) < 64)
    const home = env.landmarks.home
    const bed = env.landmarks.nearest('bed', me)
    const chest = env.landmarks.nearest('chest', me)
    let water = false
    // L1: findBlock d20 costs ~100 ms of event loop; the answer only matters for the fish habit: cache it for 20 s
    if (now() - waterAt > 20000) { try { waterNear = !!bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 20 }) } catch { /* ignore */ } waterAt = now() }
    water = waterNear
    const c = {
      bot, needs: nd, inv, env, rng, night: isNight(bot), thunder: isThunder(bot), sleepRefused: !!sleepRefusedNow(bot), light: lightAt(bot, me.floored()),
      animals, animalNear, fish, sheep, water, phase: phase(bot), dark: phase(bot) !== 'day', tier: hungerTier(bot.food ?? 20), hostiles: nd.facts.hostiles,
      ranged: [], exposed: [], ticks: timeOfDay(bot),
      players: pls.map((e) => e.username), playerNear: pls.some((e) => dist3(e.position, me) < 12),
      underground: me.y < 58 && !openSky(bot, me), hasHome: !!home, homeDist: home ? dist3(home, me) : 0,
      bedKnown: !!(bed && bed.dist < 64), bedDist: bed ? bed.dist : Infinity, chestKnown: !!(chest && chest.dist < 48), surplus: surplus(bot).length, bad: nd.levels.safety < 0.6,
    }
    c.sealed = false
    if (c.dark) { const f = me.floored(); const y = standableY(bot, f.x, f.z, f.y, 1, 3); const S0 = { x: f.x, y: y ?? f.y, z: f.z }; c.sealed = (y !== null && openCells(bot, S0) === 0) || sealedWithLeak(bot, S0) }   // STUCK3: walls + water leak = sealed (the drowning reflex plugs the leak; dig_in must not loop on it) // already inside a pillbox: keep waiting, do not dig dirt
    c.depleted = depletedMap(env, me, now())   // BAT1: a gather that found nothing here stays off the menu for 5 min (all callers share it)
    c.ranged = rangedThreats(bot, 30)
    c.exposed = c.ranged.length ? exposedTo(bot, c.ranged) : []
    c.sleepLocked = recentFailed(`sleep|${bucketOf(bot)}`) || recentFailed('sleep|*')
    c.huntLocked = recentFailed(`hunt|${bucketOf(bot)}`) || recentFailed('hunt|*')
    const lastRet = [...history].reverse().find((h) => h.habit === 'return_home')
    c.sinceReturnMs = lastRet ? now() - lastRet.t : Infinity
    c.roaming = !!env.roam?.active   // ROAM1: set by the roam playbook for the length of the trip
    c.returnWhy = returnReason(c, { sinceReturnMs: c.sinceReturnMs })
    c.campWhy = campReason(c)
    c.craftNext = null
    for (const f of CRAFT_ORDER) { const r = f(inv); if (r && !recentFailed(`craft:${r}`)) { c.craftNext = r; break } }
    return c
  }
  const commitStreak = () => { let k = 0; const n0 = history[history.length - 1]?.habit; for (let i = history.length - 1; i >= 0 && history[i].habit === n0 && history[i].status === 'done'; i--) k++; return k }
  const idleStreak = () => { let k = 0; for (let i = history.length - 1; i >= 0 && IDLE_SKILLS.has(history[i].skill); i--) k++; return k }
  const recentFailed = (key) => { const l = lock.get(key); return !!l && l.until > now() }

  /** Score all applicable habits. Pure given state + rng. */
  function rank(bot) {
    const c = situation(bot)
    const t = now()
    const b = bucketOf(bot)
    const rows = []
    for (const h of catalog) {
      let ok = false
      try { ok = h.applies(c) } catch { ok = false }
      if (!ok) continue
      const lk = lock.get(`${h.name}|${b}`) ?? lock.get(`${h.name}|*`)
      if (lk && lk.until > t && !h.noLock) continue
      let u = 0
      try { u = h.utility(c) } catch { continue }
      // recency: the same habit again right away is damped, recent repeats within the window too
      let pen = 0
      for (let i = history.length - 1, k = 0; i >= 0 && k < 8; i--, k++) if (history[i].habit === h.name) pen += 0.5 * Math.exp(-(t - history[i].t) / recencyHalfLifeMs) + 0.1
      if (history.length && history[history.length - 1].habit === h.name) pen += 0.4
      rows.push({ habit: h, name: h.name, base: u, score: u - pen + rng() * noise, pen })
    }
    // G2 commitment (hysteresis) on the habit path: a habit that just finished OK and still applies is continued (+HABIT_COMMIT) for up to HABIT_COMMIT_MAX in a row,
    // so one chain (gather, hunt, ...) is finished before the layer wanders to something else; a failure or a safety-level habit (utility >= 6) still switches at once
    const lastH = history[history.length - 1]
    if (lastH && lastH.status === 'done' && t - lastH.t < 90000 && commitStreak() < HABIT_COMMIT_MAX) {
      const r = rows.find((x) => x.name === lastH.habit)
      if (r && !LEISURE_H.has(r.name)) { r.score += HABIT_COMMIT; r.commit = HABIT_COMMIT }
    }
    rows.sort((x, y) => y.score - x.score)
    const sv = steer()
    if (sv) { rows.splice(0, rows.length, ...steerRows(rows, sv, { continuePlan: true })) }
    if (lscorer.active) { try { lscorer.apply(rows, { bot, history, levels: c.needs.levels }) } catch (e) { trace?.event('scorer_error', { message: String(e?.message).slice(0, 160) }) } }
    return { rows, c, sv }
  }

  async function step() {
    const bot = getBot()
    if (!bot?.entity || !isUp()) return 'skip'
    // F1: S2 chains intents with ~1 s gaps; a habit started in such a gap is aborted a moment later ('intent', 58 of 155 starts in 45 min).
    // Stay out of the way for liveGraceMs after the last live S2 intent was seen.
    if (hasLiveIntent()) { lastLiveAt = now(); return 'skip' }
    if (lastLiveAt && now() - lastLiveAt < (graceFn?.() ?? liveGraceMs)) return 'skip'
    if (arbiter.busy) return 'skip'
    if (conversing()) return 'skip' // VINT: stay put, face the speaker; no long skills and no idle gestures while a human talks with her
    // track novelty for the curiosity need
    const p = bot.entity.position
    const ck = env.heatmap.key(p.x, p.z)
    if (!cells.has(ck)) { cells.add(ck); needs.noteNewCell() }
    const { rows, c, sv } = rank(bot)
    if (!rows.length) return 'none'
    let top = rows[0]
    let plan = top.habit.plan(c)
    if (!plan) return 'noplan'
    // W1: never idle/gesture more than IDLE_MAX_STREAK times in a row by day while hungry or bored: move instead, and ask the stuck monitor whether she is confined.
    // (observed: 165 idle_activity/gesture in 2.5 min while physically trapped)
    if (IDLE_SKILLS.has(plan.skill) && idleStreak() >= IDLE_MAX_STREAK && !c.night && c.phase !== 'night' && (c.needs.urgencies.hunger > 0.5 || c.needs.urgencies.curiosity > 0.5)) {
      confinedShared.checkRequested = true; confinedShared.idleStreakChecks++
      let alt = null
      for (const r of rows.slice(1)) { const pl = r.habit.plan(c); if (pl && !IDLE_SKILLS.has(pl.skill)) { alt = { r, pl }; break } }
      if (alt) { top = alt.r; plan = alt.pl } else {
        const hungry = c.needs.urgencies.hunger > 0.5
        const dir = ['north', 'south', 'east', 'west', 'any'][Math.floor(rng() * 5) % 5]
        top = { name: hungry && c.inv.food === 0 ? 'seek_food' : 'explore', score: 0, habit: null }
        plan = { skill: 'explore', args: { direction: dir } }
      }
      trace?.event('habit_idle_guard', { streak: idleStreak(), forced: top.name, skill: plan.skill })
    }
    const id = `habit-${++n}`
    if (top.name === 'continue_intent') sv?.markContinued?.()
    trace?.event('habit_choice', { intent_id: id, ...goalFeature(sv, top.name), autonomy: sv ? 'high' : (process.env.WREN_AUTONOMY === 'classic' ? 'classic' : 'high'), habit: top.name, skill: plan.skill, args: plan.args, score: +top.score.toFixed(2), alt: rows.slice(1, 4).map((r) => [r.name, +r.score.toFixed(2)]), levels: Object.fromEntries(Object.entries(c.needs.levels).map(([k, v]) => [k, +v.toFixed(2)])),
      ...(lscorer.active && top.learned !== undefined ? { scorer: lscorer.mode, learned: +top.learned.toFixed(3), mixed: +top.mixed.toFixed(3), utility_top: rows[0]?.utilityTop ?? top.name, guarded: !!rows[0]?.guarded, alt_learned: rows.slice(1, 4).map((r) => [r.name, r.learned === undefined ? null : +r.learned.toFixed(3)]) } : {}) })
    const t0 = now()
    const b = bucketOf(bot)
    const res = await runner.run(plan.skill, plan.args, { owner: 's1', intent_id: id })
    const rec = { habit: top.name, skill: plan.skill, status: res.status, reason: res.reason, t: t0, ms: res.ms, bucket: b }
    history.push(rec); if (history.length > 200) history.shift()
    if (decisionLog) { // S1G: every S1 decision is logged for the goal-conditioned scorer; with no S2 intent at all it is a 'no_intent' decision
      const p0 = bot.entity.position, gf = goalFeature(sv, top.name).goal
      decisionLog.write({ kind: sv?.goalActive ? 'steered' : 'no_intent', intent_id: id, step: n, goal: gf ? { type: 'legacy', target: sv.skill ?? null, hash: gf.hash, mods: gf.mods ?? {} } : null,
        state: { hp: bot.health, food: bot.food, inv_food: c.inv.food, free: c.inv.free, blocks: c.inv.blocks, night: !!c.night, hostiles: c.hostiles ?? 0, animals: c.animals ?? 0, dist: null, pos: [Math.round(p0.x), Math.round(p0.y), Math.round(p0.z)] },
        candidates: rows.slice(0, 6).map((r) => ({ name: r.name, skill: null, score: +r.score.toFixed(3), base: +(r.base ?? 0).toFixed(3), hab: +(r.base ?? 0).toFixed(3), goal_term: r.steer ?? 0, pen: +(r.pen ?? 0).toFixed(2), ...(r.learned !== undefined ? { learned: +r.learned.toFixed(3) } : {}) })),
        busy_rejects_min: runner.busyRejectsPerMin?.() ?? 0, chosen: { name: top.name, skill: plan.skill, args: plan.args, source: 'habit' }, outcome: { status: res.status, reason: res.reason ?? null, ms: res.ms ?? null, achieved: null } })
    }
    counts[top.name] = (counts[top.name] ?? 0) + 1
    skillCounts[plan.skill] = (skillCounts[plan.skill] ?? 0) + 1
    const o = (outcomes[top.name] ??= { done: 0, failed: 0, aborted: 0, rejected: 0 })
    o[res.status] = (o[res.status] ?? 0) + 1
    if (top.name === 'sleep' && res.status === 'done') needs.noteSlept(bot)
    if (top.name === 'rest' && res.status === 'done') needs.noteRested()
    if (top.name === 'shelter' && res.status === 'done') for (let i = 0; i < 6; i++) needs.noteRested() // a night in a pillbox restores energy
    if (res.status === 'failed' || res.status === 'rejected') {
      // failure budget per (habit, place bucket): exponential cool-down
      // 'resource not around' style failures lock the habit everywhere (a few steps away will not change it); others per place bucket
      const global = ['inventory_full', 'no_food', 'not_night', 'no_bed', 'light_ok', 'no_target_found', 'no_tool', 'no_animal_nearby', 'unreachable_animal', 'no_chest', 'no_table', 'no_spot', 'no_water', 'no_rod'].includes(res.reason)
      const key = global ? `${top.name}|*` : `${top.name}|${b}`
      const l = lock.get(key) ?? { fails: 0, until: 0 }
      l.fails++; l.until = now() + Math.min(600000, (global ? 60000 : 20000) * 2 ** (l.fails - 1))
      lock.set(key, l)
      if (top.name === 'craft') lock.set(`craft:${plan.args.item}`, { fails: 1, until: now() + 120000 })
    } else if (res.status === 'done') {
      lock.delete(`${top.name}|${b}`); lock.delete(`${top.name}|*`)
    }
    return res.status
  }

  async function run() {
    while (running) {
      let s = 'skip'
      try { s = await step() } catch (e) { trace?.event('habit_error', { message: String(e?.message).slice(0, 200) }) }
      await new Promise((r) => setTimeout(r, s === 'done' ? pauseMs.done : s === 'skip' ? 300 : pauseMs.fail))
    }
  }

  return {
    needs, history, lock,
    rank: (bot = getBot()) => rank(bot),
    step,
    start() { if (running) return this; running = true; loop = run(); return this },
    async stop() { running = false; await loop },
    scorer: lscorer,
    setSteer(fn) { steer = typeof fn === 'function' ? fn : () => null },
    setGrace(fn) { graceFn = typeof fn === 'function' ? fn : null },
    setConversing(fn) { conversing = typeof fn === 'function' ? fn : () => false },
    setDrives(levels) { needs.setOverride(levels) },
    setCostAt(fn) { env.costAt = fn },
    stats() {
      return { total: history.length, counts: { ...counts }, skills: { ...skillCounts }, outcomes, entropy_bits: +shannon(counts).toFixed(3), unique_cells: cells.size }
    },
  }
}
