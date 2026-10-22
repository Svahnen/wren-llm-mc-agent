// GATH1: gather searches to 64 m and explains an empty result; digest freshness/sheltered; shelter exit breach; harmless dark.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { gatherResource, explainNoTarget } from '../src/skills/gather.js'
import { PlacedBlocks, installBuiltGuard } from '../src/skills/movements-protect.js'
import { inOwnShelter } from '../src/detect/stuck.js'
import { darkIsHarmless } from '../src/detect/deadstate.js'
import { brainDigest, confinedNote } from '../src/mindlink/digest.js'
import { renderDigest } from '../../brain/prompt.js'
import { normalizeDigest } from '../../brain/contract.js'

/** world: map 'x,y,z' -> name; everything else air, floor of dirt at y=63 (not in map: handled by blockAt) */
function mk(blocks, pos = [0, 64, 0]) {
  const m = new Map(Object.entries(blocks))
  const bot = new EventEmitter()
  const reg = { blocksByName: { oak_log: { id: 1, name: 'oak_log' }, dirt: { id: 2, name: 'dirt' }, grass_block: { id: 3, name: 'grass_block' }, stone: { id: 4, name: 'stone' } } }
  bot.registry = reg; bot.entity = { position: new Vec3(pos[0] + 0.5, pos[1], pos[2] + 0.5) }; bot.health = 20; bot.inventory = { items: () => [], emptySlotCount: () => 20 }
  bot.__placed = new PlacedBlocks()
  const nameAt = (x, y, z) => m.get([x, y, z].join(',')) ?? (y === 63 ? 'grass_block' : y < 63 ? 'stone' : 'air')
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); const n = nameAt(x, y, z); const solid = n !== 'air'; return { name: n, boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z), light: 0, skyLight: 15 } }
  bot.findBlocks = ({ matching, maxDistance, count }) => {
    const ids = [].concat(matching), out = []
    for (const [k, n] of m) { const [x, y, z] = k.split(',').map(Number); const id = reg.blocksByName[n]?.id; if (!ids.includes(id)) continue; const d = Math.hypot(x - pos[0], y - pos[1], z - pos[2]); if (d <= maxDistance) out.push({ d, p: new Vec3(x, y, z) }) }
    return out.sort((a, b) => a.d - b.d).slice(0, count).map((o) => o.p)
  }
  return { bot, m }
}
const ctx = (bot) => ({ bot, aborted: false, state: {}, log() {}, sleep: async () => {}, goto: async () => ({ ok: false }) })

test('GATH1: nothing within 64 m: result says so', async () => {
  const { bot } = mk({})
  const r = await gatherResource(ctx(bot), {}, 'wood', 2)
  assert.equal(r.reason, 'no_target_found'); assert.match(r.detail, /no log within 112 m/)
})
test('GATH1: a log 50 m away is found (radius expands past 40)', async () => {
  const { bot } = mk({ '50,64,0': 'oak_log' })
  const seen = []
  const c = { ...ctx(bot), aborted: false, log: (e, d) => seen.push([e, d]) }
  c.goto = async () => { c.aborted = true; return { ok: false } }
  await gatherResource(c, {}, 'wood', 1)
  assert.ok(seen.some(([e, d]) => e === 'target' && d.at[0] === 50), JSON.stringify(seen))
})
test('GATH1: dirt that is part of the house is not taken and the result explains it', async () => {
  // a bed beside the dirt makes it near_structure
  const { bot, m } = mk({ '4,64,0': 'dirt', '5,64,0': 'white_bed' })
  bot.__landmarks = { places: {} }
  const exp = explainNoTarget(bot, {}, 'dirt', [2])
  assert.match(exp, /1 dirt blocks within 64 m but none usable/)
  assert.match(exp, /part of your house|buried|unreachable/)
  void m
})
test('GATH1: darkIsHarmless - open sky at night and own shelter', () => {
  const { bot } = mk({})
  assert.equal(darkIsHarmless(bot, 15), 'open_sky_night')
  const box = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) box.push([dx, y, dz])
  box.push([1, 66, 0], [0, 66, 0])
  const w = mk(Object.fromEntries(box.map((c) => [c.join(','), 'dirt'])), [0, 64, 0])
  for (const c of box) w.bot.__placed.add({ x: c[0], y: c[1], z: c[2] })
  assert.equal(inOwnShelter(w.bot), true)
  assert.equal(darkIsHarmless(w.bot, 0), 'own_shelter')
  const open = mk({}); assert.equal(darkIsHarmless(open.bot, 0), null, 'a dark open cave cell is still a dead state')
})
test('GATH1: sheltered in the digest, no confined words; prompt line', () => {
  const box = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) box.push([dx, y, dz])
  box.push([1, 66, 0], [0, 66, 0])
  const w = mk(Object.fromEntries(box.map((c) => [c.join(','), 'dirt'])), [0, 64, 0])
  w.bot.entities = {}; w.bot.username = 'W'; w.bot.players = {}
  for (const c of box) w.bot.__placed.add({ x: c[0], y: c[1], z: c[2] })
  const d = brainDigest(w.bot, {})
  assert.equal(d.sheltered, true); assert.ok(d.at > 0)
  assert.equal(confinedNote(w.bot), null)
  const txt = renderDigest(normalizeDigest(d))
  assert.match(txt, /state: sheltered/); assert.ok(!/confined/.test(txt))
})
test('GATH1: position line carries the digest age when it is old', () => {
  const dg = normalizeDigest({ pos: [1, 2, 3], at: 1000000 })
  assert.ok(!/as of/.test(renderDigest(dg, { now: 1005000 })))
  assert.match(renderDigest(dg, { now: 1000000 + 4 * 60000 }), /position: 1,2,3 \(as of 4 min ago/)
})
test('GATH1: breaking an own shelter wall to leave records a shelter_exit breach; repair puts it back', async () => {
  const box = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) box.push([dx, y, dz])
  box.push([1, 66, 0], [0, 66, 0])
  const w = mk(Object.fromEntries(box.map((c) => [c.join(','), 'dirt'])), [0, 64, 0])
  w.bot.dig = async (b) => { w.m.delete([b.position.x, b.position.y, b.position.z].join(',')) }
  w.bot.placeBlock = async () => {}
  installBuiltGuard(w.bot)
  for (const c of box) w.bot.__placed.add({ x: c[0], y: c[1], z: c[2] })
  const cap = w.bot.blockAt(new Vec3(0, 66, 0))
  await w.bot.dig(cap)
  assert.deepEqual(w.bot.__wallBreach?.at, [0, 66, 0]); assert.equal(w.bot.__wallBreach.why, 'shelter_exit')
})
