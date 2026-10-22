// Speaker: owns the output queue. POST /speak -> utterance -> sentences -> TTS (one ahead) -> audio_out chunks paced at <= ~1.5x real time.
// The mod owns the playout clock and buffers up to 2 s, so we keep at most LEAD_MS of audio ahead of our own estimate of the playhead.
import { audioOut, flushMsg, chunk48, msOf48 } from './protocol.js';
import { splitSentences } from './sentences.js';
import { speakMeta } from './turnscore.js';

export class Speaker {
  constructor({ tts, send, log, leadMs = 1200, now = () => performance.now(), maxQueue = 4, archive = null }) {
    Object.assign(this, { tts, send, log, leadMs, now, maxQueue, archive }); this.cutBy = null;   // cutBy: set by the service just before a barge-in flush
    this.queue = []; this.cur = null; this.nextId = 1; this.running = false; this.lastLatency = null; this.unspoken = null;
    this.history = new Map();                  // utt_id -> {text, sentences, sentMs, playedMs, done}
    this.connected = () => true;
  }
  playedMs(u = this.cur) { return u ? this._playhead(u) : 0; }
  get speaking() { return !!this.cur; }
  get queueMs() {
    let ms = this.cur ? Math.max(0, this.cur.sentMs - this._playhead(this.cur)) : 0;
    for (const u of this.queue) ms += u.sentences.join(' ').length * 65;      // ~65 ms of speech per character
    return Math.round(ms);
  }
  _playhead(u) { return u.t0 === null ? 0 : Math.min(u.sentMs, this.now() - u.t0); }

  enqueue({ text, priority = 'normal', inReplyTo = null, kind, importance, id: forcedId = null }) {
    const sentences = splitSentences(text);
    if (!sentences.length) return null;
    const id = forcedId ?? 'u' + (this.nextId++);
    const meta = speakMeta({ kind, importance, priority, inReplyTo });
    const u = { id, text, sentences, priority, inReplyTo, kind: meta.kind, importance: meta.importance, seq: 0, sentMs: 0, t0: null, idx: 0, spans: [], cancelled: false, enq: this.now(), enqWall: Date.now() };
    this.history.set(id, u); if (this.history.size > 50) this.history.delete(this.history.keys().next().value);
    if (priority === 'urgent') {
      this.queue = this.queue.filter((q) => q.priority === 'urgent');          // urgent drops waiting normal chatter
      this.queue.push(u);
      if (this.cur && this.cur.priority !== 'urgent') this.flush(this.cur.id, 'urgent_preempt');
    } else {
      this.queue.push(u);
      while (this.queue.length > this.maxQueue) { const d = this.queue.shift(); this.log('speak_dropped', { utt_id: d.id, why: 'queue_full' }); this.archive?.dropped(d, 'queue_full'); }
    }
    this.log('speak_queued', { utt_id: id, priority, kind: meta.kind, importance: meta.importance, text, in_reply_to: inReplyTo });
    this._kick();
    return id;
  }

  // Cut off speech. which: utt id, '*' (everything incl. queue) or undefined (= current). Records the unspoken remainder.
  flush(which = '*', why = 'flush') {
    const u = this.cur; let result = null;
    if (u && (which === '*' || which === u.id)) {
      const played = this._playhead(u);
      // sentence k counts as spoken when its audio end (cumulative ms) is <= playhead (+60 ms slack)
      let spoken = 0; while (spoken < u.spans.length && u.spans[spoken] <= played + 60) spoken++;
      const rest = u.sentences.slice(spoken);
      this.unspoken = { utt_id: u.id, text: rest.join(' '), spoken: u.sentences.slice(0, spoken).join(' '), why, ts: Date.now() };
      result = { ...this.unspoken, played_ms: Math.round(played) };
      u.cancelled = true; u.abort?.abort();
      this.archive?.end(u, { flushed: true, why, played_ms: Math.round(played), cut_by: this.cutBy && this.cutBy.utt_id === u.id ? this.cutBy : null });
      this.send(flushMsg(u.id));
      this.log('flush', { utt_id: u.id, why, played_ms: Math.round(played), unspoken: rest.join(' ') });
      this.cur = null;
    } else if (which === '*') this.send(flushMsg('*'));
    if (which === '*') { for (const q of this.queue) { this.log('speak_dropped', { utt_id: q.id, why }); this.archive?.dropped(q, why); } this.queue = []; }
    return result;
  }
  // After the current sentence ends, drop everything else (finish_sentence rule).
  finishSentenceThenStop() { if (this.cur) this.cur.stopAfter = this.cur.idx; }

