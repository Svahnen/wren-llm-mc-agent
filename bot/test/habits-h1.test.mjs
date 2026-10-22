import test from 'node:test'
import assert from 'node:assert/strict'
import { createHabits } from '../src/habits/index.js'
import { Landmarks, Trail } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'
import { lineClear, hiddenFrom, phase, rangedThreats, hungerTier, returnReason, openCells, pillboxCells, chooseResponse, placeableCount } from '../src/habits/safety.js'
import { placeAt, findSite } from '../src/skills/shelter.js'
import { hazardPenalty } from '../src/skills/wander.js'

const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) }, offset(a, b, c) { return vec(x + a, y + b, z + c) }, clone() { return vec(x, y, z) } })
// world: Map "x,y,z" -> block name; ground = solid below y=63 (feet at 64) unless overridden
function mockBot({ food = 20, hp = 20, inv = [], t = 6000, entities = [], world = new Map(), free = 30, thunder = 0 } = {}) {
  const foods = { bread: { foodPoints: 5, saturation: 6 }, beef: { foodPoints: 3, saturation: 2 } }
  const ents = {}
  entities.forEach((e, i) => { ents[i + 10] = { id: i + 10, isValid: true, position: vec(e.x, e.y ?? 64, e.z), ...e } })
  const blockAt = (p) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const n = world.has(k) ? world.get(k) : (Math.floor(p.y) < 64 ? 'dirt' : 'air')
    return { name: n, position: vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block', light: 0, skyLight: 15 }
  }
  const bot = {
    username: 'WrenT2', food, health: hp, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: ents, players: {},
    time: { timeOfDay: t, age: 100000 }, thunderState: thunder,
    registry: { foodsByName: foods, blocksByName: { water: { id: 1 } } },
    inventory: { items: () => inv, emptySlotCount: () => free },
    blockAt, findBlock: () => null, equip: async () => {},
    placeBlock: async (ref, face) => { const q = ref.position; const k = `${q.x + face.x},${q.y + face.y},${q.z + face.z}`; world.set(k, 'dirt'); inv[0].count-- },
  }
  return bot
}
function rig(botOpts, extra = {}) {
  const bot = mockBot(botOpts)
  const rng = makeRng(7)
  const env = { rng, heatmap: new Heatmap({ rng }), landmarks: new Landmarks(), trail: new Trail(), costAt: null }
  if (!extra.noHome) env.landmarks.set('home', { x: extra.homeX ?? 0, y: 64, z: 0 }, 'home')
  const calls = []
  const runner = { run: async (skill, args) => { calls.push({ skill, args }); return { status: extra.status ?? 'done', reason: extra.reason, ms: 5 } } }
  const h = createHabits({ runner, arbiter: { busy: false }, getBot: () => bot, env, rng, noise: 0.05, pauseMs: { done: 1, fail: 1 }, ...extra.opts })
  return { bot, env, h, calls }
}
const it = (name, count) => ({ name, count })
const top = (r) => r.h.rank().rows[0].name
const names = (r) => r.h.rank().rows.map((x) => x.name)

test('phase: day / dusk / night, thunder = night, force flag', () => {
  assert.equal(phase(mockBot({ t: 6000 })), 'day')
  assert.equal(phase(mockBot({ t: 11500 })), 'dusk')
  assert.equal(phase(mockBot({ t: 14000 })), 'night')
  assert.equal(phase(mockBot({ t: 23800 })), 'day')
  assert.equal(phase(mockBot({ t: 6000, thunder: 1 })), 'night')
  const b = mockBot({ t: 6000 }); b._h1ForcePhase = 'dusk'; assert.equal(phase(b), 'dusk')
})

test('line of sight: a block between shooter and bot hides her, open ground does not', () => {
  const w = new Map([['5,64,0', 'stone'], ['5,65,0', 'stone'], ['5,66,0', 'stone']])
  const sk = { name: 'skeleton', x: 10.5, z: 0.5 }
  const bot = mockBot({ entities: [sk], world: w })
  const th = rangedThreats(bot)
  assert.equal(th.length, 1)
  assert.equal(hiddenFrom(bot, { x: 0, y: 64, z: 0 }, th), true)
  assert.equal(hiddenFrom(bot, { x: 0, y: 64, z: 6 }, th), false)   // beside the wall, in the open
  assert.ok(lineClear(mockBot(), { x: 0, y: 65, z: 0 }, { x: 8, y: 65, z: 3 }))
})

