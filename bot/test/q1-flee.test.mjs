import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRig } from './helpers.js'
import { makeMoveSkills } from '../src/skills/move.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), floored: () => vec(Math.floor(x), Math.floor(y), Math.floor(z)), distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z) })
function rig() {
  const r = makeRig(); const { bot } = r
  bot.entity.position = vec(0.5, 64, 0.5)
  bot.blockAt = (p) => { const n = Math.floor(p.y) < 64 ? 'dirt' : 'air'; return { name: n, position: vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' } }
  bot.entities = { 7: { id: 7, name: 'zombie', position: vec(5.5, 64, 0.5) } }
  for (const s of makeMoveSkills({ landmarks: { get: () => null }, trail: { reversed: () => [] } })) r.runner.register(s)
  return r
}

test('Q1: flee that arrives short in the first direction tries the next one instead of ending with not_far_enough', async () => {
  const r = rig(); let calls = 0
  r.bot.pathfinder.goto = async () => { calls++; if (calls >= 3) r.bot.entity.position = vec(-20, 64, 0.5) } // first two resolve without moving
  const res = await r.runner.run('flee', { from: 'zombie_7' }, { owner: 's2', intent_id: 'f1' })
  assert.equal(res.status, 'done', JSON.stringify(res)); assert.equal(calls, 3)
})
test('Q1: flee that never gets away still reports not_far_enough', async () => {
  const r = rig(); r.bot.pathfinder.goto = async () => {}
  const res = await r.runner.run('flee', { from: 'zombie_7' }, { owner: 's2', intent_id: 'f2' })
  assert.deepEqual([res.status, res.reason], ['failed', 'not_far_enough'])
})
