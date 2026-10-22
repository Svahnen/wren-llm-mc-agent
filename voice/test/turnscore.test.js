// Barge-in scoring: 40+ labelled scenarios (expected decision for a described situation), hard rules, hysteresis, pluggable model, speak metadata.
import test from 'node:test'; import assert from 'node:assert/strict';
import { features, TurnScorer, TurnState, speakMeta, interruptionType, isFillerWord, CONTINUE as C, FINISH as F, TRAIL as T, NOW as N } from '../src/turnscore.js';

const SENT = ['I found some iron near the river today.', 'It is a really big vein of it.', 'Do you want to come and see it?', 'There is also some coal over there.'];
const nameRx = /\b(?:wren|ren|wran)\b/i;
// frac = how far into her utterance (0..1); ov = overlap ms; everything else defaults to calm chatter, addressed, near, stranger
const sc = ({ text = '', ov = 1500, frac = 0.3, voiced = ov, kind = 'chatter', imp, priority = 'normal', addressed = true, dist = 3, fam = 0, patience = 0, reply = false, loud = false, want } = {}) => {
  const meta = speakMeta({ kind, importance: imp, priority });
  const u = { sentences: SENT, sentMs: 10000, spans: [2500, 5000, 7500, 10000], priority, kind: meta.kind, importance: meta.importance };
  const f = features({ text, voicedMs: voiced, overlapMs: ov, addressed, dist, familiarity: fam, u, playedMs: frac * 10000, replyToThis: reply, recentInterrupts: patience, loud, nameRx, wantFinish: want });
  return new TurnScorer().score(f);
};

const CASES = [
  // ---- fillers / hesitations: NEVER cut, on partial transcripts, text-less bursts and odd spellings
  ['eehm during a long sentence (30%)', { text: 'eehm', frac: 0.3, ov: 1800 }, C],
  ['eehm late in the sentence', { text: 'eehm', frac: 0.85, ov: 900 }, C],
  ['ehm 4 s long hesitation', { text: 'ehm', frac: 0.5, ov: 4000 }, C],
  ['uh', { text: 'uh', frac: 0.2 }, C], ['um', { text: 'um', frac: 0.6 }, C], ['hmm', { text: 'hmm', frac: 0.4 }, C], ['erm', { text: 'erm' }, C],
  ['uhhhh stretched', { text: 'uhhhh', ov: 3000 }, C], ['mmmm stretched', { text: 'mmmm', ov: 3000 }, C], ['aaah', { text: 'aaah' }, C], ['ehhm', { text: 'ehhm' }, C],
  ['eh um (two fillers)', { text: 'eh um', ov: 2500 }, C],
  ['cough-like burst, no text, 250 ms', { text: '', ov: 250, voiced: 250 }, C],
  ['cough-like burst, no text, 380 ms, loud', { text: '', ov: 380, voiced: 380, loud: true }, C],
  ['no text at all for 2 s (stream dropped the eh)', { text: '', ov: 2000, voiced: 2000 }, C],
  ['no text for 6 s (fail safe: never cut on silence of the decoder)', { text: '', ov: 6000, voiced: 6000 }, C],
  ['filler from a close friend at 10%', { text: 'ehm', fam: 1, dist: 1, frac: 0.1 }, C],
  ['filler + persistent interrupter (patience 3)', { text: 'uh', patience: 3 }, C],
  // ---- backchannels: never cut
  ['yeah at 20%', { text: 'yeah', frac: 0.2, ov: 600 }, C],
  ['okay at 50%', { text: 'okay', frac: 0.5 }, C], ['i see at 70%', { text: 'i see', frac: 0.7 }, C], ['mhm yeah', { text: 'mhm yeah' }, C],
  ['go on', { text: 'go on', ov: 2500 }, C], ['makes sense', { text: 'that makes sense', ov: 2000 }, C], ['yeah right (long overlap)', { text: 'yeah right', ov: 3500 }, C],
  ['um yeah (filler then backchannel)', { text: 'um yeah' }, C],
  // ---- explicit stop / wait
  ['stop during chatter at 20%', { text: 'stop', frac: 0.2, ov: 400 }, N], ['wait during chatter', { text: 'wait', frac: 0.5, ov: 300 }, N],
  ['hold on during a story', { text: 'hold on', kind: 'story', frac: 0.3, ov: 500 }, N], ['no wait please', { text: 'no wait please', frac: 0.4 }, N],
  ['stop during a warning (urgent): at most finish', { text: 'stop', kind: 'warning', priority: 'urgent', ov: 400 }, F],
  ['wait during importance 0.9 answer-warning', { text: 'wait', kind: 'answer', imp: 0.9 }, F],
  // ---- warnings are never cut by chatter or speech
  ['real speech during a warning, 3 s', { text: 'what are you talking about', kind: 'warning', priority: 'urgent', ov: 3000 }, C],
  ['her name during a warning', { text: 'wren what is that', kind: 'warning', priority: 'urgent', ov: 3000 }, C],
  ['danger shout during a warning', { text: 'creeper behind you', kind: 'warning', priority: 'urgent' }, C],
  // ---- real speech needs > 700 ms overlap, addressed
  ['real question but only 500 ms overlap', { text: 'what do you mean by that', ov: 500, voiced: 500 }, C],
  ['real speech not addressed (far, ambient)', { text: 'we should build the farm over there', addressed: false, dist: 14, ov: 4000 }, C],
  ['real interruption at 80% of the sentence', { text: 'can you come here please', frac: 0.8, ov: 1000 }, F],
  ['real interruption at 95%', { text: 'what is that over there', frac: 0.95, ov: 2000 }, F],
  ['real interruption at 20%, 1.5 s', { text: 'what do you mean by that', frac: 0.2, ov: 1500 }, T],
  ['real interruption at 20%, 5 s, loud', { text: 'no that is not what i said at all', frac: 0.2, ov: 5000, loud: true }, N],
  ['important answer (0.8) is finished even when asked mid-way', { text: 'what do you mean by that', kind: 'answer', imp: 0.8, frac: 0.4, ov: 1500 }, F],
  ['chatter is dropped for a close friend who keeps talking', { text: 'listen to me i have to tell you something', fam: 0.9, dist: 1, frac: 0.3, ov: 4000 }, N],
  ['stranger, 1 s, mid sentence, plain statement (finishes)', { text: 'i think the village is that way', fam: 0, frac: 0.5, ov: 1000 }, F],
  ['stranger, 3 s of statement mid sentence', { text: 'i think the village is that way and the farm is behind it', fam: 0, frac: 0.3, ov: 3000 }, T],
  ['patience used up: third interruption in 2 min', { text: 'excuse me can i ask something', patience: 3, frac: 0.4, ov: 1200 }, T],
  ['reply to that very person, he contradicts it', { text: 'no that is not what i meant', reply: true, frac: 0.4, ov: 1200 }, T],
  // ---- her name
  ['her name mid-sentence ("hey wren")', { text: 'hey wren', ov: 600, frac: 0.3 }, T],
  ['her name + question at 90% (finish is fine)', { text: 'wren where are you going', ov: 1500, frac: 0.9 }, F],
  // ---- danger words from a human
  ['"creeper behind you" over chatter', { text: 'creeper behind you', frac: 0.3, ov: 400 }, N],
  ['"lava watch out" over a story', { text: 'watch out lava', kind: 'story', frac: 0.5, ov: 400 }, N],
];

