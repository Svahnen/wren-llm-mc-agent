// SYNTHETIC ASR scaffolding: Kokoro speaks 60 reference sentences (names, Wren, Minecraft) with 5 voices x 4 speeds + light noise; each clip goes through the
// streaming recognizer and Parakeet via the real services on the box; writes voice/archive/synth/asr-confusions.jsonl (every row synthetic:true) and a WER table.
// Audio only lives in memory / a temp dir that is removed by exact path at the end. Env: SYNTH_TTS(19541) SYNTH_STT(19542) SYNTH_PK(19543) SYNTH_OUT SYNTH_N(60) SEED
// usage: node tools/synth-asr.mjs [--n 60] [--out /abs/dir]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { TtsClient } from '../src/tts.js'; import { SttStream } from '../src/stt.js'; import { ParakeetClient } from '../src/stt2.js'; import { s16ToF32, resample, f32ToS16 } from '../src/audio.js';
import { words, align, mergeHeard } from '../src/vocab.js';
const here = path.dirname(fileURLToPath(import.meta.url)), a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const N = Number(arg('--n', process.env.SYNTH_N || 60)), OUT = arg('--out', process.env.SYNTH_OUT || path.join(here, '..', 'archive', 'synth'));
const tts = (v) => new TtsClient({ base: `http://127.0.0.1:${process.env.SYNTH_TTS || 19541}`, voice: v }), pk = new ParakeetClient({ url: `http://127.0.0.1:${process.env.SYNTH_PK || 19543}`, timeoutMs: 15000 });
const STT = `ws://127.0.0.1:${process.env.SYNTH_STT || 19542}/v1/stt/stream`;
const NAMES = ['Steve', 'Alex', 'Sam'];
export const SENTENCES = [
  'Hey Wren, can you show me the way to the village?', 'Wren, are you hungry?', 'Thanks Wren, that was really helpful.', 'Where did Wren go?', 'Wren, come here please.', 'Hey Wren, do you want to build a house with me?',
  'I think Wren found some iron near the river.', 'Wren, look out behind you!', 'Good morning Wren, how did you sleep?', 'Wren, stop and wait for me.', 'Can you hear me Wren?', 'Wren is my friend.',
  'There is a creeper behind the tree.', 'A zombie is coming towards the house.', 'Watch out for the skeleton on the hill.', 'The spider is in the cave.', 'I saw an enderman near the lake.', 'Careful, there is lava down there.',
  'I need a pickaxe to mine the diamond.', 'Let us go back to the village before night.', 'My bed is in the small house.', 'We should dig for diamonds under the mountain.', 'Bring the pickaxe and some torches.',
  'The village has a farm and a well.', 'Can you craft a sword for me?', 'I found coal and iron in the same cave.', 'Please put the food in the chest.', 'There is a lot of lava near the diamond.',
  'Steve, did you see the creeper?', 'Alex, come and look at this.', 'Sam, where is your pickaxe?', 'Hello Sam, I am building a farm.', 'Steve and Alex are at the village.', 'Alex wants to sleep in the bed.',
  'Sam found a cave full of spiders.', 'Thank you Steve, that was kind.', 'Is Alex coming with us?', 'Steve, bring the sword.', 'I will meet Sam at the river.', 'Tell Alex that dinner is ready.',
  'It is getting dark, we should go home.', 'Can you follow me to the farm?', 'What are you doing here?', 'I think we should build a bridge over the water.', 'Do you want to see my new house?',
  'The sheep are in the field behind the barn.', 'Let me finish what I was saying.', 'I am not sure which way the river goes.', 'Yes, that is exactly what I meant.', 'We can plant wheat near the well.',
  'Hold on, I need to get more wood.', 'Look at the sunset over the mountain.', 'Can you help me carry these stones?', 'I will come back in five minutes.', 'The nether portal is almost finished.',
  'Wren, did you take my sword?', 'Hey Steve, hey Wren, over here!', 'Please be quiet, a skeleton is nearby.', 'I do not like caves at night.', 'Let us go fishing at the lake tomorrow.', 'My name is Alex and I live near the village.'].slice(0, N);
const VOICES = ['af_bella', 'af_nicole', 'af_sarah', 'bf_emma', 'af_jessica'], SPEEDS = [0.9, 1.0, 1.15, 1.3];
let seed = Number(process.env.SEED || 12345); const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

