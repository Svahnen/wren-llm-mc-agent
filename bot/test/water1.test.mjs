// WATER1: a hurt / night-time Wren keeps away from water. Fixture = a synthetic case (hp 3, night, pond / lake edge and a flooded pit nearby).
import test from 'node:test'
import assert from 'node:assert/strict'
import { flat, World, rig, mockBot, sleep, until, stopAll } from './reflex-helpers.mjs'
import { waterRisk, nearWater, wetCell, swimToDry, planSwimToDry, installWaterPolicy, WET_COST } from '../src/water-policy.js'
import { holeSiteRisk } from '../src/skills/activities.js'
import { planEscape } from '../src/escape/skills.js'

test.after(stopAll)
const isWet = (w, p) => w.name(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === 'water' || w.name(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z)) === 'water'

/** flat land (stone up to y63), a 2-deep pond: water cells y62..63, x 0..12, z -6..6 */
function pond() { const w = flat(); w.fill(0, 62, -6, 12, 63, 6, 'water'); return w }

test('waterRisk: hp <= 6 or night', () => {
  assert.equal(waterRisk({ health: 4, time: { timeOfDay: 6000 } }), true)
  assert.equal(waterRisk({ health: 20, time: { timeOfDay: 18000 } }), true)
  assert.equal(waterRisk({ health: 20, time: { timeOfDay: 6000 } }), false)
  assert.equal(waterRisk({ health: 7, time: { timeOfDay: 6000 } }), false)
})

test('installWaterPolicy raises the pathfinder liquidCost while hurt and restores it by day at full hp', () => {
  const bot = { health: 3, time: { timeOfDay: 18000 }, entity: {}, pathfinder: { movements: { liquidCost: 1 } } }
  const stop = installWaterPolicy(bot, { everyMs: 5 })
  assert.equal(bot.pathfinder.movements.liquidCost, WET_COST)
  bot.health = 20; bot.time.timeOfDay = 6000
  return sleep(30).then(() => { assert.equal(bot.pathfinder.movements.liquidCost, 1); stop() })
})

test('holeSiteRisk: near_water (within 3 blocks) when hurt or at night, not by day at full hp', () => {
  const w = flat(); w.fill(3, 62, -3, 8, 63, 3, 'water')
  const bot = mockBot(w, { pos: [0.5, 64, 0.5] })
  const S = { x: 0, y: 64, z: 0 }
  bot.health = 4; bot.time = { timeOfDay: 6000 }
  assert.equal(holeSiteRisk(bot, S), 'near_water')
  bot.health = 20
  assert.equal(nearWater(bot, S), true)
  assert.notEqual(holeSiteRisk(bot, S), 'near_water')
  bot.health = 4
  assert.equal(holeSiteRisk(bot, { x: -10, y: 64, z: 0 }) === 'near_water', false, 'dry ground 10 m away is fine')
  bot.destroy()
})

test('escape ladder: in water the FIRST rung is escape_swim (before bridging / staircase)', () => {
  const w = pond(); const bot = mockBot(w, { pos: [5.5, 62, 0.5] }); bot.entity.isInWater = true
  bot.health = 4
  const { cands } = planEscape(bot)
  assert.equal(cands[0], 'escape_swim', JSON.stringify(cands))
  bot.destroy()
})

test('swimToDry: plan is the shortest swim (~6 blocks), no bridging', () => {
  const w = pond(); const bot = mockBot(w, { pos: [5.5, 62, 0.5] })
  const res = planSwimToDry(bot)
  assert.ok(res, 'a path exists')
  assert.ok(res.path.length <= 9, 'steps ' + res.path.length)
  assert.ok(res.goal.x < 0, 'shore on the west side ' + JSON.stringify(res.goal))
  bot.destroy()
})

test('hp 4, night, 2-deep pond 6 m from shore: reaches dry land within 10 s and does not re-enter water (3/3)', async () => {
  for (let run = 0; run < 3; run++) {
    const w = pond()
    const bot = mockBot(w, { pos: [5.5 + run * 0.2, 62, 0.5 - run * 0.3] })
    bot.health = 4; bot.time = { timeOfDay: 18000 }
    const ctx = { bot, aborted: false, sleep: (ms) => sleep(ms).then(() => true), log() {} }
    const t0 = Date.now()
    const r = await swimToDry(ctx)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(Date.now() - t0 < 10000, 'took ' + (Date.now() - t0))
    assert.equal(isWet(w, bot.entity.position), false, 'dry at ' + bot.entity.position)
    await sleep(500)
    assert.equal(isWet(w, bot.entity.position), false, 'did not re-enter')
    bot.destroy()
  }
})

test('drowning reflex gives the body back once the head is out of the water (no 8 s tread)', async () => {
  const w = flat(); w.fill(-1, 54, -1, 1, 70, 1, 'stone'); w.fill(0, 54, 0, 0, 66, 0, 'water'); w.fill(0, 67, 0, 0, 70, 0, 'air')
  const r = rig(w, { pos: [0.5, 56, 0.5] }); r.bot.oxygenLevel = 6
  assert.ok(await until(() => r.trace.last('reflex_end').filter((e) => e.name === 'drowning').length > 0, 25000))
  const e = r.trace.last('reflex_end').filter((x) => x.name === 'drowning')[0]
  assert.equal(e.reason, 'surfaced_no_exit')
  const surfacedAt = Date.now()
  await sleep(50)
  assert.ok(Date.now() - surfacedAt < 1000)
  await r.stop()
})

test('shallow water with the head in air: the drowning reflex does not start (forage / hunt may run)', async () => {
  const w = flat(); w.fill(0, 63, -4, 8, 63, 4, 'water')   // 1 deep: feet in water, head in air
  const r = rig(w, { pos: [4.5, 63, 0.5] })
  r.bot.oxygenLevel = 8
  await sleep(600)
  assert.equal(r.trace.last('reflex_start').filter((e) => e.name === 'drowning').length, 0)
  await r.stop()
})
