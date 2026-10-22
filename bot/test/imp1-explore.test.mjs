// IMP1: explore no_reachable_target near home: hills beyond the old +6/-10 band, and short frontier legs when the long ones fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeExplore, sampleTargets } from '../src/skills/wander.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'

const solid = { name: 'stone', boundingBox: 'block' }, air = { name: 'air', boundingBox: 'empty' }
// ground at y=64 within 12 blocks of the origin, y=80 (a hill) beyond
const mkBot = () => ({ entity: { position: { x: 0.5, y: 65, z: 0.5 } }, health: 20, blockAt: (p) => { const gy = Math.hypot(p.x, p.z) < 12 ? 64 : 80; return p.y <= gy ? solid : air } })

test('hills beyond the old vertical band are found by the wide search', () => {
  const env = { rng: makeRng(7), heatmap: new Heatmap({ cell: 8 }) }
  const old = sampleTargets(mkBot(), env, { radius: 70, minDist: 30, wide: false })
  const now = sampleTargets(mkBot(), env, { radius: 70, minDist: 30, stats: {} })
  assert.equal(old.length, 0)
  assert.ok(now.length > 10 && now.every((t) => t.y === 81))
})
test('when the long legs fail, a short frontier leg is walked instead of no_reachable_target', async () => {
  const env = { rng: makeRng(3), heatmap: new Heatmap({ cell: 8 }) }
  const sk = makeExplore(env)
  const targets = [], logs = []
  const ctx = { bot: mkBot(), args: {}, aborted: false, state: {}, log: (k, d) => logs.push([k, d]), sleep: async () => {},
    goto: async (g) => { const d = Math.hypot(g.x - 0.5, g.z - 0.5); targets.push(d); if (d > 25) return { ok: false, reason: 'timeout' }; ctx.bot.entity.position = { x: g.x, y: g.y, z: g.z }; return { ok: true } } }
  const r = await sk.run(ctx)
  assert.equal(r.ok, true, JSON.stringify(logs.at(-1)))
  assert.ok(targets.length > 3 && targets.at(-1) <= 25)   // three failed long legs, then a short one
})
test('all legs failing reports the diagnosis', async () => {
  const env = { rng: makeRng(3), heatmap: new Heatmap({ cell: 8 }) }
  const logs = []
  const ctx = { bot: mkBot(), args: {}, aborted: false, state: {}, log: (k, d) => logs.push([k, d]), sleep: async () => {}, goto: async () => ({ ok: false, reason: 'timeout' }) }
  const r = await makeExplore(env).run(ctx)
  assert.deepEqual(r, { ok: false, reason: 'no_reachable_target' })
  const d = logs.find((l) => l[0] === 'explore_diag')[1]
  assert.equal(d.goto_failed, 5)
})
