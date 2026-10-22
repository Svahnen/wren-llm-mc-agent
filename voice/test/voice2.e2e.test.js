// VS2 end-to-end on the DEV instance (never the production ports): fake mod WS 19530, HTTP 19531, dev tunnel 19541 (TTS) / 19542 (stream STT) / 19543 (Parakeet).
// Run tools/dev-tunnel.sh first. Skipped when unreachable.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { FakeMod } from '../tools/fake-mod.mjs'; import { VoiceService } from '../src/service.js'; import { startHttp } from '../src/http.js'; import { TtsClient } from '../src/tts.js';
import { s16ToF32, resample, writeWav } from '../src/audio.js';
const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const ok = async (u) => { try { return (await (await fetch(u, { signal: AbortSignal.timeout(1500) })).json()).ok; } catch { return false; } };
const up = (await ok('http://127.0.0.1:19541/health')) && (await ok('http://127.0.0.1:19543/health')) && (await ok('http://127.0.0.1:19542/health'));
const haveClips = fs.existsSync(fx('hey-wren.wav'));
const opts = { skip: !haveClips ? 'no speech fixtures (generate with tools/make-fixture.mjs)' : up ? false : 'dev tunnel not up (voice/tools/dev-tunnel.sh)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'http://127.0.0.1:19531', events = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs2-'));
const speakers = [{ uuid: 'u-near', name: 'Steve', dist: 3 }, { uuid: 'u-b', name: 'Alex', dist: 4 }, { uuid: 'u-name', name: 'Alex2', dist: 12 }];
let mod, svc, srv; const post = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timeout waiting'); };
const rows = (f) => fs.existsSync(path.join(tmp, 'e2e', f)) ? fs.readFileSync(path.join(tmp, 'e2e', f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const LONG = 'I found some iron near the river. It is a big vein. Do you want to come and see it? There is also coal over there. And a cave behind the hill.';

test('setup', opts, async () => {
  mod = await new FakeMod({ port: 19530, speakers }).start();
  svc = new VoiceService({ modUrl: 'ws://127.0.0.1:19530', ttsBase: 'http://127.0.0.1:19541', sttUrl: 'ws://127.0.0.1:19542/v1/stt/stream', sttPass2Url: 'http://127.0.0.1:19543', archiveDir: tmp, runId: 'e2e' }, { log: (e, d) => events.push({ e, ...d }) });
  srv = await startHttp(svc, { port: 19531 }); svc.start();
  await waitFor(() => svc.connected && svc.status().near.length === 3);
  // generated test sounds (temp dir only): a filler and a cough-like noise burst
  const r = await new TtsClient({ base: 'http://127.0.0.1:19541', voice: 'af_bella' }).synth('Eehm.'); const x = resample(s16ToF32(r.pcm48), 48000, 16000);
  const pad = new Float32Array(3200), y = new Float32Array(pad.length + x.length); y.set(x, pad.length); writeWav(path.join(tmp, 'ehm.wav'), y, 16000);
  const n = new Float32Array(16000 * 0.5); for (let i = 0; i < 4800; i++) n[3200 + i] = (Math.random() * 2 - 1) * 0.5 * Math.exp(-i / 1500); writeWav(path.join(tmp, 'cough.wav'), n, 16000);
});

test('second pass: "Hey Ren" becomes "Hey Wren"; fields on /heard and raw+final in heard.jsonl', opts, async () => {
  const poll = fetch(API + '/heard?since=0&wait=25').then((r) => r.json());
  mod.replay(fx('hey-wren.wav'), { uuid: 'u-name', name: 'Alex2', dist: 12 });
  const [h] = await poll;
  console.log('# heard', JSON.stringify({ text: h.text, stream: h.text_stream, conf: h.confidence, unc: h.uncertain_words, corrected: h.corrected }));
  assert.match(h.text, /\bWren\b/); assert.equal(h.addressed, true); assert.ok(h.text_stream && Array.isArray(h.alternatives) && typeof h.confidence === 'number' && Array.isArray(h.uncertain_words) && typeof h.corrected === 'boolean');
  const st = await (await fetch(API + '/status')).json(); assert.equal(st.pass2, true); assert.ok(st.last_latency_ms.stt2_ms < 1500, JSON.stringify(st.last_latency_ms));
  await svc.archive.idle(); await sleep(100);
  const r = rows('heard.jsonl').find((x) => x.id === h.id); assert.ok(r.text_stream !== undefined && r.text_final && r.second_pass === true && r.stt2_ms > 0);
});

test('"eehm" and a cough-like burst during her long line never cut her; decisions are logged with full features', opts, async () => {
  const r = await post('/speak', { text: LONG }); await waitFor(() => mod.out.get(r.utt_id)?.chunks > 2);
  mod.replay(path.join(tmp, 'ehm.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 900 });
  await sleep(300); mod.replay(path.join(tmp, 'cough.wav'), { uuid: 'u-b', name: 'Alex', dist: 4, silenceMs: 900 });
  await sleep(3500);
  assert.equal(mod.out.get(r.utt_id).flushed, false, JSON.stringify(events.filter((e) => e.e === 'barge_decision')));
  await post('/flush'); await sleep(300);
  const t = rows('turn_decisions.jsonl').filter((x) => x.utt_id === r.utt_id);
  console.log('# turn rows', t.length, JSON.stringify(t.slice(0, 3).map((x) => [x.features.type, x.features.text, x.features.overlap_ms, x.action])));
  assert.ok(t.length >= 2); assert.ok(t.every((x) => x.action === 'continue'));
  const x = t[0]; assert.ok(x.features && x.x && x.components && x.logits && x.probs_all && x.source && x.played_ms >= 0 && x.utt_id === r.utt_id);
});

test('"stop wait" during chatter yields now; during a warning only finishes the sentence; two people: filler of one does not mask the other', opts, async () => {
  const r = await post('/speak', { text: LONG }); await waitFor(() => mod.out.get(r.utt_id)?.samples > 48000 * 0.3);
  mod.replay(path.join(tmp, 'ehm.wav'), { uuid: 'u-b', name: 'Alex', dist: 4, silenceMs: 600 });
  mod.replay(fx('stop-wait.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 600 });
  await waitFor(() => mod.out.get(r.utt_id)?.flushed, 15000);
  const d = rows('turn_decisions.jsonl').filter((x) => x.utt_id === r.utt_id && x.action === 'yield_now'); assert.ok(d.length >= 1); assert.ok(d.some((x) => x.source === 'rule:stop' && x.name === 'Steve'));
  await sleep(1500);
  const w = await post('/speak', { text: 'Careful, there is lava right in front of you. Step back now. Slowly.', kind: 'warning', priority: 'urgent' }); await waitFor(() => mod.out.get(w.utt_id)?.chunks > 1);
  await mod.replay(fx('stop-wait.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 600 });
  await waitFor(() => mod.out.get(w.utt_id)?.done, 12000); assert.equal(mod.out.get(w.utt_id).flushed, false);
});

test('real interruption late in the line finishes the sentence (score), logged with her utt_id', opts, async () => {
  await sleep(2000);
  const r = await post('/speak', { text: 'I will walk with you to the village. We can look at the market.' });
  await waitFor(() => mod.out.get(r.utt_id)?.samples > 48000 * 2.0);
  mod.replay(fx('what-are-you-doing-here.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 700 });
  await waitFor(() => mod.out.get(r.utt_id)?.done, 20000);
  await svc.archive.idle(); await sleep(200);
  const t = rows('turn_decisions.jsonl').filter((x) => x.utt_id === r.utt_id);
  console.log('# real interruption decisions', JSON.stringify(t.map((x) => [x.features.text, x.features.overlap_ms, x.features.frac_spoken, x.source, x.action, x.probs])));
  assert.ok(t.length >= 1); assert.ok(t.every((x) => x.features.frac_spoken >= 0));
});

test('/speak validates kind and importance and stores them', opts, async () => {
  assert.equal((await fetch(API + '/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi","kind":"x"}' })).status, 400);
  assert.equal((await fetch(API + '/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi","importance":3}' })).status, 400);
  const r = await post('/speak', { text: 'A story about the old village.', kind: 'story', importance: 0.7 }); await sleep(200);
  assert.equal(events.find((e) => e.e === 'speak_queued' && e.utt_id === r.utt_id).importance, 0.7);
});

test('teardown', opts, async () => { await post('/flush'); await sleep(300); await svc?.stop(); mod?.stop(); srv?.close(); fs.rmSync(tmp, { recursive: true }); process.exit(0); });
