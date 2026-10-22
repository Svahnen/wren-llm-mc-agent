// SURV4: trunk on a cliff edge is rejected as ONE target, hole_and_cap near a structure relocates / covers another way, no_light is one trace per episode.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { gatherResource } from '../src/skills/gather.js'
import { PlacedBlocks } from '../src/skills/movements-protect.js'
import { World, flat, mockBot, stopAll } from './reflex-helpers.mjs'
import { makeHoleAndCap, holeProtectedReason, findHoleSite } from '../src/skills/activities.js'
import { DeadStateMonitor } from '../src/detect/deadstate.js'
test.after(stopAll)

// ---- 1. gather_wood: a whole trunk on a cliff edge is one rejection, the next tree is felled
function woodWorld() {
  const m = new Map()
  const set = (x, y, z, n) => m.set([x, y, z].join(','), n)
  for (let y = 64; y <= 69; y++) set(3, y, 0, 'oak_log')                       // tree A beside a ravine
  for (let x = 4; x <= 7; x++) for (let z = -2; z <= 2; z++) for (let y = 40; y <= 63; y++) set(x, y, z, 'air')
  for (let y = 64; y <= 66; y++) set(-10, y, 0, 'oak_log')                      // tree B on plain ground
  const bot = new EventEmitter(), inv = []
  bot.registry = { blocksByName: { oak_log: { id: 1, name: 'oak_log' }, dirt: { id: 2, name: 'dirt' }, grass_block: { id: 3, name: 'grass_block' } } }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }; bot.health = 20; bot.entities = {}
  bot.inventory = { items: () => inv, emptySlotCount: () => 20 }; bot.__placed = new PlacedBlocks()
  const nameAt = (x, y, z) => m.get([x, y, z].join(',')) ?? (y === 63 ? 'grass_block' : y > 63 ? 'air' : 'dirt')
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); const n = nameAt(x, y, z); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z), light: 0, skyLight: 15 } }
  bot.findBlocks = ({ matching, maxDistance, count, useExtraInfo }) => {
    const out = []
    for (let x = -30; x <= 30; x++) for (let y = 60; y <= 72; y++) for (let z = -10; z <= 10; z++) {
      if (nameAt(x, y, z) !== 'oak_log') continue
      const d = Math.hypot(x - 0.5, y - 64, z - 0.5); if (d > maxDistance) continue
      if (useExtraInfo && !useExtraInfo(bot.blockAt(new Vec3(x, y, z)))) continue
      out.push({ d, p: new Vec3(x, y, z) })
    }
    return out.sort((a, b) => a.d - b.d).slice(0, count).map((o) => o.p)
  }
  bot.dig = async (b) => { set(b.position.x, b.position.y, b.position.z, 'air'); const e = inv.find((i) => i.name === 'oak_log'); if (e) e.count++; else inv.push({ name: 'oak_log', count: 1, type: 99 }) }
  bot.stopDigging = () => {}; bot.equip = async () => {}
  return { bot, inv }
}
test('gather_wood: six logs of one cliff-edge trunk are ONE rejection, the next tree gives the wood', async () => {
  const { bot, inv } = woodWorld()
  const log = []
  const ctx = { bot, aborted: false, state: {}, log: (e, d) => log.push([e, d]), sleep: async () => {} }
  ctx.goto = async (g) => { const p = g.pos ?? g; bot.entity.position = new Vec3(Math.floor(p.x) + (g.pos ? 1 : 0) + 0.5, 64, Math.floor(p.z) + 0.5); return { ok: true } }
  const r = await gatherResource(ctx, {}, 'wood', 3)
  const rej = log.filter(([e]) => e === 'target_rejected')
  assert.equal(r.ok, true, JSON.stringify([r, log.slice(-5)]))
  assert.ok(inv.find((i) => i.name === 'oak_log')?.count >= 3)
  assert.equal(rej.length, 1, 'one rejection for the whole trunk: ' + JSON.stringify(rej))
  assert.equal(rej[0][1].why, 'ledge')
})

