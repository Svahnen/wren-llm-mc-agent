// PCM helpers: s16le <-> Float32, polyphase windowed-sinc resampling, WAV io, RMS. No dependencies.
import fs from 'node:fs';

export function s16ToF32(buf) {
  const n = buf.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}
export function f32ToS16(f) {
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); b.writeInt16LE(Math.round(v * 32767), i * 2); }
  return b;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Resample Float32 by up/down (rational). Hann-windowed sinc, 16 zero crossings each side of the lower rate; kernel table precomputed.
const kernels = new Map();
function kernel(up, down) {
  const key = up + '/' + down; if (kernels.has(key)) return kernels.get(key);
  const cutoff = 0.5 / Math.max(up, down) * 0.97, half = 16 * Math.max(up, down), tab = new Float32Array(2 * half + 1);
  for (let d = -half; d <= half; d++) {
    const w = 0.5 + 0.5 * Math.cos(Math.PI * d / half);
    tab[d + half] = (d === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * d) / (Math.PI * d)) * w * up;
  }
  const k = { tab, half }; kernels.set(key, k); return k;
}
export function resample(x, fromRate, toRate) {
  if (fromRate === toRate) return x;
  const g = gcd(fromRate, toRate), up = toRate / g, down = fromRate / g;
  const { tab, half } = kernel(up, down);
  const outLen = Math.floor(x.length * up / down), out = new Float32Array(outLen), last = x.length - 1;
  for (let n = 0; n < outLen; n++) {
    const c = n * down;
    const k0 = Math.max(0, Math.ceil((c - half) / up)), k1 = Math.min(last, Math.floor((c + half) / up));
    let acc = 0;
    for (let k = k0; k <= k1; k++) acc += x[k] * tab[c - k * up + half];
    out[n] = acc;
  }
  return out;
}
export function rms(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / (f.length || 1)); }

export function writeWav(path, f32, rate) {
  const pcm = f32ToS16(f32), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path, Buffer.concat([h, pcm]));
}
export function readWav(path) {        // mono/stereo 16-bit PCM only; returns {rate, samples: Float32Array (channel 0)}
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, Math.min(b.length, p + 8 + sz)); break; }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('unsupported WAV');
  const frames = Math.floor(data.length / (2 * fmt.ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { rate: fmt.rate, samples: out };
}
