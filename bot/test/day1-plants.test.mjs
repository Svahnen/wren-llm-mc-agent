// DAY1: forage_plants skill: ripe berries / crops only, apples from leaves as fallback, success = edible item delta.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeForagePlants, plantTargets } from '../src/skills/forageplants.js'
import { SkillRunner } from '../src/skills/runner.js'

const P = (x, y, z) => ({ x, y, z })
function bot(blocks) {
  const stacks = new Map(); const b = { health: 4, entity: { position: { x: 0, y: 64, z: 0, distanceTo: (o) => Math.hypot(o.x, o.y - 64, o.z) } }, inventory: { items: () => [...stacks].map(([name, count]) => ({ name, count })), emptySlotCount: () => 20 },
    registry: { blocksByName: { sweet_berry_bush: { id: 1 }, carrots: { id: 2 }, potatoes: { id: 3 }, beetroots: { id: 4 }, melon: { id: 5 }, oak_leaves: { id: 6 }, dark_oak_leaves: { id: 7 } } }, stacks, activated: [], dug: [], lookAt: async () => {} }
  b.findBlocks = ({ matching }) => blocks.filter((k) => matching.includes(k.id)).map((k) => k.pos)
  b.blockAt = (p) => blocks.find((k) => k.pos.x === p.x && k.pos.z === p.z) ?? null
  b.activateBlock = async (blk) => { b.activated.push(blk.name); stacks.set('sweet_berries', (stacks.get('sweet_berries') ?? 0) + 2) }
  b.dig = async (blk) => { b.dug.push(blk.name); if (blk.name === 'oak_leaves' && b.dug.length === 3) stacks.set('apple', 1) }
  return b
}
const blk = (name, id, x, z, age) => ({ name, id, pos: P(x, 64, z), position: P(x, 64, z), getProperties: () => ({ age, persistent: false }), boundingBox: 'empty' })

test('plantTargets: only ripe berry bushes / crops, nearest first', () => {
  const b = bot([blk('sweet_berry_bush', 1, 5, 0, 3), blk('sweet_berry_bush', 1, 2, 0, 0), blk('carrots', 2, 9, 0, 7), blk('carrots', 2, 3, 0, 4)])
  assert.deepEqual(plantTargets(b).map((t) => [t.kind, Math.round(t.d)]), [['sweet_berry_bush', 5], ['carrots', 9]])
})
test('picks ripe berries (right-click) and reports the edible delta', async () => {
  const b = bot([blk('sweet_berry_bush', 1, 5, 0, 3)])
  const sk = makeForagePlants(); const ctx = { bot: b, args: { count: 2 }, state: {}, aborted: false, sleep: async () => {}, goto: async () => ({ ok: true }), log() {} }
  assert.ok(sk.precondition({ bot: b }) === true)
  const r = await sk.run(ctx)
  assert.equal(r.ok, true); assert.deepEqual(b.activated, ['sweet_berry_bush']); assert.equal(ctx.state.got, 2)
})
test('nothing ripe and no leaves: honest no_target_found; leaves: breaks them and reports nothing_gained when no apple drops', async () => {
  const b = bot([]); const sk = makeForagePlants()
  const mk = (bb) => ({ bot: bb, args: {}, state: {}, aborted: false, sleep: async () => {}, goto: async () => ({ ok: true }), log() {} })
  assert.equal((await sk.run(mk(b))).reason, 'no_target_found')
  const l = bot(Array.from({ length: 6 }, (_, i) => blk('oak_leaves', 6, 3 + i, 0, 0)))
  const r = await sk.run(mk(l)); assert.equal(r.ok, true, 'third leaf dropped an apple'); assert.ok(l.dug.length >= 3)
})
