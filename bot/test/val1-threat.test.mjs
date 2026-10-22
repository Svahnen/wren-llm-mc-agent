// VAL1: false threats. Passive/neutral/fish entities are never threats; far hostiles behind rock or far above/below do not trigger flee/defend; S2 cannot flee from a salmon.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { assess, hostilesAround, relevantThreat } from '../src/reflex/threats.js'
import { DEFAULTS } from '../src/reflex/defaults.js'
import { makeMoveSkills } from '../src/skills/move.js'

const mk = (ents, { blocked = false } = {}) => {
  const me = new Vec3(0, 64, 0)
  const bot = { entity: { position: me, height: 1.8 }, health: 20, inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, entities: {}, world: { raycast: () => (blocked ? { position: new Vec3(3, 64, 0) } : null) } }
  ents.forEach((e, i) => { bot.entities[i + 1] = { id: i + 1, isValid: true, height: 1.8, ...e, position: new Vec3(...e.pos) } })
  return bot
}
test('observed entity types (salmon, cod, sheep, pig, cow, chicken, bee, enderman, wolf, villager, item) are never threats', () => {
  const names = ['salmon', 'cod', 'tropical_fish', 'squid', 'sheep', 'pig', 'cow', 'chicken', 'bee', 'enderman', 'wolf', 'villager', 'item', 'bat']
  const bot = mk(names.map((name, i) => ({ name, pos: [2 + i * 0.1, 64, 1] })))
  assert.equal(hostilesAround(bot, 20).length, 0)
  assert.equal(assess(bot, DEFAULTS).decision, null)
})
test('zombie 12 m away behind rock: no fight and no flee; the same zombie in the open triggers', () => {
  assert.equal(assess(mk([{ name: 'zombie', pos: [8, 64, 0] }], { blocked: true }), DEFAULTS).decision, null)
  assert.equal(assess(mk([{ name: 'zombie', pos: [8, 64, 0] }]), DEFAULTS).decision, 'fight')
})
test('zombie 4 m away is a threat even without line of sight', () => {
  assert.equal(assess(mk([{ name: 'zombie', pos: [4, 64, 0] }], { blocked: true }), DEFAULTS).decision, 'fight')
})
test('flee-class mob (witch) 12 m behind a wall or 9 m below does not make her flee', () => {
  assert.equal(assess(mk([{ name: 'witch', pos: [12, 64, 0] }], { blocked: true }), DEFAULTS).decision, null)
  assert.equal(assess(mk([{ name: 'witch', pos: [8, 52, 0] }]), DEFAULTS).decision, null)
  assert.equal(assess(mk([{ name: 'witch', pos: [8, 64, 0] }]), DEFAULTS).decision, 'flee')
})
test('relevantThreat: neutral/unknown false', () => {
  const bot = mk([{ name: 'enderman', pos: [3, 64, 0] }, { name: 'salmon', pos: [3, 64, 0] }])
  assert.equal(relevantThreat(bot, bot.entities[1]), false); assert.equal(relevantThreat(bot, bot.entities[2]), false)
})
test('flee skill refuses a non-hostile target (salmon) with not_a_threat', async () => {
  const skills = makeMoveSkills({ trail: { reversed: () => [] }, landmarks: null })
  const flee = (Array.isArray(skills) ? skills : Object.values(skills)).find((s) => s.name === 'flee')
  const bot = mk([{ name: 'salmon', pos: [3, 64, 0] }]); bot.username = 'W'
  const r = await flee.run({ bot, args: { from: 'salmon_1' }, state: {}, goto: async () => ({ ok: true }), aborted: false })
  assert.equal(r.reason, 'not_a_threat')
})

import { OPTIONS } from '../src/s1/goals.js'
import { huntFish } from '../src/skills/gather.js'
test('get_food has a hunt_fish option that applies only when fish are near and the pack has room; targets the fish via hunt', () => {
  const o = OPTIONS.get_food.find((x) => x.name === 'hunt_fish')
  assert.ok(o); assert.equal(o.skill, 'hunt'); assert.deepEqual(o.args(), { target: 'fish' })
  assert.equal(o.applies({ fish: 2, inv: { free: 5 } }), true)
  assert.equal(o.applies({ fish: 0, inv: { free: 5 } }), false)
})
test('huntFish with no fish around fails with no_animal_nearby (no pathing into water)', async () => {
  const bot = mk([{ name: 'sheep', pos: [3, 64, 0] }]); bot.inventory.items = () => []; bot.pathfinder = { setGoal() {} }; bot.registry = {}
  const ctx = { bot, args: {}, state: {}, aborted: false, sleep: async () => true, log() {}, goto: async () => ({ ok: false }) }
  const r = await huntFish(ctx, {}, 'salmon')
  assert.deepEqual([r.ok, r.reason], [false, 'no_animal_nearby'])
})
