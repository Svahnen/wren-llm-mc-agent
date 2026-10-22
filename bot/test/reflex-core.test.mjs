import test from 'node:test'
import assert from 'node:assert/strict'
import { World, flat, rig, sleep, until, noKeys, stopAll } from './reflex-helpers.mjs'
import { DangerMap, HARD } from '../src/reflex/danger.js'
import { search, cellOf } from '../src/reflex/nav.js'
import { assess } from '../src/reflex/threats.js'
import { DEFAULTS } from '../src/reflex/defaults.js'

test.after(stopAll)
const evs = (r, type) => r.trace.last(type)

test('danger map: lava/fire/forbidden/provider cost', () => {
  const w = flat(); w.set(3, 64, 3, 'lava'); w.set(5, 64, 5, 'fire'); w.set(7, 63, 7, 'magma_block')
  const r = rig(w); const d = r.reflex.danger
  assert.equal(d.costAt({ x: 3, y: 64, z: 3 }), Infinity)
  assert.ok(d.costAt({ x: 5, y: 64, z: 5 }) >= HARD)
  assert.ok(d.costAt({ x: 7, y: 64, z: 7 }) >= 60)
  assert.ok(d.costAt({ x: 4, y: 64, z: 3 }) > 0 && d.costAt({ x: 4, y: 64, z: 3 }) < HARD) // next to lava: mild
  assert.equal(d.costAt({ x: 10, y: 64, z: 10 }), 0)
  d.forbid({ x: 10, y: 64, z: 10 }, 50)
  assert.equal(d.costAt({ x: 10, y: 64, z: 10 }), Infinity)
  const rm = d.addProvider((c) => (c.x === 11 ? 77 : null))
  assert.equal(d.costAt({ x: 11, y: 64, z: 10 }), 77)
  rm(); assert.equal(d.costAt({ x: 11, y: 64, z: 10 }), 0)
  d.addProvider(() => { throw new Error('boom') }) // broken provider must not blind us
  assert.equal(d.costAt({ x: 12, y: 64, z: 10 }), 0)
  return r.stop()
})

test('search never crosses lava from dry land, may leave it when already inside', async () => {
  const w = flat(); w.fill(-6, 62, -6, 6, 63, 6, 'lava'); w.fill(-1, 62, -1, 1, 63, 1, 'stone'); w.fill(-1, 62, -1, 1, 62, 1, 'stone')
  const r = rig(w, { pos: [0.5, 64, 0.5] })
  const d = r.reflex.danger
  // island 3x3 inside a lava ring; outside land at |x|>6
  const res = search(d, { x: 0, y: 64, z: 0 }, (c) => c.x >= 8, { maxNodes: 2000, maxCost: 200 })
  assert.equal(res, null, 'no path through lava')
  w.set(3, 63, 0, 'lava'); w.set(3, 64, 0, 'lava')
  const out = search(d, { x: 3, y: 63, z: 0 }, (c, i) => i.cost < 5 && d.standable(c), { lavaOk: true, maxNodes: 500, maxCost: 100 })
  assert.ok(out && out.path.length > 0)
  await r.stop()
})

test('threat assessment: fight a lone zombie with a sword, flee when outmatched/low/unarmed/flee-class', async () => {
  const r = rig(flat()); const { bot } = r
  bot.addEntity('zombie', 4.5, 64, 0.5)
  bot.give('iron_sword'); 
  assert.equal(assess(bot, DEFAULTS).decision, 'fight')
  bot.health = 6; assert.equal(assess(bot, DEFAULTS).decision, 'flee'); bot.health = 20
  for (let i = 0; i < 5; i++) bot.addEntity('zombie', 3 + i, 64, 2)
  assert.equal(assess(bot, DEFAULTS).decision, 'flee')
  const r2 = rig(flat()); r2.bot.addEntity('zombie', 3.5, 64, 0.5)
  assert.match(assess(r2.bot, DEFAULTS).reason, /outmatched/, 'bare hands against a zombie are not enough')
  r2.bot.give('stone_sword'); assert.equal(assess(r2.bot, DEFAULTS).reason, 'fight:1')
  r2.bot.items = []; r2.bot.addEntity('zombie', 3.5, 64, 2.5); assert.equal(assess(r2.bot, DEFAULTS).reason, 'unarmed')
  const r3 = rig(flat()); r3.bot.addEntity('vindicator', 8, 64, 0.5); r3.bot.give('diamond_sword')
  assert.equal(assess(r3.bot, DEFAULTS).decision, 'flee')
  r3.bot.addEntity('enderman', 2, 64, 0.5)
  for (const x of [r, r2, r3]) await x.stop()
})

