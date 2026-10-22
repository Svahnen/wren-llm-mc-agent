import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { clearTriggerCache, openDoorEx, closeDoorEx, sameRoom, plateWillOpen, onPlate, isPowered } from '../src/skills/movements-doors.js'

function rig() {
  const w = new Map()
  const bot = new EventEmitter()
  bot.blockAt = (p) => {
    const e = w.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    return { name: e?.name ?? 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: e && !/door|plate/.test(e.name) ? 'block' : 'empty', getProperties: () => e?.props ?? {} }
  }
  bot.entity = { position: new Vec3(5.5, 64, 0.5), yaw: 0 }
  bot.registry = { blocksArray: [{ id: 1, name: 'oak_pressure_plate' }] }
  bot.findBlocks = ({ point }) => [...w].filter(([, v]) => /pressure_plate/.test(v.name)).map(([k]) => new Vec3(...k.split(',').map(Number)))
  bot.lookAt = async () => {}
  bot.acts = 0
  bot.activateBlock = async (b) => { bot.acts++; const e = w.get(`${b.position.x},${b.position.y},${b.position.z}`); e.props = { ...e.props, open: !e.props.open } }
  const set = (x, y, z, name, props) => w.set(`${x},${y},${z}`, { name, props })
  return { bot, w, set }
}
beforeEach(() => clearTriggerCache())
const door = (set, x, z, o = false, powered = false) => { set(x, 64, z, 'oak_door', { open: o, powered, half: 'lower', facing: 'east' }); set(x, 65, z, 'oak_door', { open: o, powered, half: 'upper', facing: 'east' }) }

test('DOOR2: a door held open by a plate/lever (powered) is never toggled by use, neither open nor close', async () => {
  const { bot, set } = rig(); door(set, 6, 0, true, true)
  const b = bot.blockAt(new Vec3(6, 64, 0))
  assert.ok(isPowered(b))
  assert.equal((await openDoorEx(bot, b)).via, 'already_open')
  const r = await closeDoorEx(bot, b)
  assert.equal(r.reason, 'powered'); assert.equal(bot.acts, 0)
})

test('DOOR2: a closed door whose plate lies on her side is left to the plate; at the door it is used (opened exactly once)', async () => {
  const { bot, set } = rig(); door(set, 6, 0); set(7, 64, 0, 'oak_pressure_plate', { powered: false })
  bot.entity.position = new Vec3(9.5, 64, 0.5) // east side, plate between her and the door
  const b = bot.blockAt(new Vec3(6, 64, 0))
  assert.ok(plateWillOpen(bot, b))
  assert.equal((await openDoorEx(bot, b)).reason, 'plate_will_open'); assert.equal(bot.acts, 0)
  bot.entity.position = new Vec3(7.2, 64, 0.5) // right at the door and it is still closed
  const r = await openDoorEx(bot, b, { sleepMs: 60 })
  assert.ok(r.ok); assert.equal(bot.acts, 1)
})

test('DOOR2: plate on the other side of the door does not stop opening from this side', async () => {
  const { bot, set } = rig(); door(set, 6, 0); set(5, 64, 0, 'oak_pressure_plate', { powered: false })
  bot.entity.position = new Vec3(9.5, 64, 0.5)
  assert.equal(plateWillOpen(bot, bot.blockAt(new Vec3(6, 64, 0))), false)
  const r = await openDoorEx(bot, bot.blockAt(new Vec3(6, 64, 0)), { sleepMs: 60 })
  assert.ok(r.ok); assert.equal(bot.acts, 1)
})

test('DOOR2: sameRoom: roofless walled room, doors count as walls; open ground is unbounded', () => {
  const { bot, set } = rig()
  for (let x = -1; x <= 30; x++) for (let z = -1; z <= 30; z++) set(x, 63, z, 'stone')
  for (let i = -1; i <= 8; i++) for (const [x, z] of [[i, -1], [i, 8], [-1, i], [8, i]]) for (const y of [64, 65]) set(x, y, z, 'dirt')
  door(set, 8, 3)
  bot.entity.position = new Vec3(2.5, 64, 2.5)
  assert.deepEqual(sameRoom(bot, { x: 5.5, y: 64, z: 5.5 }).inside, true)
  bot.entity.position = new Vec3(10.5, 64, 3.5) // outside the door
  const r = sameRoom(bot, { x: 5.5, y: 64, z: 5.5 })
  assert.equal(r.bounded, true); assert.equal(r.inside, false)
  assert.equal(sameRoom(bot, { x: 20.5, y: 64, z: 20.5 }, { maxCells: 50 }).bounded, false)
})
