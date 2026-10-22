// HOME2: nothing she places for herself goes beside a door (observed: night pillbox at (100,66,100) used her home door as its 4th wall).
import test from 'node:test'
import assert from 'node:assert/strict'
import { doorKeepout } from '../src/skills/lib.js'
import { findSite } from '../src/skills/shelter.js'

const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) }, offset(a, b, c) { return vec(x + a, y + b, z + c) }, plus(o) { return vec(x + o.x, y + o.y, z + o.z) }, minus(o) { return vec(x - o.x, y - o.y, z - o.z) } })
// ground solid below y=64; the door pair of her home: oak_door at (10,64,10) and (10,64,11) facing east (walk axis x), upper halves at y 65
function world() {
  const m = new Map()
  for (const z of [10, 11]) { m.set(`10,64,${z}`, 'oak_door'); m.set(`10,65,${z}`, 'oak_door') }
  return m
}
function bot(w, pos = [20.5, 64, 20.5]) {
  const blockAt = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = `${x},${y},${z}`
    const n = w.has(k) ? w.get(k) : (y < 64 ? 'dirt' : 'air')
    return { name: n, position: vec(x, y, z), boundingBox: n === 'air' ? 'empty' : 'block', getProperties: () => (n === 'oak_door' ? { facing: 'east', open: false } : {}) }
  }
  return { entity: { position: vec(...pos), onGround: true }, blockAt, registry: {}, inventory: { items: () => [] } }
}

test('keep-out: the ring around a door and two cells each way along its walk axis; far cells are free', () => {
  const b = bot(world())
  assert.equal(doorKeepout(b, 10, 64, 9), true, 'north of the door (the pocket cell)')
  assert.equal(doorKeepout(b, 11, 64, 9), true, 'diagonal')
  assert.equal(doorKeepout(b, 12, 64, 10), true, 'in front on the walk axis')
  assert.equal(doorKeepout(b, 8, 64, 10), true, 'behind on the walk axis')
  assert.equal(doorKeepout(b, 10, 64, 6), false, 'far along the wall')
  assert.equal(doorKeepout(b, 15, 64, 10), false)
})
test('findSite never returns a cell next to a door, even when she stands there', () => {
  const w = world()
  const b = bot(w, [10.5, 64, 9.5])   // standing in the niche north of the door
  const s = findSite(b, {})
  assert.ok(s, 'some site exists')
  assert.equal(doorKeepout(b, s.x, s.y, s.z), false, JSON.stringify(s))
  assert.ok(!(s.x === 10 && s.z === 9))
})
