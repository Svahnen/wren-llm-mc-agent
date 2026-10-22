import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { builtReason, installBuiltGuard, PlacedBlocks, structureInfo } from '../src/skills/movements-protect.js'
import { walkable, findDoors, DIRS, feetCell, isWalkDoor } from '../src/escape/world.js'
import { assess, bestWeapon, combatFacts } from '../src/reflex/threats.js'
import { DEFAULTS } from '../src/reflex/defaults.js'
import { World, flat, mockBot } from './reflex-helpers.mjs'

const blk = (name, x, y, z, extra = {}) => ({ name, position: new Vec3(x, y, z), boundingBox: 'block', getProperties: () => ({}), ...extra })
function botWith(blocks) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0 }
  bot.registry = { blocksArray: [{ name: 'oak_door', id: 1 }, { name: 'oak_trapdoor', id: 2 }] }
  const m = new Map(blocks.map((b) => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  bot.blockAt = (p) => m.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) }
  bot.findBlocks = ({ matching }) => [...m.values()].filter((b) => /_(door|trapdoor|fence_gate)$/.test(b.name)).map((b) => b.position)
  bot.dug = []
  bot.dig = async (b) => { bot.dug.push(b.name); return 'dug' }
  bot.placeBlock = async () => undefined
  return bot
}

test('B1: doors and crafted blocks are protected; natural blocks only when a door is near; own placed blocks are free', () => {
  const door = blk('oak_door', 3, 64, 0), planks = blk('oak_planks', 1, 64, 0), dirtNear = blk('dirt', 2, 64, 1), dirtFar = blk('dirt', 40, 64, 40), glass = blk('glass', 0, 64, 1)
  const bot = botWith([door, planks, dirtNear, glass])
  assert.equal(builtReason(bot, door), 'door')
  assert.equal(builtReason(bot, planks), 'built_block')
  assert.equal(builtReason(bot, glass), 'built_block')
  assert.equal(builtReason(bot, dirtNear), 'structure_context')
  assert.equal(builtReason(bot, dirtFar), null, 'dirt far from any door is just dirt')
  bot.__placed = new PlacedBlocks()
  bot.__placed.add(dirtNear.position); bot.__placed.add(planks.position)
  assert.equal(builtReason(bot, dirtNear), 'near_structure', 'DOOR3: her own dirt right beside a door is structure too (door anchor within 2)')
  assert.equal(builtReason(bot, dirtNear, { noShell: true }), null, 'her own pillbox dirt (structure rule off)')
  assert.equal(builtReason(bot, planks, { noShell: true }), null, 'her own planks')
  assert.equal(builtReason(bot, door), 'door')
})

test('B1: bot.dig refuses built blocks (even unstuck/pathfinder), allows own blocks, tracks placeBlock, reflex suffocation may dig walls but never doors', async () => {
  const door = blk('oak_door', 3, 64, 0), wall = blk('oak_planks', 1, 64, 0), rock = blk('stone', 10, 64, 10)
  const bot = botWith([door, wall, rock])
  let suffocating = false
  installBuiltGuard(bot, { exemptReflex: () => suffocating })
  await assert.rejects(bot.dig(door), /built_protected/)
  await assert.rejects(bot.dig(wall), /built_protected/)
  assert.equal(await bot.dig(rock), 'dug')
  suffocating = true
  await assert.rejects(bot.dig(door), /built_protected/, 'never a door')
  assert.equal(await bot.dig(wall), 'dug', 'suffocation reflex may break a wall')
  suffocating = false
  const ref = blk('stone', 5, 63, 5)
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  assert.equal(bot.__placed.has(new Vec3(5, 64, 5)), true)
  const mine = blk('oak_planks', 5, 64, 5)
  assert.equal(await bot.dig(mine), 'dug', 'planks she placed herself')
  assert.equal(bot.__placed.has(new Vec3(5, 64, 5)), false, 'forgotten once dug')
  assert.equal(bot.__builtStats.blocked, 3)
})

test('B1: a closed wooden door counts as an exit for the stuck detector; hut with door is not "trapped"', () => {
  const w = flat(); w.fill(-1, 64, -1, 1, 65, 1, 'stone'); w.set(0, 64, 0, 'air'); w.set(0, 65, 0, 'air')
  const bot = mockBot(w, { pos: [0.5, 64, 0.5] })
  // door east of her, replacing the stone wall cell (both halves)
  const orig = bot.blockAt
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); if (x === 1 && z === 0 && (y === 64 || y === 65)) return { name: 'oak_door', position: new Vec3(x, y, z), boundingBox: 'block', getProperties: () => ({ open: false, half: y === 64 ? 'lower' : 'upper' }) }; return orig(v) }
  assert.equal(isWalkDoor(bot.blockAt(new Vec3(1, 64, 0))), true)
  const dirs = DIRS.filter((d) => walkable(bot, feetCell(bot), d))
  assert.equal(dirs.length, 1, 'only the door side is a way out')
  assert.equal(findDoors(bot, 4.6, { includeOpen: true }).length, 1, 'one entry per door')
})

test('B1: with a sword she fights a zombie at hp 10 (was: fled), flees two zombies, bare hands still flee, creeper handled by its own reflex', () => {
  const w = flat(); const r = mockBot(w)
  r.addEntity?.('zombie', 5.5, 64, 0.5)
  const bot = r
  bot.entities = { 1: { name: 'zombie', position: new Vec3(5.5, 64, 0.5), isValid: true, height: 1.95 } }
  bot.items = [{ name: 'iron_sword', type: 1, count: 1 }, { name: 'iron_axe', type: 2, count: 1 }, { name: 'iron_pickaxe', type: 3, count: 1 }]
  bot.health = 10
  const a = assess(bot, DEFAULTS)
  assert.equal(a.weapon.name, 'iron_sword', 'sword preferred over axe')
  assert.equal(a.decision, 'fight', a.reason)
  bot.entities[2] = { name: 'zombie', position: new Vec3(6.5, 64, 1.5), isValid: true }
  assert.equal(assess(bot, DEFAULTS).decision, 'flee', 'two zombies at 10 hp: outmatched')
  delete bot.entities[2]; bot.health = 5
  assert.equal(assess(bot, DEFAULTS).decision, 'flee', 'low hp')
  bot.health = 14; bot.items = []
  assert.equal(assess(bot, DEFAULTS).decision, 'flee', 'unarmed')
  bot.items = [{ name: 'diamond_axe', type: 2, count: 1 }, { name: 'iron_sword', type: 1, count: 1 }]
  assert.equal(bestWeapon(bot).name, 'iron_sword', 'iron sword (dps 9.6*1.15) beats a diamond axe (dps 8.1)')
  bot.health = 14; bot.items = [{ name: 'iron_sword', type: 1, count: 1 }]
  const f = combatFacts(bot, DEFAULTS)
  assert.match(f.text, /zombie 5 m, you carry iron sword/)
  assert.match(f.text, /hp 14/)
})

test('B1: structureInfo describes the door for S2', () => {
  const door = blk('oak_door', 2, 64, 0, { getProperties: () => ({ open: false, half: 'lower' }) })
  const walls = [blk('stone', 1, 64, 0), blk('stone', -1, 64, 0), blk('stone', 0, 64, 1), blk('stone', 0, 64, -1), blk('stone', 0, 66, 0)]
  const bot = botWith([door, ...walls])
  const s = structureInfo(bot, { builder: 'Alex' })
  assert.equal(s.doors.length, 1)
  assert.match(s.text, /built by Alex; there is a closed oak door at 2 64 0/)
})
