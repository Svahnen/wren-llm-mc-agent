// installDetectors(body, arbiter, runner, trace, metrics, opts): wires lag monitor, per-skill watchdog, stuck monitor,
// escalation ladder, escape skills, cycle/visit/n-gram/chat detectors, lockouts and dead-state checks.
// It wraps runner.run (to learn goal types/places, hold off habits while unstuck mode is active, record results).
import path from 'node:path'
import { LagMonitor } from './lag.js'
import { SkillWatchdog } from './watchdog.js'
import { StuckMonitor } from './stuck.js'
import { LockoutList, FailureBudget } from './lockout.js'
import { CycleDetector, VisitCounter, NgramCounter, ChatRepeat } from './cycle.js'
import { DeadStateMonitor } from './deadstate.js'
import { confinedShared } from './confined.js'
import { EscalationLadder, RestartStore } from '../escape/ladder.js'
import { registerEscapeSkills } from '../escape/skills.js'

const INTERNAL = /^(unstuck_|escape_)/

/**
 * opts: { now, getHome(bot), onRestart(reason), stateFile, enforceLockouts=false, hooks:{getBreadcrumb,lightMin,...,onDeadState},
 *         onCycle(d), onRepeat(d), lag:{}, watchdog:{}, stuck:{}, ladder:{}, deadState:{}, lockoutMs }
 */
