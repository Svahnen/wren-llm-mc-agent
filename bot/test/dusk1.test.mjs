// DUSK1: pufferfish refusal, login hp sync is not damage, early head-home cutoff, analysis script causes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { foodForbidden } from '../src/foodguard.js'
import { edibles, makeEat } from '../src/skills/survival.js'
import { chooseFood } from '../src/reflex/reflexes.js'
import { createHurtTracker } from '../src/mindlink/hurtby.js'
import { returnReason, shouldLeaveForDusk, secsToDusk, DUSK_START } from '../src/habits/safety.js'
import { causeOf, recentEat, analyze, bucketOf } from '../../scripts/hurt-analysis.mjs'
import { RISKY_FOOD, POISON_ITEMS } from '../../brain/contract.js'

const foods = { pufferfish: { foodPoints: 1, saturation: 0.2 }, cooked_beef: { foodPoints: 8, saturation: 12.8 }, spider_eye: { foodPoints: 2, saturation: 3.2 }, rotten_flesh: { foodPoints: 4, saturation: 0.8 } }
const mkBot = (inv, { food = 6, health = 12 } = {}) => ({ food, health, entity: {}, registry: { foodsByName: foods }, inventory: { items: () => inv.map(([name, count]) => ({ name, count })) } })

test('foodForbidden: pufferfish always; spider eye / potato only when hurt', () => {
  assert.equal(foodForbidden('pufferfish', 20), true)
  assert.equal(foodForbidden('spider_eye', 6), true)
  assert.equal(foodForbidden('spider_eye', 15), false)
  assert.equal(foodForbidden('rotten_flesh', 2), false)
  assert.equal(foodForbidden('cooked_beef', 2), false)
})
test('eat skill: pufferfish refused even when named and starving; chooseFood never picks it', () => {
  const b = mkBot([['pufferfish', 2]], { food: 2, health: 10 })
  assert.deepEqual(edibles(b, { allowBad: true, also: 'pufferfish' }), [])
  const pre = makeEat().precondition({ bot: b, args: { item: 'pufferfish' } })
  assert.deepEqual(pre, { ok: false, reason: 'poison_food' })
  assert.equal(chooseFood(b, { allowBad: true }), null)
  const b2 = mkBot([['pufferfish', 1], ['rotten_flesh', 1]], { food: 2, health: 10 })
  assert.equal(chooseFood(b2, { allowBad: true }).name, 'rotten_flesh')
})
test('brain: pufferfish is not offered as risky food', () => {
  assert.equal(RISKY_FOOD.has('pufferfish'), false); assert.equal(POISON_ITEMS.has('pufferfish'), true)
})

test('hurt tracker: the first health packet after login (no health yet) is a sync, not a fall', () => {
  const b = new EventEmitter(); b.entity = { position: { x: 0, y: 64, z: 0 }, onGround: false }; b.players = {}; b.entities = {}; b.health = undefined
  const tr = createHurtTracker(); const got = []; tr.attach(b, (h) => got.push(h))
  b.health = 3.1; b.emit('health')
  assert.equal(got.length, 0)
  b.health = 0.1; b.emit('health')       // real damage afterwards still counts
  assert.equal(got.length, 1); assert.equal(got[0].amount, 3)
})

test('head home before dusk: leave when time-to-dusk < travel time + margin', () => {
  const far = { hasHome: true, homeDist: 90 }
  // 90 blocks / 3 bps = 30 s + 75 s margin = 105 s = 2100 ticks before 11200
  assert.equal(shouldLeaveForDusk({ ...far, ticks: DUSK_START - 2200 }), false)
  assert.equal(shouldLeaveForDusk({ ...far, ticks: DUSK_START - 2000 }), true)
  assert.equal(shouldLeaveForDusk({ hasHome: true, homeDist: 10, ticks: DUSK_START - 100 }), false)   // already home
  assert.equal(shouldLeaveForDusk({ ...far, ticks: DUSK_START + 10 }), false)                         // dusk/night: other habits
  assert.equal(shouldLeaveForDusk({ hasHome: false, homeDist: 90, ticks: 10000 }), false)
  assert.equal(shouldLeaveForDusk({ ...far, ticks: undefined }), false)
  assert.equal(secsToDusk(DUSK_START - 200), 10)
  assert.equal(returnReason({ ...far, ticks: 10000, bot: { health: 20 }, inv: { free: 20 } }, { sinceReturnMs: 60000 }), 'before_dusk')
  assert.equal(returnReason({ ...far, ticks: 10000, bot: { health: 20 }, inv: { free: 20 } }, { sinceReturnMs: 1000 }), null)   // 30 s anti-loop
  assert.equal(returnReason({ ...far, ticks: 2000, bot: { health: 20 }, inv: { free: 20 } }), null)                            // morning, plenty of time
})

test('hurt-analysis: causes, poison after eating, deaths, 30 s window', () => {
  assert.equal(causeOf({ hurt: { kind: 'mob', who: 'zombie' } }), 'mob:zombie')
  assert.equal(causeOf({ hurt: { kind: 'env', who: 'a fall' } }), 'env:fall')
  assert.equal(causeOf({ hurt: { kind: 'env', who: 'the environment' }, eat: 'pufferfish' }), 'env:poison(pufferfish)')
  assert.equal(causeOf({ hurt: { kind: 'env', who: 'the environment' }, food: 0 }), 'env:starvation')
  assert.equal(causeOf({ hurt: { kind: 'env', who: 'the environment' }, reflexes: new Set(['drowning']) }), 'env:drown')
  assert.equal(causeOf({ hurt: { kind: 'env', who: 'the environment' }, reflexes: new Set(['lava_fire']) }), 'env:fire')
  assert.equal(bucketOf(5000), 'day'); assert.equal(bucketOf(11500), 'dusk'); assert.equal(bucketOf(15000), 'night'); assert.equal(bucketOf(null), 'unknown')
  const T0 = 1_800_000_000_000
  const ev = [
    { ts: T0, seq: 1, type: 'health', hp: 12, food: 10, tod: 5000 },
    { ts: T0 + 1000, seq: 2, type: 'intent', skill: 'eat', args: { item: 'pufferfish' } },
    { ts: T0 + 1000, seq: 3, type: 'skill_start', skill: 'eat', owner: 's2', intent_id: 'i1' },
    { ts: T0 + 3000, seq: 4, type: 'hurt_by', who: 'the environment', kind: 'env', amount: 1, pos: [100, 66, 100], tod: 5000 },
    { ts: T0 + 3000, seq: 5, type: 'health', hp: 3, food: 10, tod: 5000 },
    { ts: T0 + 20000, seq: 6, type: 'death', pos: [100, 66, 100] },
  ]
  assert.equal(recentEat(ev, T0 + 3000), 'pufferfish')
  const r = analyze(ev, { hours: 1, home: [100, 100], places: [[100, 100]] })
  assert.equal(r.hurts.length, 1); assert.equal(r.hurts[0].cause, 'env:poison(pufferfish)'); assert.equal(r.hurts[0].tod, 'day'); assert.equal(r.hurts[0].home, 0)
  assert.equal(r.episodes.length, 1); assert.equal(r.episodes[0].hp, 3); assert.equal(r.episodes[0].cause, 'env:poison(pufferfish)')
  assert.ok(r.episodes[0].before.some((b) => b.type === 'hurt_by'))
  assert.equal(r.deaths.length, 1)
})
