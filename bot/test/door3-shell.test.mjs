import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { shellInfo, shellReason, clearEnclosureCache, installWallRepair } from '../src/skills/enclosure.js'
import { installBuiltGuard, builtReason } from '../src/skills/movements-protect.js'

function rig() {
  const w = new Map()
  const bot = new EventEmitter()
  bot.blockAt = (p) => {
    const e = w.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    const isDoor = e && /door/.test(e.name)
    return { name: e?.name ?? 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: e && !isDoor ? 'block' : 'empty', getProperties: () => e?.props ?? {} }
  }
  bot.entity = { position: new Vec3(2.5, 64, 2.5), yaw: 0 }
  bot.registry = { blocksArray: [] }
  bot.digs = []
  bot.dig = async (b) => { bot.digs.push(b.position.toString()); w.delete(`${b.position.x},${b.position.y},${b.position.z}`) }
  bot.placeBlock = async () => {}
  const set = (x, y, z, name, props) => w.set(`${x},${y},${z}`, { name, props })
  return { bot, w, set }
}
// 7x7 room (inner 1..5), stone floor y=63, walls 2 high, roofless, oak door at x=6,z=3 facing east
function house(set, { blocked = false } = {}) {
  for (let x = -3; x <= 12; x++) for (let z = -3; z <= 9; z++) set(x, 63, z, 'stone')
  for (let i = 0; i <= 6; i++) for (const [x, z] of [[i, 0], [i, 6], [0, i], [6, i]]) for (const y of [64, 65]) set(x, y, z, 'dirt')
  set(6, 64, 3, 'oak_door', { open: false, half: 'lower', facing: 'east' }); set(6, 65, 3, 'oak_door', { open: false, half: 'upper', facing: 'east' })
  if (blocked) { set(7, 64, 3, 'cobblestone'); set(7, 65, 3, 'cobblestone'); set(5, 64, 3, 'cobblestone'); set(5, 65, 3, 'cobblestone') }
}

test('DOOR3: wall block of a room with a working door is shell (even her own); ground outside and a far block are not', () => {
  const { bot, set } = rig(); house(set); installBuiltGuard(bot)
  bot.__placed.add(new Vec3(0, 64, 3)) // she built that wall herself
  assert.equal(shellReason(bot, bot.blockAt(new Vec3(0, 64, 3))), 'shell')
  assert.equal(builtReason(bot, bot.blockAt(new Vec3(0, 64, 3))), 'shell')
  assert.equal(shellReason(bot, bot.blockAt(new Vec3(3, 65, 6))), 'shell')
  assert.equal(shellReason(bot, bot.blockAt(new Vec3(9, 63, 3))), null) // open floor outside
  assert.equal(shellReason(bot, bot.blockAt(new Vec3(3, 63, 3))), null) // room floor
})

test('DOOR3: bot.dig refuses a shell block; no breach recorded', async () => {
  const { bot, set } = rig(); house(set); installBuiltGuard(bot)
  await assert.rejects(() => bot.dig(bot.blockAt(new Vec3(0, 64, 3))), /built_protected/)
  assert.equal(bot.digs.length, 0)
})

