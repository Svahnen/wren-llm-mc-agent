import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { makeRig, sleep } from './helpers.js'
import { LagMonitor } from '../src/detect/lag.js'
import { SkillWatchdog } from '../src/detect/watchdog.js'
import { StuckMonitor } from '../src/detect/stuck.js'
import { EscalationLadder, RestartStore } from '../src/escape/ladder.js'
import { Trace } from '../src/trace.js'
import { installDetectors } from '../src/detect/index.js'
import { diagnose } from '../src/escape/world.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }
/** Fake world: flat stone below y=64; `walls` = predicate for extra solid cells. */
function fakeWorld(bot, walls = () => false) {
  bot.blockAt = (v) => (v.y < 64 || walls(v) ? STONE : AIR)
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  bot.inventory = { items: () => [] }
  bot.registry = { blocksByName: {} }
  return bot
}
const pitWalls = (v) => v.y >= 64 && v.y < 68 && !(v.x === 0 && v.z === 0) // 1x1 shaft
function fakeBody(bot) {
  const b = new EventEmitter()
  Object.assign(b, { bot, spawned: true, gen: 1, state: 'spawned', forceDisconnect() { b.disconnected = (b.disconnected ?? 0) + 1 } })
  return b
}
const clock = (t0 = 1e6) => { const c = { t: t0, now: () => c.t, adv: (ms) => { c.t += ms } }; return c }
const quietLag = () => new LagMonitor({ now: Date.now })

function ladderRig({ walls, script, cfg, store } = {}) {
  const bot = fakeWorld(new EventEmitter(), walls)
  const body = fakeBody(bot)
  const trace = new Trace({ keepLast: 500 })
  const calls = []
  const run = async (name, args) => {
    calls.push(name)
    const r = script?.[name]?.(bot, args) ?? { status: 'failed', reason: 'scripted' }
    return { skill: name, ms: 1, ...r }
  }
  const runner = { abort: async () => {}, current: null, skills: new Map() }
  const ladder = new EscalationLadder({ body, runner, run, trace, lag: quietLag(), cfg: { escapeBudgetS: 5, restartMinIntervalS: 1800, ...cfg }, store: store ?? new RestartStore(), onRestart: () => { body.disconnected = (body.disconnected ?? 0) + 1 } })
  return { bot, body, trace, ladder, calls }
}

test('diagnose: open floor is free, 1x1 shaft is trapped', () => {
  const a = fakeWorld(new EventEmitter())
  assert.equal(diagnose(a).trapped, false)
  const b = fakeWorld(new EventEmitter(), pitWalls)
  assert.equal(diagnose(b).trapped, true)
})

test('ladder: chain nudge -> moveAway -> escape, each verified by ground truth; stops at first verified step', async () => {
  const { ladder, calls, trace } = ladderRig({
    walls: pitWalls,
    script: {
      unstuck_nudge: () => ({ status: 'failed', reason: 'no_movement' }),
      unstuck_move_away: () => ({ status: 'failed', reason: 'no_path_away' }),
      escape_pillar_up: (bot) => { bot.entity.position = new Vec3(5.5, 64, 0.5); bot.blockAt = (v) => (v.y < 64 ? STONE : AIR); return { status: 'done' } },
    },
  })
  // give the escape rung something to try: pretend we have blocks via planEscape's inventory
  ladder.body.bot.inventory = { items: () => [{ name: 'cobblestone', count: 8, type: 1 }] }
  ladder.body.bot.registry = { blocksByName: { cobblestone: { boundingBox: 'block', transparent: false } } }
  const r = await ladder.trigger('test')
  assert.equal(r.verified, true)
  assert.deepEqual(calls.slice(0, 2), ['unstuck_nudge', 'unstuck_move_away'])
  assert.ok(calls.includes('escape_pillar_up'))
  const steps = trace.last('unstuck_step')
  assert.deepEqual(steps.map((s) => [s.level, s.verified]), [['nudge', false], ['move_away', false], ['escape', true]])
  assert.equal(ladder.level, 3)
})

test('ladder: a "done" skill that did not change position is NOT verified (no self-reported success)', async () => {
  const { ladder } = ladderRig({ walls: pitWalls, script: { unstuck_nudge: () => ({ status: 'done' }) } })
  const r = await ladder.trigger('test')
  assert.equal(r.verified, false)
})

