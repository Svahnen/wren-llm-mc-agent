// S1G: goal-conditioned action selector (System 1). S2 states WHAT (goal type + target + intent text + modulators); this picks and sequences HOW:
//   candidates (goals.js) -> score = base + 0.3 * habit utility + goal terms (urgency/caution/sociability) - recency/failure penalties (+ learned scorer, optional)
//   -> run the best skill -> judge goal achieved? -> otherwise re-plan with the failure remembered -> escalate to S2 only when achieved or out of options.
// Habits are the repertoire (their utilities feed the score; body-safety habits still pre-empt), not a separate agenda. No behavioural outcome is hard-coded:
// an unreachable goal is reported back to S2 with what was tried; S2 decides what to do next.
import { isIgnoredPlayer } from '../ignore-players.js'
import { OPTIONS, ACHIEVED, resourceOptions, customPredicate, customRelevant } from './goals.js'
import { straightHops } from './trails.js'
import { textHash, parseCoords, compass8 } from '../../../brain/goaltypes.js'
import { inventoryFacts } from '../habits/needs.js'
import { countMatch } from '../skills/lib.js'
import { createPlaybookEngine } from '../playbooks/engine.js'
import { parsePlaybookTarget, defaultPlaybookFor } from '../playbooks/catalog.js'
const safeFindFurnace = (bot) => { try { const id = bot.registry.blocksByName.furnace?.id; return id === undefined ? null : bot.findBlock({ matching: id, maxDistance: 24 }) } catch { return null } }

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const GLOBAL_FAIL = new Set(['inventory_full', 'no_food', 'not_night', 'no_bed', 'light_ok', 'no_target_found', 'no_tool', 'no_animal_nearby', 'unreachable_animal', 'no_chest', 'no_table', 'no_spot', 'no_water', 'no_rod', 'unknown_place', 'target_gone', 'precondition', 'no_raw_food', 'no_fuel', 'no_furnace_materials', 'no_furnace', 'cannot_open', 'cannot_load'])
const SAFETY_CATS = new Set(['safety', 'rest', 'survival'])
const SAFETY_MIN = 6                        // a habit at or above this utility is body safety (cover, shelter, sleep, starving) and pre-empts a goal step
const NO_SAFETY_YIELD = new Set(['build_shelter', 'rest', 'defend', 'avoid'])
export const MAX_MS = { go_to_place: 360000, follow_person: 150000, default: 300000 }
const MAX_STEPS = 14
const TRANSIENT = new Set(['busy', 'unstuck_active', 'no_body', 'preempt_timeout'])

