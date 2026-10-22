// Wires the body together: lifecycle + arbiter + skill runner + trace + metrics + default wander habit.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { loadConfig } from '../config.js'
import { Body } from './lifecycle.js'
import { Arbiter } from './arbiter.js'
import { SkillRunner } from './skills/runner.js'
import { Trace } from './trace.js'
import { Metrics } from './metrics.js'
import { Heatmap } from './heatmap.js'
import { registerSkills } from './skills/index.js'
import { createHabits } from './habits/index.js'
import { createRecover } from './recover.js'
import { conservativeMovements, installSprintPolicy } from './sprint-policy.js'
import { farmlandStepCost, installFarmGuard } from './farm-guard.js'   // RS3
import { installWaterPolicy } from './water-policy.js'
import { createS1, rememberAnimals } from './s1/selector.js'
import { TrailGraph } from './s1/trails.js'
import { createDecisionLog } from './s1/log.js'
import { installReflexes } from './reflex/index.js'
import { installDetectors } from './detect/index.js'
import { ProtectedRegions } from './integration/protect.js'
import { IntentManager } from './integration/intents.js'
import { createHooks } from './integration/hooks.js'
import { zoneStepCost } from './integration/zones.js'
import { makeRng, sleep, errInfo } from './util.js'
import { AirborneGuard } from './airborne-guard.js'
import { applyRecipeMappingFix } from './protocol-fix.js'
import { DoorMovements, installDoorOpener } from './skills/movements-doors.js'
import { installBuiltGuard } from './skills/movements-protect.js'

const { pathfinder, Movements } = pf

function defaultCreateBot(cfg) {
  return () => mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.username, auth: cfg.auth, version: cfg.version })
}

export function configurePathfinder(bot, cfg, hooks = null) {
  const mv = new DoorMovements(bot) // B1: doors are walkable (opened on the way), player-built blocks are never planned as breakable
  mv.canDig = cfg.pathfinder.canDig
  conservativeMovements(mv) // PB1: no sprinting / parkour by default (food); installSprintPolicy flips it for real threats, urgency, fed long trips
  if (hooks) mv.exclusionAreasStep.push(zoneStepCost(hooks)) // L1: lesson zones (lava deaths ...) also steer the pathfinder, not only target selection
  mv.exclusionAreasStep.push(farmlandStepCost(bot)) // RS3: walk around farmland when possible (a jump or fall onto it tramples the crops)
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = cfg.pathfinder.thinkTimeout // cap A* planning time
  bot.pathfinder.tickTimeout = cfg.pathfinder.tickTimeout   // cap per-tick planning so the 50 ms physics tick is safe
}