export function installDetectors(body, arbiter, runner, trace, metrics, opts = {}) {
  const now = opts.now ?? Date.now
  const lag = new LagMonitor({ now, trace, ...opts.lag })
  const lockouts = new LockoutList({ now, trace, defaultMs: opts.lockoutMs ?? 30 * 60e3 })
  const budget = new FailureBudget({ lockouts, now, ...opts.budget })
  const cycles = new CycleDetector({ now, ...opts.cycles })
  const visits = new VisitCounter({ now, ...opts.visits })
  const ngrams = new NgramCounter(opts.ngrams)
  const chat = new ChatRepeat({ now, ...opts.chat })
  const rawRun = runner.run.bind(runner)
  registerEscapeSkills(runner, { getHome: opts.getHome })
  const store = new RestartStore({ file: opts.stateFile ?? null, now })
  const ladder = new EscalationLadder({
    body, runner, run: rawRun, trace, metrics, lag, now, getHome: opts.getHome ?? (() => null),
    onRestart: opts.onRestart ?? ((reason) => body.forceDisconnect(`detector_restart:${reason}`)), store, cfg: opts.ladder,
  })
  const watchdog = new SkillWatchdog({ runner, lag, trace, now, ...opts.watchdog })
  const stuck = new StuckMonitor({ body, runner, ladder, lag, trace, now, cfg: opts.stuck })
  const dead = new DeadStateMonitor({ getBot: () => body.bot, lag, trace, now, hooks: opts.hooks, ...opts.deadState })
  const stats = { cycles: 0, repeat_visits: 0, ngram_repeats: 0, chat_repeats: 0, held_habits: 0, lockouts_enforced: 0 }
  let visitTimer = null

  watchdog.on('stall', (i) => stuck.onStall(i))
  watchdog.on('progress', () => { stuck.noProgressMs = 0 })
  body.on('bot', (bot) => lag.attach(bot))
  body.on('spawn', (bot) => { lag.noteDiscontinuity('spawn'); stuck.rebase(); ladder.reset('spawn'); if (lag.bot !== bot) lag.attach(bot) })
  body.on('state', (e) => { if (e.to !== 'spawned') { stuck.rebase(); ladder.reset(`state:${e.to}`) } })
  if (body.bot) lag.attach(body.bot)

  function onCycle(d) {
    stats.cycles++
    trace?.event('cycle_detected', d)
    for (const g of d.goals) lockouts.lock({ type: g.type, place: g.place, reason: `cycle p=${d.period}`, source: 'cycle' })
    opts.onCycle?.(d)
  }
  function noteGoal(type, place = null) { const d = cycles.record(type, place); if (d) onCycle(d); return d }

  runner.run = async (name, args = {}, o = {}) => {
    if (INTERNAL.test(name)) return rawRun(name, args, o)
    if (ladder.active && (o.owner ?? 's1') !== 'reflex') {
      stats.held_habits++
      return { status: 'rejected', reason: 'unstuck_active', skill: name, intent_id: o.intent_id ?? null, ms: 0 }
    }
    const type = args.goal_type ?? name
    const place = args.place ?? (Number.isFinite(args.x) && Number.isFinite(args.z) ? `${Math.floor(args.x / 16)},${Math.floor(args.z / 16)}` : null)
    if (opts.enforceLockouts) {
      const l = lockouts.isLocked(type, place)
      if (l) { stats.lockouts_enforced++; return { status: 'rejected', reason: `locked_out:${l.reason}`, skill: name, intent_id: o.intent_id ?? null, ms: 0 } }
    }
    watchdog.lastPlace = place
    const res = await rawRun(name, args, o)
    if (res.status === 'rejected') return res
    const p = place ?? watchdog.lastPlace
    noteGoal(type, p)
    const ng = ngrams.push(`${name}:${res.status}`)
    if (ng) { stats.ngram_repeats++; trace?.event('ngram_repeat', ng); opts.onRepeat?.(ng) }
    // Q1: only real failures spend the budget. An abort because a reflex, an S2 intent or the unstuck ladder took the body is not the skill failing
    // (real Wren: hunt@*, gather_wood@*, shelter@* were 'locked out' 7 times for 30 min by being interrupted)
    const interrupted = res.status === 'aborted' && !(res.reason === 'no_progress' || res.reason === 'max_s')
    if (!interrupted) budget.record(type, p, res.status === 'done')
    if (res.status === 'aborted' && (res.reason === 'no_progress' || res.reason === 'max_s') && now() - watchdog.lastStallAt > 3000) {
      watchdog.lastStallAt = now()
      stuck.onStall({ skill: name, kind: res.reason, stalled_ms: (runner.skills.get(name)?.stall_s ?? 20) * 1000, source: 'runner', place: p })
    }
    stuck.noteSkillResult(res, name)
    return res
  }

  visitTimer = setInterval(() => {
    const p = body.spawned && body.bot?.entity?.position
    if (!p || lag.status().lagging) return
    const d = visits.observe(p)
    if (d) {
      stats.repeat_visits++
      trace?.event('repeat_visit', d)
      lockouts.lock({ place: d.place, reason: `repeat_visit:${d.visits}/h`, source: 'visit' })
      opts.onRepeat?.(d)
    }
  }, 1000)
  visitTimer.unref?.()

  lag.start(); watchdog.start(); stuck.start(); dead.start()

  function snapshot() {
    const s = ladder.stats
    const rec = [...s.recoveries_ms].sort((a, b) => a - b)
    return {
      stuck: { ...stuck.stats, confined: confinedShared.confined, rescue: confinedShared.rescue && { at: confinedShared.rescue.at, pos: confinedShared.rescue.pos, dig_dir: confinedShared.rescue.dig_dir, text: confinedShared.rescue.text }, episodes: s.episodes, steps: s.steps, verified: s.verified, escape_by: s.escape_by, restarts: s.restarts, restarts_suppressed: s.restarts_suppressed, lag_aborts: s.lag_aborts, max_stuck_ms: s.max_stuck_ms, p95_recovery_ms: rec.length ? rec[Math.min(rec.length - 1, Math.floor(rec.length * 0.95))] : null, level: ladder.level },
      lag: { ...lag.stats, status: lag.status() },
      watchdog: watchdog.stats,
      repeats: { ...stats, cycle_detections: cycles.detections, ngram_entropy: ngrams.entropy(), lockouts_active: lockouts.list().length },
      dead_states: { active: dead.active(), counts: dead.counts },
    }
  }
  if (metrics && !metrics.__detectWrapped) {
    const orig = metrics.snapshot.bind(metrics)
    metrics.snapshot = (o) => ({ ...orig(o), detect: snapshot() })
    metrics.__detectWrapped = true
  }

  return {
    lag, watchdog, stuck, ladder, lockouts, budget, cycles, visits, ngrams, chat, dead, snapshot, noteGoal,
    get unstuckActive() { return ladder.active },
    isLocked: (type, place) => lockouts.isLocked(type, place),
    stop() {
      clearInterval(visitTimer); lag.stop(); watchdog.stop(); stuck.stop(); dead.stop()
      runner.run = rawRun
    },
  }
}
export { GlobalDisplacementWatchdog, confinedShared, confinedBus } from './confined.js'
export { LagMonitor, SkillWatchdog, StuckMonitor, LockoutList, FailureBudget, CycleDetector, VisitCounter, NgramCounter, ChatRepeat, DeadStateMonitor, EscalationLadder, RestartStore }
export { textSimilarity } from './cycle.js'
