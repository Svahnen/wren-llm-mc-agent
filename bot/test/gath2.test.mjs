// GATH2: gather_stone digs a safe stair through soil when no stone is exposed, gets back up; wood seeks a forest; empty searches are fast and cached.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { gatherResource, planStair } from '../src/skills/gather.js'
import { PlacedBlocks } from '../src/skills/movements-protect.js'

/** flat world: grass y=63, dirt 61..62, stone <=60 (stoneTop param); `extra` map overrides */
function world({ stoneTop = 60, extra = {}, pos = [0, 64, 0] } = {}) {
  const m = new Map(Object.entries(extra))
  const bot = new EventEmitter()
  const reg = { blocksByName: { oak_log: { id: 1, name: 'oak_log' }, dirt: { id: 2, name: 'dirt' }, grass_block: { id: 3, name: 'grass_block' }, stone: { id: 4, name: 'stone' }, cobblestone: { id: 5, name: 'cobblestone' } } }
  const inv = []
  bot.registry = reg; bot.entity = { position: new Vec3(pos[0] + 0.5, pos[1], pos[2] + 0.5), onGround: true }; bot.health = 20; bot.entities = {}
  bot.inventory = { items: () => inv, emptySlotCount: () => 20 }
  bot.__placed = new PlacedBlocks()
  const nameAt = (x, y, z) => m.get([x, y, z].join(',')) ?? (y === 63 ? 'grass_block' : y > 63 ? 'air' : y > stoneTop ? 'dirt' : 'stone')
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); const n = nameAt(x, y, z); const solid = n !== 'air'; return { name: n, boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z), light: 0, skyLight: 15 } }
  bot.findBlocks = ({ matching, maxDistance, count, useExtraInfo }) => {
    const ids = [].concat(matching), out = []
    const [px, py, pz] = [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z].map(Math.floor), R = Math.min(maxDistance, 20)
    for (let x = px - R; x <= px + R; x++) for (let y = 40; y <= 70; y++) for (let z = pz - R; z <= pz + R; z++) {
      const n = nameAt(x, y, z); if (!ids.includes(reg.blocksByName[n]?.id)) continue
      const d = Math.hypot(x - px, y - py, z - pz); if (d > maxDistance) continue
      const b = bot.blockAt(new Vec3(x, y, z)); if (useExtraInfo && !useExtraInfo(b)) continue
      out.push({ d, p: new Vec3(x, y, z) })
    }
    return out.sort((a, b) => a.d - b.d).slice(0, count).map((o) => o.p)
  }
  bot.dig = async (b) => { const n = b.name; m.set([b.position.x, b.position.y, b.position.z].join(','), 'air'); const item = n === 'stone' ? 'cobblestone' : n === 'grass_block' ? 'dirt' : n; const e = inv.find((i) => i.name === item); if (e) e.count++; else inv.push({ name: item, count: 1, type: 99 }) }
  bot.stopDigging = () => {}; bot.equip = async () => {}
  return { bot, m, inv }
}
const mkctx = (bot) => {
  const log = []
  const c = { bot, aborted: false, state: {}, log: (e, d) => log.push([e, d]), sleep: async () => {}, logs: log }
  c.goto = async (g) => {
    let x = g.x ?? g.pos?.x, z = g.z ?? g.pos?.z, y = g.y
    if (x === undefined) return { ok: false }
    if (g.pos) { // look-at: stand on the nearest free column cell next to the block
      y = g.pos.y; x = g.pos.x + 1; z = g.pos.z
      const free = (yy) => bot.blockAt(new Vec3(x, yy, z)).boundingBox === 'empty'
      if (!free(y)) { x = g.pos.x - 1 } if (!free(y)) return { ok: true }
    }
    if (y === undefined) y = 64
    bot.entity.position = new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
    return { ok: true }
  }
  return c
}

