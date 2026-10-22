// Thought track in timeline.mjs + regen.mjs by thought_id (text-only on disk; WAV only on demand into a temp dir).
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { timeline } from '../tools/timeline.mjs'; import { regen, readThoughts, thoughtRec } from '../tools/regen.mjs'; import { seedFor } from '../src/archive.js';
const TTS = 'http://127.0.0.1:19541';
let seed = null, up = false; try { const h = await (await fetch(TTS + '/health', { signal: AbortSignal.timeout(1500) })).json(); up = !!h.ok; seed = !!h.seed; } catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs2-th-'));
const T = 1760000000000, row = (id, dt, text, kind = 'thought') => ({ thought_id: id, ts_ms: T + dt, ts_iso: new Date(T + dt).toISOString(), game_time: 6000 + dt / 50, pos: { x: 1, y: 64, z: 2 }, text, kind, goal: 'mine_iron', mood: 'calm', tts: { voice: 'af_heart', speed: null, emotion: 'calm', seed: seedFor(text, 'af_heart', null, 'calm') } });
const rows = [row('th-a-1', 1000, 'I wonder if there is more iron down here.'), row('th-a-2', 9000, 'Hm. That creeper sound again.', 'mutter')];
fs.writeFileSync(path.join(tmp, 'thoughts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(tmp, 'utterances.jsonl'), JSON.stringify({ utt_id: 'u1', text: 'Hello there.', first_played_ms: T + 4000, start_ms: T + 4000, duration_ms: 1500, priority: 'normal' }) + '\n');
fs.writeFileSync(path.join(tmp, 'heard.jsonl'), JSON.stringify({ id: 1, name: 'Steve', uuid: 'x', start_ms: T + 5500, end_ms: T + 6500, text: 'hi wren', addressed: true }) + '\n');

test('readThoughts / thoughtRec use voice, speed and emotion of the row', () => {
  assert.equal(readThoughts(tmp).length, 2); assert.deepEqual(thoughtRec(rows[0]), { text: rows[0].text, tts: { voice: 'af_heart', speed: null, emotion: 'calm' } });
});
test('timeline: separate [THOUGHT] track next to lines and heard; durations by deterministic regeneration; optional thoughts-only render', { skip: up ? false : 'dev tunnel TTS not up' }, async () => {
  const out = path.join(tmp, 'out'); const r = await timeline(tmp, out, { ttsBase: TTS, renderThoughts: true, t0: T });
  assert.equal(r.thoughts, 2); assert.equal(r.wren_lines, 1); assert.equal(r.heard, 1); assert.ok(r.rendered_thoughts_ms > 9000);
  const csv = fs.readFileSync(path.join(out, 'thoughts.csv'), 'utf8'); assert.match(csv, /^track,thought_id,kind/); assert.match(csv, /"thought","th-a-1"/); assert.match(csv, /"regen"/);
  assert.match(fs.readFileSync(path.join(out, 'thoughts-labels.txt'), 'utf8'), /^1\.000\t[\d.]+\t\[THOUGHT\] Wren: I wonder/);
  const j = JSON.parse(fs.readFileSync(path.join(out, 'thoughts.json'), 'utf8')); assert.equal(j.track, 'thought'); assert.ok(j.thoughts.every((t) => t.duration_src === 'regen' && t.duration_ms > 500));
  assert.ok(fs.existsSync(path.join(out, 'wren-lines.csv')) && fs.existsSync(path.join(out, 'heard.csv'))); assert.match(fs.readFileSync(path.join(out, 'thoughts.edl'), 'utf8'), /thought_th-a-1/);
  assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.wav')).join(), 'thoughts-timeline.wav');
});
test('regen of a thought is bit-identical when the TTS server supports seeds', { skip: up ? false : 'dev tunnel TTS not up' }, async () => {
  const a = await regen(thoughtRec(rows[0]), { ttsBase: TTS }), b = await regen(thoughtRec(rows[0]), { ttsBase: TTS });
  assert.ok(a.pcm.length > 40000); if (seed) assert.equal(a.sha256, b.sha256); else console.log('# box TTS has no seed support yet (needs restart): determinism not asserted');
});
test('cleanup', () => { fs.rmSync(tmp, { recursive: true }); });
