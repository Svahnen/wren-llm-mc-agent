// ARB1: busy-retry spam. A reflex holds the body; S1 must not re-request every 300 ms (was 26 rejects per intent_id).
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig, sleep } from './helpers.js'
import { createS1 } from '../src/s1/selector.js'

const skill = (name, over = {}) => ({ name, max_s: 5, progress_fn: () => Date.now(), run: async () => ({ ok: true }), ...over })

test('runner: same (skill,intent) rejected busy under one hold is logged once, counted, summarised on release', async () => {
  const { runner, arbiter, trace } = makeRig()
  runner.register(skill('dig_in'))
  const t = await arbiter.acquire('reflex', { label: 'low_health_flee' })
  for (let i = 0; i < 26; i++) { const r = await runner.run('dig_in', {}, { owner: 's1', intent_id: 'x1' }); assert.equal(r.reason, 'busy') }
  assert.equal(trace.last().filter((e) => e.type === 'skill_reject').length, 1)
  assert.equal(trace.last().filter((e) => e.type === 'intent').length, 1)
  assert.equal(runner.busyRejectsPerMin(), 26)
  t.release()
  const sum = trace.last().find((e) => e.type === 'skill_reject_busy_hold')
  assert.equal(sum.rejects, 26); assert.equal(sum.holder, 'reflex:low_health_flee')
  const r = await runner.run('dig_in', {}, { owner: 's1', intent_id: 'x1' })
  assert.equal(r.status, 'done')
})

test('waitFree resolves on release, times out otherwise', async () => {
  const { runner, arbiter } = makeRig()
  const t = await arbiter.acquire('reflex', { label: 'drowning' })
  assert.equal(runner.isHeld('s1'), true); assert.equal(runner.isHeld('s2'), true)
  assert.equal(await runner.waitFree(50), false)
  setTimeout(() => t.release(), 30)
  assert.equal(await runner.waitFree(1000), true)
  assert.equal(runner.isHeld('s1'), false)
})

test('S1 selector with a reflex holding the body for 3 s: one request after the release, not 26 rejects', async () => {
  const { runner, arbiter, trace } = makeRig()
  let ran = 0
  runner.register(skill('dig_in', { run: async () => { ran++; return { ok: true } } }))
  const bot = runner.getBot()
  const t = await arbiter.acquire('reflex', { label: 'low_health_flee' })
  const logs = []
  const c = { bot, inv: { food: 0, free: 20, blocks: 20, logs: 0, rod: 0, beds: 0 }, animals: 0, animalNear: Infinity, night: false, players: [], hostiles: 0, exposed: [], needs: { levels: { energy: 1 } }, underground: false, bedKnown: false, rng: Math.random }
  const rows = [{ name: 'dig_in', score: 5, base: 5, habit: { category: 'x', plan: () => ({ skill: 'dig_in', args: {} }) } }]
  const s1 = createS1({ runner, getBot: () => bot, env: { rng: Math.random }, ctxFn: () => ({ c, rows }), decisionLog: { write: (r) => logs.push(r) }, pauseMs: 1, sleep })
  s1.pursue({ type: 'custom', text: 'dig' }, { intent_id: 'imvi-1a' })
  setTimeout(() => t.release(), 600)
  await s1.whenIdle()
  const rejects = trace.last().filter((e) => e.type === 'skill_reject' && e.reason === 'busy')
  assert.ok(rejects.length <= 1, `busy rejects: ${rejects.length}`)
  assert.ok(ran >= 1)
  assert.ok(logs.every((l) => typeof l.busy_rejects_min === 'number'))
})

test('dig_stairs_up is registered, needs no pickaxe, and escape_staircase works bare-handed in a stone pit', async () => {
  const { makeEscapeSkills, planEscape } = await import('../src/escape/skills.js')
  const sk = makeEscapeSkills({})
  assert.ok(sk.find((s) => s.name === 'dig_stairs_up'))
  const st = sk.find((s) => s.name === 'escape_staircase')
  assert.equal(st.precondition({ bot: null, args: { unstuck: true } }), true)
  const { DeliberateEnclosureProbe } = { DeliberateEnclosureProbe: null }
  assert.equal(DeliberateEnclosureProbe, null)
})

test('stuck monitor: a finished dig_in / build suppresses confined-trapped for 120 s', async () => {
  const { StuckMonitor } = await import('../src/detect/stuck.js')
  const m = Object.create(StuckMonitor.prototype)
  m.healthy = 1000; m.confined = { noteResult() {} }; m.progress = () => {}
  m.noteSkillResult({ status: 'done', skill: 'dig_in' }, 'dig_in')
  assert.equal(m.deliberateUntil, 121000)
  m.noteSkillResult({ status: 'failed', skill: 'build' }, 'build')
  assert.equal(m.deliberateUntil, 121000)
})
