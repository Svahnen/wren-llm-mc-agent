// FOOD1: edible-only food lines, item_not_edible re-prompt content, recover plan.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest, validate, parseOutput, edibleLine, cookableLine } from '../contract.js'
import { renderDigest, buildRepair } from '../prompt.js'
import { activityMenu } from '../menu.js'
import { recoverMenu } from '../menu-food1.js'
import { survivalOptions } from '../survival.js'

const dg = (o = {}) => ({ time: { day: 5, phase: 'night', ticks: 15000 }, pos: [0, 64, 0], health: 3, food: 8, low_hp_s: 1800, sheltered: true, inventory: { kelp: 12, cobblestone: 20 }, nearby: [], places: [{ id: 'bed_1', kind: 'bed', pos: [107, 64, 0], dist: 107, dir: 'east' }], ...o })
const V = (t, d) => validate(parseOutput(t), normalizeDigest(d), {})

test('Edible/Cookable lines: only edible items with values, kelp is cookable not edible', () => {
  const d = normalizeDigest(dg({ inventory: { cooked_cod: 3, bread: 1, kelp: 12, beef: 2, oak_log: 4 } }))
  assert.equal(edibleLine(d), 'Edible: cooked_cod x3 (+5 each), bread x1 (+5), beef x2 (+3 each)')
  assert.equal(cookableLine(d), 'Cookable (needs a furnace and fuel): kelp x12 -> dried_kelp, beef x2 -> cooked_beef')
  const t = renderDigest(dg({ inventory: { cooked_cod: 3, bread: 1, kelp: 12 } }))
  assert.match(t, /Edible: cooked_cod x3 \(\+5 each\), bread x1 \(\+5\)\n/)
  assert.match(t, /Cookable \(needs a furnace and fuel\): kelp x12 -> dried_kelp/)
  assert.ok(!/kelp x12 \(food\)/.test(t))
})
test('nothing edible: line says so, kelp never suggested for eat', () => {
  assert.equal(edibleLine(normalizeDigest(dg())), 'Edible: nothing you hold')
})
test('item_not_edible re-prompt carries the exact edible list', () => {
  const d = dg({ inventory: { kelp: 12, cooked_cod: 3, bread: 1 } })
  const v = V('{act:eat,args:{item:kelp}}\n---\nI eat.', d)
  const e = v.errors.find((x) => x.code === 'item_not_edible')
  assert.ok(e)
  assert.equal(e.msg, 'eat.item: "kelp" is not edible raw (cook it into dried_kelp first: {act:cook,args:{}}). Edible: cooked_cod x3 (+5 each), bread x1 (+5). Cookable (needs a furnace and fuel): kelp x12 -> dried_kelp')
  const m = buildRepair([{ role: 'user', content: 'x' }], 'bad', v.errors)
  assert.match(m.at(-1).content, /Edible: cooked_cod x3 \(\+5 each\), bread x1 \(\+5\)/)
  assert.ok(V('{act:eat,args:{item:cooked_cod}}\n---\nI eat.', d).ok)
})
test('recover plan: eat first, cook when only raw, wait/get food otherwise', () => {
  const eat = recoverMenu(normalizeDigest(dg({ inventory: { bread: 2, kelp: 5 }, food: 6 })))
  assert.match(eat.ok[0].text, /^recover \(hp 3 for 30 min\): eat until food is 18 so you heal naturally: bread x2; start with \{act:eat,args:\{item:bread\}\}/)
  const cook = recoverMenu(normalizeDigest(dg({ inventory: { kelp: 12, cobblestone: 20, oak_planks: 4 } })))
  assert.match(cook.ok[0].text, /raw kelp x12 -> dried_kelp: cook it right here in cover/)
  const nofuel = recoverMenu(normalizeDigest(dg({ inventory: { kelp: 12, cobblestone: 20 } })))
  assert.match(nofuel.ok[0].text, /wait in cover until day/); assert.ok(nofuel.no.some((x) => /^cook \(no fuel/.test(x)))
  const day = recoverMenu(normalizeDigest(dg({ inventory: {}, time: { day: 5, phase: 'day', ticks: 3000 } })))
  assert.match(day.ok[0].text, /forage \(hp 3 for 30 min.*get_food/)
})
test('recover only after > 2 min at low hp and no hostile near', () => {
  assert.equal(recoverMenu(normalizeDigest(dg({ low_hp_s: 100, inventory: { bread: 1 } }))).ok.length, 0)
  assert.equal(recoverMenu(normalizeDigest(dg({ health: 9, inventory: { bread: 1 } }))).ok.length, 0)
  const h = recoverMenu(normalizeDigest(dg({ inventory: { bread: 1 }, nearby: [{ id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 8 }] })))
  assert.equal(h.ok.length, 0); assert.match(h.no[0], /hostile mob within 16 m/)
})
test('menu: recovering at night denies the 107 m bed walk and shows recover first', () => {
  const t = activityMenu(normalizeDigest(dg({ inventory: { bread: 2, cobblestone: 20 } })))
  assert.match(t, /\n1\. recover \(hp 3 for 30 min\)/)
  assert.match(t, /sleep_at_night \(recovering at hp 3: 107 m is too far to walk at night while hurt\)/)
  assert.ok(!/\d\. sleep_at_night/.test(t))
  const d = activityMenu(normalizeDigest(dg({ inventory: { bread: 2 }, time: { day: 5, phase: 'day', ticks: 3000 } })))
  assert.ok(!/recovering at hp/.test(d))
})
test('survival option for a far refuge at night says staying is safer', () => {
  const o = survivalOptions(normalizeDigest(dg({ places: [{ id: 'home', kind: 'home', pos: [100, 64, 0], dist: 107, dir: 'east' }] })))
  assert.match(o.find((x) => x.key === 'go_refuge').text, /at night and hurt this is a long way in the dark/)
})
