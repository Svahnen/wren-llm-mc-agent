// FOOD4: fishing needs a rod; hunt/forage may take the body from non-urgent s1 work when hungry; food-episode counting; farm_plot honesty.
import test from 'node:test'
import { unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { rodStatus } from '../src/playbooks/priority.js'
import { mayPreemptForFood } from '../src/food-preempt.js'
import { Arbiter } from '../src/arbiter.js'
import { FoodEpisodes } from '../src/mindlink/foodepisodes.js'
import { PRED } from '../src/playbooks/predicates.js'
import '../src/playbooks/predicates-pb4.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { makeRig } from './helpers.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
const FOODS = { bread: { foodPoints: 5 } }
function mkBot({ food = 2, hp = 9, items = [], tod = 2000, age = 24000 * 3 } = {}) {
  return { username: 'Wren', health: hp, food, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, players: {}, thunderState: 0, time: { timeOfDay: tod, age },
    inventory: { items: () => items, emptySlotCount: () => 20 }, registry: { foodsByName: FOODS, blocksByName: { crafting_table: { id: 99 } } }, findBlock: () => null }
}
const it = (name, count = 1) => ({ name, count })

test('rodStatus: rod, or 2 string + (3 sticks | 2 planks | 1 log); the live case (2 sticks, 3 string) is refused with an honest text', () => {
  assert.equal(rodStatus({ rod: 1 }).ok, true)
  assert.equal(rodStatus({ string: 3, sticks: 3 }).ok, true)
  assert.equal(rodStatus({ string: 2, planks: 2 }).ok, true)
  const live = rodStatus({ string: 3, sticks: 2 })
  assert.equal(live.ok, false); assert.match(live.text, /3 string and 2 sticks/)
  assert.match(rodStatus({ string: 1, sticks: 5 }).text, /1 string/)
})

test('engine.start(fish): no rod and cannot craft -> refused before any step; with a rod or craftable -> starts', () => {
  const calls = []
  const run = async (n) => { calls.push(n); return { status: 'done', ms: 1 } }
  const mk = (items) => createPlaybookEngine({ getBot: () => mkBot({ food: 12, items }), runSkill: run, env: { landmarks: new Landmarks(), foodSeen: new Map() }, sleep: async () => {} })
  const no = mk([it('string', 3), it('stick', 2)]).start('fish', {})
  assert.equal(no.ok, false); assert.equal(no.noRod, true); assert.match(no.errors[0], /cannot fish.*3 string and 2 sticks/)
  assert.equal(calls.length, 0)
  assert.equal(mk([it('fishing_rod')]).start('fish', {}).ok, true)
  assert.equal(mk([it('string', 2), it('stick', 3)]).start('fish', {}).ok, true)
})

test('mayPreemptForFood: hunt may take a non-urgent s1 holder when hungry and foodless; never from reflexes, never when it holds food', () => {
  const b = mkBot({ food: 2 })
  assert.equal(mayPreemptForFood(b, 'hunt', { owner: 's1', label: 'explore' }).yes, true)
  assert.equal(mayPreemptForFood(b, 'forage_plants', { owner: 's1', label: 'explore' }).yes, true)
  assert.equal(mayPreemptForFood(b, 'hunt', { owner: 's1', label: 'shelter' }).yes, true)     // daylight, nothing near
  assert.equal(mayPreemptForFood(b, 'hunt', { owner: 'reflex', label: 'eat' }).yes, false)
  assert.equal(mayPreemptForFood(b, 'hunt', { owner: 's1', label: 'dig_in' }).yes, false)
  assert.equal(mayPreemptForFood(b, 'move_to', { owner: 's1', label: 'explore' }).yes, false)
  assert.equal(mayPreemptForFood(mkBot({ food: 12 }), 'hunt', { owner: 's1', label: 'explore' }).yes, false)
  assert.equal(mayPreemptForFood(mkBot({ food: 2, items: [it('bread')] }), 'hunt', { owner: 's1', label: 'explore' }).yes, false)
  assert.equal(mayPreemptForFood(mkBot({ food: 2, tod: 11500 }), 'hunt', { owner: 's1', label: 'shelter' }).yes, false)   // near dusk the shelter stays
  assert.equal(mayPreemptForFood(mkBot({ food: 2, tod: 11500 }), 'hunt', { owner: 's1', label: 'explore' }).yes, true)
})

test('arbiter: mayTake lets hunt take the body from a same-priority explore; without it the request is denied', async () => {
  const { arbiter } = makeRig()
  let aborted = null
  const t1 = await arbiter.acquire('s1', { label: 'explore', onPreempt: (r) => { aborted = r } })
  assert.equal(await arbiter.acquire('s1', { label: 'hunt' }), null)
  const t2 = await arbiter.acquire('s1', { label: 'hunt', mayTake: (h) => ({ yes: h.label === 'explore', why: 'test' }) })
  assert.ok(t2); assert.equal(t1.active, false); assert.match(aborted, /preempted_by:s1:hunt/)
  assert.equal(await arbiter.acquire('s1', { label: 'x', mayTake: () => ({ yes: false }) }), null)
  const t3 = await arbiter.acquire('reflex', { label: 'eat' }); assert.ok(t3)
  assert.equal(await arbiter.acquire('s1', { label: 'hunt', mayTake: () => ({ yes: true }) }), null)   // a reflex holder is never taken
})

test('FoodEpisodes: counts food <= 6 episodes per game day, recovery at 8 needed, persisted', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'food-ep-')), 'food-ep-test.json')
  try { unlinkSync(file) } catch { /* none */ }
  const ep = new FoodEpisodes({ file })
  const at = (food, day) => mkBot({ food, age: 24000 * (day - 1) + 100 })
  for (const f of [10, 6, 3, 0, 5, 7]) ep.tick(at(f, 5))   // one episode (never reached 8)
  assert.equal(ep.facts(at(7, 5)).today, 1)
  ep.tick(at(8, 5)); ep.tick(at(4, 5)); ep.tick(at(9, 5)); ep.tick(at(2, 5))   // two more
  assert.equal(ep.facts(at(2, 5)).today, 3)
  assert.equal(ep.facts(at(2, 6)).yesterday, 3); assert.equal(ep.facts(at(2, 6)).today, 0)
  const again = new FoodEpisodes({ file }); assert.equal(again.facts(at(2, 5)).today, 3); assert.equal(again.inEpisode, true)
  assert.equal(new FoodEpisodes({}).facts(at(20, 1)), null)
})

test('can_make_hoe is honest: 1 log is not enough without a table, enough with one in reach', () => {
  const c = (items, table) => { const b = mkBot({ items }); if (table) b.findBlock = () => ({}); return { bot: b } }
  assert.equal(PRED.can_make_hoe(c([it('oak_log')])), false)
  assert.equal(PRED.can_make_hoe(c([it('oak_log', 2)])), true)         // 8 planks: sticks 2 + hoe 2 + table 4
  assert.equal(PRED.can_make_hoe(c([it('oak_log')], true)), true)      // 4 planks with a table in reach
  assert.equal(PRED.can_make_hoe(c([it('oak_planks', 2), it('stick', 2)], true)), true)
})
