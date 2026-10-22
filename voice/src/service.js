// The Wren voice service: client of the mod WebSocket, per-speaker STT, addressee logic, turn-taking, Speaker, event log.
import { decode, speakDistanceMsg } from './protocol.js';
import { Listener } from './listener.js';
import { Speaker } from './speaker.js';
import { TtsClient } from './tts.js';
import { isAddressed, saysName, NEAR, FAR, CONVO_MS } from './addressee.js';
import { Archive, seedFor } from './archive.js';
import { tokens } from './turntake.js';
import { speakMeta, CFG as TURN_CFG, TurnScorer, TurnState, features as turnFeatures, loadLinearModel, CONTINUE, FINISH, TRAIL, NOW } from './turnscore.js';
import { ParakeetClient } from './stt2.js';
import { mergeHeard } from './vocab.js';

export const DEFAULTS = {
  modUrl: 'ws://127.0.0.1:19520', sttUrl: 'ws://127.0.0.1:19412/v1/stt/stream', sttPass2Url: 'http://127.0.0.1:19413', pass2: true, turnModel: null, turnAlpha: 0, wantFinish: 0.35, evalMs: 300, ttsBase: 'http://127.0.0.1:19411', apiKey: '', modSecret: '',
  voice: 'af_heart', botName: 'Wren', speakDistance: 48,
  archiveDir: null, archive: true, runId: undefined, fastMs: 250, minSilenceMs: 350, midMs: 500, holdMs: 1000, heldGapMs: 500, heldFairGapMs: 250, heldStaleMs: 20000, fairYields: 2, fairWindowMs: 30000, resumeMaxWords: 18, minVoicedMs: 200, maxUttMs: 25000, vadMin: 0.012, tickMs: 40, listenerIdleMs: 60000,
};

export class VoiceService {
  constructor(cfg = {}, { log = () => {}, WS = globalThis.WebSocket } = {}) {
    this.cfg = { ...DEFAULTS, ...cfg }; this.log = log; this.WS = WS;
    this.now = () => performance.now();
    this.nameRx = new RegExp(`\\b(?:${this.cfg.botName.toLowerCase()}|wrenn|wran|rhen|ren|wrin|rin)\\b`, 'i');   // + greeting-vocative variants in addressee.js
    this.ws = null; this.connected = false; this.helloSeen = null; this.botOnline = false; this.bot = null; this.near = []; this.nearAt = 0;
    this.listeners = new Map(); this.heard = []; this.nextHeard = 1; this.waiters = [];
    this.lastLatency = { endpoint_ms: null, stt_ms: null, tts_first_ms: null };
    this.episode = null; this.backoff = 500; this.stopped = false;
    this.second = this.cfg.pass2 ? new ParakeetClient({ url: this.cfg.sttPass2Url, apiKey: this.cfg.apiKey }) : null;
    this.scorer = new TurnScorer({ model: this.cfg.turnModel ? loadLinearModel(this.cfg.turnModel) : null, alpha: this.cfg.turnAlpha });
    this.held = null; this.quietSince = null; this.yields = []; this.heldStats = { held: 0, redelivered: 0, dropped_stale: 0, dropped_replaced: 0, dropped_flush: 0 };
    this.fam = new Map(); this.convoAt = new Map(); this.lastBotSpeakAt = 0; this.cuts = []; this.turnN = 0;
    this.tts = new TtsClient({ base: this.cfg.ttsBase, voice: this.cfg.voice, apiKey: this.cfg.apiKey });
    this.archive = new Archive({ root: this.cfg.archiveDir || '/nonexistent', runId: this.cfg.runId, log: (e, d) => this.log(e, d), enabled: !!(this.cfg.archive && this.cfg.archiveDir),
      ttsCfg: { voice: this.cfg.voice, emotion: this.tts.emotion, speed: this.tts.speed, backend_url: undefined, seed_supported: null, seeded: true, sample_rate_out: 48000, express: false } });
    this.speaker = new Speaker({ tts: this.tts, send: (m) => this._send(m), log: (e, d) => { if (e === 'utt_done') this.yields = []; this.log(e, d); }, archive: this.archive });
    this.speaker.onFinishCut = (u, un) => this._offerResume(un, u, 'finish_sentence');
    this.speaker.seedOf = (text) => seedFor(text, this.tts.voice, this.tts.speed, this.tts.emotion);
    this.speaker.connected = () => this.connected;
    this.speaker.now = this.now;
  }
  start() { this.archive.start(); this.tts.health().then((h) => { this.archive.ttsCfg.seed_supported = !!h.seed; this.archive.start(); }, () => {}); this._connect(); this.ticker = setInterval(() => this._tick().catch((e) => this.log('tick_error', { error: String(e) })), this.cfg.tickMs); }
  async stop() { this.stopped = true; clearInterval(this.ticker); try { this.ws?.close(); } catch {} for (const l of this.listeners.values()) l.close(); await this.archive.stop(); }

