import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Trace } from '../src/trace.js'
import { Metrics } from '../src/metrics.js'
import { Heatmap } from '../src/heatmap.js'
import { loadConfig } from '../config.js'
import { makeRng } from '../src/util.js'
import { sleep } from './helpers.js'

test('trace: JSONL lines, rotation by size, never throws on circular data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'))
  const tr = new Trace({ dir, maxBytes: 600 })
  for (let i = 0; i < 20; i++) tr.event('x', { i, pad: 'p'.repeat(50) })
  const circ = {}; circ.self = circ
  tr.event('circ', circ)
  const files = fs.readdirSync(dir).sort()
  assert.ok(files.length >= 3, files.join())
  assert.match(files[0], /^trace-\d{8}(\.\d+)?\.jsonl$/)
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
  assert.equal(lines.length, 21)
  for (const l of lines) JSON.parse(l)
  // a new Trace continues the latest part instead of overwriting
  const tr2 = new Trace({ dir, maxBytes: 600 })
  tr2.event('again')
  assert.equal(fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).length, 22)
  fs.rmSync(dir, { recursive: true })
})

test('metrics: event-loop lag sees a blocked loop; counters', async () => {
  const m = new Metrics({ resolution: 5 })
  await sleep(30)
  const t = Date.now(); while (Date.now() - t < 120); // block
  await sleep(30)
  m.skill('aborted', 'max_s'); m.skill('done'); m.reflex('lava'); m.age(42); m.state('dead')
  const s = m.snapshot()
  assert.ok(s.event_loop_lag.max_ms >= 100, JSON.stringify(s.event_loop_lag))
  assert.equal(s.skills.aborted, 1); assert.equal(s.abort_reasons.max_s, 1)
  assert.equal(s.reflexes.lava, 1); assert.equal(s.deaths, 1); assert.equal(s.intent_age_ms.max, 42)
  m.stop()
})

test('heatmap prefers unvisited cells; save/load round-trips', () => {
  const h = new Heatmap({ cell: 8, rng: makeRng(1) })
  // saturate the east half-plane
  for (let x = 0; x < 80; x += 4) for (let z = -80; z < 80; z += 4) for (let k = 0; k < 5; k++) h.visit(x, z)
  let west = 0
  for (let i = 0; i < 100; i++) { const t = h.pickTarget({ x: 0, z: 0 }, { radius: 40 }); if (t.x < 0) west++ }
  assert.ok(west > 90, `west=${west}`)
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-')), 'h.json')
  h.save(f)
  const h2 = new Heatmap({ cell: 8 }); assert.ok(h2.load(f)); assert.equal(h2.size, h.size)
})

test('config: defaults, env, validation, default-port guard', () => {
  const c = loadConfig({})
  assert.deepEqual([c.host, c.port, c.username, c.version, c.auth], ['127.0.0.1', 25566, 'Wren', '1.21.1', 'offline'])
  assert.equal(loadConfig({ MC_HOST: '192.0.2.10', MC_PORT: '25570', BOT_NAME: 'WrenT1' }).port, 25570)
  assert.throws(() => loadConfig({ MC_PORT: 'abc' }), /MC_PORT/)
  assert.throws(() => loadConfig({ BOT_NAME: 'x' }), /BOT_NAME/)
  assert.throws(() => loadConfig({ MC_PORT: '25565' }), /default Minecraft port/)
  assert.throws(() => loadConfig({ MC_PORT: '0', BOT_NAME: '!' }), /MC_PORT.*BOT_NAME/)
})
