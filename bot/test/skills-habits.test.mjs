import test from 'node:test'
import assert from 'node:assert/strict'
import { createHabits, shannon } from '../src/habits/index.js'
import { Landmarks, Trail } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'

const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) }, offset(a, b, c) { return vec(x + a, y + b, z + c) } })
function mockBot({ food = 20, hp = 20, inv = [], night = false, light = 15, entities = [], free = 30 } = {}) {
  const foods = { bread: { foodPoints: 5, saturation: 6 }, beef: { foodPoints: 3, saturation: 2 }, cooked_beef: { foodPoints: 8, saturation: 12 } }
  const pos = vec(0, 64, 0)
  const ents = {}
  entities.forEach((e, i) => { ents[i + 10] = { id: i + 10, position: vec(e.x, 64, e.z), ...e } })
  return {
    username: 'WrenT4', food, health: hp, entity: { position: pos, onGround: true }, entities: ents, players: { WrenT4: {}, ...(entities.some((e) => e.type === 'player') ? { Alex: {} } : {}) },
    time: { timeOfDay: night ? 14000 : 6000, age: 100000 }, thunderState: 0,
    registry: { foodsByName: foods, blocksByName: { water: { id: 1 } } },
    inventory: { items: () => inv, emptySlotCount: () => free },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', light, skyLight: 0 }),
    findBlock: () => null,
  }
}
function rig(botOpts, extra = {}) {
  const bot = mockBot(botOpts)
  const rng = makeRng(7)
  const env = { rng, heatmap: new Heatmap({ rng }), landmarks: new Landmarks(), trail: new Trail(), costAt: null }
  if (!extra.noHome) env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home')
  const calls = []
  const runner = { run: async (skill, args) => { calls.push({ skill, args }); return { status: extra.status ?? 'done', reason: extra.reason, ms: 5 } } }
  const h = createHabits({ runner, arbiter: { busy: false }, getBot: () => bot, env, rng, noise: 0.05, pauseMs: { done: 1, fail: 1 }, ...extra.opts })
  return { bot, env, h, calls }
}
const it = (name, count) => ({ name, count })
const top = (r) => r.h.rank().rows[0].name

test('no home -> set_home first', () => { assert.equal(top(rig({}, { noHome: true })), 'set_home') })
test('hungry with food -> eat; hungry without food but animal near -> hunt', () => {
  assert.equal(top(rig({ food: 6, inv: [it('bread', 3)] })), 'eat')
  assert.equal(top(rig({ food: 6, entities: [{ name: 'cow', x: 5, z: 5 }] })), 'hunt')
})
test('night with bed in inventory -> sleep; day -> never sleep', () => {
  assert.equal(top(rig({ night: true, inv: [it('white_bed', 1)] })), 'sleep')
  assert.ok(!rig({ night: false, inv: [it('white_bed', 1)] }).h.rank().rows.some((r) => r.name === 'sleep'))
})
test('dark with torches -> place_torch; bright -> not offered', () => {
  assert.equal(top(rig({ light: 1, inv: [it('torch', 4)] })), 'place_torch')
  assert.ok(!rig({ light: 12, inv: [it('torch', 4)] }).h.rank().rows.some((r) => r.name === 'place_torch'))
})
test('inventory nearly full with junk -> tidy (drop_junk, or chest when known)', () => {
  const r = rig({ free: 2, inv: [it('gravel', 64)] })
  assert.equal(top(r), 'tidy')
  const p = r.h.rank().rows[0].habit.plan(r.h.rank().c)
  assert.equal(p.skill, 'drop_junk')
  r.env.landmarks.set('chest_1', { x: 3, y: 64, z: 3 }, 'chest')
  assert.equal(r.h.rank().rows[0].habit.plan(r.h.rank().c).skill, 'store_in_chest')
})
test('collecting habits need free slots', () => {
  const names = rig({ free: 0, inv: [it('oak_log', 1)] }).h.rank().rows.map((r) => r.name)
  assert.ok(!names.includes('gather_wood') && !names.includes('gather_stone'))
})
test('mind drive override changes the choice (curiosity low -> explore)', () => {
  const r = rig({})
  r.h.setDrives({ curiosity: 0.0 })
  assert.equal(top(r), 'explore')
  const r2 = rig({}, {}); r2.h.setDrives({ curiosity: 1.0, social: 1.0 })
  assert.notEqual(top(r2), 'explore')
})
test('failure lockout per (habit, place) with exponential cool-down; habit chain never freezes', async () => {
  let t = 0
  const r = rig({ food: 20 }, { status: 'failed', reason: 'NoPath', opts: { now: () => t } })
  const seen = []
  for (let i = 0; i < 12; i++) { const rows = r.h.rank().rows; assert.ok(rows.length > 0, 'something is always applicable'); await r.h.step(); seen.push(r.calls.at(-1).skill); t += 1000 }
  assert.ok(new Set(seen).size >= 3, `diverse under constant failure: ${seen}`)
  const l = [...r.h.lock.values()]
  assert.ok(l.some((x) => x.fails >= 1))
})
test('respects live intent and busy arbiter', async () => {
  const r = rig({}, { opts: { hasLiveIntent: () => true } })
  assert.equal(await r.h.step(), 'skip'); assert.equal(r.calls.length, 0)
})
test('habit-only simulation is diverse (entropy) and deterministic per seed', async () => {
  const run = async () => {
    let t = 0
    const r = rig({ food: 15, inv: [it('bread', 2), it('oak_log', 3)] }, { opts: { now: () => t } })
    for (let i = 0; i < 80; i++) { await r.h.step(); if (/explore|wander/.test(r.calls.at(-1)?.skill)) r.h.needs.noteNewCell(); t += 20000 }
    return r.h.stats()
  }
  const a = await run(), b = await run()
  assert.deepEqual(a.counts, b.counts)
  assert.ok(a.entropy_bits > 1.5, `entropy ${a.entropy_bits}`)
  console.log(JSON.stringify(a.counts)); assert.ok(Math.max(...Object.values(a.counts)) / a.total < 0.5, 'no habit above 50 %')
})
test('shannon', () => { assert.equal(shannon({ a: 1, b: 1 }), 1); assert.equal(shannon({ a: 5 }), 0) })

test('resource-not-around failures lock the habit globally; rest restores energy', async () => {
  let t = 0
  const r = rig({ food: 20, inv: [it('oak_log', 3)] }, { status: 'failed', reason: 'no_target_found', opts: { now: () => t } })
  const first = r.h.rank().rows.find((x) => x.name === 'gather_stone')
  assert.ok(first)
  r.h.needs.noteSlept(r.bot)
  for (let i = 0; i < 30 && r.h.rank().rows.some((x) => x.name === 'gather_stone'); i++) { await r.h.step(); t += 1000 }
  assert.ok(!r.h.rank().rows.some((x) => x.name === 'gather_stone'), 'locked everywhere after a not-found failure')
  const n = r.h.needs
  n.lastSleepAge = r.bot.time.age - 20000
  const before = n.read(r.bot).levels.energy
  n.noteRested(); n.noteRested()
  assert.ok(n.read(r.bot).levels.energy > before)
})
