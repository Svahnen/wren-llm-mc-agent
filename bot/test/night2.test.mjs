// NIGHT2: (1) ranged threats are answered by breaking the line of sight (ranged_cover), (2) pathfinder "Timeout" no longer ends a walk (goto retry) and the door
// movement filter stays cheap (blockAt without extraInfos), (3) bed approach cells.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { flat, rig, until, stopAll, World, mockBot } from './reflex-helpers.mjs'
import { makeRig } from './helpers.js'
import { rangedCover, indoorCandidates, shootersNear, hiddenNow } from '../src/reflex/ranged-cover.js'
import { DoorMovements } from '../src/skills/movements-doors.js'
import { DEFAULTS } from '../src/reflex/defaults.js'
test.after(stopAll)

const dangerOf = (w) => ({ blockAt: (x, y, z) => w.block(x, y, z) })
const env = (bot, w) => ({ bot, cfg: DEFAULTS, danger: dangerOf(w), now: Date.now, state: {} })

test('ranged_cover check: pillager 14 m in the open fires; a lone skeleton at good health does not; hp 12 skeleton does; hidden/sealed do not', () => {
  const w = flat(); const b = mockBot(w); clearInterval(b.sim)
  b.addEntity('pillager', 14.5, 64, 0.5)
  assert.ok(rangedCover.check(env(b, w)), 'pillager in the open')
  const w2 = flat(); const b2 = mockBot(w2); clearInterval(b2.sim)
  b2.addEntity('skeleton', 14.5, 64, 0.5)
  assert.equal(rangedCover.check(env(b2, w2)), null, 'one skeleton at hp 20: mob_defense')
  b2.health = 12
  assert.ok(rangedCover.check(env(b2, w2)), 'hurt: cover')
  // a wall between: hidden -> nothing to do
  const w3 = flat(); w3.fill(6, 64, -3, 6, 66, 3, 'stone'); const b3 = mockBot(w3); clearInterval(b3.sim)
  b3.addEntity('pillager', 14.5, 64, 0.5)
  assert.equal(rangedCover.check(env(b3, w3)), null, 'already hidden')
  // hp <= 6 with blocks: low_hp_cover (85) owns it
  const b4 = mockBot(flat()); clearInterval(b4.sim); b4.give('cobblestone', 32); b4.health = 5; b4.addEntity('pillager', 14.5, 64, 0.5)
  assert.equal(rangedCover.check(env(b4, flat())), null)
})

test('ranged_cover run: pillager at 14 m in the open, a short wall 3 m behind her -> she walks around it and ends hidden (mode cover)', async () => {
  const w = flat(); w.fill(-3, 64, -2, -3, 66, 2, 'stone')
  const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { shelterMaxMs: 1000 } })
  r.bot.addEntity('pillager', 14.5, 64, 0.5)
  assert.ok(await until(() => r.trace.last('ranged_cover').length > 0, 12000), 'reflex ran')
  const c = r.trace.last('ranged_cover')[0]
  assert.equal(c.mode, 'cover', JSON.stringify(c))
  assert.ok(hiddenNow(r.bot, shootersNear(r.bot)), 'hidden from the pillager afterwards')
  assert.ok(r.bot.entity.position.x < -3, 'behind the wall: ' + r.bot.entity.position.toString())
  await r.stop()
})

test('ranged_cover run: no cover, blocks in the bag -> emergency cover (shield/pillbox), never an open-ground run', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { shelterMaxMs: 1000 } })
  r.bot.give('cobblestone', 32); r.bot.health = 12
  r.bot.addEntity('pillager', 14.5, 64, 0.5)
  assert.ok(await until(() => r.trace.last('ranged_cover').length > 0, 12000))
  const c = r.trace.last('ranged_cover')[0]
  assert.ok(['cover', 'blocks', 'shield'].includes(c.mode), JSON.stringify(c))
  await r.stop()
})

// ---- indoors: a hut with a usable door
class HutWorld extends World {
  block(x, y, z) { const b = super.block(x, y, z); if (b.name === 'oak_door') { b.boundingBox = 'block'; b.getProperties = () => ({ facing: 'south', half: y === 64 ? 'lower' : 'upper', open: false }) } return b }
}
function hut() {
  const w = new HutWorld((x, y, z) => (y <= 63 ? 'stone' : 'air'))
  w.fill(-8, 64, -2, -4, 66, 2, 'stone'); w.fill(-7, 64, -1, -5, 65, 1, 'air'); w.fill(-7, 66, -1, -5, 66, 1, 'stone')
  w.set(-6, 64, 2, 'oak_door'); w.set(-6, 65, 2, 'oak_door')   // door in the +z wall
  const b = mockBot(w, { pos: [-6.5, 64, 6.5] }); clearInterval(b.sim)
  b.registry.blocksArray = [{ id: 7, name: 'oak_door' }]
  b.findBlocks = () => [new Vec3(-6, 64, 2)]
  return { w, b }
}
test('indoorCandidates: a bounded room behind a usable door with a hidden inner cell is offered', () => {
  const { b } = hut()
  b.addEntity('pillager', 14.5, 64, 6.5)
  const rooms = indoorCandidates(b, shootersNear(b))
  assert.equal(rooms.length, 1, JSON.stringify(rooms))
  assert.deepEqual([rooms[0].door.x, rooms[0].door.z], [-6, 2])
  assert.ok(rooms[0].cell.x >= -7 && rooms[0].cell.x <= -5 && rooms[0].cell.z >= -1 && rooms[0].cell.z <= 1, 'inner cell: ' + JSON.stringify(rooms[0].cell))
  assert.ok(rooms[0].room >= 6)
})
test('indoorCandidates: a doorless open box is not a refuge', () => {
  const { w, b } = hut(); w.set(-6, 64, 2, 'stone'); w.set(-6, 65, 2, 'stone')
  b.addEntity('pillager', 14.5, 64, 6.5)
  assert.equal(indoorCandidates(b, shootersNear(b)).length, 0)
})

