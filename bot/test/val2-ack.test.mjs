// VAL2: spoken acknowledgement decision + templates (pure).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ackDecision, ackEnabled, pickAck, situationOf, ACK_TEMPLATES, ACK_DELAY_MS } from '../src/mindlink/ack.js'

const base = { enabled: true, heardId: 5, doneIds: new Set(), voiceUp: true, speaking: false, queued: false, humanTalking: false, answered: false, lastSayAt: 0, sentAt: 1000, etaMs: 4000 }
test('ack is said when S2 is silent, once per utterance', () => {
  assert.equal(ackDecision(base).ok, true)
  assert.equal(ackDecision({ ...base, doneIds: new Set([5]) }).reason, 'once_per_utterance')
  assert.equal(ACK_DELAY_MS, 1500)
})
test('no ack when her real answer is spoken, imminent (< 0.5 s), she speaks, a human talks, voice is down or it is off', () => {
  assert.equal(ackDecision({ ...base, answered: true }).reason, 'answered')
  assert.equal(ackDecision({ ...base, lastSayAt: 1200 }).reason, 'answered')
  assert.equal(ackDecision({ ...base, etaMs: 300 }).reason, 'answer_imminent')
  assert.equal(ackDecision({ ...base, etaMs: -2000 }).reason, 'answer_imminent')
  assert.equal(ackDecision({ ...base, etaMs: null }).ok, true)
  assert.equal(ackDecision({ ...base, speaking: true }).reason, 'speaking')
  assert.equal(ackDecision({ ...base, humanTalking: true }).reason, 'human_talking')
  assert.equal(ackDecision({ ...base, voiceUp: false }).reason, 'voice_down')
  assert.equal(ackDecision({ ...base, enabled: false }).reason, 'off')
})
test('WREN_ACK on/off, default on', () => {
  assert.equal(ackEnabled({}), true); assert.equal(ackEnabled({ WREN_ACK: 'on' }), true)
  assert.equal(ackEnabled({ WREN_ACK: 'off' }), false); assert.equal(ackEnabled({ WREN_ACK: 'OFF' }), false)
})
test('templates per situation, random, never the same twice in a row', () => {
  assert.equal(situationOf('what do you think about this?'), 'question'); assert.equal(situationOf('can you come here'), 'request'); assert.equal(situationOf('nice weather'), 'other')
  for (const [t, set] of [['why is the sky red?', 'question'], ['follow me', 'request'], ['hey wren', 'other']]) {
    const seen = new Set()
    for (let i = 0; i < 60; i++) { const a = pickAck(t, { rng: Math.random }); assert.ok(ACK_TEMPLATES[set].includes(a)); seen.add(a) }
    assert.ok(seen.size > 1)
    let last = null; for (let i = 0; i < 40; i++) { const a = pickAck(t, { last }); assert.notEqual(a, last); last = a }
  }
})
