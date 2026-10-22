import test from 'node:test'
import assert from 'node:assert/strict'
import { Body } from '../src/lifecycle.js'
import { Trace } from '../src/trace.js'
import { fakeBot, sleep } from './helpers.js'

function rig(over = {}) {
  const bots = []
  const trace = new Trace()
  const body = new Body({
    createBot: () => { const b = fakeBot(); bots.push(b); return b },
    trace, reconnect: { baseMs: 20, maxMs: 200, factor: 2, jitter: 0 }, connectTimeoutMs: 200, stableMs: 100, rng: () => 0.5, ...over,
  })
  const states = []
  body.on('state', (e) => states.push(e.to))
  return { body, bots, states, trace }
}

test('connecting -> spawned -> dead -> respawning -> spawned', async () => {
  const { body, bots, states } = rig()
  body.start()
  const b = bots[0]
  b.emit('login'); b.emit('spawn')
  b.emit('death'); b.emit('respawn'); b.emit('spawn')
  assert.deepEqual(states, ['connecting', 'spawned', 'dead', 'respawning', 'spawned'])
  await body.stop()
})

test('state listeners run synchronously (skills can be cancelled in the same tick)', () => {
  const { body, bots } = rig()
  let sawDead = false
  body.on('state', (e) => { if (e.to === 'dead') sawDead = true })
  body.start(); bots[0].emit('spawn'); bots[0].emit('death')
  assert.ok(sawDead)
  body.stop()
})

test('end -> disconnected -> reconnect with growing backoff; reset after stable spawn', async () => {
  const { body, bots, trace } = rig()
  body.start()
  bots[0].emit('end', 'x')
  await sleep(30); assert.equal(bots.length, 2) // 20 ms
  bots[1].emit('end', 'x')
  await sleep(25); assert.equal(bots.length, 2) // 40 ms not yet
  await sleep(40); assert.equal(bots.length, 3)
  const delays = trace.last('reconnect_scheduled').map((r) => r.in_ms)
  assert.deepEqual(delays, [20, 40])
  bots[2].emit('spawn')
  await sleep(150) // stableMs elapsed
  bots[2].emit('end', 'x')
  assert.equal(trace.last('reconnect_scheduled').at(-1).in_ms, 20)
  await body.stop()
})

test('kick is logged, reconnect follows; stale generation events are ignored', async () => {
  const { body, bots, states, trace } = rig()
  body.start(); bots[0].emit('spawn')
  bots[0].emit('kicked', 'bye'); bots[0].emit('end', 'socketClosed')
  assert.equal(body.state, 'disconnected')
  assert.equal(trace.last('kicked').length, 1)
  await sleep(40)
  assert.equal(bots.length, 2)
  const n = states.length
  bots[0].emit('death'); bots[0].emit('spawn') // old bot, must be ignored
  assert.equal(states.length, n)
  await body.stop()
})

test('connect timeout leads to a retry', async () => {
  const { body, bots } = rig({ connectTimeoutMs: 60 })
  body.start()
  await sleep(120)
  assert.ok(bots.length >= 2, 'timeout retry')
  body.stop()
})

test('stop() prevents reconnect and ends disconnected', async () => {
  const { body, bots } = rig()
  body.start(); bots[0].emit('spawn')
  await body.stop('test')
  await sleep(80)
  assert.equal(bots.length, 1)
  assert.equal(body.state, 'disconnected')
})

test('createBot throwing schedules a retry instead of crashing', async () => {
  let n = 0
  const body = new Body({ createBot: () => { if (n++ < 1) throw new Error('boom'); return fakeBot() }, reconnect: { baseMs: 10, maxMs: 50, factor: 2, jitter: 0 }, connectTimeoutMs: 500 })
  body.start()
  await sleep(60)
  assert.equal(n, 2)
  await body.stop()
})

test('non-fatal parse errors do not disconnect', () => {
  const { body, bots } = rig()
  body.start(); bots[0].emit('spawn')
  bots[0].emit('error', Object.assign(new Error('PartialReadError'), { name: 'PartialReadError' }))
  assert.equal(body.state, 'spawned')
  body.stop()
})
