import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig, sleep } from './helpers.js'

const good = (over = {}) => ({ name: 'good', max_s: 5, progress_fn: () => Date.now(), run: async () => ({ ok: true }), ...over })

test('registration rejects a skill without progress_fn, bad max_s, duplicates', () => {
  const { runner } = makeRig()
  assert.throws(() => runner.register({ name: 'x', max_s: 5, run: async () => {} }), /progress_fn/)
  assert.throws(() => runner.register({ name: 'x', progress_fn: () => 1, run: async () => {} }), /max_s/)
  assert.throws(() => runner.register({ name: 'x', max_s: 5, progress_fn: () => 1 }), /run\(\)/)
  runner.register(good())
  assert.throws(() => runner.register(good()), /duplicate/)
})

test('done, failed, exception, unknown skill, no body', async () => {
  const { runner, trace } = makeRig()
  runner.register(good())
  runner.register(good({ name: 'bad', run: async () => ({ ok: false, reason: 'nope' }) }))
  runner.register(good({ name: 'boom', run: async () => { throw new Error('x') } }))
  assert.equal((await runner.run('good')).status, 'done')
  const f = await runner.run('bad')
  assert.deepEqual([f.status, f.reason], ['failed', 'nope'])
  assert.equal((await runner.run('boom')).reason, 'exception')
  assert.equal((await runner.run('nothere')).status, 'rejected')
  assert.ok(trace.last('skill_start').length === 3 && trace.last('intent').length === 4)
  assert.equal(runner.state, 'idle')
})

test('precondition rejects; intent-level precondition rejects', async () => {
  const { runner } = makeRig()
  runner.register(good({ precondition: () => false }))
  assert.equal((await runner.run('good')).reason, 'precondition')
  runner.register(good({ name: 'g2' }))
  const r = await runner.run('g2', {}, { precondition: () => ({ ok: false, reason: 'target_gone' }) })
  assert.deepEqual([r.status, r.reason], ['rejected', 'target_gone'])
})

test('max_s aborts and cleans the body', async () => {
  const { runner, bot } = makeRig()
  runner.register({ name: 'long', max_s: 0.1, stall_s: 50, progress_fn: () => Date.now(), run: async (ctx) => { while (await ctx.sleep(10)); } })
  const t = Date.now()
  const r = await runner.run('long')
  assert.deepEqual([r.status, r.reason], ['aborted', 'max_s'])
  assert.ok(Date.now() - t < 1000)
  assert.ok(bot.calls.clear > 0 && bot.calls.stopDig > 0 && bot.calls.setGoalNull > 0)
})

test('no_progress watchdog works with NO pathfinder activity', async () => {
  const { runner } = makeRig()
  runner.register({ name: 'idle', max_s: 30, stall_s: 0.15, progress_fn: () => 'same', run: async (ctx) => { while (await ctx.sleep(10)); } })
  const r = await runner.run('idle')
  assert.deepEqual([r.status, r.reason], ['aborted', 'no_progress'])
})

test('progress keeps a skill alive; ctx.progress() counts', async () => {
  const { runner } = makeRig()
  let n = 0
  runner.register({ name: 'moving', max_s: 30, stall_s: 0.15, progress_fn: () => n, run: async (ctx) => { for (let i = 0; i < 20; i++) { await ctx.sleep(20); n++ } } })
  assert.equal((await runner.run('moving')).status, 'done')
  runner.register({ name: 'declared', max_s: 30, stall_s: 0.15, progress_fn: () => 'same', run: async (ctx) => { for (let i = 0; i < 15; i++) { await ctx.sleep(20); ctx.progress() } } })
  assert.equal((await runner.run('declared')).status, 'done')
})

test('abort() of a skill that ignores abort resolves in bounded time (orphaned)', async () => {
  const { runner, bot } = makeRig({ abortGraceMs: 150 })
  runner.register({ name: 'stubborn', max_s: 30, progress_fn: () => Date.now(), abort: () => new Promise(() => {}), run: () => new Promise(() => {}) })
  const p = runner.run('stubborn')
  await sleep(50)
  const t = Date.now()
  await runner.abort('test')
  const r = await p
  assert.ok(Date.now() - t < 600, 'bounded')
  assert.deepEqual([r.status, r.reason, r.orphaned], ['aborted', 'test', true])
  assert.equal(runner.state, 'idle')
  assert.ok(bot.calls.setGoalNull > 0)
})

test('goto wrapper converts PathStopped into {ok:false}; abort during goto', async () => {
  const { runner, bot } = makeRig()
  let seen
  runner.register({ name: 'g', max_s: 30, progress_fn: () => Date.now(), run: async (ctx) => { seen = await ctx.goto({}, { timeoutMs: 5000 }); return seen } })
  const p = runner.run('g')
  await sleep(30)
  await runner.abort('stop')
  const r = await p
  assert.equal(r.status, 'aborted')
  assert.deepEqual(seen, { ok: false, reason: 'aborted', message: 'stopped' })
  assert.equal(bot.calls.goto, 1)
})

test('goto timeout is bounded and reported', async () => {
  const { runner } = makeRig()
  let seen
  runner.register({ name: 'g', max_s: 30, progress_fn: () => Date.now(), run: async (ctx) => { seen = await ctx.goto({}, { timeoutMs: 60 }); return seen } })
  const r = await runner.run('g')
  assert.equal(seen.reason, 'GotoTimeout')
  assert.equal(r.status, 'failed')
})

test('mutex: second same-priority run is rejected busy; reflex preempts s1', async () => {
  const { runner, bot, trace } = makeRig()
  let cleaned = false
  runner.register({ name: 'slow', max_s: 30, progress_fn: () => Date.now(), abort: () => { cleaned = true }, run: async (ctx) => { while (await ctx.sleep(10)); } })
  runner.register(good({ name: 'flee', run: async () => { await sleep(30); return { ok: true } } }))
  const p1 = runner.run('slow', {}, { owner: 's1' })
  await sleep(40)
  assert.equal((await runner.run('slow', {}, { owner: 's1' })).reason, 'busy')
  assert.equal((await runner.run('slow', {}, { owner: 's2' })).reason, 'busy')
  const rf = await runner.run('flee', {}, { owner: 'reflex' })
  assert.equal(rf.status, 'done')
  const r1 = await p1
  assert.equal(r1.status, 'aborted')
  assert.match(r1.reason, /preempted_by:reflex:flee/)
  assert.ok(cleaned)
  assert.equal(trace.last('reflex').length, 1)
  assert.equal(runner.state, 'idle')
  assert.ok(bot.calls.clear > 0)
})