test('engine: cooldown with jitter, release and no stuck keys after every run', async () => {
  const w = flat(); const r = rig(w, {}, { cfg: { cooldownJitter: 0.5 } })
  const fired = []
  const dummy = { name: 'dummy', priority: 50, critical: false, cooldownMs: 200, failCooldownMs: 200, maxMs: 1000, check: () => ({}), async run(ctx) { fired.push(Date.now()); ctx.bot.setControlState('forward', true); ctx.bot.setControlState('sprint', true); await ctx.sleep(30); return { ok: true } } }
  const r2 = rig(w, {}, { reflexes: [dummy], cfg: { tickMs: 20, cooldownJitter: 0.5 } })
  await sleep(1300)
  assert.ok(fired.length >= 4 && fired.length <= 13, `fired ${fired.length}`)
  const gaps = fired.slice(1).map((t, i) => t - fired[i])
  assert.ok(Math.min(...gaps) >= 90, 'cooldown*(1-0.5) lower bound respected: ' + gaps)
  assert.ok(new Set(gaps.map((g) => Math.round(g / 20))).size > 1, 'jitter varies the gaps: ' + gaps)
  await r2.reflex.idle()
  assert.ok(noKeys(r2.bot)); assert.equal(r2.arbiter.holder, null)
  await r.stop(); await r2.stop()
})

test('engine: paused flag blocks non-critical only; handle resumes; ttl expires', async () => {
  const w = flat(); const r = rig(w)
  const bot = r.bot
  bot.food = 5; bot.give('bread', 3)
  r.reflex.paused = true
  await sleep(250)
  assert.equal(bot.calls.consume, 0, 'eat is paused')
  // critical still fires while paused
  w.set(0, 64, 0, 'lava'); w.set(0, 65, 0, 'lava')
  assert.ok(await until(() => evs(r, 'reflex_end').some((e) => e.name === 'lava_fire'), 3000), 'critical lava reflex ignores soft pause')
  r.reflex.paused = false
  assert.ok(await until(() => bot.calls.consume > 0, 3000), 'eat after resume')
  const h = r.reflex.pause({ names: ['eat'], reason: 'test', ttlMs: 150 })
  assert.equal(r.reflex.paused, true)
  await sleep(300)
  assert.equal(r.reflex.paused, false, 'ttl expired')
  h.resume()
  await r.stop()
})

test('engine: higher priority reflex supersedes, interruption event names the interrupted action', async () => {
  const w = flat(); const r = rig(w)
  // an s1 skill holds the body
  const tok = await r.arbiter.acquire('s1', { label: 'gather_wood' })
  assert.ok(tok)
  w.fill(0, 63, 0, 0, 65, 0, 'lava')
  assert.ok(await until(() => evs(r, 'reflex_interrupt').length > 0, 3000))
  const ev = evs(r, 'reflex_interrupt')[0]
  assert.equal(ev.text, 'your action gather_wood was interrupted by lava_fire')
  assert.ok(tok.signal.aborted, 's1 token revoked')
  assert.ok(r.reflex.drainEvents().some((e) => e.type === 'reflex_interrupt'))
  assert.equal(r.reflex.drainEvents().length, 0)
  await r.stop()
})

test('engine: a throwing reflex is contained, keys cleared, body released', async () => {
  const bad = { name: 'bad', priority: 10, critical: false, cooldownMs: 100, maxMs: 500, check: () => ({}), async run(ctx) { ctx.bot.setControlState('forward', true); throw new Error('x') } }
  const r = rig(flat(), {}, { reflexes: [bad] })
  await until(() => evs(r, 'reflex_end').length > 0)
  await r.reflex.idle()
  assert.equal(evs(r, 'reflex_end')[0].reason, 'exception')
  assert.ok(noKeys(r.bot)); assert.equal(r.arbiter.holder, null)
  await r.stop()
})

test('engine: maxMs bounds a reflex that never ends; state change aborts', async () => {
  const hang = { name: 'hang', priority: 10, critical: false, cooldownMs: 10000, maxMs: 150, check: () => ({}), async run(ctx) { ctx.bot.setControlState('jump', true); await ctx.sleep(60000); return { ok: true } } }
  const r = rig(flat(), {}, { reflexes: [hang] })
  await until(() => evs(r, 'reflex_end').length > 0, 2000)
  const e = evs(r, 'reflex_end')[0]
  assert.equal(e.aborted, true); assert.match(e.abort_reason, /max_ms/)
  assert.ok(noKeys(r.bot))
  await r.stop()
  const r2 = rig(flat(), {}, { reflexes: [{ ...hang, maxMs: 60000 }] })
  await until(() => r2.reflex.current)
  r2.body.state = 'dead'; r2.body.emit('state', { to: 'dead' })
  await until(() => evs(r2, 'reflex_end').length > 0, 1000)
  assert.match(evs(r2, 'reflex_end')[0].abort_reason, /state:dead/)
  await r2.stop()
})
