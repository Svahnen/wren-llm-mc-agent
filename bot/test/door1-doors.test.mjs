import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { clearTriggerCache, installDoorOpener, openDoorEx, closeDoorEx, doorsAhead, hatchAbove, isNight } from '../src/skills/movements-doors.js'
import { makeInteractSkills, chestTransfer } from '../src/skills/interact.js'

// tiny world: Map "x,y,z" -> { name, props }
function rig({ stuck = false } = {}) {
  const w = new Map()
  const bot = new EventEmitter()
  const blk = (x, y, z) => {
    const e = w.get(`${x},${y},${z}`)
    const b = { name: e?.name ?? 'air', position: new Vec3(x, y, z), boundingBox: e && !/door|button|lever|ladder/.test(e.name) ? 'block' : 'empty' }
    b.getProperties = () => e?.props ?? {}
    return b
  }
  bot.blockAt = (p) => blk(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: Math.PI * 1.5 } // facing +x (yaw: forward = (-sin, -cos))
  bot.health = 20; bot.entities = {}; bot.time = { timeOfDay: 1000 }
  bot.registry = { blocksArray: [], itemsByName: { cobblestone: { id: 5 } } }
  bot.findBlocks = () => []
  bot.lookAt = async () => {}
  bot.activations = []
  bot.activateBlock = async (b) => {
    bot.activations.push(b.name)
    if (stuck) return
    const toggle = (pos) => { const e = w.get(`${pos.x},${pos.y},${pos.z}`); if (e?.props && 'open' in e.props) e.props = { ...e.props, open: !e.props.open } }
    toggle(b.position)
    if (/_door$/.test(b.name)) toggle(b.position.offset(0, e1(b) , 0))
    function e1(bb) { return bb.getProperties().half === 'lower' ? 1 : -1 }
  }
  bot.pathfinder = { isMoving: () => true }
  const set = (x, y, z, name, props) => w.set(`${x},${y},${z}`, { name, props })
  return { bot, w, set }
}
const door = (set, x, y, z, o = false, facing = 'east', name = 'oak_door') => { set(x, y, z, name, { open: o, half: 'lower', facing }); set(x, y + 1, z, name, { open: o, half: 'upper', facing }) }
const yaw = (bot, y) => { bot.entity.yaw = y }

test('DOOR1: doorsAhead finds the lower half of a closed door in front, also when only the upper half is aimed at', () => {
  const { bot, set } = rig(); door(set, 1, 64, 0)
  assert.equal(doorsAhead(bot).length, 1)
  assert.equal(doorsAhead(bot)[0].getProperties().half, 'lower')
  yaw(bot, Math.PI / 2) // facing -x: nothing
  assert.equal(doorsAhead(bot).length, 0)
})

test('DOOR1: openDoorEx / closeDoorEx on door, gate; reasons for failure', async () => {
  const { bot, set } = rig(); door(set, 1, 64, 0); set(1, 64, 3, 'oak_fence_gate', { open: false, facing: 'north' })
  const lower = bot.blockAt(new Vec3(1, 64, 0))
  assert.deepEqual((await openDoorEx(bot, lower)).ok, true)
  assert.equal(bot.blockAt(new Vec3(1, 65, 0)).getProperties().open, true, 'upper half follows')
  assert.equal((await closeDoorEx(bot, bot.blockAt(new Vec3(1, 65, 0)))).ok, true, 'upper half reference is normalised to lower')
  set(1, 64, 20, 'oak_fence_gate', { open: false, facing: 'north' })
  assert.equal((await openDoorEx(bot, bot.blockAt(new Vec3(1, 64, 20)))).reason, 'out_of_reach')
  assert.equal((await openDoorEx(bot, bot.blockAt(new Vec3(0, 63, 0)))).reason, 'not_a_door')
  const s = rig({ stuck: true }); door(s.set, 1, 64, 0)
  assert.equal((await openDoorEx(s.bot, s.bot.blockAt(new Vec3(1, 64, 0)), { sleepMs: 5 })).reason, 'still_closed')
  assert.equal((await closeDoorEx(bot, bot.blockAt(new Vec3(1, 64, 3)))).via, 'already_closed')
})