/** Build the whole body. createBot is injectable for tests. */
export function createApp(cfg, { createBot = defaultCreateBot(cfg) } = {}) {
  fs.mkdirSync(cfg.runtimeDir, { recursive: true })
  const rng = makeRng(cfg.seed)
  const trace = new Trace({ dir: cfg.logDir, maxBytes: cfg.trace.maxBytes, echo: cfg.trace.echo })
  const metrics = new Metrics()
  trace.event('protocol_fix', applyRecipeMappingFix(cfg.version)) // before minecraft-protocol compiles the protocol
  const heatmap = new Heatmap({ cell: cfg.wander.cell, rng })
  const heatFile = path.join(cfg.runtimeDir, 'heatmap.json')
  heatmap.load(heatFile)

  const body = new Body({ createBot, trace, reconnect: cfg.reconnect, connectTimeoutMs: cfg.connectTimeoutMs, rng })
  const arbiter = new Arbiter({ getBot: () => body.bot, trace, metrics })
  const runner = new SkillRunner({ arbiter, getBot: () => body.bot, trace, metrics })

  // ---- integration layer (I1): protected regions, hooks for mind/brain, intents ----
  const protectedRegions = new ProtectedRegions({ file: cfg.protectedFile, trace })
  const hooks = createHooks({ trace })
  // protected boxes are NOT a general costAt (wander may walk through the village); they forbid DIGGING: env.digForbidden + the bot.dig guard
  const intents = new IntentManager({ runner, arbiter, trace, metrics, canStart: (i) => hooks.lockout(i) })
  intents.on('status', (e) => hooks.events.emit('status', e))

  // reflex (T2) first: it owns the body at the highest priority
  const reflex = installReflexes(body, arbiter, trace, metrics)
  // skills (T4); wander is part of the pack
  const pack = registerSkills(runner, { heatmap, rng, runtimeDir: cfg.runtimeDir, radius: cfg.wander.radius })
  pack.env.costAt = (p) => hooks.costAt(p)               // wander/explore/gather read env.costAt
  pack.env.digForbidden = (p) => protectedRegions.digForbidden(p) // gather reads this (never dig a protected block)
  // detectors (T3): wraps runner.run, so install after the skills and before habits/intents run anything
  const det = installDetectors(body, arbiter, runner, trace, metrics, {
    getHome: () => pack.env.landmarks.home ?? null,
    stateFile: path.join(cfg.runtimeDir, 'detect-state.json'),
    enforceLockouts: cfg.enforceLockouts,
    hooks: { getBreadcrumb: () => pack.env.trail },
    onCycle: (d) => hooks.events.emit('cycle', d),
    onRepeat: (d) => hooks.events.emit('repeat', d),
  })
  trace.event('protected_regions', { file: cfg.protectedFile, boxes: protectedRegions.boxes.length })
  // S1G: goal-conditioned System 1. The decision log (logs/s1-decisions/) is the training data for the goal-conditioned scorer.
  const decisionLog = createDecisionLog({ dir: path.join(cfg.logDir, 's1-decisions'), run: process.env.WREN_RUN_ID ?? null })
  const trails = new TrailGraph({ file: path.join(cfg.runtimeDir, 'trails.json') })
  pack.env.trails = trails
  let s1 = null
  // REC2: body-level recovery routine; holds habits/S1/non-urgent S2 skills while it runs and keeps the escape ladder quiet
  const recover = createRecover({ getBot: () => body.bot, runner, arbiter, intents, trace, playbooks: () => s1?.playbooks ?? null, env: pack.env })
  det.stuck.suppress = () => recover.suppressLadder()
  { const inner = runner.run.bind(runner); runner.run = (name, args = {}, o = {}) => Promise.resolve(recover.gate(name, o)).then((g) => g ?? inner(name, args, o)) }
  const habits = createHabits({ runner, arbiter, getBot: () => body.bot, env: pack.env, trace, isUp: () => body.spawned, hasLiveIntent: () => intents.hasLive() || !!s1?.active() || !!recover.active, decisionLog })
  s1 = createS1({ runner, getBot: () => body.bot, env: pack.env, habits, trace, trails, decisionLog, scorer: habits.scorer,
    playbookDefaults: process.env.WREN_PLAYBOOK_DEFAULTS !== 'off', playbookStateFile: path.join(cfg.runtimeDir, 'playbook.json'), calm: () => { const h = arbiter.holder; return !h || h.owner !== 'reflex' } })

  body.on('bot', (bot) => {
    bot.loadPlugin(pathfinder)
    // no skill and not the pathfinder may break a protected block, except reflexes and the unstuck ladder (survival)
    protectedRegions.guardDig(bot, { exempt: () => arbiter.owner === 'reflex' || det.unstuckActive })
    // B1: player-built blocks (doors, planks, glass ... or any hut with a door) are never broken, even by the ladder; own blocks are tracked
    installBuiltGuard(bot, { file: path.join(cfg.runtimeDir, 'placed-blocks.json'), trace, exemptReflex: () => bot.__suffocating === true })
    bot.__landmarks = pack.env.landmarks // DOOR3: home/bed place records protect their surroundings from digging
    installDoorOpener(bot, { trace })
    bot.on('spawn', () => { try { configurePathfinder(bot, cfg, hooks); if (!bot._waterStop) { bot._waterStop = installWaterPolicy(bot, { trace }); bot.once('end', () => { try { bot._waterStop?.() } catch { /* ignore */ } }) } if (!bot._sprintStop) { bot._sprintStop = installSprintPolicy(bot, { trace }); bot.once('end', () => { try { bot._sprintStop?.() } catch { /* ignore */ } }) } if (!bot._farmGuard) { const stopFg = installFarmGuard(bot); bot.once('end', () => { try { stopFg() } catch { /* ignore */ } }) } } catch (e) { trace.event('pathfinder_config_error', errInfo(e)) } })
    bot.on('death', () => {
      const pos = bot.entity?.position && [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z].map((v) => +v.toFixed(1))
      trace.event('death', { pos })
      hooks.events.emit('death', { pos })
    })
    bot.on('health', () => { if (bot.health < 20) trace.event('health', { hp: bot.health, food: bot.food, tod: bot.time?.timeOfDay }) })
  })
  const airGuard = new AirborneGuard({ getBot: () => body.bot, arbiter, trace }).start() // SURV3: airborne > 2 s = abort the skill; loop stalls traced
  // All running skills are cancelled on every state change.
  body.on('state', (e) => {
    metrics.state(e.to)
    arbiter.revokeAll(`state:${e.to}`).catch((err) => trace.event('revoke_error', errInfo(err)))
  })

  let running = false
  const timers = []

  function writeMetrics() {
    const snap = { ...metrics.snapshot(), state: body.state, runner: runner.state, heat_cells: heatmap.size, habits: habits.stats(), recover: recover.view(), playbook: s1?.playbooks?.view() ?? null, playbook_metrics: s1?.playbooks?.metrics() ?? null, intents: intents.stats, protected: protectedRegions.stats, reflexes: reflex.stats, pos: body.bot?.entity?.position ? [body.bot.entity.position.x, body.bot.entity.position.y, body.bot.entity.position.z].map((v) => +v.toFixed(1)) : null, trace_file: trace.currentFile() }
    trace.event('metrics', snap)
    try {
      const f = path.join(cfg.runtimeDir, 'metrics.json')
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ t: new Date().toISOString(), ...snap }, null, 1))
      fs.renameSync(`${f}.tmp`, f)
    } catch (e) { trace.event('metrics_write_error', errInfo(e)) }
    if (snap.event_loop_lag.p99_ms > 100) trace.event('lag_warn', snap.event_loop_lag)
    return snap
  }

  return {
    cfg, body, arbiter, runner, trace, metrics, heatmap, writeMetrics, reflex, pack, det, habits, intents, recover, hooks, protectedRegions, s1, trails, decisionLog,
    submitIntent: (i) => intents.submitIntent(i),
    start() {
      running = true
      trace.event('app_start', { host: cfg.host, port: cfg.port, username: cfg.username, version: cfg.version, pid: process.pid })
      timers.push(setInterval(writeMetrics, cfg.metricsIntervalMs))
      timers.push(setInterval(() => {
        const p = body.spawned && body.bot?.entity?.position
        if (p) heatmap.visit(p.x, p.z)
      }, 1000))
      timers.push(setInterval(() => heatmap.save(heatFile), 60000))
      timers.push(setInterval(() => { // 1 Hz tick for mind/: drives provider -> habits, 'tick' event
        const snap = { t: Date.now(), state: body.state, pos: body.bot?.entity?.position ?? null, hp: body.bot?.health, food: body.bot?.food, live_intent: intents.hasLive() }
        const d = hooks.drives(snap); if (d && typeof d === 'object') habits.setDrives(d)
        hooks.events.emit('tick', snap)
      }, 1000))
      pack.start(() => body.bot) // breadcrumb sampling
      timers.push(setInterval(() => { const b = body.bot; const e = b?.entity; if (body.spawned && e?.position && b.health > 0) trails.record(e.position, !!e.onGround); else trails.breakLink(); if (body.spawned) rememberAnimals(body.bot, pack.env) }, 1000)) // S1G: walked-trail graph + food-source memory
      body.start()
      habits.start()
      recover.start()
    },
    async stop(reason = 'shutdown') {
      trace.event('app_stop', { reason })
      running = false
      for (const t of timers) clearInterval(t); airGuard.stop()
      await intents.cancel('shutdown').catch(() => {})
      await s1?.cancel('shutdown'); trails.save()
      recover.stop()
      await habits.stop()
      await runner.abort(reason)
      await reflex.stop() // before body.stop(): a reflex run must not hold the body when it goes away
      det.stop()
      pack.stop()
      await body.stop(reason)
      try { heatmap.save(heatFile) } catch { /* ignore */ }
      writeMetrics()
      metrics.stop()
    },
  }
}

// ---- entry point ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg
  try { cfg = loadConfig() } catch (e) { console.error(e.message); process.exit(2) }
  const app = createApp(cfg)
  const pidFile = path.join(cfg.runtimeDir, 'bot.pid')
  fs.writeFileSync(pidFile, String(process.pid))
  let stopping = false
  const shutdown = async (sig) => {
    if (stopping) return
    stopping = true
    const hard = setTimeout(() => { app.trace.event('shutdown_forced', { sig }); process.exit(1) }, 8000)
    hard.unref()
    try { await app.stop(sig) } catch (e) { app.trace.event('shutdown_error', errInfo(e)) }
    try { fs.unlinkSync(pidFile) } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (e) => { app.trace.event('uncaught', errInfo(e)); console.error(e) })
  process.on('unhandledRejection', (e) => { app.trace.event('unhandled_rejection', errInfo(e)) })
  app.start()
}
