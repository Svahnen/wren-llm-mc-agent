// FOOD2: observed: 'eat kelp' answered 9x at hp 3.1 with furnace + coal held. Eat-raw maps to cook; the action re-prompt is short and has a valid example.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeDigest, validate, parseOutput, eatToCook, cookFeasible, reactionMsg } from '../contract.js'
import { recoverMenu } from '../menu-food1.js'

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/food2-slice.json', import.meta.url), 'utf8'))
const dg = (o = {}) => normalizeDigest({ time: { day: 80, phase: 'day', ticks: 6000 }, pos: [101, 60, 100], health: F.health, food: F.food, low_hp_s: 130, inventory: F.inventory, nearby: [{ id: 'creeper_1', kind: 'creeper', cat: 'hostile', dist: 24.7 }], places: [], ...o })

test('fixture: eat kelp with furnace and coal maps to cook {} with an honest note', () => {
  const d = dg(), p = parseOutput(F.answer), v = validate(p, d, {})
  assert.ok(!v.ok && v.errors.every((e) => e.code === 'item_not_edible'))
  assert.equal(cookFeasible(d), true)
  const m = eatToCook(p, d, v)
  assert.ok(m); assert.equal(m.parsed.act, 'cook'); assert.deepEqual(m.parsed.args, {})
  assert.match(m.note, /raw kelp is not food; your body is cooking it into dried_kelp instead/)
  assert.ok(validate(m.parsed, d, {}).ok)
})
test('no mapping without fuel, without a furnace, or for other errors / real food', () => {
  const nofuel = dg({ inventory: { kelp: 1, furnace: 1 } }), p = parseOutput(F.answer)
  assert.equal(eatToCook(p, nofuel, validate(p, nofuel, {})), null)
  const nofurn = dg({ inventory: { kelp: 1, coal: 3 } })
  assert.equal(eatToCook(p, nofurn, validate(p, nofurn, {})), null)
  const ok = dg({ inventory: { kelp: 1, coal: 3, furnace: 1, bread: 1 } }), pb = parseOutput('{act:eat,args:{item:bread}}\n---\nI eat.')
  assert.equal(eatToCook(pb, ok, validate(pb, ok, {})), null)
})
test('action re-prompt is short, names {act:none}, and gives a valid example line', () => {
  const m = reactionMsg(dg())
  assert.ok(m.length < 300 && m.length < F.old_reprompt_msg.length * 2)
  assert.match(m, /for example \{act:cook,args:\{\}\}/)
  assert.ok(validate(parseOutput('{act:cook,args:{}}\n---\nCooking.'), dg(), {}).ok)
  assert.match(reactionMsg(dg({ inventory: { stick: 2 } })), /for example \{act:flee,args:\{from:creeper_1\}\}/)
  assert.match(reactionMsg(dg({ inventory: {}, nearby: [] })), /for example \{act:idle_activity,args:\{kind:rest\}\}/)
})
test('recover plan triggers on the fixture state after 2 min (no hostile within 16 m)', () => {
  assert.match(recoverMenu(dg({ time: { day: 80, phase: 'night', ticks: 15000 } })).ok[0].text, /cook it right here in cover/)
  assert.equal(recoverMenu(dg({ low_hp_s: 100 })).ok.length, 0)
})
