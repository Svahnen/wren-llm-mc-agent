import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { Vec3 } from 'vec3'
import { GlobalDisplacementWatchdog, geometryGrid, digDirection, confinedShared, resetConfinedShared, confinedBus } from '../src/detect/confined.js'
import { StuckMonitor } from '../src/detect/stuck.js'
import { createHabits } from '../src/habits/index.js'
import { Landmarks, Trail } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'
import { confinedNote } from '../src/mindlink/digest.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }
const TELEPORT = 1792570114306


test('W1: idle share alone declares in daylight but not at night; sleeping and a night shelter are exempt', () => {
  const mk = () => { const w = new GlobalDisplacementWatchdog(); for (let t = 0; t <= 160000; t += 1000) w.sample(t, { x: 0, y: 64, z: 0 }); for (let t = 5000; t < 160000; t += 8000) w.noteResult(t, t % 16000 ? 'gesture' : 'idle_activity', 'done'); return w }
  assert.equal(mk().evaluate(160000, { night: false })?.why, 'idle_share')
  assert.equal(mk().evaluate(160000, { night: true }), null)
  assert.equal(mk().evaluate(160000, { sleeping: true }), null)
  const w = mk(); for (let t = 5000; t < 160000; t += 20000) w.noteResult(t, 'approach', 'failed', 'not_reached')
  assert.equal(w.evaluate(160000, { night: true, deliberateShelter: true }), null)
  assert.equal(w.evaluate(160000, { night: true })?.why, 'move_failures')
})

test('W1: moving bot or too-short history is never confined; 2 failures are not enough', () => {
  const w = new GlobalDisplacementWatchdog()
  for (let t = 0; t <= 160000; t += 1000) w.sample(t, { x: t / 1000 * 0.1, y: 64, z: 0 }) // 16 blocks in 160 s
  for (let t = 5000; t < 160000; t += 10000) w.noteResult(t, 'approach', 'failed', 'not_reached')
  assert.equal(w.evaluate(160000), null)
  const w2 = new GlobalDisplacementWatchdog(); for (let t = 0; t <= 60000; t += 1000) w2.sample(t, { x: 0, y: 64, z: 0 }); for (let i = 0; i < 5; i++) w2.noteResult(1000 * i, 'flee', 'failed', 'not_far_enough')
  assert.equal(w2.evaluate(60000), null)
  const w3 = new GlobalDisplacementWatchdog(); for (let t = 0; t <= 160000; t += 1000) w3.sample(t, { x: 0, y: 64, z: 0 }); w3.noteResult(1000, 'hunt', 'failed', 'no_path'); w3.noteResult(2000, 'hunt', 'failed', 'no_path')
  assert.equal(w3.evaluate(160000), null)
})

test('W1: rescue after 3 failed episodes, rate limited, verified episode resets', () => {
  resetConfinedShared()
  const w = new GlobalDisplacementWatchdog()
  assert.equal(w.noteEpisode(1000, false), null); assert.equal(w.noteEpisode(2000, false), null)
  assert.equal(w.noteEpisode(3000, false), 'rescue')
  assert.equal(w.noteEpisode(4000, false), null, 'rate limited')
  assert.equal(w.noteEpisode(3000 + 301000, false), 'rescue')
  w.noteEpisode(400000, true); assert.equal(w.failedEpisodes, 0)
})

// 1x1 shaft, walls 4 high everywhere except: east wall is 1 block thick (x=1), beyond it open air; west wall 3 thick
function pit(bot) {
  bot.blockAt = (v) => {
    if (v.y < 64) return STONE
    if (v.x === 0 && v.z === 0) return AIR
    if (v.y >= 68) return AIR
    if (v.x >= 2 && v.x <= 6 && v.z === 0) return AIR // corridor east of a 1-thick wall
    return STONE
  }
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
}
test('W1: geometry grid records the shape of the trap; dig direction picks the thinnest wall', () => {
  const bot = new EventEmitter(); pit(bot)
  const g = geometryGrid(bot)
  assert.deepEqual(g.origin, [0, 64, 0])
  assert.equal(g.layers.length, 4)
  assert.equal(g.layers[0], 'SSS/SSS/SSS') // floor
  assert.equal(g.layers[1], 'SSS/SAS/SSS') // 1x1 shaft
  assert.equal(g.layers[3], 'SSS/SAS/SSS')
  assert.deepEqual(digDirection(bot), { dir: 'east', thickness: 1 })
})

function monitor({ trigger } = {}) {
  const bot = new EventEmitter(); pit(bot); bot.time = { timeOfDay: 6000 }
  const trace = { evs: [], event(t, d) { this.evs.push({ t, ...d }) } }
  const ladder = Object.assign(new EventEmitter(), { busy: false, level: 0, cooldownUntil: 0, reset() {}, trigger: trigger ?? (async () => ({ verified: false })) })
  const body = Object.assign(new EventEmitter(), { bot, spawned: true })
  const lag = { status: () => ({ lagging: false, factor: 1 }), noteDiscontinuity() {} }
  const m = new StuckMonitor({ body, runner: { current: null }, ladder, lag, trace, now: () => 0 })
  return { m, bot, trace, ladder }
}
const fill = (m, secs, p = { x: 0.5, y: 64, z: 0.5 }) => { for (let i = 0; i < secs; i++) { m.healthy += 1000; m.confined.sample(m.healthy, p) } }

