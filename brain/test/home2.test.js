// HOME2: food <= 6 at full hp in daylight makes 'forage' the top entry; fishing is offered only with water in range.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { forageMenu } from '../menu-food1.js'

// live state observed: hp 19, food 4, nothing edible, no water near home (fish no_water 4x); phase here is daytime
const dg = (o = {}) => normalizeDigest({ time: { day: 5, phase: 'day', ticks: 3000 }, pos: [100, 66, 101], health: 19, food: 4, inventory: { string: 2, stick: 3, oak_planks: 2 }, nearby: [], water_near_m: null, ...o })

test('hp 19, food 4, daylight, nothing edible: forage is entry 1 with the means', () => {
  const m = activityMenu(dg())
  assert.match(m, /\n1\. forage \(hp 19, food 4/)
  assert.match(m, /resource_expedition resource=food/); assert.match(m, /get_food/)
})
test('no water within range: no fishing anywhere in the menu (forage, get_food, fish, farm)', () => {
  const m = activityMenu(dg())
  const fishLines = m.split('\n').filter((l) => /^\d+\./.test(l) && /fish(?!ing\)| \()/i.test(l) && !/no fishing/.test(l))
  assert.deepEqual(fishLines, [], fishLines.join(' | '))
  assert.match(m, /fish \(no water within 16 m\)/)
})
test('water within 16 m: fishing is named again; unknown water (old body) keeps the old behaviour', () => {
  assert.match(forageMenu(dg({ water_near_m: 9 })).text, /craft a fishing rod/)
  assert.match(forageMenu(dg({ water_near_m: undefined })).text, /craft a fishing rod/)
  assert.doesNotMatch(forageMenu(dg({ water_near_m: 40 })).text, /fishing rod/)
  assert.match(activityMenu(dg({ water_near_m: 9 })), /\n\d+\. fish/)
})
test('food 7 at full hp: no forage push; food 6: forage', () => {
  assert.equal(forageMenu(dg({ food: 7 })), null)
  assert.ok(forageMenu(dg({ food: 6 })))
})
