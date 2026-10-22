// End-to-end, offline (no Minecraft): fake mod <-> service <-> real STT/TTS on a model server through the tunnel (./tunnel.sh).
// Skipped when the tunnel/box are not reachable.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { FakeMod } from '../tools/fake-mod.mjs'; import { VoiceService } from '../src/service.js'; import { startHttp } from '../src/http.js';
const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
let up = false; try { up = (await (await fetch('http://127.0.0.1:19411/health', { signal: AbortSignal.timeout(1500) })).json()).ok && (await (await fetch('http://127.0.0.1:19412/health', { signal: AbortSignal.timeout(1500) })).json()).ok; } catch {}
const haveClips = fs.existsSync(fx('hey-wren.wav')); // speech clips are not shipped: generate them with tools/make-fixture.mjs into test/fixtures/
const opts = { skip: !haveClips ? 'no speech fixtures (generate with tools/make-fixture.mjs)' : up ? false : 'box TTS/STT not reachable (run voice/run.sh)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'http://127.0.0.1:19641';
const events = [];
const speakers = [{ uuid: 'u-near', name: 'Steve', dist: 3 }, { uuid: 'u-far', name: 'Alex', dist: 10 }, { uuid: 'u-name', name: 'Alex', dist: 12 }];
let mod, svc, srv;
const post = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timeout waiting'); };

test('setup', opts, async () => {
  mod = await new FakeMod({ port: 19640, speakers }).start();
  svc = new VoiceService({ modUrl: 'ws://127.0.0.1:19640' }, { log: (e, d) => events.push({ e, ...d }) });
  srv = await startHttp(svc, { port: 19641 }); svc.start();
  await waitFor(() => svc.connected && svc.status().near.length === 3);
  const st = await (await fetch(API + '/status')).json(); assert.equal(st.connected_mod, true); assert.equal(st.mod_hello.version, 1);
  assert.equal(mod.speakDistance, 48);
});

test('near player is transcribed, /heard returns it addressed:true, /speak plays the right duration in order', opts, async () => {
  const t0 = Date.now();
  const poll = fetch(API + '/heard?since=0&wait=25').then((r) => r.json());          // long-poll started BEFORE the speech
  mod.replay(fx('what-are-you-doing-here.wav'), { uuid: 'u-near', name: 'Steve', dist: 3 });
  const items = await poll;
  assert.equal(items.length, 1); const h = items[0];
  assert.match(h.text, /what are you doing here/i); assert.equal(h.addressed, true); assert.equal(h.uuid, 'u-near'); assert.equal(h.dist, 3); assert.ok(h.id >= 1);
  const lat = (await (await fetch(API + '/status')).json()).last_latency_ms; console.log('# latency after speech', JSON.stringify(lat));
  assert.ok(lat.endpoint_ms < 900 && lat.stt_ms < 1500);
  const tHeard = Date.now();
  const r = await post('/speak', { text: 'I am looking for food.', in_reply_to: h.id }); assert.match(r.utt_id, /^u\d+$/);
  await waitFor(() => mod.out.get(r.utt_id)?.done, 10000);
  const tFirst = events.find((e) => e.e === 'tts' && e.utt_id === r.utt_id);
  const u = mod.summary().utterances.find((x) => x.utt_id === r.utt_id);
  console.log('# speak: audio ms', u.ms, 'chunks', u.chunks, 'tts', JSON.stringify(tFirst), 'heard->done ms', Date.now() - tHeard);
  assert.ok(u.mult960 && u.inOrder && !u.flushed); assert.ok(u.ms > 1500 && u.ms < 2500, `duration ${u.ms}`);
  assert.deepEqual(mod.summary().errors, []);
  const st = await (await fetch(API + '/status')).json(); assert.equal(st.speaking, false);
});

test('ambient talk is heard but not addressed; saying Wren at 12 blocks is addressed', opts, async () => {
  const since = svc.nextHeard - 1;
  await mod.replay(fx('ambient.wav'), { uuid: 'u-far', name: 'Alex', dist: 10 });
  const a = await (await fetch(API + `/heard?since=${since}&wait=10`)).json();
  assert.equal(a.length, 1, JSON.stringify(a)); assert.equal(a[0].addressed, false); assert.match(a[0].text, /farm/i);
  await mod.replay(fx('hey-wren.wav'), { uuid: 'u-name', name: 'Alex', dist: 12 });
  const b = await (await fetch(API + `/heard?since=${a[0].id}&wait=10`)).json();
  assert.equal(b.length, 1); assert.equal(b[0].addressed, true, b[0].text);
});

test('backchannel while she talks does not cut her', opts, async () => {
  const r = await post('/speak', { text: 'I found some iron near the river. It is a big vein. Do you want to come and see it?' });
  await waitFor(() => mod.out.get(r.utt_id)?.chunks > 2);
  mod.replay(fx('backchannel.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 800 });
  await waitFor(() => mod.out.get(r.utt_id)?.done, 20000);
  assert.equal(mod.out.get(r.utt_id).flushed, false);
  assert.ok(!events.some((e) => e.e === 'barge_decision' && e.utt_id === r.utt_id && e.option !== 'continue'));
});

test('"stop wait" yields immediately via flush and the unspoken remainder is kept', opts, async () => {
  const r = await post('/speak', { text: 'I found some iron near the river. It is a big vein. Do you want to come and see it? There is also coal.' });
  await waitFor(() => mod.out.get(r.utt_id)?.samples > 48000 * 0.3);
  const tStop = Date.now();
  mod.replay(fx('stop-wait.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 600 });
  const u = await waitFor(() => mod.out.get(r.utt_id)?.flushed && mod.out.get(r.utt_id), 15000);
  const cut = mod.flushes.find((f) => f.utt_id === r.utt_id);
  console.log('# barge-in: flush', cut.at, 'ms after start; speech began', tStop - mod.t0, 'played', cut.playedMs, 'ms of', Math.round(u.samples / 48));
  const st = await (await fetch(API + '/status')).json();
  assert.ok(st.unspoken && st.unspoken.utt_id === r.utt_id && st.unspoken.text.length > 5, JSON.stringify(st.unspoken));
  assert.equal(st.speaking, false);
  const dec = events.filter((e) => e.e === 'barge_decision').pop(); assert.equal(dec.option, 'yield_now');
  console.log('# barge-in time from player speech start to flush ms', (mod.t0 + cut.at) - tStop, 'unspoken:', st.unspoken.text);
});

test('urgent line is not cut by "stop wait"; urgent preempts normal; POST /flush works', opts, async () => {
  const r = await post('/speak', { text: 'Creeper behind you, run!', priority: 'urgent' });
  await waitFor(() => mod.out.get(r.utt_id)?.chunks > 1);
  const rp = mod.replay(fx('stop-wait.wav'), { uuid: 'u-near', name: 'Steve', dist: 3, silenceMs: 600 });
  await waitFor(() => mod.out.get(r.utt_id)?.done, 10000);
  assert.equal(mod.out.get(r.utt_id).flushed, false);
  await rp; await sleep(1500);                      // let his (late) final transcript arrive first, else it can cut the NEXT line (flaky at HEAD too)
  const n = await post('/speak', { text: 'Some long calm chatter about nothing. And then some more of it, to be cut.' });
  await waitFor(() => mod.out.get(n.utt_id)?.chunks > 1);
  const u = await post('/speak', { text: 'Watch out!', priority: 'urgent' });
  await waitFor(() => mod.out.get(u.utt_id)?.done, 10000);
  assert.equal(mod.out.get(n.utt_id).flushed, true);
  const q = await post('/speak', { text: 'This will be cancelled right away, so it never finishes.' });
  await waitFor(() => mod.out.get(q.utt_id)?.chunks > 0); const f = await post('/flush'); assert.equal(f.flushed, true);
  await sleep(300); assert.equal(mod.out.get(q.utt_id).flushed, true);
  assert.deepEqual(mod.summary().errors, []);
});

test('bad requests', opts, async () => {
  assert.equal((await fetch(API + '/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(API + '/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi","priority":"x"}' })).status, 400);
  assert.equal((await fetch(API + '/nope')).status, 404);
});

test('teardown', opts, async () => { svc?.stop(); mod?.stop(); srv?.close(); await sleep(100); process.exit(0); });
