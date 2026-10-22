// AU1: run archive (text+metadata only), regen, timeline. Unit part is offline; e2e part needs the box STT/TTS via the tunnel
// (TTS with seed support: env AU1_TTS_URL, default http://127.0.0.1:19431 test instance, else the seeded asserts are skipped (the default speech-server port is deliberately not probed)).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { Archive, seedFor, sha256, safeId } from '../src/archive.js'; import { FakeMod } from '../tools/fake-mod.mjs'; import { VoiceService } from '../src/service.js'; import { startHttp } from '../src/http.js';
import { regen, readIndex, wavFromPcm48 } from '../tools/regen.mjs'; import { timeline } from '../tools/timeline.mjs';
const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(process.env.AU1_TMP || os.tmpdir(), 'au1-'));

test('unit: run id, seeds, append-only files, manifest merge, no audio on disk', async () => {
  assert.equal(safeId('../x y'), '.._x_y'); assert.equal(safeId(undefined), 'dev');
  assert.equal(seedFor('a', 'af_heart', null), seedFor('a', 'af_heart', null)); assert.notEqual(seedFor('a', 'af_heart', null), seedFor('a', 'af_bella', null));
  const mk = () => new Archive({ root: tmp, runId: 'unit' });
  const a = mk(); a.start();
  const u = { id: 'u1', text: 'Hi.', sentences: ['Hi.'], priority: 'normal', inReplyTo: null, enqWall: Date.now() };
  a.chunk(u, Buffer.alloc(1920, 3)); a.end(u, {}); await a.idle(); a.heard({ id: 1, uuid: 'x', name: 'S', text: 'hello', start_ms: 1, addressed: true }); await a.stop();
  const b = mk(); b.start(); b.heard({ id: 1, uuid: 'x', name: 'S', text: 'again', start_ms: 5, addressed: false }); await b.stop();      // second session, same run: appended, nothing overwritten
  const d = path.join(tmp, 'unit');
  assert.equal(fs.readFileSync(path.join(d, 'heard.jsonl'), 'utf8').trim().split('\n').length, 2);
  const row = readIndex(d)[0]; assert.equal(row.audio_sha256, sha256(Buffer.alloc(1920, 3))); assert.equal(row.samples48k, 960); assert.equal(row.duration_ms, 20);
  const m = JSON.parse(fs.readFileSync(path.join(d, 'MANIFEST.json'), 'utf8')); assert.equal(m.sessions.length, 2); assert.equal(m.sessions[0].counts.utterances, 1);
  assert.ok(m.sessions[0].files['utterances.jsonl'].sha256.length === 64); assert.ok(m.model.engine === "kokoro");
  assert.deepEqual(fs.readdirSync(d).sort(), ['MANIFEST.json', 'heard.jsonl', 'utterances.jsonl']);          // no wav, no other files
  assert.equal(wavFromPcm48(Buffer.alloc(96)).length, 140);
});