test('ladder: top reached -> one restart request, then rate limited (min interval), persisted across instances', async () => {
  const file = `${process.env.TMPDIR ?? '/tmp'}/t3-restart-test-${process.pid}.json`
  const mk = () => ladderRig({ walls: pitWalls, store: new RestartStore({ file }), cfg: { backoffBaseS: 0 } })
  const a = mk()
  const r1 = await a.ladder.trigger('x')
  assert.equal(r1.verified, false)
  assert.equal(a.body.disconnected, 1)
  assert.equal(a.trace.last('restart_request').length, 1)
  // same instance, second episode: wraps to escape level, restart suppressed
  a.ladder.cooldownUntil = 0
  await a.ladder.trigger('x')
  assert.equal(a.body.disconnected, 1)
  assert.equal(a.trace.last('restart_suppressed').length, 1)
  // a fresh process (new store from file) still knows about the restart
  const b = mk()
  await b.ladder.trigger('x')
  assert.equal(b.body.disconnected ?? 0, 0)
  assert.equal(b.trace.last('restart_suppressed').length, 1)
  await import('node:fs').then((fs) => fs.unlinkSync(file))
})

test('ladder: max restarts per day, backoff cooldown after a failed top', async () => {
  const c = clock()
  const store = new RestartStore({ now: c.now })
  store.ts = [c.t - 3 * 3600e3, c.t - 2 * 3600e3, c.t - 3600e3, c.t - 2000 * 1000]
  const { ladder, trace, body } = ladderRig({ walls: pitWalls, store, cfg: { restartMinIntervalS: 60, restartMaxPerDay: 4 } })
  await ladder.trigger('x')
  assert.equal(body.disconnected ?? 0, 0)
  assert.equal(trace.last('restart_suppressed')[0].why, 'max_per_day')
  assert.ok(ladder.cooldownUntil > Date.now()) // backoff armed
})

test('ladder: reset on progress; lag interrupts the chain without escalating; state change resets', async () => {
  const { ladder, body } = ladderRig({ walls: pitWalls })
  ladder.level = 3
  ladder.reset('moved')
  assert.equal(ladder.level, 0)
  ladder.lag.noteDiscontinuity('x')
  const r = await ladder.trigger('x')
  assert.ok(r.interrupted)
  assert.equal(ladder.level, 0)
  assert.equal(body.disconnected ?? 0, 0)
})

test('watchdog: stalled skill aborted + stall event; lag shields it; works with no pathfinder at all', async () => {
  const { runner, trace } = makeRig()
  let lagging = false
  const lag = { status: () => ({ lagging, factor: 1, reasons: [] }) }
  const wd = new SkillWatchdog({ runner, lag, trace, tickMs: 25 })
  const stalls = []
  wd.on('stall', (i) => stalls.push(i))
  wd.start()
  runner.register({ name: 'idle', max_s: 5, stall_s: 0.25, progress_fn: () => 1, run: async (ctx) => { await ctx.sleep(3000); return true } })
  // lag: shielded, must survive well past stall_s (runner tickMs is 20 ms, so its own watchdog would have fired)
  lagging = true
  const p = runner.run('idle')
  await sleep(700)
  assert.equal(runner.state, 'running')
  assert.equal(stalls.length, 0)
  lagging = false
  const res = await p
  assert.deepEqual([res.status, res.reason], ['aborted', 'no_progress'])
  wd.stop()
})

test('stuck monitor: physical stall triggers ladder; free-roaming stall does not; teleport and lag freeze do not', () => {
  const bot = fakeWorld(new EventEmitter(), pitWalls)
  const body = fakeBody(bot)
  const c = clock()
  const lag = new LagMonitor({ now: c.now })
  const triggers = []
  const ladder = Object.assign(new EventEmitter(), { busy: false, level: 0, cooldownUntil: 0, reset() {}, trigger: async (r) => { triggers.push(r); return { verified: false } } })
  const sm = new StuckMonitor({ body, runner: { current: { name: 'x' } }, ladder, lag, now: c.now, cfg: {} })
  const step = (n) => { for (let i = 0; i < n; i++) { c.adv(1000); lag.notePacket(c.t); sm.tick() } }
  step(10)
  sm.onStall({ skill: 'x', stalled_ms: 8000, source: 'watchdog' })
  assert.deepEqual(triggers, ['stall_physical'])
  // free roaming: positions spread over 30 blocks
  triggers.length = 0; sm.settleUntil = 0
  for (let i = 0; i < 12; i++) { bot.entity.position = new Vec3(i * 2.5, 64, 0); step(1) }
  sm.onStall({ skill: 'x', stalled_ms: 8000, source: 'watchdog' })
  assert.deepEqual(triggers, [])
  // teleport: no trigger, ladder reset path taken, discontinuity noted
  bot.entity.position = new Vec3(500, 64, 500); step(1)
  assert.equal(sm.stats.teleports, 1)
  // lag: clocks frozen for a long time, global no-progress never fires
  sm.noProgressMs = 0
  lag.noteDiscontinuity('x')
  const before = sm.noProgressMs
  for (let i = 0; i < 3; i++) { c.adv(1000); sm.tick() }
  assert.equal(sm.noProgressMs, before)
  assert.ok(sm.stats.frozen_ms >= 3000)
})

