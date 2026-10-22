// DAY1: hurt + foodless in daylight: forage is the top menu option with a reason; never "no options" while daylight remains; thunder/night/dusk do not offer it.
// Digest mirrors the live state (trace/mindlink observed): hp 3.1, food 9, nothing edible, pond next to her.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { forageMenu } from '../menu-food1.js'

const dg = (o = {}) => normalizeDigest({ time: { day: 5, phase: 'day', ticks: 4000 }, pos: [100, 59, 99], health: 3.1, food: 9, low_hp_s: 600, inventory: { oak_log: 2, furnace: 1, coal: 3 }, nearby: [], players: [], places: [], hazards: [], ...o })

test('daylight, hp 3.1, food 9, nothing edible: forage is menu entry 1 with a reason and the ways', () => {
  const m = activityMenu(dg())
  assert.match(m, /\n1\. forage \(hp 3\.1/)
  assert.match(m, /nothing edible/); assert.match(m, /resource_expedition resource=food max_dist=120/); assert.match(m, /get_food/)
})
test('animals in sight and string+sticks are named in the line', () => {
  const t = forageMenu(dg({ inventory: { stick: 3, string: 2 }, nearby: [{ id: 'cow_1', name: 'cow', cat: 'passive', dist: 30, tags: [] }] })).text
  assert.match(t, /craft a fishing rod/); assert.match(t, /1 animals within 48 m/)
})
test('thunderstorm, night, dusk, edible food in the pack: no forage line (shelter / eat instead)', () => {
  assert.equal(forageMenu(dg({ thunder: true })), null)
  assert.equal(forageMenu(dg({ time: { day: 5, phase: 'night', ticks: 15000 } })), null)
  assert.equal(forageMenu(dg({ time: { day: 5, phase: 'day', ticks: 12000 } })), null, 'under 2 min to dusk')
  assert.equal(forageMenu(dg({ inventory: { cooked_cod: 2 } })), null)
  assert.equal(forageMenu(dg({ health: 20, food: 15 })), null, 'healthy and fed')
})
test('a hostile within 16 m: dig_in stays first, forage is still listed (never an empty menu)', () => {
  const m = activityMenu(dg({ inventory: { cobblestone: 20 }, nearby: [{ id: 'zombie_1', name: 'zombie', cat: 'hostile', dist: 10, tags: [] }] }))
  assert.match(m, /\n1\. dig_in/); assert.match(m, /\n2\. forage \(hp 3\.1/)
})
test('not hurt long enough yet (recover not active) still offers forage at hp 3', () => {
  assert.match(activityMenu(dg({ low_hp_s: 20 })), /\n1\. forage/)
})
