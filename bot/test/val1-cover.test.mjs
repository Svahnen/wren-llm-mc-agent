// VAL1: a skill covered by a reflex (fight <- mob_defense) waits for the reflex instead of a busy rejection, and is reported satisfied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig, sleep } from './helpers.js'

const cov = (over = {}) => ({ name: 'fightx', max_s: 5, coveredBy: ['mob_defense'], coverWaitMs: 800, progress_fn: () => Date.now(), precondition: () => (globalThis.__hostile ? true : { ok: false, reason: 'no_target_found' }), run: async () => ({ ok: true }), ...over })

test('reflex mob_defense holds the body, last target dies: fight intent is done (reflex_handled), no busy', async () => {
  const { runner, arbiter } = makeRig()
  runner.register(cov())
  globalThis.__hostile = true
  const t = await arbiter.acquire('reflex', { label: 'mob_defense' })
  setTimeout(() => { globalThis.__hostile = false; t.release() }, 150)
  const r = await runner.run('fightx', {}, { owner: 's1' })
  assert.deepEqual([r.status, r.reason], ['done', 'reflex_handled'])
})

test('precondition already false while the covering reflex holds the body: done at once', async () => {
  const { runner, arbiter } = makeRig()
  runner.register(cov())
  globalThis.__hostile = false
  const t = await arbiter.acquire('reflex', { label: 'mob_defense' })
  const r = await runner.run('fightx', {}, { owner: 's1' })
  assert.equal(r.reason, 'reflex_handled'); t.release()
})

test('reflex ends but a hostile is left: the skill itself runs', async () => {
  const { runner, arbiter } = makeRig()
  let ran = 0
  runner.register(cov({ run: async () => { ran++; return { ok: true } } }))
  globalThis.__hostile = true
  const t = await arbiter.acquire('reflex', { label: 'mob_defense' })
  setTimeout(() => t.release(), 100)
  const r = await runner.run('fightx', {}, { owner: 's1' })
  assert.equal(r.status, 'done'); assert.equal(ran, 1)
})

test('another reflex (low_health_flee) holding the body stays a plain busy rejection', async () => {
  const { runner, arbiter } = makeRig()
  runner.register(cov())
  globalThis.__hostile = true
  const t = await arbiter.acquire('reflex', { label: 'low_health_flee' })
  const t0 = Date.now()
  const r = await runner.run('fightx', {}, { owner: 's1' })
  assert.deepEqual([r.status, r.reason], ['rejected', 'busy']); assert.ok(Date.now() - t0 < 300); t.release()
})

test('covering reflex never ends within the wait: busy (bounded)', async () => {
  const { runner, arbiter } = makeRig()
  runner.register(cov({ coverWaitMs: 200 }))
  globalThis.__hostile = true
  const t = await arbiter.acquire('reflex', { label: 'mob_defense' })
  const r = await runner.run('fightx', {}, { owner: 's1' })
  assert.deepEqual([r.status, r.reason], ['rejected', 'busy']); t.release()
})

test('real fight skill declares the cover', async () => {
  const { makeFight } = await import('../src/skills/fight.js')
  assert.deepEqual(makeFight().coveredBy, ['mob_defense'])
})