test('exposed to a skeleton -> take_cover is the top habit; covered or a zombie -> not', () => {
  assert.equal(top(rig({ t: 14000, inv: [it('dirt', 20)], entities: [{ name: 'skeleton', x: 12.5, z: 0.5 }] })), 'take_cover')
  const w = new Map([['5,64,0', 'stone'], ['5,65,0', 'stone'], ['5,66,0', 'stone']])
  assert.ok(!names(rig({ t: 14000, entities: [{ name: 'skeleton', x: 12.5, z: 0.5 }], world: w })).includes('take_cover'))
  assert.ok(!names(rig({ t: 14000, entities: [{ name: 'zombie', x: 12.5, z: 0.5 }] })).includes('take_cover'))
  assert.equal(chooseResponse({ hp: 20, nThreats: 1, nearest: 8, hasWeapon: true }), 'charge')
  assert.equal(chooseResponse({ hp: 20, nThreats: 2, nearest: 8, hasWeapon: true }), 'cover')
  assert.equal(chooseResponse({ hp: 9, nThreats: 1, nearest: 8, hasWeapon: true }), 'cover')
  assert.equal(chooseResponse({ hp: 20, nThreats: 1, nearest: 8, hasWeapon: false }), 'cover')
})

test('dusk or night with blocks and no bed -> shelter; never explore/wander in the dark', () => {
  for (const t of [11600, 14000, 20000]) {
    const r = rig({ t, inv: [it('dirt', 20)] })
    assert.equal(top(r), 'shelter', `t=${t}`)
    assert.ok(!names(r).includes('explore') && !names(r).includes('wander') && !names(r).includes('gather_wood'))
  }
  assert.ok(names(rig({ t: 6000, inv: [it('dirt', 20)] })).includes('explore'))
})

test('forced dusk flag works for a daytime clock (live test hook)', () => {
  const r = rig({ t: 6000, inv: [it('dirt', 20)] }); r.bot._h1ForcePhase = 'dusk'
  assert.equal(top(r), 'shelter')
})

test('dark without enough blocks -> stock_blocks (dirt) first; with a bed -> sleep at night, go_bed at dusk', () => {
  assert.equal(top(rig({ t: 12000, inv: [it('dirt', 3)] })), 'stock_blocks')
  assert.equal(top(rig({ t: 14000, inv: [it('white_bed', 1)] })), 'sleep')
  const r = rig({ t: 11800, inv: [it('dirt', 20)] }); r.env.landmarks.set('bed', { x: 30, y: 64, z: 0 }, 'bed')
  assert.equal(top(r), 'go_bed')
  const r2 = rig({ t: 14000, inv: [it('dirt', 20)] }); r2.env.landmarks.set('bed', { x: 30, y: 64, z: 0 }, 'bed')
  assert.equal(top(r2), 'sleep')
})

test('failed sleep falls back to shelter, failed shelter falls back to something harmless', async () => {
  let t = 0
  const r = rig({ t: 14000, inv: [it('white_bed', 1), it('dirt', 20)] }, { status: 'failed', reason: 'cannot_place_bed', opts: { now: () => t } })
  assert.equal(top(r), 'sleep')
  await r.h.step(); t += 1000
  assert.equal(top(r), 'shelter')
  await r.h.step(); t += 1000
  assert.ok(r.h.rank().rows.length > 0)
})

test('hunger: starving with animals -> hunt beats everything; no animals -> seek_food; hungry with food -> eat', () => {
  assert.equal(top(rig({ food: 4, entities: [{ name: 'cow', x: 20.5, z: 0.5 }] })), 'hunt')
  assert.equal(top(rig({ food: 4 })), 'seek_food')
  assert.equal(top(rig({ food: 5, inv: [it('bread', 2)] })), 'eat')
  assert.equal(hungerTier(5), 3); assert.equal(hungerTier(9), 2); assert.equal(hungerTier(13), 1); assert.equal(hungerTier(18), 0)
  // animals at 50 blocks are in reach now (was 32)
  assert.ok(names(rig({ food: 10, entities: [{ name: 'pig', x: 50.5, z: 0.5 }] })).includes('hunt'))
})

test('food reserve: well fed with no food in the pack still hunts when animals are around, but exploring wins when food reserve is full', () => {
  const full = rig({ food: 20, inv: [it('beef', 5)], entities: [{ name: 'cow', x: 10.5, z: 0.5 }] })
  assert.ok(!names(full).includes('hunt'))
  const low = rig({ food: 17, inv: [], entities: [{ name: 'cow', x: 10.5, z: 0.5 }] })
  assert.ok(names(low).includes('hunt'))
})

test('hunger-driven priority: food 8 and no meat, cow near -> hunt above explore/wander/gather', () => {
  const r = rig({ food: 8, entities: [{ name: 'cow', x: 10.5, z: 0.5 }] })
  const rows = r.h.rank().rows
  assert.equal(rows[0].name, 'hunt')
  assert.ok(!rows.some((x) => x.name === 'explore'), 'no exploring while starving next to food')
})

test('wool chain: sheep near, no bed -> hunt sheep; wool>=3 -> craft bed', () => {
  const r = rig({ food: 20, inv: [it('oak_log', 4), it('beef', 5)], entities: [{ name: 'sheep', x: 12.5, z: 0.5 }] })
  const row = r.h.rank().rows.find((x) => x.name === 'get_wool')
  assert.ok(row); assert.deepEqual(row.habit.plan(r.h.rank().c), { skill: 'hunt', args: { target: 'sheep' } })
  const r2 = rig({ inv: [it('oak_log', 4), it('white_wool', 3), it('beef', 5)] })
  assert.ok(names(r2).includes('craft')); assert.equal(r2.h.rank().c.craftNext, 'bed')
})

