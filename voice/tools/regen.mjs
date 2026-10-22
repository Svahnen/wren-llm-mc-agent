// Re-synthesize Wren's voice from TEXT + PARAMS (no audio is archived). The service sends Kokoro one sentence at a time with a
// seed derived from (sentence, voice, speed, emotion); this tool repeats exactly that, so the samples are bit-identical to what she sent
// (verified against audio_sha256 in the index) whenever the TTS server supports `seed` (box/tts_server.py, health.seed=true).
//   node tools/regen.mjs <run-dir|utterances.jsonl> <utt_id> --out /abs/path/u3.wav [--session <id>] [--tts-url http://127.0.0.1:19411]
//   node tools/regen.mjs <thoughts.jsonl|run-dir> <thought_id> --out /abs/th.wav     (AI1 inner thought: same voice/speed/per-sentence-seed rules as spoken lines)
//   node tools/regen.mjs --thought-row '<one thoughts.jsonl line as JSON>' --out /abs/th.wav
//   node tools/regen.mjs --text "Hello there. How are you?" [--voice af_heart] [--speed 1.0] [--emotion calm] --out /abs/path/x.wav
import fs from 'node:fs'; import path from 'node:path';
import { TtsClient } from '../src/tts.js'; import { splitSentences } from '../src/sentences.js'; import { seedFor, sha256 } from '../src/archive.js';

export function wavFromPcm48(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(48000, 24); h.writeUInt32LE(96000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function readIndex(p, session = null) {
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'utterances.jsonl') : p;
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return session ? rows.filter((r) => r.session === session) : rows;
}
/** thoughts.jsonl rows (AI1): {thought_id, ts_ms, text, kind, tts:{voice,speed,emotion,seed}}. Accepts a file or a run dir. */
export function readThoughts(p) {
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'thoughts.jsonl') : p;
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}
// A thought row regenerates exactly like a spoken line: Kokoro sentence by sentence, seed = seedFor(sentence, voice, speed, emotion). row.tts.seed (whole text) is informational.
export const thoughtRec = (r) => ({ text: r.text, tts: { voice: r.tts?.voice ?? r.voice ?? 'af_heart', speed: r.tts?.speed ?? r.speed ?? null, emotion: r.tts?.emotion ?? 'calm' } });
// rec = index row (or {text, tts:{voice,emotion,speed}}). Returns {pcm, sha256, match}.
export async function regen(rec, { ttsBase = 'http://127.0.0.1:19411', voice, speed, emotion } = {}) {
  const t = rec.tts || {};
  const v = voice ?? t.voice, sp = speed ?? t.speed ?? null, em = emotion ?? t.emotion ?? 'calm';
  const tts = new TtsClient({ base: ttsBase, voice: v, emotion: em, speed: sp });
  const sentences = rec.sentences?.length ? rec.sentences : splitSentences(rec.text);
  const parts = [];
  for (const s of sentences) parts.push((await tts.synth(s, { seed: seedFor(s, v, sp, em) })).pcm48);
  let pcm = Buffer.concat(parts);
  if (rec.samples48k && rec.samples48k * 2 < pcm.length) pcm = pcm.subarray(0, rec.samples48k * 2);      // she was cut: only the part that was actually sent
  const h = sha256(pcm);
  return { pcm, sha256: h, match: rec.audio_sha256 ? rec.audio_sha256 === h : null };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const out = get('--out'); if (!out || !path.isAbsolute(out)) { console.error('usage: regen.mjs <run-dir> <utt_id> --out /abs/file.wav | --text "..." --out /abs/file.wav'); process.exit(2); }
  if (fs.existsSync(out)) { console.error('refusing to overwrite', out); process.exit(3); }
  let rec;
  if (get('--thought-row')) rec = thoughtRec(JSON.parse(get('--thought-row')));
  else if (a[1]?.startsWith('th-')) { const t = readThoughts(a[0]).find((r) => r.thought_id === a[1]); if (!t) { console.error('thought_id not found'); process.exit(4); } rec = thoughtRec(t); }
  else if (get('--text')) rec = { text: get('--text'), tts: { voice: get('--voice', 'af_heart'), speed: get('--speed') ? Number(get('--speed')) : null, emotion: get('--emotion', 'calm') } };
  else { const rows = readIndex(a[0], get('--session')); rec = rows.filter((r) => r.utt_id === a[1] && !r.dropped).at(-1); if (!rec) { console.error('utt_id not found'); process.exit(4); } }
  const r = await regen(rec, { ttsBase: get('--tts-url', process.env.VOICE_TTS_URL || 'http://127.0.0.1:19411') });
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, wavFromPcm48(r.pcm), { flag: 'wx' });
  console.log(JSON.stringify({ out, ms: Math.round(r.pcm.length / 96), sha256: r.sha256, matches_index: r.match }));
}
