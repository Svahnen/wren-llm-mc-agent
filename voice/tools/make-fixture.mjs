// Synthesize a test sentence with Kokoro and write it as a 16 kHz mono WAV (with 300 ms of lead-in silence). usage: node make-fixture.mjs "text" out.wav [voice]
import { TtsClient } from '../src/tts.js'; import { s16ToF32, resample, writeWav } from '../src/audio.js';
const [text, out, voice] = process.argv.slice(2);
const r = await new TtsClient({ voice: voice || 'af_bella' }).synth(text);        // a different voice than Wren's own, like a player
const x = resample(s16ToF32(r.pcm48), 48000, 16000), pad = new Float32Array(4800);
const y = new Float32Array(pad.length + x.length); y.set(x, pad.length); writeWav(out, y, 16000); console.log('wrote', out, (y.length / 16000).toFixed(2), 's');
