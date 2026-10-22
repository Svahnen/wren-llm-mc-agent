// Kokoro TTS client (POST /v1/tts on the box, chunked audio/L16;rate=24000). Returns 48 kHz s16le Buffers.
import { s16ToF32, f32ToS16, resample } from './audio.js';

export class TtsClient {
  constructor({ base = 'http://127.0.0.1:19411', voice = null, emotion = 'calm', speed = null, apiKey = '' } = {}) { Object.assign(this, { base, voice, emotion, speed, apiKey }); }
  get _auth() { return this.apiKey ? { 'x-api-key': this.apiKey } : {}; }
  async health() { const r = await fetch(this.base + '/health', { headers: this._auth, signal: AbortSignal.timeout(2000) }); return r.json(); }
  // Synthesize one sentence. Resolves {pcm48: Buffer, ttfb_ms, total_ms, samples24}. Aborts early when signal fires (returns what exists).
  async synth(text, { signal, voice = this.voice, emotion = this.emotion, speed = this.speed, seed = null } = {}) {
    const t0 = performance.now();
    const body = { text, emotion }; if (voice) body.voice = voice; if (speed) body.speed = speed; if (seed !== null && seed !== undefined) body.seed = seed;
    const r = await fetch(this.base + '/v1/tts', { method: 'POST', headers: { 'content-type': 'application/json', ...this._auth }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error('tts http ' + r.status);
    const chunks = []; let ttfb = null, carry = Buffer.alloc(0);
    for await (const c of r.body) {
      if (ttfb === null) ttfb = performance.now() - t0;
      let b = Buffer.concat([carry, c]); const even = b.length & ~1; carry = b.subarray(even); chunks.push(b.subarray(0, even));
    }
    const pcm24 = Buffer.concat(chunks);
    const pcm48 = to48k(pcm24);
    return { pcm48, ttfb_ms: Math.round(ttfb ?? 0), total_ms: Math.round(performance.now() - t0), samples24: pcm24.length >> 1 };
  }
}
// 24 kHz s16le -> 48 kHz s16le, padded with silence to a multiple of 960 samples (20 ms).
export function to48k(pcm24) {
  const up = resample(s16ToF32(pcm24), 24000, 48000);
  const n = Math.ceil(up.length / 960) * 960, f = new Float32Array(n); f.set(up);
  return f32ToS16(f);
}