async function sttStream(pcm) {
  const done = new Promise((res) => { const s = new SttStream(STT); let fed = false; const go = async () => { for (let i = 0; i < pcm.length; i += 3200) { s.feed(pcm.subarray(i, i + 3200)); await new Promise((r) => setTimeout(r, 8)); } await new Promise((r) => setTimeout(r, 400)); const f = await s.finalize(8000); s.close(); res(f.text || ''); }; setTimeout(go, 300); });
  return done;
}
const err = (ref, hyp) => { const r = words(ref), h = words(hyp), ops = align(r, h), bad = ops.filter((o) => o.op !== 'ok'); return { wer: r.length ? +(bad.length / r.length).toFixed(3) : 0, errors: bad.map((o) => ({ op: o.op, ref: o.a ?? null, hyp: o.b ?? null })), ref_words: r.length }; };

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-asr-')); const rows = [], file = path.join(OUT, 'asr-confusions.jsonl');
fs.writeFileSync(file, '');
try {
  for (let i = 0; i < SENTENCES.length; i++) {
    const ref = SENTENCES[i], voice = VOICES[i % VOICES.length], speed = SPEEDS[Math.floor(i / VOICES.length) % SPEEDS.length], snr = [30, 25, 20][i % 3];
    const r = await tts(voice).synth(ref, { speed, seed: 1000 + i }), x = resample(s16ToF32(r.pcm48), 48000, 16000);
    let p = 0; for (const v of x) p += v * v; const sigma = Math.sqrt(p / x.length) / Math.pow(10, snr / 20);
    const y = new Float32Array(x.length + 8000); y.set(x, 4000); for (let k = 0; k < y.length; k++) y[k] += gauss() * sigma;        // lead-in/tail + white noise at snr dB
    const pcm = Buffer.from(f32ToS16(y).buffer);
    fs.writeFileSync(path.join(tmp, `c${i}.pcm`), pcm);                 // temp only; removed at the end
    const t0 = performance.now(); const st = await sttStream(pcm); const stMs = Math.round(performance.now() - t0);
    const p2 = await pk.transcribe(pcm), corrected = mergeHeard({ stream: st, final: p2.ok ? p2.text : null, names: ['Wren', ...NAMES], botName: 'Wren' });
    const row = { synthetic: true, id: `s${i}`, reference: ref, voice, speed, noise_snr_db: snr, hyp: { stream: st, parakeet: p2.ok ? p2.text : null, corrected: corrected.text },
      errors: { stream: err(ref, st), parakeet: p2.ok ? err(ref, p2.text) : null, corrected: err(ref, corrected.text) }, agreement: corrected.confidence, uncertain_words: corrected.uncertain_words, changes: corrected.changes,
      latency_ms: { stream_total: stMs, parakeet_rtt: p2.rtt_ms ?? null }, has_wren: /wren/i.test(ref) };
    rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); process.stdout.write(`${i + 1}/${SENTENCES.length}\r`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
const agg = (sel, pass) => { const rs = rows.filter(sel).filter((r) => r.errors[pass]); const ew = rs.reduce((s, r) => s + r.errors[pass].errors.length, 0), rw = rs.reduce((s, r) => s + r.errors[pass].ref_words, 0); return { n: rs.length, wer: rw ? +(ew / rw).toFixed(4) : null, sentence_error_rate: rs.length ? +(rs.filter((r) => r.errors[pass].errors.length).length / rs.length).toFixed(3) : null }; };
const table = {}; for (const pass of ['stream', 'parakeet', 'corrected']) table[pass] = { all: agg(() => true, pass), wren_sentences: agg((r) => r.has_wren, pass), other: agg((r) => !r.has_wren, pass) };
for (const sp of SPEEDS) table[`by_speed_${sp}`] = Object.fromEntries(['stream', 'parakeet', 'corrected'].map((p) => [p, agg((r) => r.speed === sp, p).wer]));
const conf = {}; for (const r of rows) for (const pass of ['stream', 'parakeet']) for (const e of r.errors[pass]?.errors ?? []) if (e.op === 'sub') { const k = `${pass}:${e.ref}->${e.hyp}`; conf[k] = (conf[k] || 0) + 1; }
table.top_confusions = Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 25);
table.note = 'synthetic:true. Kokoro voices ' + VOICES.join(',') + '; speeds ' + SPEEDS.join(',') + '; white noise 20-30 dB SNR; stream = sherpa nemo80, parakeet = TDT-0.6B-v3, corrected = parakeet + vocabulary fix-up';
fs.writeFileSync(path.join(OUT, 'wer-table.json'), JSON.stringify(table, null, 1));
console.log('\nWER (word error rate) by pass'); console.log('pass       all     Wren-sentences  other'); for (const p of ['stream', 'parakeet', 'corrected']) console.log(p.padEnd(10), String(table[p].all.wer).padEnd(7), String(table[p].wren_sentences.wer).padEnd(15), table[p].other.wer);
console.log('rows', rows.length, '->', file);