test('stuck monitor: global no-progress fires only after healthy time; lag spike in the middle does not count', () => {
  const bot = fakeWorld(new EventEmitter(), pitWalls)
  const body = fakeBody(bot)
  const c = clock()
  const lag = new LagMonitor({ now: c.now, graceMs: 2000 })
  const triggers = []
  const ladder = Object.assign(new EventEmitter(), { busy: false, level: 0, cooldownUntil: 0, reset() {}, trigger: async (r) => { triggers.push(r); return { verified: false } } })
  const sm = new StuckMonitor({ body, runner: { current: { name: 'x', skill: { stationary: true } } }, ladder, lag, now: c.now, cfg: { globalNoProgressS: 100 } })
  const step = (n) => { for (let i = 0; i < n; i++) { c.adv(1000); lag.notePacket(c.t); sm.tick() } }
  step(60)
  for (let i = 0; i < 90; i++) { c.adv(1000); sm.tick() } // 90 s of packet silence = lag, frozen
  assert.deepEqual(triggers, [])
  step(45)
  assert.deepEqual(triggers, ['global_no_progress'])
})

test('installDetectors: wraps run(), records cycles -> lockouts, holds habits during unstuck mode, restores on stop', async () => {
  const rig = makeRig()
  const body = fakeBody(rig.bot)
  const det = installDetectors(body, rig.arbiter, rig.runner, rig.trace, rig.metrics, { onRestart: () => {} })
  for (const n of ['a', 'b']) rig.runner.register({ name: n, max_s: 2, progress_fn: () => Date.now(), run: async () => true })
  const orig = rig.runner.run
  for (let i = 0; i < 3; i++) { await rig.runner.run('a', { place: 'p' }); await rig.runner.run('b', { place: 'q' }) }
  assert.ok(det.isLocked('a', 'p') && det.isLocked('b', 'q'))
  assert.equal(det.snapshot().repeats.cycle_detections, 1)
  assert.ok(rig.metrics.snapshot().detect)
  det.ladder.active = true
  assert.equal((await rig.runner.run('a')).reason, 'unstuck_active')
  det.ladder.active = false
  assert.equal((await rig.runner.run('a')).status, 'done')
  assert.ok(rig.runner.skills.has('escape_pillar_up') && rig.runner.skills.has('unstuck_nudge'))
  det.stop()
  assert.notEqual(rig.runner.run, orig)
})

test('stuck monitor: confined + trapped (ground truth) triggers even when progress_fn is fooled; not for stationary skills; not under lag', () => {
  const mk = (stationary) => {
    const bot = fakeWorld(new EventEmitter(), pitWalls)
    const c = clock()
    const lag = new LagMonitor({ now: c.now })
    const triggers = []
    const ladder = Object.assign(new EventEmitter(), { busy: false, level: 0, cooldownUntil: 0, reset() {}, trigger: async (r) => { triggers.push(r); return { verified: false } } })
    const sm = new StuckMonitor({ body: fakeBody(bot), runner: { current: { name: 'x', skill: { stationary } } }, ladder, lag, now: c.now, cfg: { globalNoProgressS: 9999 } })
    return { c, lag, triggers, sm, step: (n) => { for (let i = 0; i < n; i++) { c.adv(1000); lag.notePacket(c.t); sm.tick() } } }
  }
  const a = mk(false); a.step(40)
  assert.deepEqual(a.triggers.slice(0, 1), ['confined_trapped'])
  const b = mk(true); b.step(60)
  assert.deepEqual(b.triggers, [])
  const l = mk(false)
  l.lag.notePacket(l.c.t)
  for (let i = 0; i < 60; i++) { l.c.adv(1000); l.sm.tick() } // no packets at all = connection stall = lag
  assert.deepEqual(l.triggers, [])
})
