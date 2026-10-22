import test from 'node:test'
import assert from 'node:assert/strict'
import { flat, rig, sleep, until, noKeys, stopAll } from './reflex-helpers.mjs'
import { cellOf } from '../src/reflex/nav.js'

test.after(stopAll)
const ends = (r, name) => r.trace.last('reflex_end').filter((e) => e.name === name)
const burnOn = (bot) => { bot.entity.metadata[0] = 1 }
// the flag goes out in water or on demand
const flameOut = (r, { after = Infinity } = {}) => { const t0 = Date.now(); const iv = setInterval(() => { if (r.bot.entity.isInWater || Date.now() - t0 > after) r.bot.entity.metadata[0] = 0 }, 20); return () => clearInterval(iv) }

test('L1 burning on dry land: walks to water within 8 blocks and stays in charge until the fire is out', async () => {
  const w = flat(); w.fill(6, 62, -1, 8, 63, 1, 'water') // pond 5 blocks east
  w.fill(6, 63, -1, 8, 63, 1, 'water')
  const r = rig(w, { pos: [0.5, 64, 0.5] })
  const stop = flameOut(r)
  r.bot.food = 5; r.bot.give('bread', 3)
  // count only bites taken WHILE the flag is set: once the fire is out she may (rightly) eat at once, and the poll below can lag behind that
  let ateBurning = 0; const consume0 = r.bot.consume
  r.bot.consume = async (...a) => { if ((r.bot.entity.metadata[0] & 1) === 1) ateBurning++; return consume0.apply(r.bot, a) }
  burnOn(r.bot)
  assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 8000), 'reflex ended')
  stop()
  const e = ends(r, 'lava_fire')[0]
  assert.equal(e.ok, true, JSON.stringify(e))
  assert.ok(r.bot.entity.position.x > 4.5, 'moved toward the water: ' + r.bot.entity.position.x)
  assert.equal(ateBurning, 0, 'did not eat while burning')
  assert.ok(noKeys(r.bot)); assert.equal(r.arbiter.holder?.owner === 'reflex' && r.arbiter.holder?.label === 'lava_fire', false)
  await r.stop()
})

test('L1 burning, no water anywhere: the reflex keeps the body (no skill, no eat) until the fire is out', async () => {
  const w = flat()
  const r = rig(w, { pos: [0.5, 64, 0.5] })
  r.bot.food = 5; r.bot.give('bread', 3)
  const stop = flameOut(r, { after: 3000 })
  burnOn(r.bot)
  assert.ok(await until(() => r.arbiter.holder?.label === 'lava_fire', 2000), 'reflex took the body')
  await sleep(2200)
  assert.equal(r.arbiter.holder?.label, 'lava_fire', 'still in charge after 2 s of fire (old code: gave up after 1.5 s and went quiet for 8 s)')
  assert.equal(await r.arbiter.acquire('s1', { label: 'explore' }), null, 'other skills are denied')
  assert.equal(r.bot.calls.consume, 0, 'no eat while burning')
  assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 6000), 'ended after the fire went out')
  stop()
  assert.equal(ends(r, 'lava_fire')[0].ok, true)
  await r.stop()
})

test('L1 leaving lava while the flag stays unreliable: hp falling with no mob near still counts as burning', async () => {
  const w = flat(); w.fill(-2, 63, -2, 0, 64, 2, 'lava'); w.fill(-2, 62, -2, 0, 62, 2, 'stone')
  const r = rig(w, { pos: [-0.5, 63, 0.5] })
  r.bot.food = 5; r.bot.give('bread', 3)
  // never sets the entity flag; hp falls 1 per 300 ms for 3 s
  let hp = 20; const t0 = Date.now()
  const iv = setInterval(() => { if (Date.now() - t0 < 3500) { hp -= 1; r.bot.health = hp; r.bot.emit('health') } }, 300)
  assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 12000), 'first run (lava) ended')
  await sleep(300)
  const last = r.trace.last('reflex_start').filter((e) => e.name === 'lava_fire')
  const holdUntil = Date.now() + 1500
  while (Date.now() < holdUntil && Date.now() - t0 < 3000) { assert.equal(r.bot.calls.consume, 0, 'no eat while hp falls after fire'); await sleep(100) }
  clearInterval(iv)
  assert.ok(last.length >= 1)
  await r.stop()
})
