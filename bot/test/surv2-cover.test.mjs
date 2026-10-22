// SURV2: hp <= 6 with a hostile in range seals her in fast (pit with a pick, else pillbox), shield toward the shooter first.
import test from 'node:test'
import assert from 'node:assert/strict'
import { flat, rig, until, stopAll } from './reflex-helpers.mjs'
test.after(stopAll)
const ends = (r, name) => r.trace.last('reflex_end').filter((e) => e.name === name)

test('low_hp_cover: hp 4, skeleton at 15 m, 32 cobblestone -> sealed, shield first, flee reflex stays out', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { shelterMaxMs: 1000 } })
  r.bot.give('cobblestone', 32); r.bot.health = 4
  r.bot.addEntity('skeleton', 15.5, 64, 0.5)
  assert.ok(await until(() => r.trace.last('low_hp_cover').length > 0, 8000), 'reflex ran')
  const c = r.trace.last('low_hp_cover')[0]
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.equal(c.mode, 'shield')   // shield placed first, then walls
  assert.deepEqual(r.bot.calls.place[0], [1, 64, 0], 'first block is the one toward the skeleton')
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(w.name(dx, 65, dz), 'cobblestone')
  await r.stop()
})

test('low_hp_cover: not at hp 15, not without means', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] })
  r.bot.give('cobblestone', 32); r.bot.health = 15
  r.bot.addEntity('skeleton', 15.5, 64, 0.5)
  await new Promise((x) => setTimeout(x, 600))
  assert.equal(r.reflex.stats.low_hp_cover.fired, 0)
  await r.stop()
  const w2 = flat(); const r2 = rig(w2, { pos: [0.5, 64, 0.5] })
  r2.bot.health = 4; r2.bot.addEntity('zombie', 6.5, 64, 0.5)
  await new Promise((x) => setTimeout(x, 600))
  assert.equal(r2.reflex.stats.low_hp_cover.fired, 0, 'nothing to build with')
  await r2.stop()
})