for (const [name, args, want] of CASES) {
  test(`scenario: ${name} -> ${want}`, () => {
    const r = sc(args);
    assert.equal(r.action, want, `${name}: got ${r.action} (${r.source}) probs=${JSON.stringify(r.probs)} features=${JSON.stringify({ t: r.features.type, ov: r.features.overlap_ms, fr: r.features.frac_spoken })}`);
    if (['filler', 'backchannel'].includes(r.features.type)) assert.equal(r.action, C);             // hard rule, independent of weights
  });
}
test('there are at least 40 labelled scenarios', () => assert.ok(CASES.length >= 40, String(CASES.length)));

test('fillers/backchannels never cut for ANY feature combination (fuzz) and urgent is never cut by chatter', () => {
  let n = 0;
  for (const text of ['eehm', 'uh', 'yeah', 'mhm', 'okay', 'i see', '', 'hmm yeah']) for (const frac of [0, 0.3, 0.9]) for (const ov of [100, 800, 5000]) for (const fam of [0, 1]) for (const patience of [0, 5]) for (const loud of [false, true]) for (const kind of ['chatter', 'story', 'answer']) {
    const r = sc({ text, frac, ov, fam, patience, loud, kind, imp: 0, want: 0, dist: 1 }); assert.equal(r.action, C, `${text} ${frac} ${ov}`); n++;
  }
  for (const text of ['what do you want', 'wren', 'creeper', 'no no no']) assert.equal(sc({ text, kind: 'warning', priority: 'urgent', ov: 4000, loud: true, fam: 1, patience: 5, dist: 1 }).action, C);
  assert.ok(n > 700);
});

