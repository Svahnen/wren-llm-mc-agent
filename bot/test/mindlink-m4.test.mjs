import test from 'node:test'
import assert from 'node:assert/strict'
import { AbortLog, abortKind, invCounts, invGain, ABORT_MAX_PER_WINDOW } from '../src/mindlink/aborted.js'
import { SpeechQueue, DANGER_RE } from '../src/mindlink/speech.js'

test('M4: abort reasons map to reflex / unstuck / preempted', () => {
  assert.deepEqual(abortKind('preempted_by:reflex:low_health_flee'), { kind: 'reflex', by: 'low_health_flee' })
  assert.equal(abortKind('unstuck_active').kind, 'unstuck'); assert.equal(abortKind('preempted_by:s2').kind, 'preempted'); assert.equal(abortKind('superseded').kind, 'preempted')
})

test('M4: a 3-minute shelter that was aborted is written; a 2 s eat-interrupt with no progress is not', () => {
  const l = new AbortLog(), t = 1e6
  assert.equal(l.note({ goal: 'hunt', reason: 'preempted_by:reflex:eat', ms: 2000, now: t }), null)
  const ep = l.note({ goal: 'shelter', reason: 'preempted_by:s2', ms: 180000, now: t })
  assert.match(ep.text, /interrupted by a new decision while I was doing shelter, after 3 minutes/)
  const g = l.note({ goal: 'explore', reason: 'preempted_by:reflex:low_health_flee', ms: 5000, moved: 20, gains: invGain(invCounts([{ name: 'dirt', count: 1 }]), invCounts([{ name: 'dirt', count: 5 }, { name: 'oak_log', count: 3 }])), now: t })
  assert.match(g.text, /a reflex \(low health flee\).*moved about 20 blocks, gained 4 dirt, 3 oak log/)
})

test('M4: repeated aborted routines merge into one summary with a count, and the flood is rate limited', () => {
  const l = new AbortLog(); let t = 0
  assert.ok(l.note({ goal: 'shelter', reason: 'preempted_by:s2', ms: 60000, now: t }))
  for (let i = 1; i <= 5; i++) assert.equal(l.note({ goal: 'shelter', reason: 'preempted_by:s2', ms: 60000, now: t + i * 1000 }), null)
  assert.deepEqual(l.flush(t + 60000), [])
  const out = l.flush(t + 11 * 60000)
  assert.equal(out.length, 1); assert.equal(out[0].count, 5); assert.match(out[0].text, /again 5 more times.*5 minutes in total/)
  const r = new AbortLog(); let written = 0
  for (let i = 0; i < 20; i++) if (r.note({ goal: 'g' + i, reason: 'preempted_by:s2', ms: 40000, now: 5000 + i })) written++
  assert.equal(written, ABORT_MAX_PER_WINDOW)
})

test('M4: speech keeps the NEWEST pending line, 1 per 20 s, drops older ones', () => {
  const q = new SpeechQueue(); let t = 100000
  assert.deepEqual(q.offer('first', {}, t), { send: 'first' })
  assert.ok(q.offer('older', {}, t + 3000).queued); assert.ok(q.offer('newer', {}, t + 8000).queued); assert.ok(q.offer('newest', {}, t + 12000).queued)
  assert.equal(q.drain(t + 15000), null)
  assert.equal(q.drain(t + 20000), 'newest'); assert.equal(q.drain(t + 21000), null); assert.equal(q.dropped, 2)
})

test('M4: answers to humans and death/danger reports are never dropped, and go first', () => {
  const q = new SpeechQueue(); const t = 0
  q.offer('hello there', {}, t)
  q.offer('idle thought', {}, t + 1000)
  assert.ok(q.offer('Hi Sam, yes I am here', { protect: true }, t + 2000).queued)
  assert.ok(q.offer('I died near the lava', { protect: true }, t + 3000).queued)
  q.offer('a newer idle thought', {}, t + 3500)
  assert.equal(q.drain(t + 4500), 'Hi Sam, yes I am here')
  assert.equal(q.drain(t + 8500), 'I died near the lava')
  assert.equal(q.drain(t + 29000), 'a newer idle thought')
  assert.ok(DANGER_RE.test('I died (lava)') && !DANGER_RE.test('I see a sheep'))
})
