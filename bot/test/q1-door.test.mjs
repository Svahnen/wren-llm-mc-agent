import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig } from './helpers.js'
import { openDoor, boxedIn } from '../src/skills/shelter.js'

// a 1x1x2 dirt pillbox around (0,64,0) on dirt ground; world: Map "x,y,z" -> block name
function boxWorld() {
  const w = new Map()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { w.set(`${dx},64,${dz}`, 'dirt'); w.set(`${dx},65,${dz}`, 'dirt') }
  w.set('0,66,0', 'dirt')
  return w
}
function wire(bot, w) {
  const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), floored: () => vec(Math.floor(x), Math.floor(y), Math.floor(z)), distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) })
  bot.entity.position = vec(0.5, 64, 0.5)
  bot.blockAt = (p) => { const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; const n = w.get(k) ?? (Math.floor(p.y) < 64 ? 'dirt' : 'air'); return { name: n, position: vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' } }
  bot.dig = async (b) => { w.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air') }
  bot.inventory = { items: () => [] }
  bot.equip = async () => {}
  bot.pathfinder.goto = async () => { if (boxedIn(bot)) throw Object.assign(new Error('No path'), { name: 'NoPath' }); }
}

test('Q1: openDoor digs a head+feet wall column of a sealed dirt pillbox, nothing else', async () => {
  const { bot } = makeRig(); const w = boxWorld(); wire(bot, w)
  assert.equal(boxedIn(bot), true)
  assert.equal(await openDoor(bot, {}), true)
  assert.equal(boxedIn(bot), false)
  assert.equal([...w.values()].filter((v) => v === 'dirt').length, 9 - 2, 'exactly two of the nine pillbox blocks removed')
  assert.equal(await openDoor(bot, {}), false, 'not boxed in any more: no-op')
})

test('Q1: protected cells and natural stone are never dug', async () => {
  const { bot } = makeRig(); const w = boxWorld(); wire(bot, w)
  assert.equal(await openDoor(bot, { digForbidden: () => true }), false)
  assert.equal(boxedIn(bot), true)
  const w2 = boxWorld(); for (const k of [...w2.keys()]) if (k !== '0,66,0') w2.set(k, 'bedrock')
  const r2 = makeRig(); wire(r2.bot, w2); assert.equal(await openDoor(r2.bot, {}), false)
})

test('Q1: ctx.goto from inside the pillbox opens a door once and retries instead of reporting NoPath', async () => {
  const { bot, runner, trace } = makeRig(); const w = boxWorld(); wire(bot, w)
  runner.onNoPath = (b) => openDoor(b, {})
  runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 2000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason } } })
  const res = await runner.run('walk')
  assert.equal(res.status, 'done', JSON.stringify(res))
  assert.deepEqual(trace.last('skill_door').map((e) => e.opened), [true])
  // without the hook it is the old behaviour
  const r2 = makeRig(); wire(r2.bot, boxWorld())
  r2.runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 2000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason } } })
  assert.equal((await r2.runner.run('walk')).reason, 'NoPath')
})

test('Q1: goto that RESOLVES without moving (empty path) from inside the pillbox also opens the door once', async () => {
  const { bot, runner, trace } = makeRig(); const w = boxWorld(); wire(bot, w)
  bot.pathfinder.goto = async () => { /* resolves at once; only moves when the box is open */ if (!boxedIn(bot)) bot.entity.position = { ...bot.entity.position, x: bot.entity.position.x + 5, floored: bot.entity.position.floored, offset: bot.entity.position.offset } }
  runner.onNoPath = (b) => openDoor(b, {})
  runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 2000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason } } })
  assert.equal((await runner.run('walk')).status, 'done')
  assert.deepEqual(trace.last('skill_door').map((e) => e.opened), [true])
  assert.equal(boxedIn(bot), false)
})
test('Q1: a goto that does not move in the open never digs', async () => {
  const { bot, runner, trace } = makeRig(); const w = new Map(); wire(bot, w)
  bot.pathfinder.goto = async () => {}
  runner.onNoPath = (b) => openDoor(b, {})
  runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { await ctx.goto({}, { timeoutMs: 2000 }); return { ok: true } } })
  await runner.run('walk'); assert.deepEqual(trace.last('skill_door').map((e) => e.opened), [false])
})
