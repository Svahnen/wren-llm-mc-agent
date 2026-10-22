// FARM1: food security status, set-up options with feasibility, morning round hook, project idea (offered, never set).
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { foodSecurity, foodSecurityLine, farmMenu, morningRoundLine, farmIdea } from '../menu-farm1.js'
import { projectOptions } from '../menu-goal3.js'
import { buildMessages } from '../prompt.js'

const dg = (o = {}) => normalizeDigest({ time: { day: 3, phase: 'day', ticks: 3000 }, pos: [0, 64, 0], health: 20, food: 20, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], players: [], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3, dir: 'here' }], events: [], chat: [], recent_intents: [], difficulty: 'easy', failures: [], ...o })
const lines = (t) => t.split('\n').filter((l) => /^\d+\./.test(l))

test('food security: points in the bag, days, sources; nothing known says so', () => {
  const s = foodSecurity(dg({ food: 7, inventory: { bread: 2, cooked_cod: 1, kelp: 3 } }))
  assert.equal(s.pts, 15); assert.equal(s.raw_pts, 3); assert.equal(s.level, 'none'); assert.ok(s.days < 3); assert.equal(foodSecurity(dg({ food: 3 })).level, 'low')
  assert.match(s.text, /15 hunger points of food in your bag \(\+3 if you cook what is raw\)/)
  assert.match(s.text, /no farm, animal pen or fishing spot of your own yet/)
})
test('food security: farm stage, pen count, rod durability and berries appear; a growing farm + food = ok', () => {
  const d = dg({ food: 18, inventory: { bread: 5, fishing_rod: 1 }, food_security: { farm: { dist: 20, crops: 9, ripe: 0, avg_age: 0.4, stage: 'growing' }, pen: { dist: 25, total: 2, babies: 0, kinds: { cow: 2 } }, rod: { durability_left: 300 }, berries: { dist: 60 } } })
  const s = foodSecurity(d)
  assert.equal(s.level, 'ok')
  assert.match(s.text, /farm plot 20 m away: 9 crops growing \(40% grown\)/)
  assert.match(s.text, /animal pen 25 m away: 2 animals \(2 cow\), killing waits until 3/)
  assert.match(s.text, /fishing rod \(300 casts of durability left\)/)
  assert.match(s.text, /sweet berry bushes remembered 60 m away/)
})
test('low food, nothing renewable: set-up options with feasibility; farm_plot is offered but never a forced goal', () => {
  const t = activityMenu(dg({ food: 6, inventory: { oak_planks: 6, stick: 4, wheat_seeds: 3 }, nearby: [{ id: 'cow_1', kind: 'cow', cat: 'animal', dist: 8, tags: ['animal'] }] }), { max: 12 })
  const l = lines(t).find((x) => /farm_plot/.test(x))
  assert.ok(l, t); assert.match(l, /hoe can be crafted \(6 planks worth of wood/); assert.match(l, /3 seeds held/); assert.match(l, /remembered/)
  assert.match(t, /NOT NOW:.*animal_pen \(6\/28 blocks or 15 fences\)/)
  assert.match(t, /fish \(no fishing rod and 0 string/)
})
test('night: farm_plot is a NOT NOW line, no farm creation', () => {
  const t = activityMenu(dg({ time: { day: 3, phase: 'night', ticks: 15000 }, food: 6, inventory: { oak_planks: 4 } }), { max: 12 })
  assert.ok(!lines(t).some((x) => /farm_plot/.test(x))); assert.match(t, /farm_plot \(night/)
})
test('ripe farm and low food: harvest_farm ranks high; wheat >= 3 offers bread; growing farm is NOT NOW', () => {
  const fs = (stage, ripe) => ({ farm: { dist: 12, crops: 9, ripe, avg_age: stage === 'ripe' ? 1 : 0.3, stage } })
  let t = activityMenu(dg({ food: 6, inventory: { wheat: 4 }, food_security: fs('ripe', 9) }), { max: 12 })
  assert.match(lines(t).find((x) => /harvest_farm/.test(x)), /harvest_farm \(12 m\): 9\/9 crops are ripe/)
  assert.match(t, /craft item=bread: 1 bread from 4 wheat/)
  t = activityMenu(dg({ food: 6, food_security: fs('growing', 0) }), { max: 12 })
  assert.ok(!lines(t).some((x) => /harvest_farm/.test(x))); assert.match(t, /harvest_farm \(crops about 30% grown/)
})
test('pen: slaughter only with >= 3 animals; breed needs feed', () => {
  const pen = (n) => ({ pen: { dist: 10, total: n, babies: 0, kinds: { cow: n } } })
  let r = farmMenu(dg({ food: 8, inventory: { wheat: 2 }, food_security: pen(2) }))
  assert.ok(r.ok.some((o) => /^breed_animals/.test(o.text))); assert.ok(r.no.some((n) => /^pen_slaughter \(the pen has 2 animals, killing waits until 3\)/.test(n)))
  r = farmMenu(dg({ food: 8, inventory: {}, food_security: pen(3) }))
  assert.ok(r.ok.some((o) => /^pen_slaughter/.test(o.text))); assert.ok(r.no.some((n) => /^breed_animals/.test(n)))
})
test('morning routine hook: food_round ranks high in the morning when a farm or pen exists, quiet later; prompt carries the round line', () => {
  const fs = { farm: { dist: 12, crops: 9, ripe: 2, avg_age: 0.5, stage: 'ripe' } }
  const m = farmMenu(dg({ time: { day: 4, phase: 'day', ticks: 500 }, food: 18, inventory: { bread: 5 }, food_security: fs })).ok.find((o) => /^food_round/.test(o.text))
  const l = farmMenu(dg({ time: { day: 4, phase: 'day', ticks: 9000 }, food: 18, inventory: { bread: 5 }, food_security: fs })).ok.find((o) => /^food_round/.test(o.text))
  assert.ok(m.score > 6 && l.score < 3)
  assert.match(morningRoundLine(dg({ food_security: fs })), /harvest and replant the farm/)
  assert.equal(morningRoundLine(dg()), null)
  const msgs = buildMessages({ job: 'idle', digest: dg({ food_security: fs, food: 18 }), ctx: {}, autonomy: 'high' })
  assert.match(msgs[1].content, /Your morning round/)
  assert.match(msgs[1].content, /food security: /)
})
test('project idea: offered in the no-goal list only when food is not secure; never auto-set', () => {
  assert.match(projectOptions(dg({ food: 7 })).join('; '), /make a farm near home/)
  assert.ok(!projectOptions(dg({ food: 20, inventory: { bread: 20 }, food_security: { farm: { dist: 5, crops: 9, ripe: 0, avg_age: 0.1, stage: 'growing' } } })).join('; ').includes('make a farm'))
  assert.equal(farmIdea(dg({ food_security: { farm: { dist: 5, crops: 1, ripe: 0, stage: 'growing' } }, food: 3 })), null)
  const msgs = buildMessages({ job: 'idle', digest: dg({ food: 7 }), ctx: {}, autonomy: 'high', noProject: true })
  assert.match(msgs[1].content, /make a farm near home/)
})
test('line is hidden when food is fine and nothing is known', () => { assert.equal(foodSecurityLine(dg({ food: 20, inventory: { bread: 30 } })), null) })
