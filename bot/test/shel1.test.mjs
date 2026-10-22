// SHEL1: observed: shelter failed 9x (only_falling_blocks, ~100,63,100, sand bag, centre cap unsupported). It must seal as open-top, and never retry a failing place more than twice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { World, flat, mockBot } from './reflex-helpers.mjs'
import { makeShelter, noteShelterFail, shelterFailsNear, resetShelterFails } from '../src/skills/shelter.js'

const mkCtx = (bot) => { const logs = []; return { bot, args: { max_wait_s: 1 }, state: {}, aborted: false, log: (t, d) => logs.push([t, d]), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), goto: async () => ({ ok: true }), logs } }
const night = (bot) => { bot._h1ForcePhase = 'night'; return bot }

test('sand-only bag: walls placed, open top accepted, no build_failed (observed)', async () => {
  resetShelterFails()
  const w = flat(); const bot = night(mockBot(w, { pos: [0.5, 64, 0.5] }))
  bot.give('sand', 26)
  const ctx = mkCtx(bot); const t0 = Date.now()
  const sk = makeShelter({})
  const run = sk.run(ctx)
  setTimeout(() => { bot._h1ForcePhase = 'day' }, 60)
  const r = await run
  assert.equal(r.ok, true, JSON.stringify([r, ctx.logs]))
  assert.ok(ctx.logs.some(([t]) => t === 'shelter_open_top'), JSON.stringify(ctx.logs))
  assert.ok(!ctx.logs.some(([t]) => t === 'build_failed_detail'))
  assert.ok(Date.now() - t0 < 2000)
})

test('no blocks at all and nothing to dig with: fails with an honest reason, recorded; third try is suppressed in ms', async () => {
  resetShelterFails()
  const w = flat(); const bot = night(mockBot(w, { pos: [0.5, 64, 0.5] }))
  const sk = makeShelter({})
  for (let i = 0; i < 2; i++) { const ctx = mkCtx(bot); const r = await sk.run(ctx); assert.equal(r.ok, false); assert.equal(r.reason, 'build_failed') }
  assert.equal(shelterFailsNear({ x: 0, y: 64, z: 0 }), 2)
  const ctx = mkCtx(bot); const t0 = Date.now(); const r = await sk.run(ctx)
  assert.equal(r.reason, 'build_failed_repeat'); assert.ok(Date.now() - t0 < 200)
  assert.equal(shelterFailsNear({ x: 40, y: 64, z: 40 }), 0)
  noteShelterFail({ x: 40, y: 64, z: 40 }); assert.equal(shelterFailsNear({ x: 40, y: 64, z: 40 }), 1)
})