test('DOOR3: blocked doorway -> one break allowed, then repair puts a block back (wall_repaired)', async () => {
  const ev = []; const trace = { event: (t, f) => ev.push([t, f]) }
  const r = rig(); house(r.set, { blocked: true }); installBuiltGuard(r.bot, { trace })
  assert.equal(shellInfo(r.bot, new Vec3(0, 64, 3)).kind, 'door_blocked')
  await r.bot.dig(r.bot.blockAt(new Vec3(0, 64, 3)))
  assert.deepEqual(r.bot.digs, ['(0, 64, 3)'])
  assert.equal(ev[0][0], 'wall_break_emergency')
  // repair: she is out, has cobblestone
  r.bot.entity.position = new Vec3(-3.5, 64, 3.5)
  r.bot.inventory = { items: () => [{ name: 'cobblestone' }] }
  r.bot.equip = async () => {}
  r.bot.placeBlock = async (ref, face) => { r.set(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z, 'cobblestone') }
  r.bot.__wallBreach.t -= 5000
  installWallRepair(r.bot, { trace })
  r.bot.emit('physicsTick'); await new Promise((x) => setTimeout(x, 150))
  r.bot.__wallBreach && (r.bot.__wallBreach.t -= 5000)
  const t0 = Date.now(); while (r.bot.__wallBreach && Date.now() - t0 < 3000) { await new Promise((x) => setTimeout(x, 800)); r.bot.emit('physicsTick') }
  assert.ok(ev.some((e) => e[0] === 'wall_repaired'), JSON.stringify(ev))
  assert.equal(r.bot.blockAt(new Vec3(0, 64, 3)).name, 'cobblestone')
})

test('DOOR3: no blocks to place -> hole noted for S2', async () => {
  const r = rig(); house(r.set, { blocked: true }); const ev = []; installBuiltGuard(r.bot, { trace: { event: (t, f) => ev.push([t, f]) } })
  await r.bot.dig(r.bot.blockAt(new Vec3(0, 64, 3)))
  r.bot.entity.position = new Vec3(-5.5, 64, 3.5); r.bot.inventory = { items: () => [] }
  r.bot.__wallBreach.t -= 5000
  installWallRepair(r.bot, { trace: { event: (t, f) => ev.push([t, f]) }, note: () => {} })
  const t0 = Date.now(); while (r.bot.__wallBreach && Date.now() - t0 < 3000) { r.bot.emit('physicsTick'); await new Promise((x) => setTimeout(x, 800)) }
  assert.ok(ev.some((e) => e[0] === 'wall_hole_noted'), JSON.stringify(ev))
  assert.match(r.bot.__wallHoles[0].text, /hole in my wall at 0,64,3/)
})

test('DOOR3: open ground (no room) is never shell', () => {
  const { bot, set } = rig(); for (let x = -30; x <= 30; x++) for (let z = -30; z <= 30; z++) set(x, 63, z, 'stone'); set(2, 64, 2, 'dirt')
  assert.equal(shellReason(bot, bot.blockAt(new Vec3(2, 64, 2))), null)
})

import { structureReason } from '../src/skills/enclosure.js'
test('DOOR3: blocks beside a bed / workstation / torch and inside a known place record are structure, far natural dirt is free; every dig is traced', async () => {
  const { bot, set } = rig(); for (let x = -30; x <= 30; x++) for (let z = -30; z <= 30; z++) set(x, 63, z, 'stone')
  set(10, 64, 10, 'crafting_table'); set(11, 64, 10, 'dirt'); set(20, 64, 20, 'dirt'); set(-20, 64, 3, 'dirt')
  bot.registry = { blocksArray: [{ id: 1, name: 'crafting_table' }] }
  bot.findBlocks = () => [new Vec3(10, 64, 10)]
  assert.equal(structureReason(bot, bot.blockAt(new Vec3(11, 64, 10))), 'near_structure')
  assert.equal(structureReason(bot, bot.blockAt(new Vec3(20, 64, 20))), null)
  bot.__landmarks = { places: { home: { x: -20, y: 64, z: 3, kind: 'home' } } }
  assert.equal(structureReason(bot, bot.blockAt(new Vec3(-20, 64, 3))), 'known_place')
  const ev = []; installBuiltGuard(bot, { trace: { event: (t, f) => ev.push([t, f]) } })
  await bot.dig(bot.blockAt(new Vec3(20, 64, 20)))
  const be = ev.find((e) => e[0] === 'block_broken')
  assert.ok(be); assert.equal(be[1].block, 'dirt'); assert.equal(be[1].protected, false); assert.ok(be[1].caller)
  await assert.rejects(() => bot.dig(bot.blockAt(new Vec3(11, 64, 10))), /built_protected/)
})
