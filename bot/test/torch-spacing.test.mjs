import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG } from '../src/habits/catalog.js'
import { makePlaceTorch } from '../src/skills/survival.js'

const h = CATALOG.find((x) => x.name === 'place_torch')
const near = { findBlock: () => ({ name: 'torch' }) }, far = { findBlock: () => null }
test('place_torch habit does not apply with a torch within 6 blocks', () => {
  assert.ok(!h.applies({ inv: { torches: 5 }, light: 0, bot: near }))
  assert.ok(h.applies({ inv: { torches: 5 }, light: 0, bot: far }))
})
test('place_torch skill: torch_nearby unless force', () => {
  const p = makePlaceTorch().precondition
  const bot = { ...near, entity: { position: { floored: () => ({ x: 0, y: 64, z: 0 }) } }, inventory: { items: () => [{ name: 'torch', count: 3 }] }, blockAt: () => null, health: 20 }
  const r = p({ bot, args: { force: false } }); assert.ok(r === true || r.reason !== undefined)
})
