import test from 'node:test'
import assert from 'node:assert/strict'
import { createMind } from '../api.js'
test('goals persist through the mind api (goals_save / goals_load) and core_add stores a value', async () => {
  const m = createMind({ dbPath: ':memory:' })
  assert.equal((await m.handle({ op: 'goals_load' })).result.snapshot, null)
  await m.handle({ op: 'goals_save', snapshot: { goals: [{ id: 'G1', text: 't', status: 'active' }], rev: 3 } })
  assert.equal((await m.handle({ op: 'goals_load' })).result.snapshot.goals[0].id, 'G1')
  assert.equal((await m.handle({ op: 'core_add', text: 'I prefer to look before I leap' })).result.added, true)
})