  // ---------------------------------------------------------------- mod connection
  _connect() {
    if (this.stopped) return;
    let ws; try { ws = new this.WS(this.cfg.modUrl, this.cfg.modSecret ? { headers: { 'X-Wren-Secret': this.cfg.modSecret } } : undefined); } catch (e) { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.backoff = 500; this.log('mod_connected', {}); this._send(speakDistanceMsg(this.cfg.speakDistance)); };
    ws.onmessage = (ev) => this._onMessage(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    ws.onclose = () => { if (this.connected) this.log('mod_disconnected', {}); this.connected = false; this.helloSeen = null; this.botOnline = false; this.speaker.flush('*', 'mod_disconnected'); this._retry(); };
    ws.onerror = () => {};
  }
  _retry() { if (this.stopped) return; const d = this.backoff; this.backoff = Math.min(10000, this.backoff * 2); setTimeout(() => this._connect(), d); }
  _send(m) { if (this.connected && this.ws?.readyState === 1) this.ws.send(m); }

  _onMessage(text) {
    const m = decode(text);
    switch (m.type) {
      case 'hello': this.helloSeen = m; this.botOnline = !!m.botOnline; this.log('hello', { version: m.version, bot: m.bot, botOnline: m.botOnline }); break;
      case 'players': this.archive.noteServerTime(m.t); this.bot = m.bot; this.near = m.near; this.nearAt = this.now(); this.botOnline = m.bot != null;
        for (const p of m.near) { const l = this.listeners.get(p.uuid); if (l) l.dist = p.dist; } break;
      case 'audio_in': this._audioIn(m); break;
      case 'audio_end': this.listeners.get(m.uuid)?.audioEnd(); break;
      case 'played': this.speaker.onPlayed(m); break;
      case 'error': this.log('mod_error', { msg: m.msg }); break;
      case 'invalid': this.log('bad_message', { reason: m.reason }); break;
      default: break;
    }
  }
  _listener(uuid, name) {
    let l = this.listeners.get(uuid);
    if (!l) {
      l = new Listener({ uuid, name, sttUrl: this.cfg.sttUrl, sttKey: this.cfg.apiKey, second: this.second, now: this.now, cfg: this.cfg, onPartial: (li, t) => this._onPartial(li, t) });
      this.listeners.set(uuid, l); this.log('listener_open', { uuid, name });
    }
    if (name) l.name = name;
    return l;
  }
  _audioIn(m) {
    const l = this._listener(m.uuid, m.name);
    l.inRange = m.in_range !== false;          // V4: the mod forwards everyone for the transcript; she perceives only in_range (missing = in range)
    l.feed(m.pcm, m.dist, m.t);
    l.lastSeq = m.seq;
  }

  // ---------------------------------------------------------------- barge-in (scored: src/turnscore.js)
  /** Conversation continuity: this speaker spoke to her or was answered by her within CONVO_MS, or he is the only human in hearing range and she spoke to anyone that recently. */
  _inConvo(l) {
    const t = Date.now();
    if (t - (this.convoAt.get(l.uuid) ?? 0) < CONVO_MS) return true;
    const others = this.near.filter((p) => p.uuid !== l.uuid && (p.dist ?? 99) <= FAR);
    return !others.length && t - this.lastBotSpeakAt < CONVO_MS && this.convoAt.size > 0 && Math.max(...this.convoAt.values()) > t - 2 * CONVO_MS;
  }
  _addressed(l, text) { return isAddressed({ text, dist: l.dist, botOnline: this.botOnline }, { nameRx: this.nameRx, convo: this._inConvo(l) }); }
  _famOf(name) { return this.fam.get(name) ?? 0; }
  _onPartial(l, text) {
    this.log('partial', { uuid: l.uuid, name: l.name, text });
    if (text !== l.lastEvalText) this._evalOverlap(l, text);
  }
  /** Evaluate one listener's overlap with her current utterance. Called on every partial change and every evalMs while he is voiced (so no-text bursts are scored too). */
  _evalOverlap(l, text, { final = false, voicedMs = null } = {}) {
    const u = this.speaker.cur; if (!u || l.inRange === false || !l.inUtt && !final) return null;
    const now = this.now(); l.lastEvalAt = now; l.lastEvalText = text;
    if (!this.episode) this.episode = new TurnState();
    const addressed = this._addressed(l, text || ' x');
    const run = voicedMs ?? l.voicedMs, ovMs = final ? run : Math.max(0, Math.min(l.voicedMs - (l.ovVoiced0 || 0), l.ovStart != null ? now - l.ovStart : 0));
    const recent = this.cuts.filter((t) => now - t < 120000).length;
    const replyTo = u.inReplyTo != null && this.heard.find((h) => h.id === u.inReplyTo)?.uuid === l.uuid;
    const f = turnFeatures({ text, voicedMs: run, overlapMs: ovMs, addressed, dist: l.dist, familiarity: this._famOf(l.name), u, playedMs: this.speaker.playedMs(u), replyToThis: replyTo, recentInterrupts: recent, loud: l.loud, owed: this._owed(l.uuid), nameRx: this.nameRx, final, wantFinish: this.cfg.wantFinish });
    const res = this.scorer.score(f), st = this.episode.apply(res, now);
    this.archive.turn({ n: ++this.turnN, ts: Date.now(), uuid: l.uuid, name: l.name, utt_id: u.id, played_ms: f.played_ms, features: f, x: f.x, rules: res.rules, source: res.source, logits: res.logits, components: res.components, probs: res.probs, probs_all: res.probs_all, learned: res.learned, blended: res.blended,
      scored_action: res.action, action: st.action, held: st.held, changed: st.changed, duck_db: res.duck_db });
    if (res.action !== CONTINUE || st.changed) this.log('barge_decision', { option: st.action, scored: res.action, source: res.source, text, probs: res.probs, held: st.held });
    if (st.changed) { this.cuts.push(now); this._apply(st.action, u, l, text, res); }
    return { res, st };
  }
  _apply(option, u, l, text, res = null) {
    if (option === CONTINUE) return;
    this._noteBarge(l, u, option, text);
    const hard = res?.source === 'rule:stop' || res?.source === 'rule:danger';       // an explicit stop / danger call is never auto-resumed
    if (option === FINISH) { this.speaker.finishSentenceThenStop(); return; }
    this._noteYield(l.uuid);
    const cut = (why) => { const r = this.speaker.flush(u.id, why); if (r && !hard) this._offerResume(r, u, why, l.uuid); };
    if (option === TRAIL) { setTimeout(() => { if (this.speaker.cur === u) cut('yield_trail_off'); }, 300); return; }
    cut('yield_now');
  }

  // ---------------------------------------------------------------- V4: held lines, auto-resume, turn fairness
  _talking() { return [...this.listeners.values()].filter((l) => l.inUtt && l.inRange !== false && l.voicedMs >= 200 && !(Number.isFinite(l.dist) && l.dist > FAR)); }
  _noteYield(uuid) { const t = Date.now(); this.yields.push({ uuid, t }); this.yields = this.yields.filter((y) => t - y.t < this.cfg.fairWindowMs).slice(-8); }
  /** Number of consecutive yields to the same person within the window (0 when someone else interleaved or she completed a line). */
  _consecYields(uuid) { const t = Date.now(); let n = 0; for (let i = this.yields.length - 1; i >= 0; i--) { const y = this.yields[i]; if (y.uuid !== uuid || t - y.t >= this.cfg.fairWindowMs) break; n++; } return n; }
  _owed(uuid) { return this._consecYields(uuid) >= this.cfg.fairYields; }
  _hold(body, id, why) {
    this.held = { id, body, at: Date.now(), why };
    this.heldStats.held++; this.log('speak_held', { utt_id: id, why, text: body.text, talkers: this._talking().map((l) => l.name) });
  }
  dropHeld(why) { if (!this.held) return; this.heldStats['dropped_' + why] = (this.heldStats['dropped_' + why] ?? 0) + 1; this.log('held_dropped_' + why, { utt_id: this.held.id, text: this.held.body.text, age_ms: Date.now() - this.held.at }); this.held = null; }
  /** She was cut (or finish_sentence left a remainder): keep what was not said for the next gap. Nothing was delivered when no whole sentence was spoken. */
  _offerResume(un, u, why, uuid = null) {
    if (!un || !un.text) return;
    const words = un.text.split(/\s+/).filter(Boolean).length;
    const whole = !un.spoken;
    if (!whole && words > this.cfg.resumeMaxWords) return;                                 // long remainder: S2 decides (it gets it via /status unspoken)
    if (this.held) return;                                                                 // a newer line is already waiting
    const id = 'u' + (this.speaker.nextId++);
    this.held = { id, body: { text: un.text, priority: 'normal', in_reply_to: u.inReplyTo ?? null, kind: u.kind, importance: u.importance }, at: Date.now(), why: whole ? 'cut_before_sentence' : 'resume_remainder', uuid };
    un.auto_resume = true; this.heldStats.held++;
    this.log('speak_held', { utt_id: id, from: u.id, why: this.held.why, text: un.text, words });
  }
  _heldTick() {
    const h = this.held; if (!h) return;
    const t = this.now(), age = Date.now() - h.at;
    if (age > this.cfg.heldStaleMs) return this.dropHeld('stale');
    const talkers = this._talking();
    if (talkers.length) this.quietSince = null; else if (this.quietSince == null) this.quietSince = t;
    const fair = talkers.length > 0 && talkers.some((l) => this._owed(l.uuid)) && talkers.every((l) => l.effectiveSilenceMs() >= this.cfg.heldFairGapMs);
    const gap = !talkers.length && this.quietSince != null && t - this.quietSince >= this.cfg.heldGapMs;
    if (!(gap || fair) || this.speaker.cur || this.speaker.queue.length || !this.connected) return;
    this.held = null; this.heldStats.redelivered++;
    this.log('held_redelivered', { utt_id: h.id, waited_ms: age, why: h.why, gap: fair && !gap ? 'fairness_short_gap' : 'turn_gap', text: h.body.text });
    this.speaker.enqueue({ ...h.body, id: h.id });
  }

  _noteBarge(l, u, option, text) {
    if (l.rec) l.rec.barge = { utt_id: u.id, option };
    this.speaker.cutBy = { utt_id: u.id, uuid: l.uuid, name: l.name, option, text: text ?? null, ms: Date.now() };
  }
  // ---------------------------------------------------------------- endpointing tick
  async _tick() {
    if (!this.speaker.cur) this.episode = null;
    const t = this.now();
    this._heldTick();
    for (const l of this.listeners.values()) {
      if (l.inUtt && l.inRange !== false && this.speaker.cur) { if (l.ovStart == null) { l.ovStart = t; l.ovVoiced0 = l.voicedMs; } if (l.rec) l.rec.overlap_utt_id = this.speaker.cur.id; if (t - l.lastEvalAt >= this.cfg.evalMs && !l.finalizing) this._evalOverlap(l, l.partial); }
      else if (!l.inUtt || !this.speaker.cur) l.ovStart = null;
      if (l.shouldEndpoint()) this._finish(l);
      else if (!l.inUtt && t - l.lastFrameAt > this.cfg.listenerIdleMs && !l.finalizing) { l.close(); this.listeners.delete(l.uuid); this.log('listener_close', { uuid: l.uuid }); }
    }
  }
  _addressedWhy(l, text) {
    if (!this.botOnline) return 'bot_offline'; if (!text || !/[a-z]/i.test(text)) return 'no_text'; if (!Number.isFinite(l.dist)) return 'dist_unknown';
    if (l.dist <= NEAR) return `near<=${NEAR}`; if (l.dist <= FAR && saysName(text, this.nameRx)) return `name<=${FAR}`; if (l.dist <= FAR && this._inConvo(l)) return `convo<=${FAR}`;
    return l.dist <= FAR ? 'ambient:no_name' : 'ambient:far';
  }
  async _finish(l) {
    const r = await l.endpoint();
    const rec = r.rec || {};
    const streamText = r.text, sec = r.second?.ok ? r.second : null;
    const names = [...new Set([this.cfg.botName, ...this.near.map((p) => p.name)])];
    const m = mergeHeard({ stream: streamText, final: sec?.text ?? null, names, botName: this.cfg.botName });
    const text = m.text;
    const base = { uuid: l.uuid, name: l.name, dist_start: rec.dist_start ?? null, dist_end: rec.dist_end ?? l.dist, first_audio_in_ms: rec.first_audio_in_ms ?? null, start_ms: rec.start_ms ?? null, end_ms: rec.end_ms ?? null,
      server_start_ms: rec.server_start_ms ?? null, server_end_ms: rec.server_end_ms ?? null, final_ms: r.final_ms, partials: rec.partials ?? [], endpoint_ms: r.endpoint_ms, stt_ms: r.stt_ms, voiced_ms: r.voiced_ms,
      stt_kind: r.kind, overlap_utt_id: rec.overlap_utt_id ?? null, barge: rec.barge ?? null,
      // both decoders, raw and final (AU1 rows had text only): text = corrected best text, text_final = Parakeet raw, text_stream = streaming raw
      text_stream: m.text_stream, text_final: m.text_final, second_pass: m.second_pass, stt2_ms: r.stt2_ms, stt2_error: r.second && !r.second.ok ? r.second.error : undefined, stt2_device: sec?.device, pcm_ms: r.pcm_ms,
      alternatives: m.alternatives, confidence: m.confidence, uncertain_words: m.uncertain_words, uncertain: m.uncertain, corrected: m.corrected, changes: m.changes };
    const inRange = l.inRange !== false;
    if (r.voiced_ms < this.cfg.minVoicedMs || !/[a-z]/i.test(text)) {
      this.log('utt_discarded', { uuid: l.uuid, voiced_ms: r.voiced_ms, text });
      this.archive.heard({ id: null, ...base, in_range: inRange, text, addressed: false, addressed_why: 'discarded', discarded: true }); return;
    }
    const addressed = inRange && this._addressed(l, text);
    if (addressed) this.convoAt.set(l.uuid, Date.now());
    if (!inRange) {      // out of her hearing range: transcribed and logged for the video (text only), never perceived by her
      this.log('heard_out_of_range', { uuid: l.uuid, name: l.name, dist: l.dist, text });
      this.archive.heard({ id: null, ...base, in_range: false, text, addressed: false, addressed_why: 'out_of_range', discarded: false }); return;
    }
    const ev = { id: this.nextHeard++, uuid: l.uuid, name: l.name, dist: l.dist, text, addressed, addressed_why: this._addressedWhy(l, text), ts: Date.now(),
      text_stream: m.text_stream, alternatives: m.alternatives, confidence: m.confidence, uncertain_words: m.uncertain_words, corrected: m.corrected };
    this.lastLatency = { ...this.lastLatency, endpoint_ms: r.endpoint_ms, stt_ms: r.stt_ms, stt2_ms: r.stt2_ms ?? null };
    this.heard.push(ev); if (this.heard.length > 500) this.heard.shift();
    this.log('heard', { ...ev, endpoint_ms: r.endpoint_ms, stt_ms: r.stt_ms, stt2_ms: r.stt2_ms, voiced_ms: r.voiced_ms });
    if (addressed) { this.famN = this.famN || new Map(); const n = (this.famN.get(l.name) || 0) + 1; this.famN.set(l.name, n); this.fam.set(l.name, Math.max(this._famOf(l.name), Math.min(1, Math.log1p(n) / Math.log(40)))); }   // same curve as people.js
    // a finished addressed turn that was still overlapping her speech: score it once more with the corrected final text
    let barge = base.barge;
    if (addressed && this.speaker.cur) {
      const cu = this.speaker.cur, out = this._evalOverlap(l, text, { final: true, voicedMs: r.voiced_ms });
      if (out?.st.changed) barge = { utt_id: cu.id, option: out.st.action };
    }
    this.archive.heard({ id: ev.id, ...base, in_range: true, barge, text, addressed, addressed_why: this._addressedWhy(l, text), discarded: false });
    this.waiters.splice(0).forEach((w) => w());
  }

  // ---------------------------------------------------------------- API used by http.js
  async heardSince(since = 0, waitS = 0) {
    const get = () => this.heard.filter((h) => h.id > since);
    if (get().length || waitS <= 0) return get();
    await new Promise((res) => { const to = setTimeout(res, waitS * 1000); this.waiters.push(() => { clearTimeout(to); res(); }); });
    return get();
  }
  status() {
    const s = this.speaker;
    return { connected_mod: this.connected, mod_hello: this.helloSeen ? { version: this.helloSeen.version, bot: this.helloSeen.bot } : null, bot_online: this.botOnline,
      near: this.near, speaking: s.speaking, speaking_utt: s.cur?.id ?? null, queue_ms: s.queueMs, queue_len: s.queue.length, unspoken: s.unspoken, held: this.held ? { utt_id: this.held.id, text: this.held.body.text, why: this.held.why, age_ms: Date.now() - this.held.at } : null, held_stats: this.heldStats,
      last_latency_ms: { ...this.lastLatency, tts_first_ms: s.lastLatency?.tts_first_ms ?? null }, listeners: [...this.listeners.values()].map((l) => ({ uuid: l.uuid, name: l.name, dist: l.dist, in_utt: l.inUtt, silence_ms: l.inUtt ? Math.round(l.effectiveSilenceMs()) : 0 })),
      heard_last_id: this.nextHeard - 1, pass2: !!this.second, turn_decisions: this.turnN };
  }
  speak(body) {
    // VAL2: an acknowledgement filler is only worth saying right now: never held for later, never over a human or over her own speech
    if (body.kind === 'ack') {
      if (this._talking().length || this.speaker.cur || this.speaker.queue.length || !/[a-z0-9]/i.test(body.text || '')) { this.archive.dropped({ id: 'ack-' + Date.now(), text: body.text, priority: 'normal', enqWall: Date.now() }, 'ack_suppressed'); this.log('ack_suppressed', { text: body.text }); return 'suppressed'; }
    }
    if (this.held) this.dropHeld('replaced');                       // S2 said something newer
    const meta = speakMeta({ kind: body.kind, importance: body.importance, priority: body.priority === 'urgent' ? 'urgent' : 'normal', inReplyTo: body.in_reply_to ?? null });
    const talkers = this._talking();
    if (talkers.length && body.priority !== 'urgent' && meta.kind !== 'warning' && meta.importance < TURN_CFG.warningImportance && !this.speaker.cur && !this.speaker.queue.length && /[a-z0-9]/i.test(body.text || '')) {
      // a human is mid-utterance and she has not said a word: hold the line for the next turn gap instead of starting into his speech
      const id = 'u' + (this.speaker.nextId++);
      for (const l of talkers) this._noteYield(l.uuid);
      this.lastBotSpeakAt = Date.now();
      this._hold({ ...body, kind: meta.kind, importance: meta.importance }, id, 'human_speaking');
      return id;
    }
    this.lastBotSpeakAt = Date.now(); { const h = body.in_reply_to != null ? this.heard.find((x) => x.id === body.in_reply_to) : null; if (h) this.convoAt.set(h.uuid, Date.now()); }
    const id = this.speaker.enqueue({ text: body.text, priority: body.priority === 'urgent' ? 'urgent' : 'normal', inReplyTo: body.in_reply_to ?? null, kind: body.kind, importance: body.importance });
    return id;
  }
}
