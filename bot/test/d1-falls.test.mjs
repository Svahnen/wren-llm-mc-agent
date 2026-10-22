import test from 'node:test'
import assert from 'node:assert/strict'
import { digRisk, ledgeRisk, columnBelow } from '../src/skills/dig-safe.js'
import { mlg, ALL_REFLEXES } from '../src/reflex/reflexes.js'

const world = (f) => ({
  blockAt: (v) => { const n = f(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)); return n && { name: n, boundingBox: ['air', 'lava', 'water'].includes(n) ? 'empty' : 'block' } },
  entity: { position: { x: 0.5, y: 65, z: 0.5 } },
})
// floor at y=64 (solid), stone below only where given
const flat = (extra = () => null) => world((x, y, z) => extra(x, y, z) ?? (y <= 64 ? 'stone' : 'air'))

test('D1 digRisk: digging the block under the feet needs a solid cell below-below', () => {
  const ok = flat()
  assert.equal(digRisk(ok, { x: 0, y: 64, z: 0 }), null)
  const hole = flat((x, y, z) => (x === 0 && z === 0 && y < 64 ? 'air' : null))
  assert.equal(digRisk(hole, { x: 0, y: 64, z: 0 }), 'dig_down_unsafe')
  const lava = flat((x, y, z) => (x === 0 && z === 0 && y === 63 ? 'lava' : null))
  assert.ok(digRisk(lava, { x: 0, y: 64, z: 0 }))
})

test('D1 digRisk: a side block above a drop > 3 is refused, a shallow one is fine', () => {
  const ravine = flat((x, z0) => null)
  const deep = world((x, y, z) => (x === 1 && z === 0 && y < 64 ? 'air' : y <= 64 ? 'stone' : 'air')); deep.entity.position = { x: 0.5, y: 65, z: 0.5 }
  assert.equal(digRisk(deep, { x: 1, y: 64, z: 0 }), 'drop_beside')
  assert.equal(digRisk(ravine, { x: 1, y: 64, z: 0 }), null)
  const shallow = world((x, y, z) => (x === 1 && z === 0 && (y === 63 || y === 62) ? 'air' : y <= 64 ? 'stone' : 'air')); shallow.entity.position = { x: 0.5, y: 65, z: 0.5 }
  assert.equal(digRisk(shallow, { x: 1, y: 64, z: 0 }), null) // 1 + 2 empties = 3
})

test('D1 ledgeRisk: a target beside an open drop is rejected', () => {
  const cliff = world((x, y, z) => (x >= 2 ? (y < 70 ? 'air' : 'air') : y <= 64 ? 'stone' : 'air'))
  assert.equal(ledgeRisk(cliff, { x: 1, y: 64, z: 0 }), 'ledge')
  assert.equal(ledgeRisk(flat(), { x: 1, y: 64, z: 0 }), null)
  assert.equal(columnBelow(cliff, 2, 65, 0).empty, 8)
})

test('D1 mlg reflex: needs a water bucket and a fall > 8; registered', () => {
  assert.ok(ALL_REFLEXES.includes(mlg))
  const mk = (bucket, vy = -2) => ({ entity: { onGround: false, position: { y: 100 }, velocity: { y: vy } }, inventory: { items: () => (bucket ? [{ name: 'water_bucket' }] : []) } })
  const state = {}
  const b = mk(true)
  assert.equal(mlg.check({ bot: b, state }), null) // fell 0
  b.entity.position.y = 88
  assert.ok(mlg.check({ bot: b, state }).fallen >= 12)
  assert.equal(mlg.check({ bot: mk(false), state: {} }), null)
  const b2 = mk(true); const st2 = {}
  mlg.check({ bot: b2, state: st2 }); b2.entity.position.y = 95
  assert.equal(mlg.check({ bot: b2, state: st2 }), null) // fell 5 only
})

test('D1 mlg run: places the water when the ground is in reach', async () => {
  let acts = 0
  const bot = {
    entity: { onGround: false, position: { y: 70 }, velocity: { y: -3 }, yaw: 0 },
    inventory: { items: () => [{ name: 'water_bucket' }] },
    equip: async () => {}, look: async () => {}, blockAtCursor: () => ({ name: 'stone' }), activateItem: () => { acts++ },
  }
  const r = await mlg.run({ bot, signal: { aborted: false }, sleep: async () => true }, { fallen: 20 })
  assert.equal(r.ok, true); assert.equal(acts, 1)
})
