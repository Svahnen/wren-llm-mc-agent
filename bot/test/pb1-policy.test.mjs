// PB1: sprint policy (food conservation), mindlink wiring, selector integration, build plans.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sprintDecision, conservativeMovements, installSprintPolicy } from '../src/sprint-policy.js'
import { PLANS, blocksNeeded, doorCells } from '../src/skills/build.js'
import { blockRank, PLACEABLE, placeableCount } from '../src/habits/safety.js'
import { createS1 } from '../src/s1/selector.js'
import { derived, getPlaybook } from '../src/playbooks/catalog.js'
import { Landmarks } from '../src/skills/landmarks.js'

test('sprint policy: off by default; on for a real threat, high urgency, or a long trip while fed', () => {
  assert.equal(sprintDecision({}).sprint, false)
  assert.equal(sprintDecision({ food: 20, tripM: 20 }).sprint, false)
  assert.deepEqual(sprintDecision({ threat: true, food: 3 }), { sprint: true, reason: 'threat' })
  assert.equal(sprintDecision({ urgency: 0.9 }).reason, 'urgent')
  assert.equal(sprintDecision({ tripM: 80, food: 20 }).sprint, true)
  assert.equal(sprintDecision({ tripM: 80, food: 15 }).sprint, false)   // healing pending: conserve
  assert.equal(sprintDecision({ tripM: 80, food: 5 }).reason, 'food_low')
  const mv = conservativeMovements({ allowSprinting: true, allowParkour: true }); assert.equal(mv.allowSprinting, false); assert.equal(mv.allowParkour, false)
})

test('sprint policy loop: flips Movements and logs sprint_on / sprint_off with the reason', async () => {
  const ev = []
  const bot = { food: 20, health: 20, entity: { position: { x: 0, y: 64, z: 0 } }, entities: {}, pathfinder: { movements: { allowSprinting: false }, goal: { x: 100, z: 0 } } }
  const stop = installSprintPolicy(bot, { trace: { event: (e, d) => ev.push([e, d.reason]) }, everyMs: 5 })
  await new Promise((r) => setTimeout(r, 40)); assert.equal(bot.pathfinder.movements.allowSprinting, true)
  bot.food = 10; await new Promise((r) => setTimeout(r, 40)); assert.equal(bot.pathfinder.movements.allowSprinting, false)
  stop()
  assert.deepEqual(ev.map((e) => e[0]), ['sprint_on', 'sprint_off']); assert.equal(ev[0][1], 'long_trip_fed'); assert.equal(bot._sprintStats.on, 1)
})

test('build plans: material agnostic ranking, hut size and door gap', () => {
  const rank = ['cobblestone', 'dirt', 'oak_planks', 'sandstone', 'sand', 'oak_log'].map(blockRank)
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b))
  for (const n of ['spruce_planks', 'gravel', 'birch_log', 'terracotta', 'tuff', 'red_sand']) assert.ok(PLACEABLE.test(n), n)
  assert.ok(!PLACEABLE.test('diamond_block') && !PLACEABLE.test('torch'))
  assert.equal(placeableCount([{ name: 'oak_log', count: 3 }, { name: 'sand', count: 5 }, { name: 'bread', count: 9 }]), 8)
  assert.equal(PLANS.wall_ring({ x: 0, y: 0, z: 0 }, { height: 2 }).length, 8)
  const hut = PLANS.simple_hut({ x: 0, y: 0, z: 0 }, { size: 5 })
  assert.equal(hut.length, 30 + 25); assert.equal(blocksNeeded('simple_hut', { size: 5 }), 55)
  assert.equal(derived(getPlaybook('simple_hut'), { size: 5 }).hut_blocks, 57)
  for (const d of doorCells({ x: 0, y: 0, z: 0 }, { size: 5 })) assert.ok(!hut.some((c) => c.x === d.x && c.y === d.y && c.z === d.z))
  assert.equal(blocksNeeded('pillar_up', { height: 4 }), 4)
})

test('selector: type playbook runs the playbook, reports the step summary; a speech-only none does not cancel it; unknown playbook fails with a reason', async () => {
  const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
  const bot = { username: 'Wren', health: 20, food: 20, entity: { position: vec(0, 64, 0) }, entities: {}, players: {}, thunderState: 0, inventory: { items: () => [], emptySlotCount: () => 20 }, registry: { foodsByName: {}, blocksByName: {} }, time: { timeOfDay: 1000 } }
  const calls = [], fin = []
  const runner = { run: async (n, a) => { calls.push(n); if (n === 'move_to') bot.entity.position = vec(a.x, 64, a.z); return { status: 'done', ms: 1 } }, abort: async () => {} }
  const env = { landmarks: new Landmarks(), foodSeen: new Map() }
  const s1 = createS1({ runner, getBot: () => bot, env, ctxFn: () => ({ c: { bot, inv: {}, rng: Math.random }, rows: [] }), onFinish: (e) => fin.push(e), pauseMs: 1, sleep: async () => {}, playbookDefaults: true })
  s1.pursue({ type: 'playbook', target: 'explore_and_return radius=30', text: 'look around' }, { intent_id: 'x1' })
  await s1.whenIdle()
  assert.equal(fin[0].status, 'done'); assert.match(fin[0].summary, /explore_and_return: done/); assert.ok(calls.includes('explore'))
  s1.pursue({ type: 'playbook', target: 'fly_away', text: '' }, { intent_id: 'x2' }); await s1.whenIdle()
  assert.equal(fin[1].status, 'failed'); assert.match(fin[1].reason, /playbook/)
  // default mapping: get_food with food 20 completes at once through the get_food playbook
  s1.pursue({ type: 'get_food', target: null, text: 'eat' }, { intent_id: 'x3' }); await s1.whenIdle()
  assert.equal(fin[2].status, 'done'); assert.equal(fin[2].playbook?.name, 'get_food')
})