// ---- pathfinder Timeout no longer ends the walk
test('NIGHT2: ctx.goto retries after the pathfinder "Timeout" (partial path walked meanwhile) and succeeds', async () => {
  const { bot, runner, trace } = makeRig()
  const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), floored: () => vec(Math.floor(x), Math.floor(y), Math.floor(z)), distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) })
  bot.entity.position = vec(0.5, 64, 0.5)
  let calls = 0
  bot.pathfinder.goto = async () => { calls++; if (calls === 1) { bot.entity.position = vec(3.5, 64, 0.5); throw Object.assign(new Error('Took to long to decide path to goal!'), { name: 'Timeout' }) } }
  runner.register({ name: 'walk', max_s: 10, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 5000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason } } })
  const res = await runner.run('walk')
  assert.equal(res.status, 'done', JSON.stringify(res)); assert.equal(calls, 2)
  assert.equal(trace.last('skill_goto_timeout_retry').length, 1)
})
test('NIGHT2: a Timeout without any headway is retried once, then reported as Timeout (no endless loop)', async () => {
  const { bot, runner } = makeRig()
  const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), floored: () => vec(Math.floor(x), Math.floor(y), Math.floor(z)), distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) })
  bot.entity.position = vec(0.5, 64, 0.5)
  let calls = 0
  bot.pathfinder.goto = async () => { calls++; throw Object.assign(new Error('x'), { name: 'Timeout' }) }
  runner.register({ name: 'walk', max_s: 20, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 5000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason } } })
  const res = await runner.run('walk')
  assert.equal(res.reason, 'Timeout'); assert.equal(calls, 2)
})

// ---- the door movement filter is cheap
test('NIGHT2: DoorMovements.getNeighbors asks the world without extraInfos and memoises door lookups', async () => {
  const w = flat(); const b = mockBot(w); clearInterval(b.sim)
  b.registry = (await import('minecraft-data')).default('1.21.1'); b.version = '1.21.1'
  const calls = []
  const orig = b.blockAt
  b.blockAt = (v, extra) => { calls.push(extra); return orig(v) }
  const mv = new DoorMovements(b)
  const P = Object.getPrototypeOf(DoorMovements.prototype), saved = P.getNeighbors
  P.getNeighbors = () => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, z]) => ({ x, y: 64, z }))
  try {
    const out = mv.getNeighbors({ x: 0, y: 64, z: 0 })
    assert.equal(out.length, 8, 'no doors: nothing filtered')
    const n1 = calls.length
    assert.ok(n1 > 0 && calls.every((e) => e === false), 'filter lookups are extraInfos=false')
    mv.getNeighbors({ x: 0, y: 64, z: 0 })
    assert.ok(calls.length - n1 < n1 * 0.2, `second call is cached (${n1} then ${calls.length - n1})`)
  } finally { P.getNeighbors = saved }
})

// ---- open water: swim to a far shore instead of treading water for minutes (observed death at 100,61,100)
import { findFarShore, swimToward, swimToDry } from '../src/water-policy.js'
const ocean = () => new World((x, y, z) => (y <= 55 ? 'stone' : x >= 40 ? (y <= 62 ? 'stone' : 'air') : y <= 62 ? 'water' : 'air'))
test('NIGHT2: findFarShore sees land 40 blocks away; none when the loaded world is all water', () => {
  const w = ocean(); const b = mockBot(w, { pos: [0.5, 61, 0.5] }); clearInterval(b.sim)
  const far = findFarShore(b)
  assert.ok(far && far.x >= 40 && far.r >= 36 && far.r <= 50, JSON.stringify(far))
  const w2 = new World((x, y, z) => (y <= 55 ? 'stone' : y <= 62 ? 'water' : 'air')); const b2 = mockBot(w2, { pos: [0.5, 61, 0.5] }); clearInterval(b2.sim)
  assert.equal(findFarShore(b2), null)
})
test('NIGHT2: swimToDry in open water (no shore in local reach) swims to the far shore and gets out', async () => {
  const w = ocean(); const b = mockBot(w, { pos: [0.5, 61, 0.5] })
  b.__landmarks = { home: { x: 80, z: 0 } }
  const ctx = { bot: b, aborted: false, sleep: (ms) => new Promise((r) => setTimeout(() => r(true), ms)), log: () => {} }
  const r = await swimToDry(ctx, { farMs: 25000 })
  clearInterval(b.sim)
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.far, true)
  assert.ok(b.entity.position.x > 38, 'on the far shore: ' + b.entity.position.toString())
})