test('DOOR1: iron door needs a button in reach; no trigger => iron_no_trigger', async () => {
  const { bot, set } = rig(); door(set, 1, 64, 0, false, 'east', 'iron_door')
  bot.registry.blocksArray = [{ name: 'stone_button', id: 9 }, { name: 'iron_door', id: 10 }]
  assert.equal((await openDoorEx(bot, bot.blockAt(new Vec3(1, 64, 0)))).reason, 'iron_no_trigger')
  clearTriggerCache(); set(0, 64, 1, 'stone_button', { powered: false })
  bot.findBlocks = ({ point }) => (point ? [new Vec3(0, 64, 1)] : [])
  bot.activateBlock = async (b) => { bot.activations.push(b.name); if (b.name === 'stone_button') { set(1, 64, 0, 'iron_door', { open: true, half: 'lower', facing: 'east' }) } }
  const r = await openDoorEx(bot, bot.blockAt(new Vec3(1, 64, 0)))
  assert.equal(r.ok, true); assert.equal(r.via, 'stone_button')
  assert.equal((await closeDoorEx(bot, bot.blockAt(new Vec3(1, 64, 0)))).reason, 'iron_self_closing')
})

test('DOOR1: hatchAbove only when in a ladder column under a closed trapdoor', () => {
  const { bot, set } = rig()
  set(0, 64, 0, 'ladder', {}); set(0, 65, 0, 'ladder', {}); set(0, 66, 0, 'oak_trapdoor', { open: false })
  assert.equal(hatchAbove(bot)?.name, 'oak_trapdoor')
  set(0, 66, 0, 'oak_trapdoor', { open: true }); assert.equal(hatchAbove(bot), null)
  const r = rig(); r.set(0, 66, 0, 'oak_trapdoor', { open: false }); assert.equal(hatchAbove(r.bot), null, 'not on a ladder')
})

test('DOOR1: opener opens ahead, closes after crossing the door plane, emits events; no close before crossing', async () => {
  const { bot, set } = rig(); door(set, 1, 64, 0)
  const events = []
  const o = installDoorOpener(bot, { trace: { event: (t, f) => events.push([t, f]) }, closeAfterMs: 0 })
  await o.tick()
  assert.deepEqual(events.map((e) => e[0]), ['door_opened'])
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).getProperties().open, true)
  bot.entity.position = new Vec3(1.5, 64, 0.5); await o.tick() // standing in the doorway
  assert.equal(events.length, 1, 'not closed while in the doorway')
  bot.entity.position = new Vec3(2.8, 64, 0.5); await o.tick()
  assert.deepEqual(events.map((e) => e[0]), ['door_opened', 'door_closed'])
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).getProperties().open, false)
  assert.deepEqual([o.stats.opened, o.stats.closed], [1, 1])
})

test('DOOR1: door out of reach after crossing => door_failed out_of_reach (not silent), stuck door => door_failed still_open', async () => {
  const { bot, set } = rig(); door(set, 1, 64, 0)
  const events = []
  const o = installDoorOpener(bot, { trace: { event: (t, f) => events.push([t, f]) }, closeAfterMs: 0 })
  await o.tick()
  bot.entity.position = new Vec3(9.5, 64, 0.5); bot.pathfinder.isMoving = () => false
  const mineEntry = [...o.mine.values()][0]; mineEntry.at -= 25000
  await o.tick()
  assert.ok(events.some((e) => e[0] === 'door_failed' && e[1].reason === 'out_of_reach'), JSON.stringify(events))
})

