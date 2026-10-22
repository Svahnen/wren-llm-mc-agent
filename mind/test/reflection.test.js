import test from 'node:test'
import assert from 'node:assert/strict'
import { reflectOnce, reflectionProblem, deterministicDaySummary } from '../reflection.js'
const good = 'I spent the day near the village and mostly walked. I gathered wood and some dirt. I got hurt once by a skeleton at night. I like open ground more than caves. I want to build a safer place to sleep. Tomorrow I would like to explore west.'
const dg = { day: 3, new_episode_count: 7, kinds: { routine: 5, damage: 2 }, deaths: [], notable: [{ kind: 'damage', text: 'A skeleton shot me.' }], lessons: [{ goal_type: 'explore', result: 'ok' }] }
test('reflectionProblem: three words, header, echo, too few sentences are rejected; a real paragraph passes', () => {
  assert.ok(reflectionProblem('I like caves.')); assert.ok(reflectionProblem('{act:none,args:{}}\n---\nx'.repeat(20)))
  assert.ok(reflectionProblem('What has happened since: ' + 'x '.repeat(200))); assert.ok(reflectionProblem('I walked a lot and it was long and tiring. '.repeat(1) + 'x'.repeat(220)))
  assert.equal(reflectionProblem(good), null)
})
test('reflectOnce: valid first / valid after nudge / fallback / llm down', async () => {
  let n = 0
  assert.equal((await reflectOnce(dg, async () => (n++, good))).source, 'llm'); assert.equal(n, 1)
  let calls = []; const r2 = await reflectOnce(dg, async (retry) => { calls.push(retry); return retry ? good : 'Short.' })
  assert.equal(r2.source, 'llm_retry'); assert.ok(r2.self_summary); assert.ok(calls[1].nudge)
  const r3 = await reflectOnce(dg, async () => 'Three words only.')
  assert.equal(r3.source, 'fallback'); assert.equal(r3.self_summary, undefined); assert.match(r3.reflections[0], /Day 3: 7 things happened/)
  const r4 = await reflectOnce(dg, async (retry) => { if (!retry) throw new Error('down'); return 'x' }); assert.equal(r4.source, 'fallback')
  await assert.rejects(reflectOnce(dg, async () => { throw new Error('down') }), /down/)
  assert.match(deterministicDaySummary(dg), /skeleton/)
})
