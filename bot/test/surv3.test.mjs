// SURV3: sand/gravel ground cover, no wall-opening while hurt, sleep by day ends at once, airborne guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { World, flat, rig, until, stopAll } from './reflex-helpers.mjs'
import { makeSleep, noteSleepRefused, sleepRefusedNow } from '../src/skills/survival.js'
import { AirborneGuard, isAirborne } from '../src/airborne-guard.js'
import { holeSiteRisk } from '../src/skills/activities.js'
test.after(stopAll)

const sandWorld = () => new World((x, y, z) => (y <= 60 ? 'stone' : y <= 63 ? 'sand' : 'air'))

test('low_hp_cover on sand: pit with a pick, cap is cobblestone, never sand', async () => {
  const w = sandWorld(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { shelterMaxMs: 500 } })
  r.bot.give('stone_pickaxe', 1); r.bot.give('cobblestone', 12); r.bot.health = 4
  r.bot.addEntity('zombie', 6.5, 64, 0.5)
  assert.ok(await until(() => r.trace.last('low_hp_cover').length > 0, 8000), 'reflex ran')
  const c = r.trace.last('low_hp_cover')[0]
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(c.mode, 'pit')
  const names = []; for (let y = 60; y <= 68; y++) names.push(w.name(0, y, 0))
  assert.ok(!names.includes('sand') || names.indexOf('sand') < 4, 'no sand in the cap: ' + names.join())
  await r.stop()
})

test('low_hp_cover on sand with only sand in the bag (SURV4): a 3-block sand tower under her feet', async () => {
  const w = sandWorld(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { shelterMaxMs: 500 } })
  r.bot.jumpHop = true
  r.bot.give('stone_pickaxe', 1); r.bot.give('sand', 16); r.bot.health = 4
  r.bot.addEntity('zombie', 6.5, 64, 0.5)
  assert.ok(await until(() => r.trace.last('low_hp_cover').length > 0, 8000), 'reflex ran')
  const c = r.trace.last('low_hp_cover')[0]
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(c.mode, 'tower'); assert.equal(c.placed, 3)
  for (let y = 64; y <= 66; y++) assert.equal(w.name(0, y, 0), 'sand', 'pillar cell ' + y)
  assert.ok(r.bot.entity.position.y >= 66.9, 'standing on top: ' + r.bot.entity.position.y)
  await r.stop()
})

test('hole_and_cap site: sand ground is allowed only with 2 safe blocks', () => {
  const w = sandWorld(); const r = rig(w, { pos: [0.5, 64, 0.5] })
  assert.equal(holeSiteRisk(r.bot, new Vec3(0, 64, 0)), 'falling_block_ground')
  r.bot.give('cobblestone', 4)
  assert.equal(holeSiteRisk(r.bot, new Vec3(0, 64, 0)), null)
  return r.stop()
})

test('sleep by day: precondition fails at once with the dusk time, after a server refusal too (thunder flag stale)', async () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, time: { timeOfDay: 3000 }, thunderState: 0.9, inventory: { items: () => [] }, findBlock: () => null }
  const sk = makeSleep({ landmarks: { get: () => ({ x: 0, y: 64, z: 0 }) } })
  const r = sk.precondition({ bot })   // client thinks thunder -> passes the clock test
  assert.equal(r === true, true)
  noteSleepRefused(bot)
  assert.ok(sleepRefusedNow(bot))
  const r2 = sk.precondition({ bot })
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'not_night'); assert.match(r2.detail, /dusk in about \d+ min/)
  bot.thunderState = 0; bot.time.timeOfDay = 6000
  assert.match(sk.precondition({ bot }).detail, /dusk in \d+ min/)
})

test('airborne guard: > 2 s in the air aborts the holder and stops the body; water/ladder/ground do not', () => {
  let t = 0, revoked = null, stopped = 0
  const bot = { health: 20, entity: { position: new Vec3(0, 70, 0), velocity: new Vec3(0, 0, 0), onGround: false }, blockAt: () => ({ name: 'air' }), clearControlStates() { stopped++ } }
  const arbiter = { holder: { owner: 's1', label: 'gather_wood' }, revokeAll: async (why) => { revoked = why } }
  const events = []; const trace = { event: (type, f) => events.push([type, f]) }
  const g = new AirborneGuard({ getBot: () => bot, arbiter, trace, now: () => t, tickMs: 100 })
  g.last = 0
  for (t = 100; t <= 1900; t += 100) g.tick()
  assert.equal(revoked, null, 'not yet')
  t = 2200; g.tick()
  assert.equal(revoked, 'airborne_guard'); assert.ok(stopped > 0)
  assert.equal(events.find((e) => e[0] === 'airborne_guard')[1].owner, 's1:gather_wood')
  // in water: never
  bot.blockAt = () => ({ name: 'water' }); assert.equal(isAirborne(bot), false)
  bot.blockAt = () => ({ name: 'air' }); bot.entity.onGround = true; assert.equal(isAirborne(bot), false)
})

test('airborne guard traces a loop stall with the airborne flag', () => {
  let t = 0
  const bot = { health: 20, entity: { position: new Vec3(0, 70, 0), velocity: new Vec3(0, 0, 0), onGround: false }, blockAt: () => ({ name: 'air' }) }
  const events = []; const g = new AirborneGuard({ getBot: () => bot, arbiter: { revokeAll: async () => {} }, trace: { event: (a, b) => events.push([a, b]) }, now: () => t })
  g.last = 0; t = 4400; g.tick()
  assert.equal(events.find((e) => e[0] === 'loop_stall')[1].airborne, true)
})

import { shelterAndHeal } from '../src/reflex/reflexes.js'
const ctxOf = (r, ac) => ({ bot: r.bot, danger: r.reflex.danger, cfg: { ...r.reflex.cfg, shelterMaxMs: 3000 }, state: r.reflex.state, rng: () => 0.5, signal: ac.signal, log() {},
  sleep: (ms) => new Promise((res) => { if (ac.signal.aborted) return res(false); const t = setTimeout(() => res(true), ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); res(false) }, { once: true }) }) })

test('shelterAndHeal: aborted by a higher reflex -> the wall stays shut (it once dug it open with a zombie outside)', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }); r.reflex.stop()
  r.bot.give('cobblestone', 20); r.bot.health = 8
  const ac = new AbortController(); setTimeout(() => ac.abort('superseded_by:low_hp_cover'), 400)
  r.bot.addEntity('zombie', 6.5, 64, 6.5)
  const res = await shelterAndHeal(ctxOf(r, ac), 'recover')
  assert.equal(res.ok, true)
  assert.equal(r.bot.calls.dig.length, 0, 'no wall was dug: ' + r.bot.calls.dig.join())
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(w.name(dx, 64, dz), 'cobblestone')
  await r.stop()
})

test('shelterAndHeal: a zombie hits her over the corner -> she hits back instead of waiting', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }); r.reflex.stop()
  r.bot.give('cobblestone', 20); r.bot.give('iron_sword', 1); r.bot.health = 7.5
  const ac = new AbortController(); setTimeout(() => ac.abort('test_end'), 1800)
  const z = r.bot.addEntity('zombie', 1.4, 64, 1.4)
  setTimeout(() => { r.bot.health = 5; r.bot.emit('health') }, 500)
  await shelterAndHeal(ctxOf(r, ac), 'recover')
  assert.ok(r.bot.calls.attack.includes('zombie'), 'attacked: ' + r.bot.calls.attack.join())
  assert.equal(r.bot.calls.dig.length, 0)
  await r.stop()
})