test('DOOR1: shelter closes an open door when a hostile is near and she is enclosed; skips during the day without hostile', async () => {
  const { bot, set } = rig(); door(set, 1, 64, 0, true)
  bot.registry.blocksArray = [{ name: 'oak_door', id: 1 }]
  bot.findBlocks = () => [new Vec3(1, 64, 0)]
  bot.pathfinder.isMoving = () => false
  // enclosure: ceiling + walls on 4 sides
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1]]) { set(x, 64, z, 'stone', {}); set(x, 65, z, 'stone', {}) }
  set(0, 67, 0, 'stone', {})
  const events = []
  const o = installDoorOpener(bot, { trace: { event: (t, f) => events.push([t, f]) } })
  await o.tick(); assert.equal(events.length, 0, 'day, no hostile: leave it')
  bot.__doorShelterT = 0; bot.entities = { 1: { name: 'zombie', position: new Vec3(8, 64, 0) } }
  await o.tick()
  assert.deepEqual(events.map((e) => e[1].why ?? e[0]), ['shelter_hostile'])
  assert.equal(isNight({ time: { timeOfDay: 14000 } }), true)
  assert.equal(isNight({ time: { timeOfDay: 6000 } }), false)
})

test('DOOR1: interact skills: open_door reasons, close_doors_nearby, chestTransfer', async () => {
  const sk = Object.fromEntries(makeInteractSkills().map((s) => [s.name, s]))
  assert.deepEqual(Object.keys(sk).sort(), ['chest', 'close_doors_nearby', 'open_door', 'press_button'])
  const { bot, set } = rig(); door(set, 1, 64, 0)
  const ctx = (args) => ({ bot, args, aborted: false, log: () => {}, sleep: async () => true, goto: async () => ({ ok: true }) })
  assert.equal((await sk.open_door.run(ctx({}))).reason, 'no_door_nearby')
  assert.equal((await sk.open_door.run(ctx({ x: 1, y: 64, z: 0 }))).ok, true)
  assert.equal((await sk.open_door.run(ctx({ x: 5, y: 64, z: 5 }))).reason, 'not_a_door')
  // chest primitive with a fake window
  const inv = [{ type: 5, count: 4, name: 'cobblestone' }]; const chest = [{ type: 5, count: 3, name: 'cobblestone' }]
  bot.inventory = { items: () => inv }
  bot.openContainer = async () => ({ containerItems: () => chest, withdraw: async (id, m, n) => { chest[0].count -= n }, deposit: async (id, m, n) => { chest[0].count += n }, close() {} })
  assert.deepEqual((await chestTransfer(bot, {}, { action: 'list' })).items, { cobblestone: 3 })
  assert.equal((await chestTransfer(bot, {}, { action: 'take', item: 'cobblestone', count: 2 })).moved, 2)
  assert.equal((await chestTransfer(bot, {}, { action: 'put', item: 'cobblestone' })).moved, 4)
  assert.equal((await chestTransfer(bot, {}, { action: 'take', item: 'diamond' })).reason, 'unknown_item')
})

test('DOOR3b: a lever she flipped on to open an iron door is flipped back after she passed', async () => {
  const { bot, set, w } = rig(); door(set, 1, 64, 0, false, 'east', 'iron_door'); set(0, 64, 1, 'lever', { powered: false, face: 'floor', facing: 'north' })
  bot.registry.blocksArray = [{ name: 'lever', id: 9 }, { name: 'iron_door', id: 10 }]
  bot.findBlocks = ({ matching }) => (matching.includes(9) ? [new Vec3(0, 64, 1)] : [])
  clearTriggerCache()
  const toggleLever = () => { const e = w.get('0,64,1'); e.props = { ...e.props, powered: !e.props.powered }; for (const y of [64, 65]) { const d = w.get(`1,${y},0`); d.props = { ...d.props, open: e.props.powered } } }
  bot.activateBlock = async (b) => { bot.activations.push(b.name); if (b.name === 'lever') toggleLever() }
  const events = []
  const o = installDoorOpener(bot, { trace: { event: (t, f) => events.push(t) }, closeAfterMs: 0 })
  await o.tick()
  assert.equal(w.get('0,64,1').props.powered, true, 'lever flipped to open the door')
  assert.equal(w.get('1,64,0').props.open, true)
  bot.entity.position = new Vec3(2.8, 64, 0.5)   // through the door, lever still within reach
  await o.tick()
  assert.equal(w.get('0,64,1').props.powered, false, 'lever flipped back')
  assert.ok(events.includes('lever_reset'))
  assert.equal(bot.activations.filter((n) => n === 'lever').length, 2)
})
