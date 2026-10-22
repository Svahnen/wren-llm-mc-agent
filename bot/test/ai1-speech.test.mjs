// AI1: speaking gate (SAY only heard when a player is in range or she answers), demotion to thoughts, mutter rate limit, thought log fields,
// templates, steering of the habit layer and the goal feature in habit_choice.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { speakDecision, muttersAllowed, ThoughtLog, seedFor } from '../src/mindlink/thoughts.js'
import { steerRows, steerView, goalFeature, serving } from '../src/habits/steer.js'

test('speakDecision: nobody near -> demoted; someone near -> heard; answering a human -> heard even if far', () => {
  assert.deepEqual(speakDecision({ kind: 'say', near: 0 }), { speak: false, why: 'nobody_near' })
  assert.equal(speakDecision({ kind: 'say', near: 1 }).speak, true)
  assert.equal(speakDecision({ kind: 'legacy', near: 0, answering: true }).speak, true)
  assert.equal(speakDecision({ kind: 'say', near: 2, urgent: true }).why, 'urgent_near')
  assert.equal(speakDecision({ kind: 'say', near: 0, urgent: true }).speak, false, 'a warning needs someone to hear it')
})
test('templates: never when nobody is near; rare (60 s) when someone is near; fine when answering', () => {
  assert.equal(speakDecision({ kind: 'template', near: 0 }).speak, false)
  assert.equal(speakDecision({ kind: 'template', near: 1, sinceTemplateMs: 10000 }).why, 'template_rate')
  assert.equal(speakDecision({ kind: 'template', near: 1, sinceTemplateMs: 90000 }).speak, true)
  assert.equal(speakDecision({ kind: 'template', near: 0, answering: true }).speak, true)
})
test('mutter: at most once per 10 minutes', () => {
  assert.equal(muttersAllowed(0, 1000), true)
  assert.equal(muttersAllowed(1000, 1000 + 599000), false)
  assert.equal(muttersAllowed(1000, 1000 + 600000), true)
})
test('thought log: full text, ids, position, players, goal, mood, job/intent, tts fields with the voice-service seed algorithm; run copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'))
  const tl = new ThoughtLog({ file: path.join(dir, 'a', 'thoughts.jsonl'), extraFile: path.join(dir, 'run1', 'thoughts.jsonl'), voiceCfg: () => ({ voice: 'af_heart', speed: null, emotion: 'calm' }) })
  const long = 'x '.repeat(900)
  const r = tl.add({ text: long, kind: 'demoted_say', goal: 'G2', mood: { label: 'neutral', p: 0, a: 0, d: 0 }, pos: [1, 2, 3], players: [{ name: 'Sam', dist: 9 }], humanNear: true, job_id: 7, intent_id: 'i1' })
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'run1', 'thoughts.jsonl'), 'utf8').trim())
  assert.equal(line.text, long.trim()); assert.equal(line.goal, 'G2'); assert.equal(line.job_id, 7); assert.equal(line.kind, 'demoted_say'); assert.equal(line.players_near[0].name, 'Sam')
  assert.equal(line.tts.seed, seedFor(long.trim(), 'af_heart', null, 'calm')); assert.ok(line.ts_ms > 0 && line.thought_id && line.mood.label)
  assert.equal(fs.existsSync(path.join(dir, 'a', 'thoughts.jsonl')), true)
  for (let i = 0; i < 50; i++) tl.add({ text: 'again ' + i }) // never dropped by rate limits
  assert.equal(fs.readFileSync(path.join(dir, 'a', 'thoughts.jsonl'), 'utf8').trim().split('\n').length, 51)
  assert.equal(r.tts.voice, 'af_heart')
})
test('steering: leisure habits not serving the goal are dropped, serving ones boosted, survival untouched; no goal = unchanged', () => {
  const mk = () => [{ name: 'take_cover', score: 9 }, { name: 'explore', score: 2.5 }, { name: 'wander', score: 1.2 }, { name: 'gather_wood', score: 1.0 }, { name: 'idle', score: 0.5 }]
  assert.equal(steerRows(mk(), null).length, 5)
  const S = { gstore: { goals: [{ id: 'G1', text: 'build a hut', status: 'active' }] }, steer: { goalId: 'G1', skill: 'collect', args: { resource: 'wood' }, status: 'done', mods: { urgency: 0.8, caution: 0 }, repeats: 0 } }
  const v = steerView(S); const out = steerRows(mk(), v, { continuePlan: true })
  assert.deepEqual(out.map((r) => r.name).filter((n) => ['explore', 'wander', 'idle'].includes(n)), [], 'unrelated leisure is not started')
  assert.ok(out.some((r) => r.name === 'take_cover') && serving('gather_wood', 'collect'))
  assert.ok(out.some((r) => r.name === 'continue_intent'), 'S2 silent: last intent continues')
  v.markContinued(); v.markContinued(); v.markContinued(); assert.equal(steerRows(mk(), steerView(S), { continuePlan: true }).some((r) => r.name === 'continue_intent'), false, 'bounded repeats')
  const f = goalFeature(v, 'gather_wood'); assert.equal(f.goal.id, 'G1'); assert.equal(f.goal.serves, true); assert.ok(f.goal.hash)
  assert.equal(goalFeature(null, 'x').goal, null)
  const hot = steerRows([{ name: 'gather_stone', score: 3 }, { name: 'gather_wood', score: 3 }], steerView({ ...S, steer: { ...S.steer, skill: 'collect', mods: { urgency: 0, caution: 0.9 } } }))
  assert.ok(hot.find((r) => r.name === 'gather_stone').score < hot.find((r) => r.name === 'gather_wood').score + 3.0)
})