test('return_home only with a reason and a cool-down', async () => {
  const far = { homeX: 100 }
  assert.ok(!names(rig({ food: 20 }, far)).includes('return_home'), 'far from home but healthy and empty-handed: no reason')
  assert.ok(names(rig({ hp: 6 }, far)).includes('return_home'), 'low health')
  assert.ok(names(rig({ free: 1, inv: [it('stick', 1)] }, { homeX: 100, ...{} })).every((n) => n !== 'return_home'), 'full but no chest known: not a reason')
  assert.equal(returnReason({ hasHome: true, homeDist: 200, bot: { health: 20 }, inv: { free: 20 } }), 'far')
  assert.equal(returnReason({ hasHome: true, homeDist: 200, bot: { health: 20 }, inv: { free: 20 } }, { sinceReturnMs: 1000 }), null)
  assert.equal(returnReason({ hasHome: true, homeDist: 20, bot: { health: 3 }, inv: { free: 20 } }), null)
  // long simulated life: return_home share stays low even when always far from home
  let t = 0
  const r = rig({ food: 20, inv: [it('bread', 2)] }, { homeX: 90, opts: { now: () => t } })
  for (let i = 0; i < 120; i++) { await r.h.step(); t += 15000 }
  const share = (r.h.stats().counts.return_home ?? 0) / r.h.stats().total
  assert.ok(share < 0.1, `return_home share ${share}`)
})

test('never return_home at night (shelter/sleep own the night)', () => {
  assert.ok(!names(rig({ hp: 6, t: 14000 }, { homeX: 100 })).includes('return_home'))
})

test('pillbox: placeAt builds all 10 cells on flat ground, openCells -> 0; findSite refuses a protected spot', async () => {
  const bot = mockBot({ inv: [it('dirt', 20)] })
  const S = { x: 0, y: 64, z: 0 }
  assert.equal(openCells(bot, S), 10)
  assert.equal(pillboxCells(S).length, 10)
  for (const c of pillboxCells(S)) await placeAt(bot, c)
  assert.equal(openCells(bot, S), 0)
  assert.equal(placeableCount(bot.inventory.items()), 10)
  const bot2 = mockBot({ inv: [it('dirt', 20)] })
  const site = findSite(bot2, { digForbidden: (p) => p.x < 3 })
  assert.ok(site && site.x >= 3 - 1, `site ${JSON.stringify(site)}`)
  assert.equal(findSite(bot2, { digForbidden: () => true }), null)
})

test('hazardPenalty: lava next to the target costs, plain ground does not', () => {
  const w = new Map([['2,64,0', 'lava']])
  assert.ok(hazardPenalty(mockBot({ world: w }), 0, 64, 0) >= 8)
  assert.equal(hazardPenalty(mockBot(), 0, 64, 0), 0)
})

test('already sealed in a pillbox at night with few blocks left: keep sheltering, do not dig dirt', () => {
  const w = new Map()
  const r0 = rig({ t: 14000, inv: [it('dirt', 2)], world: w })
  for (const c of pillboxCells({ x: 0, y: 64, z: 0 })) w.set(`${c.x},${c.y},${c.z}`, 'dirt')
  const r = rig({ t: 14000, inv: [it('dirt', 2)], world: w })
  assert.equal(r.h.rank().c.sealed, true)
  assert.equal(top(r), 'shelter')
  assert.ok(!names(r).includes('stock_blocks'))
  assert.equal(top(r0), 'shelter') // r0 shares the same world map, now sealed
})

import { inventoryFacts } from '../src/habits/needs.js'
test('F1 wool fact counts the biggest single colour (a bed needs 3 of one colour)', () => {
  const mk = (l) => ({ inventory: { items: () => l.map(([name, count]) => ({ name, count })) }, registry: { foodsByName: {} } })
  assert.equal(inventoryFacts(mk([['white_wool', 2], ['red_wool', 2], ['black_wool', 1]])).wool, 2)
  assert.equal(inventoryFacts(mk([['white_wool', 2], ['white_wool', 1], ['red_wool', 2]])).wool, 3)
})

test('P1: starving in daylight with animals only in huntBad never idles: plan is explore/hunt, not idle_activity', () => {
  const r = rig({ food: 4, hp: 6, inv: [], t: 6000, entities: [{ name: 'chicken', x: 20, z: 0 }] })
  const idle = r.h.rank().rows.find((x) => x.name === 'idle')
  assert.ok(idle)
  const c = r.h.rank().c
  for (let i = 0; i < 20; i++) { const p = idle.habit.plan(c); assert.equal(p.skill, 'explore') }
  assert.notEqual(r.h.rank().rows.length, 0)
})

