import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { makeRig } from './helpers.js'
import { installDetectors } from '../src/detect/index.js'

function setup(results) {
  const { runner, arbiter, trace, metrics, bot } = makeRig()
  let i = 0
  runner.run = async (name) => ({ status: results[i % results.length].status, reason: results[i++ % results.length].reason, skill: name, ms: 5 })
  const body = Object.assign(new EventEmitter(), { bot, spawned: true, forceDisconnect() {} })
  const det = installDetectors(body, arbiter, runner, trace, metrics, { deadState: { intervalMs: 1e9 } })
  return { runner, det, stop: () => det.stop?.() }
}

test('Q1: being interrupted (reflex, S2 intent, unstuck) does not spend the failure budget; real failures and stalls do', async () => {
  const a = setup([{ status: 'aborted', reason: 'preempted_by:reflex:eat' }, { status: 'aborted', reason: 'intent' }, { status: 'aborted', reason: 'unstuck' }])
  for (let k = 0; k < 9; k++) await a.runner.run('shelter', {})
  assert.equal(a.det.lockouts.list().length, 0, 'nine interruptions: no lockout')
  const b = setup([{ status: 'failed', reason: 'no_site' }])
  for (let k = 0; k < 3; k++) await b.runner.run('shelter', {})
  assert.equal(b.det.lockouts.list().some((l) => l.type === 'shelter'), true, 'three real failures lock it')
  const c = setup([{ status: 'aborted', reason: 'no_progress' }])
  for (let k = 0; k < 3; k++) await c.runner.run('collect', {})
  assert.equal(c.det.lockouts.list().some((l) => l.type === 'collect'), true, 'three stalls lock it')
  for (const x of [a, b, c]) x.stop()
})
