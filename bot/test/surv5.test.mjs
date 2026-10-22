// SURV5: trident drowned = ranged flee-class threat (also behind water / no line of sight); water_shooter reflex; craft finds/makes a table with honest reasons.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { assess, hostilesAround, relevantThreat, profOf } from '../src/reflex/threats.js'
import { waterShooter } from '../src/reflex/reflexes.js'
import { DEFAULTS } from '../src/reflex/defaults.js'
import { craftItem } from '../src/skills/craft.js'

const mk = (ents, { blocked = false, hp = 12 } = {}) => {
  const bot = { entity: { position: new Vec3(0, 64, 0), height: 1.8 }, health: hp, inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, entities: {}, world: { raycast: () => (blocked ? { position: new Vec3(1, 64, 0) } : null) } }
  ents.forEach((e, i) => { bot.entities[i + 1] = { id: i + 1, isValid: true, height: 1.95, ...e, position: new Vec3(...e.pos) } })
  return bot
}
const tri = { name: 'drowned', pos: [10, 64, 0], equipment: [{ name: 'trident' }] }

test('plain drowned stays a melee fighter; a trident drowned is a ranged flee-class threat', () => {
  assert.equal(profOf({ name: 'drowned' }).ranged, undefined)
  const p = profOf(tri)
  assert.equal(p.ranged, true); assert.equal(p.flee, true); assert.equal(p.trident, true)
})
test('trident drowned at 10 m: relevant even without line of sight, hp 12 -> flee (flee_class)', () => {
  const bot = mk([tri], { blocked: true })
  assert.equal(relevantThreat(bot, bot.entities[1]), true)
  assert.equal(hostilesAround(bot, 24)[0].prof.ranged, true)
  const a = assess(bot, DEFAULTS)
  assert.equal(a.decision, 'flee'); assert.match(a.reason, /flee_class:drowned/)
})
test('plain drowned 10 m behind a wall is still ignored (VAL1 unchanged)', () => {
  assert.equal(assess(mk([{ name: 'drowned', pos: [10, 64, 0] }], { blocked: true }), DEFAULTS).decision, null)
})
test('water_shooter reflex triggers on a trident drowned at 10 m and 24 m, not at 30 m, not for a plain drowned', () => {
  const run = (e) => waterShooter.check({ bot: mk([e]), danger: { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) } })
  assert.ok(run(tri)); assert.ok(run({ ...tri, pos: [24, 64, 0] }))
  assert.equal(run({ ...tri, pos: [30, 64, 0] }), null)
  assert.equal(run({ name: 'drowned', pos: [10, 64, 0] }), null)
})

// ---- craft: honest no_table
function craftBot({ inv = [], table = null } = {}) {
  const bot = { registry: { blocksByName: { crafting_table: { id: 7 } }, itemsByName: { furnace: { id: 1 }, crafting_table: { id: 2 }, oak_planks: { id: 3 } } }, entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, inventory: { items: () => inv } }
  bot.findBlock = () => table
  bot.blockAt = () => ({ name: 'air', type: 0 })
  bot.recipesFor = () => []
  return bot
}
const cctx = (bot) => ({ bot, aborted: false, log: () => {}, sleep: async () => {}, goto: async () => ({ ok: true }) })
test('craft furnace with no table and no wood: no_table with the real cause', async () => {
  const r = await craftItem(cctx(craftBot({ inv: [{ name: 'cobblestone', count: 8 }] })), 'furnace', 1)
  assert.equal(r.ok, false); assert.equal(r.reason, 'no_table'); assert.match(r.detail, /no wood to make one/)
})
test('craft furnace: a table in reach is used (no table error), then the missing recipe is reported', async () => {
  const tb = { name: 'crafting_table', position: new Vec3(1, 64, 0) }
  const r = await craftItem(cctx(craftBot({ inv: [{ name: 'cobblestone', count: 8 }], table: tb })), 'furnace', 1)
  assert.notEqual(r.reason, 'no_table')
})
test('craft with planks but nowhere to place: honest no_table detail', async () => {
  const bot = craftBot({ inv: [{ name: 'oak_planks', count: 4 }, { name: 'cobblestone', count: 8 }] })
  bot.recipesFor = () => [{}]; bot.craft = async () => {}
  const r = await craftItem(cctx(bot), 'furnace', 1)
  assert.equal(r.reason, 'no_table'); assert.ok(r.detail)
})
