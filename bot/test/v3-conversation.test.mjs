// V3: pure conversation / commitment logic (bot/src/mindlink/converse.js, commitments.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../../voice/src/turntake.js'
import { isAck, answerGate, convoFact } from '../src/mindlink/converse.js'
import { CommitmentBook, commitmentFromIntent } from '../src/mindlink/commitments.js'

test('isAck: closed list of acknowledgements only; greetings and questions are not; an answer to her question is not', () => {
  for (const t of ['Yeah.', 'Okay.', 'Mhm', 'I see', 'Right', 'uh um', 'Yeah, go ahead']) assert.ok(isAck(t, { classify }), t)
  for (const t of ['Hi it is me', 'Where are you going?', 'Follow me.', 'Hello there, Wren.', 'wait', 'Okay Wren']) assert.ok(!isAck(t, { classify }), t)
  assert.ok(!isAck('Yes.', { classify, lastSayText: 'Do you want me to follow you?', lastSayAt: 1000, now: 5000 }))
  assert.ok(isAck('Yes.', { classify, lastSayText: 'Do you want me to follow you?', lastSayAt: 1000, now: 60000 }))
})

test('answerGate: one answer per utterance, stale answers dropped, follow-ups need quiet + new content', () => {
  const th = { heardId: 1, answeredId: 0, lastAt: 1000 }
  assert.equal(answerGate({ th, jobKind: 'human_speech', answers: [1], now: 2000 }).ok, true)
  assert.equal(answerGate({ th: { ...th, answeredId: 1 }, jobKind: 'human_speech', answers: [1], now: 9000 }).reason, 'already_answered')
  assert.equal(answerGate({ th, jobKind: 'heartbeat', now: 2000 }).reason, 'unanswered_belongs_to_answer_job')
  assert.equal(answerGate({ th: { ...th, heardId: 2 }, jobKind: 'human_speech', answers: [1], now: 3000 }).reason, 'stale_answer')
  const done = { heardId: 1, answeredId: 1, lastAt: 1000 }
  assert.equal(answerGate({ th: done, jobKind: 'heartbeat', lastSayAt: 1500, now: 10000, text: 'x' }).reason, 'already_answered')   // 8.5 s after her line
  assert.equal(answerGate({ th: done, jobKind: 'heartbeat', lastSayAt: 1500, lastSays: ['i am heading east to find my bed'], text: 'I am heading east to find the bed', now: 30000 }).reason, 'repeat')
  assert.equal(answerGate({ th: done, jobKind: 'heartbeat', lastSayAt: 1500, lastSays: ['hello'], text: 'Look, a cave with iron in it', now: 30000 }).followup, true)
  assert.equal(answerGate({ th: done, jobKind: 'heartbeat', lastSayAt: 1500, text: 'Idle talk', now: 100000 }).ok, true) // conversation over
  assert.equal(answerGate({ th, jobKind: 'heartbeat', urgent: true, now: 2000 }).ok, true)
})

test('convoFact: a fact for S2 about walking away from a conversation partner, never a block', () => {
  const talk = { name: 'Alex', dist: 2, at: 1000 }
  assert.match(convoFact({ goal: 'explore', talk, now: 11000 }), /Alex talked with you 10 s ago.*explore takes you away/)
  assert.equal(convoFact({ goal: 'follow', talk, now: 11000 }), null)
  assert.equal(convoFact({ goal: 'explore', talk, now: 60000 }), null)      // conversation over
  assert.equal(convoFact({ goal: 'explore', talk: { ...talk, dist: 12 }, now: 11000 }), null)
})

const near = (m) => (n) => (m[n] != null ? { dist: m[n] } : null)
test('commitments: a follow promise survives 5 min of heartbeats/drive wakes, shows first in every prompt, is never released by a timer', () => {
  let t = 0; const book = new CommitmentBook({ now: () => t })
  const it = { goal: 'follow', args: { target: 'Alex' } }
  const c = commitmentFromIntent(it, { jobKind: 'human_speech', speech: "I'll follow you.", talkName: 'Alex', knownPlayer: (n) => n === 'Alex' })
  assert.deepEqual([c.person, c.kind], ['Alex', 'follow'])
  book.add(c, "I'll follow you.")
  for (t = 0; t <= 300000; t += 10000) {
    assert.equal(book.active().length, 1)
    assert.match(book.reminders(near({ Alex: 6 }))[0], /You promised Alex to follow them (\d+ s|\d+ min) ago.*they are 6 m away/)
    // other drives / heartbeats choose small acts: they do not break it
    assert.equal(book.onChosen({ goal: 'look_at', args: {} }).length, 0)
    assert.equal(book.onChosen({ goal: 'follow', args: { target: 'Alex' } }).length, 0)
  }
  assert.match(book.reminders(near({}))[0], /not in hearing range/)
})
test('commitments: ended only by S2 choosing something else (with its reason) - "stop" / "you can go"', () => {
  let t = 0; const book = new CommitmentBook({ now: () => t })
  book.add({ person: 'Sam', kind: 'follow', goal: 'follow', args: { target: 'Sam' } }, 'ok')
  t = 5000
  const ended = book.onChosen({ goal: 'explore', args: {} }, 'Sam said I can go')
  assert.equal(ended.length, 1); assert.equal(ended[0].status, 'broken_by_choice'); assert.match(ended[0].why, /explore: Sam said I can go/)
  assert.equal(book.active().length, 0); assert.equal(book.reminders(near({})).length, 0)
})
test('commitments: absence/logoff is reported to S2 once after 60 s (an event), the promise stays until S2 decides', () => {
  let t = 0; const book = new CommitmentBook({ now: () => t })
  book.add({ person: 'Sam', kind: 'follow', goal: 'follow', args: { target: 'Sam' } }, 'ok')
  t = 1000; assert.equal(book.checkPresence(near({}), () => false).length, 0)
  t = 61000; const o = book.checkPresence(near({}), () => true)
  assert.equal(o.length, 1); assert.equal(o[0].logged_off, true)
  t = 120000; assert.equal(book.checkPresence(near({}), () => true).length, 0)   // told once
  assert.equal(book.active().length, 1)
  t = 130000; book.checkPresence(near({ Sam: 4 })); assert.equal(book.active()[0].notified, false)   // came back: re-armed
})
test('commitmentFromIntent: only answers to a person that promise something', () => {
  const kp = (n) => n === 'Sam'
  assert.equal(commitmentFromIntent({ goal: 'follow', args: { target: 'Sam' } }, { jobKind: 'heartbeat', speech: 'ok', talkName: 'Sam', knownPlayer: kp }), null)
  assert.equal(commitmentFromIntent({ goal: 'explore', args: {} }, { jobKind: 'human_speech', speech: 'ok', talkName: 'Sam', knownPlayer: kp }), null)
  assert.equal(commitmentFromIntent({ goal: 'idle_activity', args: {} }, { jobKind: 'human_speech', speech: "I'll wait here.", talkName: 'Sam', knownPlayer: kp }).kind, 'wait')
  assert.equal(commitmentFromIntent({ goal: 'go_to', args: { place: 'home' } }, { jobKind: 'human_speech', speech: 'Sure', talkName: 'Sam', knownPlayer: kp }).kind, 'go_to')
})