  onPlayed(m) {
    const u = this.history.get(String(m.utt_id)); if (!u) return;
    u.playedMs = m.ms_played; u.done = !!m.done; this.archive?.played(m);
    if (this.unspoken && this.unspoken.utt_id === u.id && typeof m.ms_played === 'number') {   // refine the estimate with the mod's number
      let spoken = 0; while (spoken < u.spans.length && u.spans[spoken] <= m.ms_played + 60) spoken++;
      this.unspoken = { ...this.unspoken, text: u.sentences.slice(spoken).join(' '), spoken: u.sentences.slice(0, spoken).join(' '), played_ms: m.ms_played };
    }
    this.log('played', { utt_id: u.id, ms_played: m.ms_played, done: !!m.done });
  }

  _kick() { if (!this.running) { this.running = true; this._run().catch((e) => this.log('speaker_error', { error: String(e) })).finally(() => { this.running = false; if (this.queue.length) this._kick(); }); } }

  async _run() {
    while (this.queue.length) {
      if (!this.connected()) { await sleep(200); this._expire(); continue; }
      const u = this.queue.shift(); this.cur = u; u.abort = new AbortController();
      let pending = this._synth(u, 0);
      for (u.idx = 0; u.idx < u.sentences.length && !u.cancelled; u.idx++) {
        if (u.stopAfter !== undefined && u.idx > u.stopAfter) break;
        const r = await pending;
        pending = u.idx + 1 < u.sentences.length ? this._synth(u, u.idx + 1) : null;      // synth the next one while we send this one
        if (u.cancelled) break;
        if (!r) continue;
        if (u.idx === 0) { u.firstAudioAt = this.now(); this.lastLatency = { ...(this.lastLatency || {}), tts_first_ms: r.ttfb_ms }; }
        await this._sendSentence(u, r.pcm48);
        u.spans[u.idx] = u.sentMs;
      }
      if (u.cancelled) { continue; }
      // everything sent: wait until our estimated playhead reaches the end (so `speaking` stays true while she is audible)
      if (u.stopAfter !== undefined && u.idx < u.sentences.length) { this.unspoken = { utt_id: u.id, text: u.sentences.slice(u.idx).join(' '), spoken: u.sentences.slice(0, u.idx).join(' '), why: 'finish_sentence', ts: Date.now() }; this.onFinishCut?.(u, this.unspoken); }
      while (!u.cancelled && this._playhead(u) < u.sentMs) await sleep(40);
      if (!u.cancelled) { this.log('utt_done', { utt_id: u.id, sent_ms: Math.round(u.sentMs) }); this.archive?.end(u, { flushed: false, cut: u.stopAfter !== undefined && u.idx < u.sentences.length, why: u.stopAfter !== undefined && u.idx < u.sentences.length ? 'finish_sentence' : null, cut_by: this.cutBy && this.cutBy.utt_id === u.id ? this.cutBy : null }); }
      if (this.cur === u) this.cur = null;
    }
  }
  _expire() { const t = this.now(); this.queue = this.queue.filter((u) => (t - u.enq < 20000) || (this.log('speak_dropped', { utt_id: u.id, why: 'mod_offline' }), this.archive?.dropped(u, 'mod_offline'), false)); }

  async _synth(u, i) {
    try { const r = await this.tts.synth(u.sentences[i], { signal: u.abort.signal, seed: this.seedOf?.(u.sentences[i]) ?? null }); this.log('tts', { utt_id: u.id, i, ttfb_ms: r.ttfb_ms, total_ms: r.total_ms, ms: Math.round(msOf48(r.pcm48)), text: u.sentences[i] }); return r; }
    catch (e) { if (!u.cancelled) this.log('tts_error', { utt_id: u.id, i, error: String(e) }); return null; }
  }
  async _sendSentence(u, pcm48) {
    for (const ch of chunk48(pcm48, 5)) {
      // pace: do not run more than leadMs ahead of the playhead we estimate
      while (!u.cancelled && u.t0 !== null && u.sentMs - this._playhead(u) > this.leadMs) await sleep(25);
      if (u.cancelled) return;
      if (u.t0 === null) u.t0 = this.now();
      else if (this.now() - u.t0 > u.sentMs) u.t0 = this.now() - u.sentMs + 0 ;   // underrun: the playhead cannot be ahead of what we sent
      this.archive?.chunk(u, ch);
      this.send(audioOut(u.id, u.seq++, ch));
      u.sentMs += msOf48(ch);
    }
  }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
