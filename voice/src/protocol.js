// Framing for the mod WebSocket protocol (FIXED by the Fabric voice mod; mod = server, this service = client).
// mod->service: hello players audio_in audio_end played error | service->mod: audio_out flush speak_distance
export const SR_IN = 16000, SR_OUT = 48000, FRAME_OUT = 960;          // 960 samples at 48 kHz = 20 ms
export const FRAME_IN = 320;                                           // 20 ms at 16 kHz

export function decode(text) {
  let m; try { m = JSON.parse(text); } catch { return { type: 'invalid', reason: 'json' }; }
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { type: 'invalid', reason: 'no type' };
  switch (m.type) {
    case 'hello': case 'error': return m;
    case 'players': return { ...m, near: Array.isArray(m.near) ? m.near : [], bot: m.bot ?? null };
    case 'audio_in': {
      if (typeof m.uuid !== 'string' || typeof m.pcm16k !== 'string') return { type: 'invalid', reason: 'audio_in fields' };
      const pcm = Buffer.from(m.pcm16k, 'base64');
      if (pcm.length === 0 || pcm.length % 2) return { type: 'invalid', reason: 'audio_in pcm length' };
      return { ...m, pcm };
    }
    case 'audio_end': if (typeof m.uuid !== 'string') return { type: 'invalid', reason: 'audio_end uuid' }; return m;
    case 'played': if (typeof m.utt_id === 'undefined') return { type: 'invalid', reason: 'played utt_id' }; return m;
    default: return { type: 'unknown', raw: m };
  }
}

// Encode one audio_out. pcm48 = Buffer s16le mono 48 kHz, length must be a multiple of 960 samples.
export function audioOut(uttId, seq, pcm48) {
  if (pcm48.length % (FRAME_OUT * 2)) throw new Error('audio_out must be a multiple of 960 samples');
  return JSON.stringify({ type: 'audio_out', utt_id: uttId, seq, pcm48k: pcm48.toString('base64') });
}
export const flushMsg = (uttId = '*') => JSON.stringify({ type: 'flush', utt_id: uttId });
export const speakDistanceMsg = (d) => JSON.stringify({ type: 'speak_distance', d });

// Split a 48k buffer into chunks of `frames` x 20 ms (default 5 = 100 ms); every chunk is a whole number of 960-sample frames.
export function* chunk48(pcm48, frames = 5) {
  const step = FRAME_OUT * 2 * frames;
  for (let i = 0; i < pcm48.length; i += step) yield pcm48.subarray(i, Math.min(pcm48.length, i + step));
}
export const msOf48 = (buf) => (buf.length / 2) / SR_OUT * 1000;
