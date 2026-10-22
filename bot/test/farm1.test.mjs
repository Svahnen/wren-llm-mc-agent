// FARM1: pen helpers (slaughter >= 3 rule, breeding pick), food-security facts, bread recipe, playbook library.
import test from 'node:test'
import assert from 'node:assert/strict'
import { penAnimals, breedable, canSlaughter, isBaby, MIN_SLAUGHTER } from '../src/skills/farm1.js'
import { foodSecurityFacts, farmStatus, penStatus, rodStatus, _resetFoodSecCache } from '../src/mindlink/foodsec.js'
import { RECIPES, craftItem } from '../src/skills/craft.js'
import { getPlaybook, playbookNames } from '../src/playbooks/catalog.js'
import { PRED } from '../src/playbooks/predicates.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { SKILLS } from '../src/skills/schema.js'

const ent = (id, name, x, z, md) => ({ id, name, position: { x, y: 64, z }, metadata: md })
const botWith = (entities, inv = [], blocks = {}) => ({
  entity: { position: { x: 0, y: 64, z: 0 } }, entities: Object.fromEntries(entities.map((e) => [e.id, e])),
  inventory: { items: () => inv }, registry: { blocksByName: { wheat: { id: 1 }, carrots: { id: 2 }, potatoes: { id: 3 }, beetroots: { id: 4 }, sweet_berry_bush: { id: 5 } }, itemsByName: { fishing_rod: { maxDurability: 384 } } },
  findBlocks: ({ matching }) => (blocks.find ? blocks.find(matching) : []), blockAt: (p) => blocks.at?.(p) ?? { name: 'farmland', position: p },
})
const C = { x: 10, y: 64, z: 10 }

test('penAnimals counts only animals inside the pen square; babies are flagged', () => {
  const b = botWith([ent(1, 'cow', 10.5, 10.5), ent(2, 'cow', 11.5, 9.5), ent(3, 'cow', 30, 30), ent(4, 'cow', 10.2, 10.9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true]), ent(5, 'zombie', 10.5, 10.5)])
  const an = penAnimals(b, C)
  assert.equal(an.length, 3); assert.equal(an.filter((a) => a.baby).length, 1); assert.equal(isBaby(an[0].e), false)
})
test('slaughter rule: needs >= 3 animals in total and 2 adults of that kind; babies never', () => {
  const a = (name, baby = false) => ({ name, baby })
  assert.equal(MIN_SLAUGHTER, 3)
  assert.equal(canSlaughter([a('cow'), a('cow')]), null)
  assert.equal(canSlaughter([a('cow'), a('cow'), a('cow')]), 'cow')
  assert.equal(canSlaughter([a('cow'), a('cow', true), a('cow', true)]), null)
  assert.equal(canSlaughter([a('cow'), a('pig'), a('sheep')]), null)
  assert.equal(canSlaughter([a('cow'), a('cow'), a('pig')]), 'cow')
})
test('breedable: two adults of one kind and the right feed', () => {
  const inv = [{ name: 'wheat', count: 2 }]
  const b = botWith([], inv)
  const a = (name, baby = false) => ({ name, baby })
  assert.deepEqual(breedable(b, [a('cow'), a('cow')]).map((o) => o.kind), ['cow'])
  assert.deepEqual(breedable(b, [a('pig'), a('pig')]), [])          // pigs want carrots/potatoes
  assert.deepEqual(breedable(b, [a('cow'), a('cow', true)]), [])
})
test('food-security facts: farm stage from crop ages, pen count, rod durability, berries remembered', () => {
  _resetFoodSecCache()
  const crop = (x, age) => ({ name: 'wheat', position: { x, y: 65, z: 10 }, getProperties: () => ({ age }) })
  const crops = [crop(9, 7), crop(10, 3), crop(11, 0)]
  const lm = new Landmarks()
  lm.set('farm', { x: 10, y: 65, z: 10 }, 'place'); lm.set('pen', C, 'place')
  const b = botWith([ent(1, 'cow', 10.5, 10.5), ent(2, 'cow', 11.5, 9.5), ent(3, 'cow', 10.2, 10.9)], [{ name: 'fishing_rod', count: 1, durabilityUsed: 100 }],
    { find: (m) => (m === 5 || (Array.isArray(m) && m.includes(5)) ? [{ x: 20, y: 64, z: 20 }] : crops.map((c) => c.position)), at: (p) => crops.find((c) => c.position.x === p.x && p.y === 65) ?? { name: 'farmland', position: p } })
  const fs = foodSecurityFacts(b, lm, 1000)
  assert.equal(fs.farm.stage, 'ripe'); assert.equal(fs.farm.crops, 3); assert.equal(fs.farm.ripe, 1)
  assert.equal(fs.pen.total, 3); assert.deepEqual(fs.pen.kinds, { cow: 3 })
  assert.deepEqual(fs.rod, { durability_left: 284, durability_max: 384 })
  assert.ok(fs.berries, 'berry bush remembered as a place'); assert.equal(lm.get('berries').kind, 'food_area')
})
test('pen far away keeps the last known count and says it is stale', () => {
  const b = botWith([ent(1, 'cow', 10.5, 10.5), ent(2, 'cow', 11.5, 9.5)])
  assert.equal(penStatus(b, C).total, 2)
  b.entity.position = { x: 500, y: 64, z: 500 }
  const s = penStatus(b, C); assert.equal(s.total, 2); assert.equal(s.stale, true)
  assert.equal(rodStatus(botWith([])), null)
})
test('bread recipe: 3 wheat at a table; missing wheat is an honest reason', async () => {
  assert.deepEqual(RECIPES.bread, { wheat: 3, table: true })
  const bot = { entity: {}, inventory: { items: () => [{ name: 'wheat', count: 2 }, { name: 'crafting_table', count: 1 }] }, findBlock: () => ({ position: { x: 0, y: 64, z: 0 }, type: 1 }), registry: { blocksByName: { crafting_table: { id: 1 } }, itemsByName: {} } }
  bot.entity.position = { x: 0, y: 64, z: 0, constructor: Object }
  const ctx = { bot, env: {}, log() {}, sleep: async () => {}, goto: async () => ({ ok: true }), aborted: false }
  const r = await craftItem(ctx, 'bread', 1)
  assert.equal(r.ok, false); assert.equal(r.reason, 'missing_wheat')
})
test('skills + playbooks are registered; predicates work', () => {
  assert.ok(SKILLS.breed_animals && SKILLS.pen_slaughter)
  for (const n of ['breed_animals', 'pen_slaughter', 'food_round']) assert.ok(playbookNames().includes(n), n)
  const lm = new Landmarks(); const c = { bot: botWith([], [{ name: 'wheat_seeds', count: 3 }]), env: { landmarks: lm } }
  assert.equal(PRED.pen_known(c), false); lm.set('pen', C); assert.equal(PRED.pen_known(c), true)
  assert.equal(PRED.has_feed(c), true)
  assert.ok(getPlaybook('food_round').steps.length >= 3)
})
