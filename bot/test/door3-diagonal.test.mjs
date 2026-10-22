import test from 'node:test'
import assert from 'node:assert/strict'
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { DoorMovements } from '../src/skills/movements-doors.js'

test('DOOR3 root cause: a diagonal step that cuts the corner of a door cell is not offered (she ended beside the open door)', () => {
  const w = new Map()
  const set = (x, y, z, name, props) => w.set(`${x},${y},${z}`, { name, props })
  set(10, 64, 5, 'oak_door', { open: false, half: 'lower', facing: 'east' }); set(10, 65, 5, 'oak_door', { open: false, half: 'upper', facing: 'east' })
  const bot = { blockAt: (p) => { const e = w.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`); return { name: e?.name ?? 'air', position: p, boundingBox: e ? 'block' : 'empty', getProperties: () => e?.props ?? {} } } }
  const orig = pf.Movements.prototype.getNeighbors
  // from (10,64,4) (north of the door) to (9,64,5) diagonally would clip the door cell (10,64,5); straight steps are fine
  pf.Movements.prototype.getNeighbors = () => [{ x: 9, y: 64, z: 5 }, { x: 9, y: 64, z: 4 }, { x: 10, y: 64, z: 3 }]
  try {
    const mv = Object.create(DoorMovements.prototype); mv.bot = bot
    const out = mv.getNeighbors({ x: 10, y: 64, z: 4 })
    assert.deepEqual(out.map((n) => `${n.x},${n.z}`), ['9,4', '10,3'])
  } finally { pf.Movements.prototype.getNeighbors = orig }
})
