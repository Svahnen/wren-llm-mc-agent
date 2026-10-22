// One Listener per speaking player uuid: owns that player's STT stream and endpointing state.
import { s16ToF32, rms } from './audio.js';
import { SttStream } from './stt.js';
import { eotRequiredMs } from './turntake.js';

export class Listener {
  constructor({ uuid, name, sttUrl, sttKey = '', now, onPartial, onFinal, cfg, second = null }) {
    Object.assign(this, { uuid, name, now, onPartial, onFinal, cfg, second });
    this.dist = null; this.noise = 0.004; this.inUtt = false; this.voicedMs = 0; this.silenceMs = 0; this.lastFrameAt = 0; this.lastVoicedAt = 0;
    this.utterStart = 0; this.endedAt = null; this.finalizing = false; this.loud = false; this.peak = 0; this.frames = 0; this.firstVoicedAt = 0;
    this.rec = null; this.runStartWall = null; this.lastFeedWall = 0;     // rec = timing/metadata of the utterance in progress (for heard.jsonl)
    this.stt = new SttStream(sttUrl, { apiKey: sttKey, onPartial: (t, m) => { this.partial = t; this.partialAt = this.now(); this._notePartial(t, m); onPartial?.(this, t); } });
    this.partial = ''; this.pcmChunks = []; this.pcmBytes = 0; this.pre = []; this.preBytes = 0; this.ovStart = null; this.ovVoiced0 = 0; this.lastEvalAt = 0; this.lastEvalText = null;
  }
  // Called for every audio_in message (up to 5 x 20 ms frames).
  _notePartial(t, m) {
    const r = this.rec; if (!r || !t || r.partials.at(-1)?.text === t) return;
    r.partials.push({ ms: Date.now(), text: t, ...(m && m.type === 'endpoint' ? { endpoint: true } : {}), ...(typeof m?.confidence === 'number' ? { confidence: m.confidence } : {}) });
  }
  feed(pcm, dist, serverT = null) {
    const wall = Date.now(); if (wall - this.lastFeedWall > 300) this.runStartWall = wall; this.lastFeedWall = wall;
    if (Number.isFinite(dist)) this.dist = dist;
    const t = this.now(); this.endedAt = null;
    const f = s16ToF32(pcm), fl = 320;
    for (let i = 0; i + fl <= f.length; i += fl) {
      const r = rms(f.subarray(i, i + fl)); this.frames++;
      const voiced = r > Math.max(this.cfg.vadMin, this.noise * 3);
      if (!voiced) this.noise = this.noise * 0.98 + r * 0.02;           // adaptive noise floor from non-voiced frames
      if (voiced) {
        if (!this.inUtt) { this.inUtt = true; this.rec = { first_audio_in_ms: this.runStartWall, start_ms: wall, server_start_ms: serverT, dist_start: this.dist, partials: [], overlap_utt_id: null, barge: null }; this.voicedMs = 0; this.utterStart = t; this.firstVoicedAt = t; this.peak = 0; }
        this.voicedMs += 20; if (this.rec) { this.rec.end_ms = wall; this.rec.server_end_ms = serverT; this.rec.dist_end = this.dist; } this.silenceMs = 0; this.lastVoicedAt = t; this.peak = Math.max(this.peak, r); this.loud = this.peak > 0.25;
      } else if (this.inUtt) this.silenceMs += 20;
    }
    this.lastFrameAt = t;
    this._buffer(pcm);
    this.stt.feed(pcm);                                                          // always feed: leading silence is harmless, keeps timing
  }
  // Keep the PCM of the utterance for the accurate second pass (300 ms pre-roll before the first voiced frame; capped at 30 s).
  _buffer(pcm) {
    if (this.inUtt) { if (this.pre.length) { this.pcmChunks.push(...this.pre); this.pcmBytes += this.preBytes; this.pre = []; this.preBytes = 0; } if (this.pcmBytes < 32000 * 30) { this.pcmChunks.push(pcm); this.pcmBytes += pcm.length; } return; }
    this.pre.push(pcm); this.preBytes += pcm.length; while (this.preBytes > 9600 && this.pre.length > 1) this.preBytes -= this.pre.shift().length;
  }
  takePcm() { const b = Buffer.concat(this.pcmChunks); this.pcmChunks = []; this.pcmBytes = 0; return b; }
  audioEnd() { this.endedAt = this.now(); }
  // Effective silence: audio-time silence + wall time since the last frame (the mod sends nothing while the player is silent)
  // + the mod's audio_end as a floor (the stream stopped: at least the fast threshold has passed).
  effectiveSilenceMs() {
    if (!this.inUtt) return 0;
    const wall = this.now() - this.lastFrameAt;
    let s = this.silenceMs + wall;
    if (this.endedAt !== null) s = Math.max(s, this.cfg.fastMs + (this.now() - this.endedAt));
    return s;
  }
  // Check the endpoint rule; returns true when the utterance should be finalized now.
  shouldEndpoint() {
    if (!this.inUtt || this.finalizing) return false;
    if (this.now() - this.utterStart > this.cfg.maxUttMs) return true;
    if (this.voicedMs < this.cfg.minVoicedMs) return this.effectiveSilenceMs() > 1500 ? true : false;   // too short: dropped at finalize
    // The streaming STT lags the audio by ~0.3-0.4 s and has no punctuation: never trust the text before minSilenceMs of silence,
    // and treat 'no words decoded yet' like 'no punctuation' (mid), not like 'finished sentence' (fast).
    const need = this.partial ? eotRequiredMs(this.partial, { fast: this.cfg.fastMs, mid: this.cfg.midMs, hold: this.cfg.holdMs }) : this.cfg.midMs;
    return this.effectiveSilenceMs() >= Math.max(need, this.cfg.minSilenceMs);
  }
  async endpoint() {
    this.finalizing = true;
    const endpointAt = this.now(), lastVoiced = this.lastVoicedAt, voicedMs = this.voicedMs, startAt = this.utterStart;
    const rec = this.rec; this.rec = null;
    const pcm = this.takePcm(); this.ovStart = null;
    const t0 = this.now(); const p2 = this.second ? this.second.transcribe(pcm) : Promise.resolve(null);
    const fin = await this.stt.finalize(); const sttMs = Math.round(this.now() - t0);
    const sec = await p2; const stt2Ms = sec ? Math.round(this.now() - t0) : null;
    this.inUtt = false; this.voicedMs = 0; this.silenceMs = 0; this.partial = ''; this.finalizing = false; this.endedAt = null;
    return { text: (fin.text || '').trim(), endpoint_ms: Math.round(endpointAt - lastVoiced), stt_ms: sttMs, voiced_ms: voicedMs, start_at: startAt, end_at: endpointAt, last_voiced_at: lastVoiced, kind: fin.type, rec, confidence: typeof fin.confidence === 'number' ? fin.confidence : null, final_ms: Date.now(), second: sec, stt2_ms: stt2Ms, pcm_ms: Math.round(pcm.length / 32) };
  }
  close() { this.stt.close(); }
}
