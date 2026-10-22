// S1G: with no S2 intent, the habit layer still keeps her alive and curious; every such decision is logged as kind 'no_intent' (and 'steered' under a legacy S2 goal).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHabits } from '../src/habits/index.js'
import { Landmarks, Trail } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'
import { goalFeature } from '../src/habits/steer.js'

const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) }, offset(a, b, c) { return vec(x + a, y + b, z + c) }, clone() { return vec(x, y, z) } })
// world: Map "x,y,z" -> block name; ground = solid below y=63 (feet at 64) unless overridden
function mockBot({ food = 20, hp = 20, inv = [], t = 6000, entities = [], world = new Map(), free = 30, thunder = 0 } = {}) {
  const foods = { bread: { foodPoints: 5, saturation: 6 }, beef: { foodPoints: 3, saturation: 2 } }
  const ents = {}
  entities.forEach((e, i) => { ents[i + 10] = { id: i + 10, isValid: true, position: vec(e.x, e.y ?? 64, e.z), ...e } })
  const blockAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const n = world.has(k) ? world.get(k) : (Math.floor(p.y) < 64 ? 'dirt' : 'air')
    return { name: n, position: vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block', light: 0, skyLight: 15 }
  }
  const bot = {
    username: 'WrenT2', food, health: hp, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: ents, players: {},
    time: { timeOfDay: t, age: 100000 }, thunderState: thunder,
    registry: { foodsByName: foods, blocksByName: { water: { id: 1 } } },
    inventory: { items: () => inv, emptySlotCount: () => free },
    blockAt, findBlock: () => null, equip: async () => {},
    placeBlock: async (ref, face) => { const q = ref.position; const k = `${q.x + face.x},${q.y + face.y},${q.z + face.z}`; world.set(k, 'dirt'); inv[0].count-- },
  }
  return bot
}
function rig(botOpts, extra = {}) {
  const bot = mockBot(botOpts)
  const rng = makeRng(7)
  const env = { rng, heatmap: new Heatmap({ rng }), landmarks: new Landmarks(), trail: new Trail(), costAt: null }
  if (!extra.noHome) env.landmarks.set('home', { x: extra.homeX ?? 0, y: 64, z: 0 }, 'home')
  const calls = []
  const runner = { run: async (skill, args) => { calls.push({ skill, args }); return { status: extra.status ?? 'done', reason: extra.reason, ms: 5 } } }
  const h = createHabits({ runner, arbiter: { busy: false }, getBot: () => bot, env, rng, noise: 0.05, pauseMs: { done: 1, fail: 1 }, ...extra.opts })
  return { bot, env, h, calls }
}

test('no S2 intent: habit decision is logged as no_intent with candidates, chosen and outcome; goal type stays none', async () => {
  const logs = []
  const r = rig({ food: 20 }, { opts: { decisionLog: { write: (x) => logs.push(x) } } })
  await r.h.step()
  assert.equal(logs.length, 1); const l = logs[0]
  assert.equal(l.kind, 'no_intent'); assert.equal(l.goal, null); assert.ok(l.candidates.length >= 1 && typeof l.candidates[0].score === 'number')
  assert.equal(l.chosen.source, 'habit'); assert.equal(l.outcome.status, 'done'); assert.equal(typeof l.state.hp, 'number')
  assert.deepEqual(goalFeature(null, 'explore'), { goal: null, goal_type: 'none' })
})
test('steered by a legacy S2 goal: logged as steered with the goal hash', async () => {
  const logs = []
  const r = rig({ food: 20 }, { opts: { decisionLog: { write: (x) => logs.push(x) } } })
  r.h.setSteer(() => ({ goalActive: true, goalId: 'G1', goalText: 'see the hills', skill: 'explore', args: {}, status: 'done', mods: { urgency: 0.5 }, repeats: 0, markContinued() {} }))
  await r.h.step()
  assert.equal(logs[0].kind, 'steered'); assert.equal(logs[0].goal.type, 'legacy'); assert.match(logs[0].goal.hash, /^[0-9a-f]+$/)
})
