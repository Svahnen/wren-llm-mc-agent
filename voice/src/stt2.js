// Second-pass STT client: Parakeet-TDT-0.6B-v3 on the model server (box/stt_parakeet_server.py, port 19413). Whole utterance in, accurate text out.
// Input is raw 16 kHz s16le mono PCM. Never throws: failures resolve {ok:false} and the caller keeps the streaming text.
export class ParakeetClient {
  constructor({ url = 'http://127.0.0.1:19413', timeoutMs = 4000, fetchFn = (...a) => fetch(...a), apiKey = '' } = {}) { Object.assign(this, { url: url.replace(/\/$/, ''), timeoutMs, fetchFn, apiKey }); this.fails = 0; this.downUntil = 0; }
  async health() { try { return await (await this.fetchFn(this.url + '/health', { headers: this.apiKey ? { 'x-api-key': this.apiKey } : {}, signal: AbortSignal.timeout(1500) })).json(); } catch { return { ok: false }; } }
  async transcribe(pcm16k) {
    if (!pcm16k?.length) return { ok: false, error: 'empty' };
    if (Date.now() < this.downUntil) return { ok: false, error: 'backoff' };
    const t0 = performance.now();
    try {
      const r = await this.fetchFn(this.url + '/v1/stt?rate=16000', { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) }, body: pcm16k, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error('http_' + r.status);
      const j = await r.json(); this.fails = 0;
      return { ok: true, text: (j.text || '').trim(), words: j.words || [], duration: j.duration, server_s: j.latency_s, device: j.device, rtt_ms: Math.round(performance.now() - t0) };
    } catch (e) { if (++this.fails >= 3) { this.downUntil = Date.now() + 10000; this.fails = 0; } return { ok: false, error: String(e?.message ?? e), rtt_ms: Math.round(performance.now() - t0) }; }
  }
}
