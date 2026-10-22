import test from 'node:test'; import assert from 'node:assert/strict';
import { decode, audioOut, chunk48, flushMsg, msOf48 } from '../src/protocol.js';
import { isAddressed, saysName } from '../src/addressee.js';
import { classify, choose, eotRequiredMs, Episode, CONTINUE, FINISH, TRAIL, NOW } from '../src/turntake.js';
import { splitSentences } from '../src/sentences.js';
import { resample, s16ToF32, f32ToS16 } from '../src/audio.js';
import { to48k } from '../src/tts.js';
import { Speaker } from '../src/speaker.js';

test('decode audio_in and invalid messages', () => {
  const pcm = Buffer.alloc(640, 1);
  const m = decode(JSON.stringify({ type: 'audio_in', uuid: 'u', name: 'S', dist: 2, seq: 1, t: 5, pcm16k: pcm.toString('base64') }));
  assert.equal(m.type, 'audio_in'); assert.equal(m.pcm.length, 640);
  assert.equal(decode('{not json').type, 'invalid');
  assert.equal(decode(JSON.stringify({ type: 'audio_in', uuid: 'u', pcm16k: Buffer.alloc(3).toString('base64') })).type, 'invalid');
  assert.equal(decode(JSON.stringify({ type: 'players', t: 1, bot: null })).near.length, 0);
  assert.equal(decode(JSON.stringify({ type: 'zzz' })).type, 'unknown');
  assert.equal(decode(JSON.stringify({ type: 'hello', version: 1, bot: 'Wren', botOnline: true })).botOnline, true);
});
test('audio_out framing: multiples of 960 samples, base64 round trip, 100 ms chunks', () => {
  const buf = Buffer.alloc(960 * 2 * 12);                        // 240 ms
  const chunks = [...chunk48(buf, 5)]; assert.deepEqual(chunks.map((c) => c.length / 2), [4800, 4800, 960 * 2]);
  const j = JSON.parse(audioOut('u1', 3, chunks[0])); assert.equal(j.type, 'audio_out'); assert.equal(j.seq, 3); assert.equal(Buffer.from(j.pcm48k, 'base64').length, 9600);
  assert.throws(() => audioOut('u1', 0, Buffer.alloc(100)));
  assert.deepEqual(JSON.parse(flushMsg()), { type: 'flush', utt_id: '*' });
  assert.equal(msOf48(Buffer.alloc(1920)), 20);
});
test('to48k doubles the rate and pads to 20 ms frames', () => {
  const x = f32ToS16(new Float32Array(2400).map((_, i) => Math.sin(i / 5) * 0.5));
  const y = to48k(x); assert.equal((y.length / 2) % 960, 0); assert.ok(y.length / 2 >= 4800);
  const f = s16ToF32(y); let pk = 0; for (let i = 500; i < 4000; i++) pk = Math.max(pk, Math.abs(f[i])); assert.ok(pk > 0.45 && pk < 0.55);
});
test('addressee rules', () => {
  const a = (text, dist, botOnline = true) => isAddressed({ text, dist, botOnline });
  assert.equal(a('what are you doing here', 3), true);          // near player speaking
  assert.equal(a('what are you doing here', 6), true);          // exactly 6
  assert.equal(a('i think we should build a farm', 8), false);  // ambient between others
  assert.equal(a('hey wren come here', 12), true);              // name within 48 (FAR)
  assert.equal(a('hey wren come here', 60), false);            // name too far (beyond FAR 48)
  assert.equal(a('', 2), false); assert.equal(a('hmm', 2), true);
  assert.equal(a('hey run come here', 12), true);              // ASR variant of the name after a greeting
  assert.equal(a('i like to run fast', 12), false);
  assert.equal(a('hello', 2, false), false);                    // bot offline
  assert.equal(a('hello', NaN), false);
  assert.ok(saysName('Wren, wait')); assert.ok(!saysName('the wrench is here'));
});
const ctx = (o = {}) => ({ urgent: false, secsLeft: 3, wordsLeft: 8, runS: 0.5, loud: false, sentencesLeft: 0, emotion: 'calm', ...o });
test('classify: fillers and backchannels never cut', () => {
  for (const t of ['', 'um', 'uh huh', 'hmm', 'yeah', 'okay', 'i see', 'mhm yeah']) assert.equal(classify(t).speech, false, t);
  assert.equal(classify('what').speech, true);
  assert.equal(classify('can you show me the way').speech, true);
  assert.equal(classify('wait a second').stop, true);
  assert.equal(classify('i will wait here for you friend').stop, false);
});
test('choose: stop yields now; urgent never yields; name only trail/now; filler never reaches choose', () => {
  assert.equal(choose(ctx(), classify('stop')).option, NOW);
  assert.equal(choose(ctx(), classify('no wait')).option, NOW);
  assert.equal(choose(ctx({ urgent: true }), classify('can you show me the way')).option, CONTINUE);
  assert.equal(choose(ctx({ urgent: true }), classify('stop wait')).option, FINISH);
  const nameRx = /\bwren\b/;
  const d = choose(ctx(), classify('wren look at this', { nameRx })); assert.ok([TRAIL, NOW].includes(d.option));
  const q = choose(ctx(), classify('where are you going now')); assert.ok(q.option !== CONTINUE);
});
test('episode escalates only upward and rate-limits evaluations', () => {
  const ep = new Episode(0); assert.equal(ep.due(1000, 3), true); ep.noteEval(1000, 3);
  assert.equal(ep.due(1100, 4), false);
  assert.equal(ep.escalate({ option: FINISH }), true); assert.equal(ep.escalate({ option: CONTINUE }), false);
  assert.equal(ep.escalate({ option: NOW }), true); assert.equal(ep.due(9000, 30), false);
});
test('end-of-turn silence by transcript shape', () => {
  assert.equal(eotRequiredMs('what are you doing here?'), 250);
  assert.equal(eotRequiredMs('what are you doing here'), 500);
  assert.equal(eotRequiredMs('i want to go and'), 1000);
  assert.equal(eotRequiredMs('well,'), 1000); assert.equal(eotRequiredMs('so um...'), 1000); assert.equal(eotRequiredMs('so um.'), 1000);
  assert.equal(eotRequiredMs(''), 250);
});
test('sentence splitting with early first clause', () => {
  assert.deepEqual(splitSentences('I am looking for food.'), ['I am looking for food.']);
  assert.deepEqual(splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!']);
  const s = splitSentences('Well, I found some iron near the river and I want to show it to you.'); assert.equal(s[0], 'Well,'.length ? s[0] : ''); assert.ok(s.length >= 1);
  const s2 = splitSentences('I found some iron near the river, and I want to show it to you.'); assert.equal(s2[0], 'I found some iron near the river,'); assert.equal(s2.length, 2);
  assert.deepEqual(splitSentences('   '), []); assert.deepEqual(splitSentences('*sigh*'), ['sigh']);
});
test('speaker: pacing never exceeds the lead, flush keeps the unspoken remainder', async () => {
  const sent = []; let t = 0;
  const tts = { synth: async (text) => ({ pcm48: Buffer.alloc(48000 * 2 * 2), ttfb_ms: 5, total_ms: 5 }) };   // 2 s per sentence
  const sp = new Speaker({ tts, send: (m) => sent.push(JSON.parse(m)), log: () => {}, leadMs: 600 });
  sp.enqueue({ text: 'One. Two. Three.' });
  await new Promise((r) => setTimeout(r, 300));
  const audio = sent.filter((m) => m.type === 'audio_out');
  const ms = audio.reduce((a, m) => a + Buffer.from(m.pcm48k, 'base64').length / 96, 0);
  assert.ok(ms >= 600 && ms <= 1000, `sent ${ms} ms in 300 ms with lead 600`);   // lead + elapsed playhead + one 100 ms chunk
  assert.deepEqual(audio.map((m) => m.seq), audio.map((_, i) => i));
  const r = sp.flush('*', 'test'); assert.equal(r.text, 'One. Two. Three.'); assert.equal(sent.at(-1).type, 'flush');
  assert.equal(sp.speaking, false);
});