export function createS1({
  runner, getBot, env, habits = null, trace = null, rng = env?.rng ?? Math.random, now = Date.now, scorer = null, trails = null, decisionLog = null,
  onFinish: onFinish0 = () => {}, ctxFn = null, hop = 40, playbookDefaults = false, playbookStateFile = null, calm = null, owner = 's1', pauseMs = 150, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let onFinish = onFinish0
  let cur = null          // the goal being pursued
  let seq = 0, lastChosen = null
  const switchTimes = []
  const stats = { goals: 0, done: 0, failed: 0, cancelled: 0, steps: 0, safety_yields: 0, replans: 0, no_intent: 0, switches: 0, decisions: 0 }

  // ---- PB1: playbooks (multi-step activities as data). S2 names one (goal type `playbook`) or a goal type maps to a default; steps/resume live in playbooks/engine.js
  const pbHooks = { notify: () => {}, screenRecent: null, log: () => {} }
  const DANGER_HABITS = new Set(['take_cover', 'dig_in', 'shelter'])   // while a playbook runs only real danger pre-empts it; hunger/sleep follow priority.js
  let pbSafetyUntil = new Map()
  const foodSourceDist = (bot) => {
    const me = bot.entity.position; let best = Infinity
    for (const e of Object.values(bot.entities ?? {})) if (e?.position && ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(e.name)) best = Math.min(best, d3(e.position, me))
    const f = nearestFoodSource(bot); if (f) best = Math.min(best, f.dist)
    return best
  }
  const playbooks = createPlaybookEngine({
    getBot, env, now, sleep, stateFile: playbookStateFile, decisionLog,
    runSkill: (name, args, o = {}) => runner.run(name, args, { owner, intent_id: o.intent_id }),
    abortCurrent: async () => { try { await runner.abort?.('playbook_step') } catch { /* ignore */ } },
    notify: (kind, text, data) => pbHooks.notify(kind, text, data), log: (e, d) => pbHooks.log(e, d), screenRecent: (a, n) => pbHooks.screenRecent?.(a, n) ?? [],
    calm: calm ?? (async () => true), foodSource: foodSourceDist,
    safety: async () => {
      const bot = getBot(); if (!bot?.entity) return false
      const { c, rows } = situation(bot)
      const top = rows.find((r) => DANGER_HABITS.has(r.name) && r.score >= SAFETY_MIN)
      if (!top || (pbSafetyUntil.get(top.name) ?? 0) > now()) return false
      pbSafetyUntil.set(top.name, now() + 30000)
      const pl = top.habit.plan(c); if (!pl) return false
      stats.safety_yields++
      const res = await runner.run(pl.skill, pl.args, { owner, intent_id: `pb-safe-${top.name}` })
      decisionLog?.write({ kind: 'goal', intent_id: 'playbook', state: { hp: bot.health, food: bot.food }, chosen: { name: top.name, skill: pl.skill, args: pl.args, source: 'safety' }, outcome: { status: res.status, reason: res.reason ?? null } })
      return true
    },
  })
  const knowFor = (bot) => ({ players: Object.keys(bot?.players ?? {}).filter((n) => n !== bot.username && !isIgnoredPlayer(n)), places: (env.landmarks?.list?.() ?? []).map((l) => l.id) })

  // ---- perception for the selector (reads the habit situation when available: one source of truth)
  function situation(bot) {
    if (ctxFn) return ctxFn(bot)
    if (habits?.rank) { const r = habits.rank(bot); return { c: r.c, rows: r.rows } }
    const inv = inventoryFacts(bot)
    return { c: { bot, inv, rng, animals: 0, animalNear: Infinity, night: false, dark: false, players: [], playerNear: false, hostiles: 0, exposed: [], needs: { levels: { energy: 1 } }, underground: false }, rows: [] }
  }
  function entityPos(bot, ref) {
    if (!ref) return null
    const pl = bot.players?.[ref]?.entity; if (pl?.position) return pl.position
    const base = String(ref).replace(/_\d+$/, '')
    const pool = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && (e.username === ref || e.name === base))
    pool.sort((a, b) => d3(a.position, bot.entity.position) - d3(b.position, bot.entity.position))
    return pool[0]?.position ?? null
  }
  function resolveTarget(g, bot) {
    const spec = g.spec, tg = spec.target
    if (!tg) return null
    const me = bot.entity.position
    if (spec.type === 'go_to_place' || spec.type === 'explore_area') {
      const lm = env.landmarks?.get?.(tg)
      if (lm) return { place: tg, isPlace: true, x: lm.x, y: lm.y, z: lm.z, pos: lm, dist: d3(lm, me), dir: undefined }
      const c = parseCoords(String(tg).replace(/,/g, ' '))
      if (c) { const y = c.y ?? me.y; return { isPlace: true, x: c.x, y, z: c.z, pos: { x: c.x, y, z: c.z }, dist: d3({ x: c.x, y, z: c.z }, me) } }
      if (spec.type === 'explore_area') return { dir: /^(north|south|east|west)$/.test(tg) ? tg : undefined, isPlace: false }
      return null
    }
    const p = entityPos(bot, tg)
    return p ? { pos: p, x: p.x, y: p.y, z: p.z, dist: d3(p, me), isPlace: false } : { pos: null, isPlace: false }
  }

  function facts(bot, c, t) {
    const inv = inventoryFacts(bot)
    return { inv, food: bot.food ?? 20, heat: env.heatmap?.size ?? 0, t, hostiles: c.hostiles ?? 0, energyLevel: c.needs?.levels?.energy ?? 1, matchCount: (re) => countMatch(bot, re), blockCount: (name) => { try { const id = bot.registry.blocksByName[name]?.id; return id == null ? 0 : bot.findBlocks({ matching: id, maxDistance: 16, count: 64 }).length } catch { return 0 } } }
  }

  function optionsFor(g, c, rows) {
    let list = OPTIONS[g.spec.type] ?? []
    if (g.spec.type === 'find_resource') list = resourceOptions(g.spec.target)
    if (g.spec.type === 'custom' || list.length === 0) list = rows.filter((r) => r.habit && (g.spec.type !== 'custom' || customRelevant(r.habit, g.spec.text))).map((r) => ({ name: r.name, habitRow: r, skill: null, base: 0, applies: () => true }))
    return list
  }

  function candidates(g, c, rows) {
    const mods = g.spec.mods ?? {}
    const hab = new Map(rows.map((r) => [r.name, r]))
    const out = []
    for (const op of optionsFor(g, c, rows)) {
      let ok = false
      try { ok = !!op.applies(c, g) } catch { ok = false }
      if (!ok) continue
      const lk = g.tried.get(op.name)
      const locked = !!lk && (lk.locked || lk.until > now())
      let args = null, skill = null
      try {
        if (op.habitRow) { const pl = op.habitRow.habit.plan(c); if (!pl) continue; skill = pl.skill; args = pl.args } else if (!op.route) { skill = typeof op.skill === 'function' ? op.skill(c, g) : op.skill; args = op.args(c, g) }
      } catch { continue }
      const h = hab.get(op.name)
      const habU = h ? h.score : 0
      let gt = 0
      try { gt = op.goalTerm ? op.goalTerm(c, g, mods) : 0 } catch { gt = 0 }
      // recency: repeating the same option right after it succeeded without reaching the goal is damped, so alternatives get their turn
      // commitment (hysteresis): an action that just succeeded is continued for up to 2 more steps before alternatives are tried; a failure switches at once
      const same = g.last?.name === op.name && g.last.status === 'done'
      const rep = same ? (g.last.streak >= 3 ? 1.0 * (g.last.streak - 2) : -0.9) : 0
      const pen = (lk ? 0.8 * lk.fails : 0) + rep
      const base = op.base ?? 0
      let score = base + 0.3 * habU + gt - pen + rng() * 0.15
      if (op.habitRow) score = op.habitRow.score
      out.push({ name: op.name, skill, args, route: op.route || false, score: +score.toFixed(3), base, hab: +habU.toFixed(2), goal_term: +gt.toFixed(2), pen: +pen.toFixed(2), locked, _op: op })
    }
    out.sort((a, b) => b.score - a.score)
    const open = out.filter((x) => !x.locked)
    if (scorer?.active && open.length) {
      try { scorer.apply(open, { bot: getBot(), history: g.hist, levels: c.needs?.levels ?? {} }) } catch (e) { trace?.event('s1_scorer_error', { message: String(e?.message).slice(0, 160) }) }
      if (open[0]?.mixed !== undefined) open.sort((a, b) => (b.mixed ?? b.score) - (a.mixed ?? a.score))
    }
    return { all: out, open }
  }

  // ---- long-range travel along walked trails, hop by hop, re-planned when a hop fails (chunk-aware: hops stay inside the loaded area)
  async function travel(g, tgt) {
    const t0 = now()
    const goal = { x: tgt.x, y: tgt.y, z: tgt.z }
    let viaTrail = false
    for (let attempt = 0; attempt < 6 && !g.cancelled && now() - t0 < 240000; attempt++) {
      const bot = getBot(); if (!bot?.entity) return { status: 'failed', reason: 'no_body', ms: now() - t0 }
      const me = bot.entity.position
      if (dxz(me, goal) <= 4.5 && Math.abs(me.y - goal.y) <= 8) return { status: 'done', reason: 'ok', ms: now() - t0 }
      let wps = trails?.route?.(me, goal)
      viaTrail = !!wps
      if (!wps) wps = straightHops(me, goal, hop)
      g.nav.push({ attempt, via: viaTrail ? 'trail' : 'hops', n: wps.length })
      if (attempt > 0) stats.replans++
      let failedAt = null
      for (const wp of wps) {
        if (g.cancelled) return { status: 'aborted', reason: 'cancelled', ms: now() - t0 }
        const last = wp === wps.at(-1)
        const res = await runner.run('move_to', { x: Math.round(wp.x), y: Math.round(wp.y), z: Math.round(wp.z), radius: last ? 3 : 5 }, { owner, intent_id: g.id })
        trace?.event('s1_nav_hop', { id: g.id, wp: [Math.round(wp.x), Math.round(wp.z)], status: res.status, reason: res.reason, via: viaTrail ? 'trail' : 'hops' })
        if (res.status === 'aborted' || res.status === 'rejected') return { status: res.status, reason: res.reason, ms: now() - t0 }
        if (res.status !== 'done') { failedAt = wp; if (viaTrail) trails.markBad(wp); break }
      }
      if (!failedAt) { const m = getBot().entity.position; return dxz(m, goal) <= 6 ? { status: 'done', reason: 'ok', ms: now() - t0 } : { status: 'failed', reason: 'short_of_goal', ms: now() - t0 } }
      await sleep(pauseMs)
    }
    return { status: 'failed', reason: 'unreachable', ms: now() - t0 }
  }

  const nearestFoodSource = (bot) => {
    const t = now(), me = bot.entity.position; let best = null
    for (const [k, f] of env.foodSeen ?? []) { if (t - f.t > 360000) { env.foodSeen.delete(k); continue }; const d = d3(f, me); if (!best || d < best.dist) best = { ...f, dist: d } }
    return best
  }
  function summary(g) {
    const parts = [...g.tried].map(([k, v]) => `${k} ${v.done ? `done x${v.done}` : ''}${v.fails ? ` failed x${v.fails} (${v.last})` : ''}`.trim())
    return `${g.spec.type}${g.spec.target ? ' ' + g.spec.target : ''}: ${g.finishWhy}. Tried: ${parts.join('; ') || 'nothing'}`
  }

  function finish(g, status, reason, pbEnd = null) {
    if (g.finished) return
    g.finished = true; g.finishWhy = reason
    if (cur === g) cur = null
    stats[status === 'done' ? 'done' : g.cancelled ? 'cancelled' : 'failed']++
    trace?.event('s1_goal_end', { id: g.id, type: g.spec.type, status, reason, steps: g.steps, ms: now() - g.t0 })
    if (g.cancelled) return // S2 (or a new goal) took over: nothing to report
    try { onFinish({ intent_id: g.id, status, reason_code: status === 'done' ? 'goal_achieved' : reason === 'timeout' ? 'timeout' : 'options_exhausted', reason, summary: pbEnd ? pbEnd.summary : g.playbook ? `playbook: ${g.finishWhy}` : summary(g), steps: pbEnd ? pbEnd.steps : g.steps, ms: now() - g.t0, playbook: pbEnd ? { name: pbEnd.name, interruptions: pbEnd.interruptions, resumes: pbEnd.resumes, after_this: pbEnd.after_this } : undefined }) } catch { /* ignore */ }
  }

  async function loop(g) {
    try {
      let yields = 0, yieldFails = 0
      try { await runner.abort?.('s1_goal_start') } catch { /* ignore */ }   // a habit skill still running from before the goal must give way (same owner token, no pre-emption)
      while (!g.cancelled && !g.finished) {
        const bot = getBot()
        if (!bot?.entity || bot.health <= 0) { await sleep(500); if (now() - g.t0 > 60000 + g.limit) return finish(g, 'failed', 'no_body'); continue }
        if (now() - g.t0 - g.yieldMs > g.limit) return finish(g, 'failed', 'timeout')
        const { c, rows } = situation(bot)
        c.t = resolveTarget(g, bot); g.target = c.t
        if (c.t?.pos && g.spec.type === 'follow_person' && c.t.dist <= 8) g.nearMs += now() - (g.lastTick ?? now())
        g.lastTick = now()
        const f = facts(bot, c, c.t)
        if (g.steps > 0 && ACHIEVED[g.spec.type]?.(f, g)) return finish(g, 'done', 'goal achieved')
        if (g.spec.type === 'custom' && !g.pred && g.steps > 0 && g.didDone > 0) return finish(g, 'failed', `not done: attempted but unverified (ran ${[...g.did].join(', ')}); I cannot confirm "${String(g.spec.text).slice(0, 80)}" happened`)
        if (g.steps >= MAX_STEPS) return finish(g, 'failed', 'step budget used')
        // body safety first (code responsibility): a very high-utility safety/rest/survival habit pre-empts the step, then the goal resumes
        const top = rows[0]
        if (top && !NO_SAFETY_YIELD.has(g.spec.type) && top.score >= SAFETY_MIN && SAFETY_CATS.has(top.habit?.category) && yieldFails < 3 && (g.safetyUntil.get(top.name) ?? 0) <= now()) {
          g.safetyUntil.set(top.name, now() + 30000) // one pre-emption per habit per 30 s: a goal step must follow (the habit's own state change gets its time)
          const pl = top.habit.plan(c)
          if (pl) {
            const ty = now(); stats.safety_yields++; yields++
            const res = await runner.run(pl.skill, pl.args, { owner, intent_id: `${g.id}-safe${yields}` })
            g.yieldMs += now() - ty
            decisionLog?.write(rec(g, c, f, [{ name: top.name, skill: pl.skill, score: +top.score.toFixed(2) }], { name: top.name, skill: pl.skill, args: pl.args, source: 'safety' }, res, false))
            if (res.status === 'failed' || res.status === 'rejected') yieldFails++; else yieldFails = 0
            if (g.cancelled) return
            await sleep(pauseMs); continue
          }
        }
        c.foodSrc = nearestFoodSource(bot)
        c.furnaceKnown = (c.inv?.raw ?? 0) > 0 && !!safeFindFurnace(bot)
        const { all, open } = candidates(g, c, rows)
        if (!open.length) return finish(g, 'failed', all.length ? 'every option failed' : 'no option applies')
        const ch = open[0]
        // ARB1 (a): never request while the body is held; wait for the release (arb_release), then re-evaluate once
        if (runner.isHeld?.(owner)) {
          if (++g.busy > 25) return finish(g, 'failed', 'body_busy')
          await runner.waitFree(15000); if (g.cancelled) return
          continue
        }
        g.steps++; stats.steps++
        if (lastChosen && lastChosen !== ch.name) { stats.switches++; switchTimes.push(now()) }
        lastChosen = ch.name; stats.decisions++
        let res
        if (ch.route) res = await travel(g, ch.route === 'food' ? c.foodSrc : c.t)
        else res = await runner.run(ch.skill, ch.args, { owner, intent_id: g.id })
        if (g.cancelled) return
        // the body is momentarily held by someone else (a habit finishing, the unstuck ladder): that says nothing about the option; wait and retry
        if (res.status === 'rejected' && TRANSIENT.has(res.reason)) {
          g.steps--; stats.steps--
          if (++g.busy > 25) return finish(g, 'failed', 'body_busy')
          try { if (res.reason === 'busy' && runner.arbiter?.owner !== 'reflex') await runner.abort?.('s1_goal_busy') } catch { /* ignore */ }
          // ARB1 (b): one request per hold; wait for the release instead of re-requesting every 300 ms
          if (res.reason === 'busy' && runner.waitFree) await runner.waitFree(15000)
          else await sleep(Math.max(pauseMs, res.reason === 'busy' ? 300 : 1500))
          continue
        }
        // outcome bookkeeping
        const tr = g.tried.get(ch.name) ?? { fails: 0, done: 0, until: 0, locked: false, last: null }
        if (res.status === 'done') { tr.done++; tr.fails = Math.max(0, tr.fails - 1) } else if (res.status === 'failed' || res.status === 'rejected' || (res.status === 'aborted' && res.reason && res.reason !== 'intent' && !/^preempted/.test(res.reason) && res.reason !== 'superseded')) {
          tr.fails++; tr.last = res.detail ? `${res.reason}: ${res.detail}` : (res.reason ?? res.status)   // GATH1: the why travels with the reason
          if (GLOBAL_FAIL.has(res.reason)) tr.locked = true
          else if (tr.fails >= 2) tr.locked = true
          else tr.until = now() + 20000
        }
        g.tried.set(ch.name, tr)
        g.last = { name: ch.name, status: res.status, streak: g.last?.name === ch.name ? g.last.streak + 1 : 1 }
        g.did.add(`${ch.name}:${res.status}`); if (res.status === 'done') g.didDone++
        g.hist.push({ habit: ch.name, skill: ch.skill, status: res.status, reason: res.reason, t: now() })
        const f2 = facts(getBot(), c, resolveTarget(g, getBot()))
        const ach = !!ACHIEVED[g.spec.type]?.(f2, g)
        decisionLog?.write(rec(g, c, f, all.map(({ _op, ...x }) => x).slice(0, 6), { name: ch.name, skill: ch.skill, args: ch.args, source: 'selector', route: ch.route ? g.nav.slice(-3) : undefined }, res, ach))
        trace?.event('s1_decision', { id: g.id, type: g.spec.type, step: g.steps, chosen: ch.name, skill: ch.skill, status: res.status, reason: res.reason, alt: open.slice(1, 4).map((x) => x.name), score: ch.score })
        await sleep(pauseMs)
      }
    } catch (e) {
      trace?.event('s1_error', { message: String(e?.message).slice(0, 200), stack: String(e?.stack).split('\n')[1] })
      finish(g, 'failed', 'internal_error')
    }
  }

  const rec = (g, c, f, candidatesOut, chosen, res, achieved) => ({
    kind: 'goal', intent_id: g.id, step: g.steps,
    goal: { type: g.spec.type, target: g.spec.target ?? null, hash: textHash(g.spec.text), mods: g.spec.mods ?? {} },
    state: { hp: c.bot.health, food: c.bot.food, inv_food: f.inv.food, free: f.inv.free, blocks: f.inv.blocks, night: !!c.night, hostiles: c.hostiles ?? 0, animals: c.animals ?? 0, dist: c.t?.dist != null ? +c.t.dist.toFixed(1) : null, pos: [Math.round(c.bot.entity.position.x), Math.round(c.bot.entity.position.y), Math.round(c.bot.entity.position.z)] },
    candidates: candidatesOut, chosen, outcome: { status: res.status, reason: res.reason ?? null, ms: res.ms ?? null, achieved },
    busy_rejects_min: runner.busyRejectsPerMin?.() ?? 0,
  })

  return {
    /** Start pursuing a goal. spec = {type, target, text, mods:{urgency,caution,sociability}}. Returns the goal id. Replaces any goal in progress. */
    pursue(spec, { intent_id = null } = {}) {
      if (cur) this.cancel('replaced')
      const bot = getBot()
      const id = intent_id ?? `s1g-${++seq}`
      const sp = { type: spec.type ?? 'custom', target: spec.target ?? null, text: spec.text ?? '', mods: spec.mods ?? {} }
      const inv = bot?.entity ? inventoryFacts(bot) : { food: 0 }
      const g = { id, spec: sp, t0: now(), limit: MAX_MS[sp.type] ?? MAX_MS.default, yieldMs: 0, steps: 0, tried: new Map(), did: new Set(), didDone: 0, hist: [], nav: [], safetyUntil: new Map(), last: null, cancelled: false, finished: false, nearMs: 0, busy: 0, target: null,
        pred: sp.type === 'custom' ? customPredicate(sp.text, bot?.registry) : null,
        start: { predCount: 0, invFood: inv.food, heat: env.heatmap?.size ?? 0, resCount: bot?.entity && OPTIONS && sp.target ? countMatch(bot, resourceRe(sp.target)) : 0 } }
      if (g.pred && bot) { try { g.start.predCount = g.pred.kind === 'item' ? countMatch(bot, new RegExp(`^${g.pred.name}$`)) : facts(bot, {}, null).blockCount(g.pred.name) } catch { /* ignore */ } }
      cur = g; stats.goals++
      // PB1: a named playbook, or the default playbook of this goal type
      let pb = null
      if (sp.type === 'playbook') pb = parsePlaybookTarget(sp.target)
      else if (playbookDefaults && bot?.entity) pb = defaultPlaybookFor(sp)
      if (sp.type === 'playbook' && !pb) { g.promise = Promise.resolve().then(() => finish(g, 'failed', 'playbook target missing: name a playbook')); return id }
      if (pb) {
        const st = playbooks.start(pb.name, pb.args, { intent_id: id, serves: spec.serves ?? null, know: bot ? knowFor(bot) : null, onEnd: (e) => finish(g, e.status === 'done' ? 'done' : 'failed', e.status === 'done' ? 'goal achieved' : `${e.reason}${e.hint ? ': ' + e.hint : ''}`, e) })
        g.playbook = pb.name
        if (st.ok) { trace?.event('s1_goal_start', { id, type: sp.type, target: sp.target, playbook: pb.name, resumed: st.resumed }); g.promise = st.promise; return id }
        if (st.cooldown) { g.promise = Promise.resolve().then(() => finish(g, 'failed', st.errors.join('; '))); return id }
        if (sp.type === 'playbook') { g.promise = Promise.resolve().then(() => finish(g, 'failed', `playbook not started: ${st.errors.join('; ')}`)); return id }
        g.playbook = null   // a default mapping that cannot start falls back to the classic selector
      }
      trace?.event('s1_goal_start', { id, type: sp.type, target: sp.target, hash: textHash(sp.text), mods: sp.mods })
      g.promise = loop(g)
      return id
    },
    /** Stop the goal in progress (S2 changed its mind, a reflex took over). Silent: no report. */
    async cancel(reason = 'cancelled') {
      const g = cur; if (!g) return false
      g.cancelled = true; g.cancelReason = reason; cur = null
      stats.cancelled++
      if (g.playbook) await playbooks.cancel(reason)
      try { await runner.abort?.('s1_' + reason) } catch { /* ignore */ }
      return true
    },
    playbooks,
    setPlaybookHooks(h) { Object.assign(pbHooks, h) },
    setOnFinish(fn) { onFinish = typeof fn === 'function' ? fn : () => {} },
    active: () => !!cur,
    current: () => (cur ? { id: cur.id, type: cur.spec.type, target: cur.spec.target, playbook: cur.playbook ?? undefined, steps: cur.steps, tried: [...cur.tried].map(([k, v]) => `${k}:${v.done}ok/${v.fails}fail`) } : null),
    stats: () => ({ ...stats }),
    /** option switches in the last minute: the thrash metric (target: few) */
    switchesPerMin: () => switchTimes.filter((t) => now() - t < 60000).length,
    whenIdle: async () => { while (cur) await cur.promise },
  }
}

import { resourceOf } from './goals.js'
function resourceRe(t) { return resourceOf(t)?.re ?? /^$/ }

/** perception memory (1 Hz from main.js): animals seen recently, so a food plan can head for where they were last seen. */
export function rememberAnimals(bot, env, t = Date.now()) {
  const me = bot?.entity?.position; if (!me) return
  env.foodSeen ??= new Map()
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e === bot.entity || !['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(e.name)) continue
    if (d3(e.position, me) > 48) continue
    env.foodSeen.set(`${e.name}:${Math.floor(e.position.x / 16)},${Math.floor(e.position.z / 16)}`, { name: e.name, x: e.position.x, y: e.position.y, z: e.position.z, t })
  }
  if (env.foodSeen.size > 16) env.foodSeen.delete(env.foodSeen.keys().next().value)
}
