// RS3: menu entries state the real state (seeds held, rod, bone meal, village), the eat emergency line, and the breed cap.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { rs3Menu } from '../menu-rs3.js'
import { farmMenu } from '../menu-farm1.js'

const dg = (o = {}) => normalizeDigest({ time: { day: 3, phase: 'day', ticks: 3000 }, pos: [0, 64, 0], health: 20, food: 8, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], players: [], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3 }], events: [], chat: [], recent_intents: [], ...o })
const texts = (m) => m.ok.map((o) => o.text)

test('seed_hunt says the seeds held and the honest odds; gone at 9 seeds or with a farm and 3 seeds', () => {
  const m = rs3Menu(dg({ inventory: { wheat_seeds: 3 } })); const t = texts(m).find((x) => /^seed_hunt/.test(x))
  assert.match(t, /you hold 3\/9 wheat seeds.*about 1 break in 8.*roughly 48 breaks for 6 more/)
  assert.ok(rs3Menu(dg({ inventory: { wheat_seeds: 9 } })).no.some((x) => /seed_hunt \(9\/9/.test(x)))
  assert.ok(rs3Menu(dg({ inventory: { wheat_seeds: 3 }, food_security: { farm: { dist: 9, crops: 9, ripe: 0, avg_age: 0.2, stage: 'growing' } } })).no.some((x) => /seed_hunt \(a farm exists/.test(x)))
  assert.ok(rs3Menu(dg({ time: { day: 1, phase: 'night', ticks: 15000 } })).no.some((x) => /seed_hunt \(night/.test(x)))
})
test('eat emergency line: rotten flesh at food <= 6 only when nothing better is held; never spider eye', () => {
  const t = texts(rs3Menu(dg({ food: 4, inventory: { rotten_flesh: 3 } }))).find((x) => /^eat item=rotten_flesh/.test(x))
  assert.match(t, /3 rotten flesh.*until food is 18.*On Easy starving stops at 5 hearts/)
  assert.ok(!texts(rs3Menu(dg({ food: 4, inventory: { rotten_flesh: 3, cooked_beef: 1 } }))).some((x) => /^eat item=rotten_flesh/.test(x)))
  assert.ok(!texts(rs3Menu(dg({ food: 4, inventory: { spider_eye: 3 } }))).some((x) => /spider/.test(x.split(':')[0])))
})
test('fish_session needs a rod and water, fish_hit needs fish in view; bone meal entries only with bone meal; village honest about daylight', () => {
  const rod = rs3Menu(dg({ inventory: { fishing_rod: 1 }, water_near_m: 6 })); assert.match(texts(rod).find((x) => /^fish_session/.test(x)), /rod is in the bag, water 6 m away/)
  const norod = rs3Menu(dg({ water_near_m: 6, nearby: [{ id: 'cod_1', kind: 'cod', cat: 'animal', dist: 5 }] }))
  assert.ok(norod.no.some((x) => /^fish_session \(no fishing rod/.test(x))); assert.match(texts(norod).find((x) => /^fish_hit/.test(x)), /1 cod in view/)
  assert.ok(!rs3Menu(dg()).ok.some((o) => /^bonemeal/.test(o.text)))
  assert.match(texts(rs3Menu(dg({ inventory: { bone_meal: 2 } }))).find((x) => /^bonemeal_grass/.test(x)), /NOT measured on this server yet/)
  const v = { places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3 }, { id: 'village_1', kind: 'village', pos: [200, 64, 0], dist: 200 }] }
  assert.match(texts(rs3Menu(dg(v))).find((x) => /^village_forage/.test(x)), /village_forage place=village_1 \(200 m/)
  assert.ok(rs3Menu(dg({ ...v, time: { day: 1, phase: 'day', ticks: 10800 } })).no.some((x) => /^village_forage \(200 m needs about/.test(x)))
})
test('breed menu: timers in the text, a kind at 6 is a NOT NOW; the RS3 entries reach the merged menu', () => {
  const pen = (n) => ({ food_security: { pen: { dist: 10, total: n, babies: 0, kinds: { cow: n } } }, inventory: { wheat: 4 } })
  assert.match(activityMenu(dg(pen(4)), { max: 14 }), /Parents rest 5 min after a birth, a baby needs 20 min/)
  assert.ok(farmMenu(dg(pen(6))).no.some((x) => /^breed_animals \(6 cows in the pen; it is kept at 4-6/.test(x)))
  assert.match(activityMenu(dg({ food: 5, inventory: { wheat_seeds: 1 } }), { max: 14 }), /seed_hunt count=9: you hold 1\/9/)
})