test('gather_wood: when every tree is on a ledge the failure says why (detail), not a bare nothing_gained', async () => {
  const { bot } = woodWorld()
  for (let y = 64; y <= 66; y++) bot.blockAt = ((orig) => (v) => { const b = orig(v); return b })(bot.blockAt)   // keep
  // turn tree B into a cliff tree too
  const orig = bot.blockAt
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); if (x >= -13 && x <= -11 && y <= 63 && y >= 40 && z >= -1 && z <= 1 && !(x === -11 && z === 0 && y === 63)) return { name: 'air', boundingBox: 'empty', position: new Vec3(x, y, z), light: 0, skyLight: 15 }; return orig(v) }
  const ctx = { bot, aborted: false, state: {}, log: () => {}, sleep: async () => {} }
  ctx.goto = async () => ({ ok: true })
  const r = await gatherResource(ctx, {}, 'wood', 3)
  assert.equal(r.ok, false)
  assert.ok(['nothing_gained', 'no_target_found'].includes(r.reason), r.reason)
  assert.ok(r.detail, 'has a detail: ' + JSON.stringify(r))
})

// ---- 2. hole_and_cap near a structure
function holeRig({ table = [0, 64, 2] } = {}) {
  const w = flat(); const bot = mockBot(w)
  bot.registry.blocksArray = [{ name: 'crafting_table', id: 7 }]
  bot.findBlocks = () => (table ? [new Vec3(...table)] : [])
  bot.setBlock = () => {}
  const d0 = bot.dig; bot.dig = async (b) => { await d0(b); bot.give(b.name === 'stone' ? 'cobblestone' : b.name, 1) }
  const ctx = { bot, aborted: false, state: {}, log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(() => r(true), Math.min(ms, 30))), moves: [] }
  ctx.goto = async (g) => { ctx.moves.push([g.x, g.y, g.z]); bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5); return { ok: true } }
  return { w, bot, ctx }
}

test('hole_and_cap: ground within 2 of a crafting table is protected (the dig guard said near_structure) -> walks to plain ground and digs there', async () => {
  const { w, bot, ctx } = holeRig()
  assert.match(holeProtectedReason(bot, new Vec3(0, 64, 0), {}), /^protected_ground_near_structure/)
  const site = findHoleSite(bot, {}); assert.ok(site, 'a free site exists')
  const r = await makeHoleAndCap({}).run(ctx)
  assert.equal(r.ok, true, JSON.stringify([r, ctx.state]))
  assert.equal(r.reason, 'sealed_in_hole')
  assert.equal(ctx.moves.length, 1, 'walked once')
  assert.ok(Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5) >= 3, 'moved away from the table')
})

test('hole_and_cap: no plain ground anywhere + blocks -> walls instead of the hole (honest mode), not cannot_dig', async () => {
  const { bot, ctx } = holeRig()
  bot.give('cobblestone', 12)
  const r = await makeHoleAndCap({ digForbidden: () => true }).run(ctx)
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.reason, 'sealed_in_cover'); assert.match(r.note, /protected/)
})

test('hole_and_cap: no plain ground and nothing to wall with -> cannot_dig with the real reason', async () => {
  const { bot, ctx } = holeRig()
  const r = await makeHoleAndCap({ digForbidden: () => true }).run(ctx)
  assert.equal(r.ok, false); assert.equal(r.reason, 'cannot_dig'); assert.match(r.detail, /protected_ground_(near_structure|protected_area).*no plain ground within 18 m/)
})

test('hole_and_cap: precondition no longer rejects a protected site (it relocates)', () => {
  const { bot } = holeRig()
  assert.equal(makeHoleAndCap({}).precondition({ bot }), true)
})

// ---- 4. no_light: one dead_state trace per episode even when the light flaps
test('no_light flapping dark/lit 12 times = ONE dead_state trace and no clear spam', () => {
  const c = { t: 1e6 }
  let dark = true
  const bot = { entity: { position: new Vec3(0.5, 70, 0.5) }, inventory: { emptySlotCount: () => 5, items: () => [], slots: [] }, blockAt: () => ({ light: dark ? 2 : 12, skyLight: 0 }), food: 20, time: { timeOfDay: 18000 }, registry: { foodsByName: {} } }
  const events = []
  const m = new DeadStateMonitor({ getBot: () => bot, lag: { status: () => ({ lagging: false }) }, now: () => c.t, trace: { event: (t, d) => events.push([t, d.kind]) } })
  for (let i = 0; i < 12; i++) { dark = true; m.check(); c.t += 70000; dark = false; m.check(); c.t += 5000 }
  assert.equal(events.filter(([t, k]) => t === 'dead_state' && k === 'no_light').length, 1)
  assert.equal(events.filter(([t]) => t === 'dead_state_clear').length, 0)
  assert.ok(m.counts.no_light_suppressed >= 10)
  c.t += 700000; dark = true; m.check()   // a new episode after the dark has been away for > 10 min
  assert.equal(events.filter(([t, k]) => t === 'dead_state' && k === 'no_light').length, 2)
})
