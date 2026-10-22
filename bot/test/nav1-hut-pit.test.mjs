// NAV1: sealed own hut is not a trap (leaveHut / NoPath hook), NoPath says why, gather does not dig a deep pit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { makeRig } from './helpers.js'
import { PLANS, doorCells } from '../src/skills/build.js'
import { recordHut, leaveHut, explainNoPath, allowPitDig, openDoor } from '../src/skills/shelter.js'
import { gatherResource } from '../src/skills/gather.js'
import { PlacedBlocks } from '../src/skills/movements-protect.js'

/** a finished sealed 5x5 simple_hut on stone ground (floor y=63, feet y=64), she stands in the middle. world: Map 'x,y,z' -> name */
function sealedHut() {
  const S = { x: 0, y: 64, z: 0 }, w = new Map()
  for (const c of PLANS.simple_hut(S, { size: 5 })) w.set(`${c.x},${c.y},${c.z}`, 'cobblestone')
  for (const c of doorCells(S, { size: 5 })) w.set(`${c.x},${c.y},${c.z}`, 'cobblestone')   // sealed door (2 placed blocks)
  const { bot, runner, trace } = makeRig()
  const nameAt = (x, y, z) => w.get(`${x},${y},${z}`) ?? (y < 64 ? 'stone' : 'air')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z), n = nameAt(x, y, z); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  bot.dig = async (b) => { w.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air') }
  bot.inventory = { items: () => [] }; bot.equip = async () => {}
  bot.__placed = new PlacedBlocks()
  for (const k of w.keys()) { const [x, y, z] = k.split(',').map(Number); bot.__placed.add({ x, y, z }) }
  recordHut(bot, S, 5, doorCells(S, { size: 5 }), true)
  return { bot, runner, trace, w, S }
}

test('NAV1: from inside her sealed hut, NoPath is explained and leaveHut opens exactly the 2 door cells', async () => {
  const { bot, w } = sealedHut()
  assert.match(explainNoPath(bot), /^sealed_in_own_hut/)
  const walls = [...w.values()].filter((v) => v === 'cobblestone').length
  assert.equal(await leaveHut(bot, {}), true)
  assert.equal([...w.values()].filter((v) => v === 'cobblestone').length, walls - 2)
  assert.equal(explainNoPath(bot), null, 'door open: not sealed any more')
  assert.equal(await leaveHut(bot, {}), false, 'second call: nothing to open')
})

test('NAV1: goto from the sealed hut opens the door and goes (no NoPath), 3/3 times', async () => {
  for (let i = 0; i < 3; i++) {
    const { bot, runner, trace, w } = sealedHut()
    bot.pathfinder.goto = async () => { if ([...w.keys()].some((k) => k === '0,64,2' && w.get(k) === 'cobblestone')) throw Object.assign(new Error('No path'), { name: 'NoPath' }) }
    runner.onNoPath = async (b) => (await openDoor(b, {})) || (await leaveHut(b, {}))
    runner.explainNoPath = explainNoPath
    runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 2000 }); return r.ok ? { ok: true } : { ok: false, reason: r.reason, detail: r.why } } })
    const res = await runner.run('walk')
    assert.equal(res.status, 'done', JSON.stringify(res))
    assert.deepEqual(trace.last('skill_door').map((e) => e.opened), [true])
  }
})

test('NAV1: an unfixable NoPath carries the reason in the result', async () => {
  const { bot, runner, w } = sealedHut()
  for (const c of PLANS.simple_hut({ x: 0, y: 64, z: 0 }, { size: 5 })) bot.__placed.delete(c)   // not hers any more: stays closed
  bot.__huts = []                                                                                  // and no record
  bot.pathfinder.goto = async () => { throw Object.assign(new Error('No path'), { name: 'NoPath' }) }
  runner.explainNoPath = explainNoPath
  runner.register({ name: 'walk', max_s: 5, progress_fn: () => Date.now(), run: async (ctx) => { const r = await ctx.goto({}, { timeoutMs: 2000 }); return { ok: false, reason: r.reason, detail: r.why } } })
  const res = await runner.run('walk')
  assert.equal(res.reason, 'NoPath'); assert.match(String(res.detail), /enclosed_room|boxed_in|in_pit/)
  void w
})

test('NAV1: in a pit the pathfinder may dig for one retry, then it is switched off again', async () => {
  const w = new Map()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [65, 66]) w.set(`${dx},${y},${dz}`, 'stone')
  const { bot } = makeRig()
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.blockAt = (v) => { const n = w.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`) ?? 'air'; return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: v } }
  bot.pathfinder.movements = { canDig: false }
  assert.match(explainNoPath(bot), /^in_pit/)
  assert.equal(allowPitDig(bot, 30), true); assert.equal(bot.pathfinder.movements.canDig, true)
  await new Promise((r) => setTimeout(r, 80)); assert.equal(bot.pathfinder.movements.canDig, false)
  bot.pathfinder.movements.canDig = true; assert.equal(allowPitDig(bot), false, 'already digging: no-op')
})

test('NAV1: gather_stone does not dig more than 1 below where she started working', async () => {
  const m = new Map(); const reg = { blocksByName: { stone: { id: 4, name: 'stone' } } }
  const bot = new EventEmitter()
  bot.registry = reg; bot.entity = { position: new Vec3(0.5, 64, 0.5) }; bot.health = 20; bot.inventory = { items: () => [], emptySlotCount: () => 20 }
  bot.__placed = new PlacedBlocks()
  // a shaft of stone going down at x=1 (y 63..58), open above; floor otherwise stone
  for (let y = 58; y <= 63; y++) m.set(`1,${y},0`, 'stone')
  m.set('1,64,0', 'air')
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z), n = m.get(`${x},${y},${z}`) ?? (y < 63 ? 'stone' : 'air'); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z), light: 15 } }
  bot.findBlocks = ({ matching, count }) => [...m.keys()].filter((k) => m.get(k) === 'stone').map((k) => new Vec3(...k.split(',').map(Number))).slice(0, count)
  bot.dig = async (b) => { const p = b.position; m.set(`${p.x},${p.y},${p.z}`, 'air'); bot.entity.position = new Vec3(0.5, p.y + 0.0, 0.5) }
  const dug = []
  const c = { bot, aborted: false, state: {}, log: (e, d) => { if (e === 'target') dug.push(d.at[1]) }, sleep: async () => {}, goto: async () => ({ ok: true }) }
  await gatherResource(c, { noStair: true }, 'stone', 6).catch(() => {})
  assert.ok(dug.length && dug.every((y) => y >= 63), `dug ys ${dug}`)
})