const TTS = process.env.AU1_TTS_URL || 'http://127.0.0.1:19431';
let ttsUp = null; for (const base of [TTS]) { try { const h = await (await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })).json(); if (h.ok) { ttsUp = { base, seed: !!h.seed }; break; } } catch {} }
let sttUp = false; try { sttUp = (await (await fetch('http://127.0.0.1:19412/health', { signal: AbortSignal.timeout(1500) })).json()).ok; } catch {}
const opts = { skip: !fs.existsSync(fx('stop-wait.wav')) ? 'no speech fixtures (generate with tools/make-fixture.mjs)' : ttsUp && sttUp ? false : 'box TTS/STT not reachable' };
const API = 'http://127.0.0.1:19651', RUN = 'au1-e2e';
let mod, svc, srv; const captured = new Map();
const post = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timeout waiting'); };
const idx = () => readIndex(path.join(tmp, RUN)), heardRows = () => (fs.existsSync(path.join(tmp, RUN, 'heard.jsonl')) ? fs.readFileSync(path.join(tmp, RUN, 'heard.jsonl'), 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('e2e setup: second instance (fake mod 19650, http 19651)', opts, async () => {
  mod = await new FakeMod({ port: 19650, speakers: [{ uuid: 'u-near', name: 'Steve', dist: 3 }] }).start();
  const orig = mod._fromService.bind(mod);
  mod._fromService = (t) => { const m = JSON.parse(t); if (m.type === 'audio_out') { const c = captured.get(m.utt_id) || []; c.push(Buffer.from(m.pcm48k, 'base64')); captured.set(m.utt_id, c); } orig(t); };
  svc = new VoiceService({ modUrl: 'ws://127.0.0.1:19650', ttsBase: ttsUp.base, archiveDir: tmp, runId: RUN });
  srv = await startHttp(svc, { port: 19651 }); svc.start();
  await waitFor(() => svc.connected && svc.status().near.length === 1);
});

test('e2e: index row complete; sha equals the audio_out chunks; regen reproduces it', opts, async () => {
  const r = await post('/speak', { text: 'I am looking for food. I found some iron near the river.', in_reply_to: 7 });
  await waitFor(() => mod.out.get(r.utt_id)?.done, 15000); await svc.archive.idle(); await sleep(1700); await svc.archive.idle();
  const row = idx().find((x) => x.utt_id === r.utt_id);
  const sent = Buffer.concat(captured.get(r.utt_id));
  assert.equal(row.audio_sha256, sha256(sent)); assert.equal(row.samples48k, sent.length / 2); assert.equal(row.duration_ms, Math.round(sent.length / 96));
  assert.equal(row.text, 'I am looking for food. I found some iron near the river.'); assert.equal(row.sentences.length, 2); assert.equal(row.priority, 'normal'); assert.equal(row.in_reply_to, 7);
  assert.equal(row.tts.voice, 'af_heart'); assert.equal(row.tts.seeds.length, 2); assert.equal(row.flushed, false); assert.equal(row.cut, false);
  assert.ok(row.start_ms > 1e12 && row.end_ms > row.start_ms && row.queued_ms <= row.start_ms); assert.ok(row.first_played_ms > 1e12 && row.first_played_server_ms > 1e12, JSON.stringify(row));
  assert.ok(row.played_ms > 1500);
  const g = await regen(row, { ttsBase: ttsUp.base });
  console.log('# regen seed support', ttsUp.seed, 'match', g.match);
  if (ttsUp.seed) { assert.equal(g.match, true); assert.ok(g.pcm.equals(sent)); } else assert.equal(g.pcm.length, sent.length);
});

test('e2e: flush marks cut with played ms; regen of a cut utterance matches the sent prefix', opts, async () => {
  const r = await post('/speak', { text: 'Some long calm chatter about nothing at all. And then some more of it, to be cut off.' });
  await waitFor(() => mod.out.get(r.utt_id)?.chunks > 2); await post('/flush');
  await waitFor(() => mod.out.get(r.utt_id)?.flushed); await svc.archive.idle(); await sleep(100); await svc.archive.idle();
  const row = idx().find((x) => x.utt_id === r.utt_id);
  assert.equal(row.flushed, true); assert.equal(row.cut, true); assert.equal(row.cut_why, 'api_flush'); assert.ok(row.played_ms_at_cut >= 0 && row.played_ms_at_cut < row.duration_ms + 200);
  const sent = Buffer.concat(captured.get(r.utt_id)); assert.equal(row.audio_sha256, sha256(sent));
  if (ttsUp.seed) assert.equal((await regen(row, { ttsBase: ttsUp.base })).match, true);
});

test('e2e: heard.jsonl has timing, partials, addressed why; barge-in links both files', opts, async () => {
  const r = await post('/speak', { text: 'I found some iron near the river. It is a big vein. Do you want to come and see it? There is also coal.' });
  await waitFor(() => mod.out.get(r.utt_id)?.samples > 48000 * 0.3);
  mod.replay(fx('stop-wait.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 600 });
  await waitFor(() => mod.out.get(r.utt_id)?.flushed, 15000); await sleep(800); await svc.archive.idle();
  const h = await waitFor(() => heardRows().find((x) => /stop/i.test(x.text)));
  assert.equal(h.uuid, 'u-near'); assert.equal(h.name, 'Steve'); assert.equal(h.addressed, true); assert.equal(h.addressed_why, 'near<=6'); assert.equal(h.dist_start, 3); assert.equal(h.dist_end, 3);
  assert.ok(h.start_ms > 1e12 && h.end_ms > h.start_ms && h.first_audio_in_ms <= h.start_ms && h.final_ms >= h.end_ms && h.server_start_ms > 1e12);
  assert.ok(h.partials.length >= 1 && h.partials.every((p) => p.ms >= h.start_ms - 50 && typeof p.text === 'string'), JSON.stringify(h.partials));
  assert.equal(h.overlap_utt_id, r.utt_id); assert.equal(h.barge?.utt_id, r.utt_id); assert.equal(h.barge.option, 'yield_now'); assert.equal(h.discarded, false);
  const st = await (await fetch(API + '/status')).json(); assert.ok(st.listeners.length && st.listeners.every((l) => typeof l.silence_ms === 'number'), 'status.listeners[].silence_ms (VINT)');
  const row = idx().find((x) => x.utt_id === r.utt_id); assert.equal(row.flushed, true); assert.equal(row.cut_by.uuid, 'u-near'); assert.equal(row.cut_why, 'yield_now');
});

test('e2e: answered transcript, timeline markers + optional render, stop writes manifest with hashes', opts, async () => {
  await mod.replay(fx('what-are-you-doing-here.wav'), { uuid: 'u-near', name: 'Steve', dist: 3 });
  const hid = await waitFor(() => svc.heard.find((x) => /doing here/i.test(x.text))?.id);
  const r = await post('/speak', { text: 'I am looking for food.', in_reply_to: hid });
  await waitFor(() => mod.out.get(r.utt_id)?.done, 10000); await svc.archive.idle(); await sleep(1700); await svc.archive.idle();
  const row = idx().find((x) => x.utt_id === r.utt_id); assert.match(row.answered.text, /doing here/i); assert.equal(row.answered.name, 'Steve');
  const out = path.join(tmp, 'tl'); const res = await timeline(path.join(tmp, RUN), out, { render: true, ttsBase: ttsUp.base });
  for (const f of ['wren-lines.csv', 'wren-lines.edl', 'wren-labels.txt', 'heard.csv', 'heard.edl', 'heard-labels.txt', 'heard.json', 'wren-timeline.wav']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.match(fs.readFileSync(path.join(out, 'heard.csv'), 'utf8'), /doing here/i); assert.match(fs.readFileSync(path.join(out, 'wren-lines.edl'), 'utf8'), /FROM CLIP NAME: wren_u/);
  const wav = fs.readFileSync(path.join(out, 'wren-timeline.wav')); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.ok(wav.length > 48000 * 2 * 3);
  console.log('# timeline', JSON.stringify({ lines: res.wren_lines, heard: res.heard, rendered_ms: res.rendered_ms }));
  await svc.stop(); mod.stop(); srv.close(); await sleep(100);
  const m = JSON.parse(fs.readFileSync(path.join(tmp, RUN, 'MANIFEST.json'), 'utf8')); const s = m.sessions.at(-1);
  assert.ok(s.stopped_ms > 0); assert.ok(s.counts.utterances >= 3 && s.counts.cut >= 2 && s.counts.heard >= 2); assert.equal(s.files['utterances.jsonl'].sha256, sha256(fs.readFileSync(path.join(tmp, RUN, 'utterances.jsonl'))));
  assert.equal(m.tts.seed_supported, ttsUp.seed);
  assert.ok(!fs.readdirSync(path.join(tmp, RUN)).some((f) => f.endsWith('.wav')));
});
