// SURV2: a block she placed herself is never refused as 'known_place'/'near_structure'; sealed in her own pillbox at night is not 'confined'.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { builtReason, PlacedBlocks } from '../src/skills/movements-protect.js'
import { inOwnShelter } from '../src/detect/stuck.js'

function world(solidCells) {
  const set = new Set(solidCells.map((c) => c.join(',')))
  const bot = { entity: { position: new Vec3(10.5, 64, 10.5) }, __placed: new PlacedBlocks(), __landmarks: { places: { shelter: { x: 10, y: 64, z: 10, kind: 'shelter' } } },
    blockAt: (v) => { const k = [Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)]; const s = set.has(k.join(',')); return { name: s ? 'dirt' : 'air', boundingBox: s ? 'block' : 'empty', position: new Vec3(...k) } } }
  return bot
}
const box = []
for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) box.push([10 + dx, y, 10 + dz])
box.push([11, 66, 10], [10, 66, 10])

test('own pillbox block inside a known place may be dug; a foreign one may not', () => {
  const bot = world([...box, [14, 64, 10]])
  const far = bot.blockAt(new Vec3(14, 64, 10))   // not beside her: a foreign block of the known place stays protected
  assert.equal(builtReason(bot, far), 'known_place')
  const wall = bot.blockAt(new Vec3(11, 64, 10))  // sealed in: the wall is her way out, placed-blocks entry or not
  assert.equal(builtReason(bot, wall), null)
  bot.__placed.add({ x: 14, y: 64, z: 10 })
  assert.equal(builtReason(bot, far), null, 'own block in a known place')
})
test('sealed in an own pillbox is recognised, a foreign cell is not', () => {
  const bot = world(box)
  assert.equal(inOwnShelter(bot), false)
  for (const c of box) bot.__placed.add({ x: c[0], y: c[1], z: c[2] })
  assert.equal(inOwnShelter(bot), true)
})
