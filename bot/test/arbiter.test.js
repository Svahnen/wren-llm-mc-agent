import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig, sleep } from './helpers.js'

test('grant, deny equal/lower priority, release', async () => {
  const { arbiter } = makeRig()
  const t = await arbiter.acquire('s1', { label: 'a' })
  assert.ok(t.active)
  assert.equal(await arbiter.acquire('s1'), null)
  assert.equal(await arbiter.acquire('s2'), null)
  t.release()
  assert.equal(t.active, false)
  assert.equal(arbiter.owner, null)
  const t2 = await arbiter.acquire('s2')
  assert.ok(t2)
})

test('reflex preempts s1: body stopped synchronously, token revoked, onPreempt awaited', async () => {
  const { arbiter, bot } = makeRig()
  let preemptCalled = null
  const t1 = await arbiter.acquire('s1', { label: 'walk', onPreempt: async (r) => { await sleep(20); preemptCalled = r } })
  const before = bot.calls.setGoalNull
  const p = arbiter.acquire('reflex', { label: 'lava' })
  assert.ok(bot.calls.setGoalNull > before, 'pathfinder stopped before any await')
  const t3 = await p
  assert.equal(t3.owner, 'reflex')
  assert.equal(t1.active, false)
  assert.ok(t1.signal.aborted)
  assert.match(preemptCalled, /preempted_by:reflex:lava/)
  t1.release() // stale release must not drop the reflex token
  assert.equal(arbiter.owner, 'reflex')
  t3.release()
  assert.equal(arbiter.owner, null)
})

test('holder that never winds down is forced out after the timeout', async () => {
  const { arbiter } = makeRig({ preemptTimeoutMs: 80 })
  await arbiter.acquire('s2', { onPreempt: () => new Promise(() => {}) })
  const t0 = Date.now()
  const r = await arbiter.acquire('s1')
  assert.ok(r)
  assert.ok(Date.now() - t0 < 500)
})

test('lower priority waiter during a preemption is denied afterwards', async () => {
  const { arbiter } = makeRig()
  await arbiter.acquire('s2', { onPreempt: () => sleep(50) })
  const pr = arbiter.acquire('reflex')
  const ps = arbiter.acquire('s1')
  const [r, s] = await Promise.all([pr, ps])
  assert.ok(r); assert.equal(s, null)
})

test('revokeAll cancels the holder; runAs releases and reports denial', async () => {
  const { arbiter } = makeRig()
  const t = await arbiter.acquire('s1')
  await arbiter.revokeAll('state:dead')
  assert.equal(t.active, false)
  assert.equal(arbiter.owner, null)
  const res = await arbiter.runAs('reflex', 'eat', async () => 42)
  assert.deepEqual(res, { ok: true, value: 42 })
  assert.equal(arbiter.owner, null)
  await arbiter.acquire('reflex')
  assert.deepEqual(await arbiter.runAs('s1', 'x', async () => 1), { ok: false, reason: 'denied' })
})
