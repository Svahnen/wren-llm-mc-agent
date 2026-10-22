// Try Kokoro voices: first-audio latency per sentence + STT round trip (does the transcript match?).
import { TtsClient } from '../src/tts.js';
import { writeWav, s16ToF32, resample } from '../src/audio.js';
import { SttStream } from '../src/stt.js';
import fs from 'node:fs';
const voices = process.argv.slice(2).length ? process.argv.slice(2) : ['af_heart', 'af_bella', 'af_nicole', 'af_sky', 'af_sarah', 'bf_emma'];
const lines = ['What are you doing here?', 'I am looking for food.', 'Careful, there is a creeper behind you!', 'I found some iron near the river, do you want to come and see it?'];
const tts = new TtsClient(); const out = process.env.OUT || '/tmp/voicetrial'; fs.mkdirSync(out, { recursive: true });
for (const v of voices) {
  const rows = [];
  for (const [round, text] of [...lines, ...lines].entries()) {
    try {
      const r = await tts.synth(text, { voice: v });
      rows.push({ text, ttfb: r.ttfb_ms, total: r.total_ms, dur: +(r.pcm48.length / 2 / 48000).toFixed(2) });
      if (round < lines.length) writeWav(`${out}/${v}-${round}.wav`, s16ToF32(r.pcm48), 48000);
      if (round < lines.length && round === 0) {            // STT check
        const pcm16 = resample(s16ToF32(r.pcm48), 48000, 16000); const b = Buffer.alloc(pcm16.length * 2);
        pcm16.forEach((x, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), i * 2));
        const s = new SttStream('ws://127.0.0.1:19412/v1/stt/stream'); await new Promise(r => setTimeout(r, 400));
        for (let i = 0; i < b.length; i += 640) s.feed(b.subarray(i, i + 640));
        rows[rows.length - 1].stt = (await s.finalize()).text; s.close();
      }
    } catch (e) { rows.push({ text, error: String(e) }); }
  }
  const t2 = rows.slice(lines.length).map(r => r.ttfb).sort((a, b) => a - b);
  console.log(v, 'warm ttfb ms', t2.join(','), 'stt:', JSON.stringify(rows[0].stt), 'dur', rows.slice(0, 4).map(r => r.dur).join('/'));
}