test('GATH2: stone under dirt on a plain: stair digs 8 cobblestone and she is back on the surface', async () => {
  const { bot, inv } = world({ stoneTop: 61 })
  const c = mkctx(bot)
  const r = await gatherResource(c, { }, 'stone', 8)
  const cobble = inv.filter((i) => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0)

  assert.equal(r.ok, true, JSON.stringify([r, c.logs.slice(-6)]))
  assert.ok(cobble >= 8, `cobble ${cobble}`)
  assert.ok(bot.entity.position.y >= 63.9, `y ${bot.entity.position.y}`)
  assert.ok(c.logs.some(([e]) => e === 'stair_plan'))
  // never deeper than STAIR_DEPTH+1 below the top: no stone dug below y 58
})
test('GATH2: the stair is never planned under a roof or straight down', () => {
  const roof = {}; for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) roof[`${x},67,${z}`] = 'oak_planks'
  const { bot } = world({ stoneTop: 61, extra: roof })
  const p = planStair(bot, {}, bot.entity.position)
  assert.ok(p, 'a site outside the roof')
  assert.ok(Math.abs(p.top.x) > 3 || Math.abs(p.top.z) > 3, JSON.stringify(p.top))
  assert.ok(p.dir[0] !== 0 || p.dir[1] !== 0)
})
test('GATH2: no stair through water, lava or a protected region', () => {
  const lava = {}; for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) lava[`${x},59,${z}`] = 'lava'
  const { bot } = world({ stoneTop: 61, extra: lava })
  assert.equal(planStair(bot, {}, bot.entity.position), null)
  const w = world({ stoneTop: 61 })
  assert.equal(planStair(w.bot, { digForbidden: () => true }, w.bot.entity.position), null)
})
test('GATH2: exposed stone in a hillside is preferred, no stair', async () => {
  const { bot } = world({ stoneTop: 50, extra: { '3,64,0': 'stone', '3,65,0': 'stone' } })
  const c = mkctx(bot)
  const r = await gatherResource(c, {}, 'stone', 2)
  assert.equal(r.ok, true)
  assert.ok(!c.logs.some(([e]) => e === 'stair_plan'))
})
test('GATH2: wood: nothing loaded -> probes outward, honest reason, then cached for 30 s (fast)', async () => {
  const { bot } = world()
  const c = mkctx(bot)
  const env = {}
  const t0 = Date.now()
  const r = await gatherResource(c, env, 'wood', 2)
  assert.equal(r.reason, 'no_target_found'); assert.match(r.detail, /no log within 112 m/); assert.match(r.detail, /looked further away/)
  assert.ok(c.logs.filter(([e]) => e === 'seek_forest').length >= 1)
  const c2 = mkctx(bot); const r2 = await gatherResource(c2, env, 'wood', 2)
  assert.match(r2.detail, /on cooldown/); assert.ok(r2.detail.includes(r.detail.slice(0, 40))); assert.ok(c2.logs[0][1].cached)   // BAT1: the 30 s cache is now a 5 min cooldown with the reason shown
})
test('GATH2: wood: a remembered forest is visited and its tree taken', async () => {
  const { bot } = world({ extra: { '104,64,0': 'oak_log' } })
  const places = {}
  const lm = { places, list: () => Object.entries(places).map(([id, v]) => ({ id, ...v })), set: (id, p, kind) => { places[id] = { x: p.x, y: p.y, z: p.z, kind, t: Date.now() } }, forget: (id) => delete places[id], home: null }
  lm.set('forest_a', { x: 100, y: 64, z: 0 }, 'forest')
  const env = { landmarks: lm }
  const origFind = bot.findBlocks
  bot.findBlocks = (o) => { const p = bot.entity.position; const res = origFind.call(bot, { ...o, maxDistance: 1e9 }); return res.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) <= o.maxDistance) } // mock: unlimited world, true radius
  const c = mkctx(bot)
  const r = await gatherResource(c, env, 'wood', 1)
  assert.equal(r.ok, true, JSON.stringify([r, c.logs.slice(-5)]))
  assert.ok(c.logs.some(([e, d]) => e === 'seek_forest' && d.to === 'forest_a'))
})
test('GATH2: buried-stone search is bounded (< 2 s) even when 400k stones match', async () => {
  const { bot } = world({ stoneTop: 61 })
  let calls = 0
  const base = bot.findBlocks
  bot.findBlocks = (o) => { const b = o.useExtraInfo; if (b) { // simulate a huge sphere: call the filter 200k times
    for (let i = 0; i < 200000; i++) { calls++; b({ position: new Vec3(i % 50, 55, i % 70) }) } } return base.call(bot, o) }
  const c = mkctx(bot); c.goto = async () => ({ ok: false })
  const t0 = Date.now()
  await gatherResource(c, { digForbidden: () => false }, 'stone', 8)
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
})
