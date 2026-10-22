// Run archive: TEXT AND METADATA ONLY (no audio is ever stored). Per run: utterances.jsonl (what she said), heard.jsonl (what she heard), MANIFEST.json.
// Dir: <root>/<run-id>/ ; run-id from WREN_RUN_ID (default 'dev'). Files are append-only; nothing existing is overwritten.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const safeId = (s) => String(s || 'dev').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'dev';
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function loadModelInfo(file = process.env.VOICE_TTS_MODEL_JSON || path.join(here, '..', 'box', 'MODEL.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { engine: 'kokoro', model: 'hexgrad/Kokoro-82M', unknown: true }; }
}
// Deterministic per-sentence seed from (sentence, voice, speed, emotion): regen can recompute it without the archive.
export function seedFor(text, voice, speed, emotion = 'calm') {
  return crypto.createHash('sha256').update(`${text}\u0000${voice}\u0000${speed ?? ''}\u0000${emotion}`).digest().readUInt32LE(0) & 0x7fffffff;
}
const hashFile = (f) => { const h = crypto.createHash('sha256'); const fd = fs.openSync(f, 'r'), b = Buffer.alloc(1 << 20); let n; while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex'); };

export class Archive {
  constructor({ root, runId = process.env.WREN_RUN_ID, log = () => {}, ttsCfg = {}, model = loadModelInfo(), enabled = true, playedWaitMs = 1500 } = {}) {
    this.enabled = enabled; this.log = log; this.ttsCfg = ttsCfg; this.model = model; this.playedWaitMs = playedWaitMs;
    this.runId = safeId(runId); this.dir = path.join(root, this.runId);
    this.counts = { utterances: 0, cut: 0, heard: 0, addressed: 0, dropped: 0 }; this.live = new Map(); this.pending = new Set(); this.serverOffset = null; this.heardIdx = new Map();
    this.session = { started_ms: Date.now(), pid: process.pid, id: crypto.randomBytes(4).toString('hex') };
    this.files = { utt: path.join(this.dir, 'utterances.jsonl'), heard: path.join(this.dir, 'heard.jsonl'), turns: path.join(this.dir, 'turn_decisions.jsonl'), manifest: path.join(this.dir, 'MANIFEST.json') };
  }
  start(extra = {}) {
    if (!this.enabled) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this.session = { ...this.session, ...extra };
    this._manifest({ stopped: false }); this.log('archive_start', { dir: this.dir, run_id: this.runId, size_mb: this.sizeMb() });
  }
  sizeMb() { let t = 0; for (const f of [this.files.utt, this.files.heard, this.files.turns, this.files.manifest]) try { t += fs.statSync(f).size; } catch {} return Math.round(t / 1e4) / 100; }
  _append(file, rec) { if (this.enabled) try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch (e) { this.log('archive_error', { error: String(e) }); } }
  _manifest({ stopped }) {
    let m = { run_id: this.runId, created_ms: this.session.started_ms, sessions: [] };
    try { m = JSON.parse(fs.readFileSync(this.files.manifest, 'utf8')); } catch {}
    m.model = this.model; m.tts = this.ttsCfg; m.note = 'text and metadata only; no audio stored. Regenerate her voice with tools/regen.mjs';
    m.sessions = (m.sessions || []).filter((s) => s.id !== this.session.id);
    const s = { ...this.session, counts: { ...this.counts }, stopped_ms: stopped ? Date.now() : null };
    if (stopped) { s.files = {}; for (const [k, f] of Object.entries(this.files)) if (k !== 'manifest' && fs.existsSync(f)) s.files[path.basename(f)] = { bytes: fs.statSync(f).size, sha256: hashFile(f) }; }
    m.sessions.push(s);
    m.totals = { size_mb: this.sizeMb() };
    const tmp = this.files.manifest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, this.files.manifest);   // manifest is the one file rewritten (merged, sessions kept)
  }
  // server clock: the mod's players{t} and audio_in{t} are epoch ms of the Minecraft server; keep the latest offset (server - local) for estimates
  noteServerTime(serverT) { if (Number.isFinite(serverT)) this.serverOffset = serverT - Date.now(); }
  serverNow(wallMs) { return this.serverOffset === null ? null : Math.round(wallMs + this.serverOffset); }

  // ---------------------------------------------------------------- her utterances
  chunk(u, buf) {                                               // exactly the samples sent as audio_out
    let a = this.live.get(u); if (!a) { a = { start_ms: Date.now(), hash: crypto.createHash('sha256'), bytes: 0, chunks: 0, played: [] }; this.live.set(u, a); }
    a.hash.update(buf); a.bytes += buf.length; a.chunks++; a.last_ms = Date.now();
  }
  played(m) {                                                   // mod 'played' progress for utt_id (string)
    const now = Date.now();
    for (const [u, a] of this.live) if (u.id === String(m.utt_id)) { if (a.first_played_recv_ms === undefined) { a.first_played_recv_ms = now; a.first_played_ms_played = m.ms_played; } a.played_ms = m.ms_played; a.played_done = !!m.done; if (a.waitRes && m.done) a.waitRes(); }
  }
  end(u, { flushed = false, why = null, played_ms = null, cut_by = null, cut = false } = {}) {
    if (!this.enabled) return;
    const a = this.live.get(u) || { start_ms: null, hash: crypto.createHash('sha256'), bytes: 0, chunks: 0 };
    if (a.ended) return; a.ended = true; a.end_ms = Date.now(); this.counts.utterances++; if (flushed || cut) this.counts.cut++;
    const p = new Promise((res) => { a.waitRes = res; if (a.played_done || a.bytes === 0) res(); else setTimeout(res, this.playedWaitMs); }).then(() => {
      const samples = a.bytes / 2, dur = Math.round(samples / 48);
      const t0 = a.first_played_recv_ms !== undefined ? a.first_played_recv_ms - (a.first_played_ms_played || 0) : null;   // wall time at which the first sample started playing (estimate)
      const rec = {
        utt_id: u.id, run_id: this.runId, session: this.session.id, text: u.text, sentences: u.sentences, priority: u.priority, kind: u.kind ?? null, importance: u.importance ?? null, in_reply_to: u.inReplyTo ?? null,
        answered: this.heardIdx.get(u.inReplyTo) ?? null,
        queued_ms: u.enqWall ?? null, start_ms: a.start_ms, end_ms: a.end_ms, duration_ms: dur, samples48k: samples,
        first_played_ms: t0 !== null ? Math.round(t0) : null, first_played_server_ms: t0 !== null ? this.serverNow(t0) : null, start_server_ms: a.start_ms ? this.serverNow(a.start_ms) : null,
        flushed: !!flushed, cut: !!(flushed || cut), cut_why: why, cut_by, played_ms: a.played_ms ?? played_ms, played_ms_at_cut: played_ms,
        tts: { ...this.ttsCfg, seeds: u.sentences.map((s) => seedFor(s, this.ttsCfg.voice, this.ttsCfg.speed, this.ttsCfg.emotion)) },
        audio_sha256: a.bytes ? a.hash.digest('hex') : null,        // hash of the samples sent (audio itself is NOT stored)
      };
      this._append(this.files.utt, rec); this.live.delete(u); this.pending.delete(p);
      this.log('archive_utt', { utt_id: u.id, size_mb: this.sizeMb() });
    });
    this.pending.add(p);
  }
  dropped(u, why) { this.counts.dropped++; this._append(this.files.utt, { utt_id: u.id, run_id: this.runId, session: this.session.id, text: u.text, priority: u.priority, in_reply_to: u.inReplyTo ?? null, queued_ms: u.enqWall ?? null, dropped: true, why }); }

  // ---------------------------------------------------------------- what she heard
  heard(rec) {
    this.counts.heard++; if (rec.addressed) this.counts.addressed++; this.heardIdx.set(rec.id, { id: rec.id, uuid: rec.uuid, name: rec.name, text: rec.text, start_ms: rec.start_ms, end_ms: rec.end_ms });
    if (this.heardIdx.size > 2000) this.heardIdx.delete(this.heardIdx.keys().next().value);
    this._append(this.files.heard, { run_id: this.runId, session: this.session.id, ...rec });
  }
  /** One barge-in scoring decision (every evaluation): full feature vector, components, probabilities, action, her utt_id and played ms. For training a model later. */
  turn(rec) { this.counts.turns = (this.counts.turns || 0) + 1; this._append(this.files.turns, { run_id: this.runId, session: this.session.id, ...rec }); }
  async idle() { await Promise.all([...this.pending]); }
  async stop() { if (!this.enabled) return; await this.idle(); this._manifest({ stopped: true }); this.log('archive_stop', { size_mb: this.sizeMb(), counts: this.counts }); }
}
