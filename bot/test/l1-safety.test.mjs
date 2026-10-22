import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { IntentManager } from '../src/integration/intents.js'
import { hazardNear, isUndergroundTarget, sampleTargets, pathNearHazard } from '../src/skills/wander.js'
import { zoneStepCost } from '../src/integration/zones.js'
import { createHooks } from '../src/integration/hooks.js'
import { buildConstraints, zoneDist } from '../../mind/lessons-to-constraints.js'
import { makeRng } from '../src/util.js'
import { Heatmap } from '../src/heatmap.js'

const world = (f) => ({ blockAt: (v) => { const n = f(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)); return { name: n, position: v, boundingBox: ['air', 'lava', 'water', 'fire'].includes(n) ? 'empty' : 'block', transparent: n === 'air' } }, entity: { position: new Vec3(0, 64, 0) } })

test('L1 intent retry: busy behind a normal holder retries 3 times max with 1 s / 2 s backoff', async () => {
  const calls = []
  const arbiter = Object.assign(new EventEmitter(), { owner: 'reflex', holder: { owner: 'reflex', label: 'eat' } })
  const runner = { run: async () => { calls.push(Date.now()); return { status: 'rejected', reason: 'busy' } }, abort: async () => {} }
  const im = new IntentManager({ runner, arbiter, busyWaitMs: 6000 })
  const done = new Promise((r) => im.on('status', (e) => { if (e.status === 'blocked') r(e) }))
  im.submitIntent({ intent_id: 'a', goal: 'explore', args: {}, ttl_s: 60 })
  await done
  assert.equal(calls.length, 3)
  assert.ok(calls[1] - calls[0] >= 950 && calls[2] - calls[1] >= 1950, calls.map((c) => c - calls[0]).join(','))
})

test('L1 intent retry: no retry at all while a lasting hazard reflex (lava_fire) holds the body', async () => {
  let n = 0
  const arbiter = Object.assign(new EventEmitter(), { owner: 'reflex', holder: { owner: 'reflex', label: 'lava_fire' } })
  const runner = { run: async () => { n++; return { status: 'rejected', reason: 'busy' } }, abort: async () => {} }
  const im = new IntentManager({ runner, arbiter })
  const done = new Promise((r) => im.on('status', (e) => { if (e.status === 'blocked') r(e) }))
  im.submitIntent({ intent_id: 'b', goal: 'explore', args: {}, ttl_s: 60 })
  await done
  assert.equal(n, 1)
})

test('L1 hazardNear / underground target / path hazard', () => {
  const w = world((x, y, z) => (y < 64 ? (x === 5 && z === 0 && y === 63 ? 'lava' : 'stone') : 'air'))
  assert.equal(hazardNear(w, 0, 64, 0, 6), true)
  assert.equal(hazardNear(w, 0, 64, 0, 4), false)
  assert.equal(pathNearHazard(w, [{ x: 8, y: 64, z: 0 }, { x: 7, y: 64, z: 0 }, { x: 6, y: 64, z: 0 }]), true)
  const w2 = world((x, y) => (y === 50 ? 'air' : y === 70 ? 'stone' : y < 50 ? 'stone' : 'air'))
  assert.equal(isUndergroundTarget(w2, 0, 50, 0), true)
  assert.equal(isUndergroundTarget(w, 0, 64, 0), false)
})

test('L1 sampleTargets drops forbidden (Infinity) lesson-zone targets', () => {
  const w = world((x, y) => (y < 64 ? 'stone' : 'air'))
  w.entity.position = new Vec3(0.5, 64, 0.5)
  const rng = makeRng(5)
  const env = { rng, heatmap: new Heatmap({ cell: 8, rng }), costAt: (p) => (p.x > 0 ? Infinity : 0) }
  const c = sampleTargets(w, env, { radius: 40, minDist: 6, samples: 100 })
  assert.ok(c.length > 10 && c.every((t) => t.x <= 1 && Number.isFinite(t.score)))
})

test('L1 zoneStepCost: lava blocks and forbidden zones are huge but finite; harmless blocks free', () => {
  const hooks = createHooks()
  const f = zoneStepCost(hooks)
  const b = (name, x = 0) => ({ name, position: new Vec3(x, 64, 0) })
  assert.equal(f(b('stone')), 0)
  assert.ok(f(b('lava')) >= 1000)
  hooks.addCostProvider((p) => (p.x > 10 ? Infinity : p.x > 5 ? 20 : 0))
  assert.equal(f(b('stone', 3)), 0); assert.equal(f(b('stone', 7)), 20)
  const inf = f(b('stone', 12)); assert.ok(Number.isFinite(inf) && inf >= 1000)
})

test('L1 lesson zones: horizontal-weighted distance, repeat lava deaths nearby enlarge + strengthen the zone', () => {
  const l1 = { id: 1, goal_type: 'return_to_surface', x: -408.7, y: 50, z: 286.5, result: 'death', cause: 'lava', strength: 1.5, extent: 8 }
  const l2 = { id: 2, goal_type: 'explore', x: -400.8, y: 63, z: 273.9, result: 'death', cause: 'lava', strength: 1.5, extent: 8 }
  const one = buildConstraints([l1])
  const two = buildConstraints([l1, l2])
  const p = { x: -400.8, y: 63, z: 273.9 }
  assert.ok(zoneDist(p, { x: -408.7, y: 50, z: 286.5 }) < 20)
  assert.ok(two.zones[0].radius > one.zones[0].radius && two.zones[0].forbid > one.zones[0].forbid, 'cluster enlarges')
  assert.equal(two.forbidden(p), true, 'second death site is forbidden')
  assert.equal(one.forbidden({ x: -408.7, y: 60, z: 286.5 }), true, 'a lake 10 blocks above the cave death is the same hazard')
  assert.equal(buildConstraints([{ ...l1, cause: 'mob', extent: 0 }, { ...l2, cause: 'mob', extent: 0 }]).zones[0].radius, 20, 'mob zones are not clustered')
})