test('classification: filler shapes, text-less bursts, danger, stop, name', () => {
  for (const w of ['eehm', 'ehm', 'uhhh', 'mmm', 'aaah', 'erm', 'hmm']) assert.ok(isFillerWord(w), w);
  for (const w of ['her', 'hum', 'hello', 'eat']) assert.ok(!isFillerWord(w), w);
  assert.equal(interruptionType({ text: '', voicedMs: 200 }).why, 'no_text_short_burst');
  assert.equal(interruptionType({ text: 'creeper behind you' }).type, 'danger');
  assert.equal(interruptionType({ text: 'stop' }).type, 'command');
  assert.equal(interruptionType({ text: 'hey wren come here', nameRx }).type, 'name');
  assert.equal(interruptionType({ text: 'eehm yeah' }).type, 'backchannel');
});

test('output is transparent: features, components per option, logits, probabilities that sum to 1', () => {
  const r = sc({ text: 'what do you mean by that', frac: 0.4, ov: 2000 });
  assert.equal(r.source, 'score'); assert.ok(r.components[T].length > 3); assert.ok(r.features.x.near_end >= 0);
  assert.ok(Math.abs(Object.values(r.probs).reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.ok(Math.abs(Object.values(r.probs_all).reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.deepEqual(Object.keys(r.probs_all).sort(), [C, F, N, T].sort());
  assert.equal(r.features.want, +(0.35 + 0.5 * 0.3).toFixed(3));        // want_finish setting + importance
});

test('hysteresis: a cutting decision holds 1 s and may only escalate; explicit stop overrides', () => {
  const s = new TurnState();
  const fin = sc({ text: 'can you come here please', frac: 0.8, ov: 1000 });
  assert.equal(s.apply(fin, 0).action, F);
  const trail = sc({ text: 'what do you mean by that', frac: 0.2, ov: 1500 });
  const held = s.apply(trail, 500); assert.equal(held.action, F); assert.equal(held.held, true);            // would escalate, but within 1 s
  assert.equal(s.apply(trail, 1200).action, T);                                                              // after the hold: escalation allowed
  assert.equal(s.apply(fin, 2500).action, T);                                                                // never de-escalates
  const s2 = new TurnState(); s2.apply(fin, 0);
  assert.equal(s2.apply(sc({ text: 'stop', ov: 300 }), 200).action, N);                                      // hard rule beats the hold
  const s3 = new TurnState(); assert.equal(s3.apply(sc({ text: 'uh' }), 0).action, C); assert.equal(s3.apply(sc({ text: 'stop', ov: 300 }), 100).action, N);   // continue is not a lock
});

test('pluggable model: default off; alpha blends; hard rules still win', () => {
  const args = { text: 'what do you mean by that', frac: 0.3, ov: 1500 };
  const f = features({ ...{ text: args.text, voicedMs: 1500, overlapMs: 1500, addressed: true, dist: 3, u: { sentences: SENT, sentMs: 10000, spans: [10000], kind: 'chatter', importance: 0.3 }, playedMs: 3000, nameRx } });
  const base = new TurnScorer().score(f);
  const always = { predict: () => ({ [C]: 0, [F]: 0, [T]: 0, [N]: 1 }) };
  const off = new TurnScorer({ model: always, alpha: 0 }).score(f); assert.equal(off.action, base.action); assert.equal(off.learned, null);
  const on = new TurnScorer({ model: always, alpha: 0.95 }).score(f); assert.equal(on.action, N); assert.equal(on.source, 'score+model'); assert.ok(on.learned);
  const fill = features({ text: 'eehm', voicedMs: 3000, overlapMs: 3000, addressed: true, dist: 1, u: { sentences: SENT, sentMs: 10000, spans: [10000], kind: 'chatter', importance: 0.3 }, playedMs: 1000, nameRx });
  assert.equal(new TurnScorer({ model: always, alpha: 1 }).score(fill).action, C);                          // filler rule is not blendable
  const warn = features({ text: 'what', voicedMs: 3000, overlapMs: 3000, addressed: true, dist: 1, u: { sentences: SENT, sentMs: 10000, spans: [10000], kind: 'warning', importance: 0.9, priority: 'urgent' }, playedMs: 1000, nameRx });
  assert.equal(new TurnScorer({ model: always, alpha: 1 }).score(warn).action, C);
});

test('POST /speak metadata defaults: chatter 0.3, answers 0.5, warnings 0.9, explicit wins', () => {
  assert.deepEqual(speakMeta({}), { kind: 'chatter', importance: 0.3 });
  assert.deepEqual(speakMeta({ inReplyTo: 3 }), { kind: 'answer', importance: 0.5 });
  assert.deepEqual(speakMeta({ priority: 'urgent' }), { kind: 'warning', importance: 0.9 });
  assert.deepEqual(speakMeta({ kind: 'story', importance: 0.7 }), { kind: 'story', importance: 0.7 });
  assert.deepEqual(speakMeta({ kind: 'bogus', importance: 7 }), { kind: 'chatter', importance: 1 });
});