test('W1: StuckMonitor - idle/gesture results never count as progress, a real skill does', () => {
  const { m } = monitor()
  let n = 0; m.progress = () => { n++ }
  for (const sk of ['idle_activity', 'gesture', 'look_at']) m.noteSkillResult({ status: 'done' }, sk)
  assert.equal(n, 0)
  m.noteSkillResult({ status: 'done' }, 'collect'); assert.equal(n, 1)
})

test('W1: StuckMonitor - confined verdict runs the ladder from the escape rung, logs geometry, 3 failed episodes -> rescue_requested', async () => {
  resetConfinedShared()
  let triggers = 0
  const { m, trace, ladder } = monitor({ trigger: async () => { triggers++; return { verified: false } } })
  const rescues = []; confinedBus.on('rescue_requested', (e) => rescues.push(e)); const helps = []; ladder.on('help_needed', (e) => helps.push(e))
  fill(m, 160)
  for (const sk of ['approach', 'return_home', 'flee', 'hunt']) m.noteSkillResult({ status: 'failed', reason: 'not_reached' }, sk)
  for (let k = 0; k < 3; k++) {
    m.confined.lastDeclare = -Infinity; m.settleUntil = 0
    const v = m.checkConfined()
    assert.ok(v, 'episode ' + k)
    await new Promise((r) => setImmediate(r))
  }
  assert.equal(triggers, 3)
  assert.ok(ladder.level >= 2)
  const ev = trace.evs.find((e) => e.t === 'confined_global')
  assert.deepEqual(ev.geometry.layers[1], 'SSS/SAS/SSS')
  assert.equal(ev.dig_dir.dir, 'east')
  const r = trace.evs.find((e) => e.t === 'rescue_requested')
  assert.ok(r && /dig out in direction east/.test(r.text), JSON.stringify(r))
  assert.equal(rescues.length, 1); assert.equal(helps[0].why, 'rescue_requested')
  const note = confinedNote(monitor().bot)
  assert.ok(note && /confined and cannot move; try dig out in direction east/.test(note.text), note?.text)
  resetConfinedShared(); confinedBus.removeAllListeners('rescue_requested')
})

test('W1: StuckMonitor - hist still moving or sleeping is not declared', () => {
  resetConfinedShared()
  const { m, bot } = monitor(); fill(m, 160)
  for (const sk of ['approach', 'flee', 'hunt']) m.noteSkillResult({ status: 'failed', reason: 'not_reached' }, sk)
  bot.isSleeping = true
  assert.equal(m.checkConfined(), null)
  bot.isSleeping = false; bot.time.timeOfDay = 14000; m.runner.current = { skill: { name: 'shelter', stationary: true } }
  assert.equal(m.checkConfined(), null)
})

// ---- habit layer: idle streak guard
const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) }, offset(a, b, c) { return vec(x + a, y + b, z + c) }, clone() { return vec(x, y, z) } })
function habitRig(t = 6000) {
  const bot = {
    username: 'WrenT2', food: 0, health: 20, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, players: {}, time: { timeOfDay: t, age: 100000 }, thunderState: 0,
    registry: { foodsByName: {}, blocksByName: { water: { id: 1 } } }, inventory: { items: () => [], emptySlotCount: () => 30 },
    blockAt: (p) => ({ name: Math.floor(p.y) < 64 ? 'dirt' : 'air', position: vec(p.x, p.y, p.z), boundingBox: Math.floor(p.y) < 64 ? 'block' : 'empty', light: 15, skyLight: 15 }), findBlock: () => null,
  }
  const rng = makeRng(3)
  const env = { rng, heatmap: new Heatmap({ rng }), landmarks: new Landmarks(), trail: new Trail(), costAt: null }
  env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home')
  const calls = []
  const runner = { run: async (skill, args) => { calls.push(skill); return { status: 'done', ms: 5 } } }
  const catalog = [{ name: 'idle', category: 'leisure', noLock: true, applies: () => true, utility: () => 1, plan: () => ({ skill: 'idle_activity', args: { kind: 'sit' } }) }]
  const h = createHabits({ runner, arbiter: { busy: false }, getBot: () => bot, env, rng, noise: 0.05, pauseMs: { done: 1, fail: 1 }, catalog })
  return { h, calls }
}
test('W1: habits never idle more than 3 times in a row by day when hunger/curiosity drive; they explore and ask for a confined check', async () => {
  resetConfinedShared()
  const { h, calls } = habitRig()
  h.setDrives({ hunger: 0, curiosity: 0 })
  for (let i = 0; i < 12; i++) await h.step()
  let run = 0, maxRun = 0
  for (const c of calls) { run = c === 'idle_activity' ? run + 1 : 0; maxRun = Math.max(maxRun, run) }
  assert.ok(maxRun <= 3, 'max idle run ' + maxRun + ' ' + calls.join(','))
  assert.ok(calls.includes('explore'), calls.join(','))
  assert.equal(confinedShared.checkRequested, true)
  // night or satisfied drives: the guard stays out of the way
  const n = habitRig(14000); n.h.setDrives({ hunger: 0, curiosity: 0 }); for (let i = 0; i < 8; i++) await n.h.step()
  assert.ok(!n.calls.includes('explore'))
  const s = habitRig(); s.h.setDrives({ hunger: 1, curiosity: 1 }); for (let i = 0; i < 8; i++) await s.h.step()
  assert.ok(!s.calls.includes('explore'))
  resetConfinedShared()
})
