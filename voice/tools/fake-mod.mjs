// FAKE Fabric voice mod: a WebSocket SERVER on ws://127.0.0.1:19520 that speaks the fixed protocol.
//  - sends hello, then players{} every 500 ms (bot + the fake speaker at --dist)
//  - replays WAV files as audio_in (16 kHz resampled, 20 ms frames, 5 per message, real time) with --at offsets
//  - logs every audio_out (utt_id, seq, samples, ordering) and simulates the mod's playout clock + played{} events + flush
// CLI:  node tools/fake-mod.mjs --wav a.wav [--wav b.wav ...] [--name Steve --uuid u1 --dist 3] [--port 19520] [--repeat-after 20] [--out summary.json] [--silence-ms 1500]
import fs from 'node:fs';
import { wsServer } from './ws-min-server.mjs';
import { readWav, resample, f32ToS16 } from '../src/audio.js';

export class FakeMod {
  constructor({ port = 19520, bot = { x: 0, y: 64, z: 0, uuid: 'bot-uuid' }, speakers = [], realtime = 1, log = () => {} } = {}) {
    this.port = port; this.bot = bot; this.speakers = speakers; this.log = log; this.rt = realtime;
    this.conn = null; this.out = new Map(); this.events = []; this.playTimer = null; this.t0 = Date.now(); this.flushes = []; this.errors = [];
    this.speakDistance = null;
  }
  async start() {
    this.srv = await wsServer({ port: this.port, onConnection: (c) => this._onConn(c) }); return this;
  }
  stop() { clearInterval(this.pl); clearInterval(this.pt); this.conn?.close(); this.srv?.close(); }
  _ev(type, d = {}) { const e = { t: Date.now() - this.t0, type, ...d }; this.events.push(e); this.log(e); }
  _onConn(c) {
    this.conn = c; this._ev('service_connected');
    c.send(JSON.stringify({ type: 'hello', version: 1, bot: this.bot ? 'Wren' : null, botOnline: !!this.bot }));
    clearInterval(this.pt);
    this.pt = setInterval(() => c.send(JSON.stringify({ type: 'players', t: Date.now(), bot: this.bot, near: this.speakers.map((s) => ({ uuid: s.uuid, name: s.name, dist: s.dist, x: s.dist, y: 64, z: 0 })) })), 500);
    c.on('message', (t) => this._fromService(t));
    c.on('close', () => { this._ev('service_disconnected'); clearInterval(this.pt); });
    clearInterval(this.pl); this.pl = setInterval(() => this._playTick(), 250);
  }
  _fromService(t) {
    let m; try { m = JSON.parse(t); } catch { this.errors.push('bad json'); return; }
    if (m.type === 'audio_out') {
      const n = Buffer.from(m.pcm48k, 'base64').length / 2;
      let u = this.out.get(m.utt_id); if (!u) { u = { id: m.utt_id, chunks: 0, samples: 0, seqs: [], startAt: Date.now(), lastAt: Date.now(), played: 0, buffered: 0, done: false, flushed: false, playedMs() { return Math.min(this.samples / 48, Date.now() - this.startAt); } }; this.out.set(m.utt_id, u); this._ev('first_audio_out', { utt_id: m.utt_id }); }
      { const gap = Date.now() - u.startAt - u.samples / 48; if (u.chunks > 0 && gap > 0) u.startAt += gap; }   // underrun: the clock paused
      if (n % 960) this.errors.push(`audio_out not multiple of 960: ${n}`);
      if (m.seq !== u.seqs.length) this.errors.push(`seq gap in ${m.utt_id}: got ${m.seq} expected ${u.seqs.length}`);
      u.seqs.push(m.seq); u.chunks++; u.samples += n; u.buffered += n; u.lastAt = Date.now();
      const ahead = (u.samples / 48 - u.playedMs()) ; if (ahead > 2100) this.errors.push(`sent more than 2 s ahead (${Math.round(ahead)} ms)`);
    } else if (m.type === 'flush') {
      for (const u of this.out.values()) if ((m.utt_id === '*' || m.utt_id === u.id) && !u.done) { u.flushed = true; u.done = true; this.flushes.push({ utt_id: u.id, at: Date.now() - this.t0, playedMs: Math.round(u.playedMs()) }); this.conn.send(JSON.stringify({ type: 'played', utt_id: u.id, ms_played: Math.round(u.playedMs()), done: true })); }
    } else if (m.type === 'speak_distance') this.speakDistance = m.d;
  }
  _playTick() {   // simulated playout clock: audio plays at 1x from the first chunk of the utterance; report progress
    for (const u of this.out.values()) {
      if (u.done) continue;
      const ms = u.playedMs(), total = u.samples / 48;
      if (ms >= total - 1 && Date.now() - u.lastAt > 300) { u.done = true; this.conn?.send(JSON.stringify({ type: 'played', utt_id: u.id, ms_played: Math.round(total), done: true })); this._ev('utt_played', { utt_id: u.id, ms: Math.round(total) }); }
      else this.conn?.send(JSON.stringify({ type: 'played', utt_id: u.id, ms_played: Math.round(ms), done: false }));
    }
  }
  // Replay a WAV as audio_in from one player. Returns when done (after trailing silence + audio_end).
  async replay(wavPath, { uuid = 'u1', name = 'Steve', dist = 3, silenceMs = 1500, sendEnd = true, seqStart = 0 } = {}) {
    while (!this.conn) await new Promise((r) => setTimeout(r, 50));
    const w = readWav(wavPath); const x = resample(w.samples, w.rate, 16000);
    const pcm = f32ToS16(x); const frameB = 640; let seq = seqStart;
    const t0 = Date.now(); this._ev('replay_start', { uuid, wav: wavPath, ms: Math.round(x.length / 16) });
    const total = pcm.length + Math.round(silenceMs / 20) * frameB, sil = Buffer.alloc(frameB * 5);
    for (let i = 0, n = 0; i < total; i += frameB * 5, n++) {
      const chunk = i < pcm.length ? Buffer.concat([pcm.subarray(i, Math.min(pcm.length, i + frameB * 5)), Buffer.alloc(Math.max(0, i + frameB * 5 - pcm.length))]) : sil;
      this.conn.send(JSON.stringify({ type: 'audio_in', uuid, name, dist, seq: seq++, t: Date.now(), pcm16k: chunk.toString('base64') }));
      const wait = (n + 1) * 100 / this.rt - (Date.now() - t0); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    this.lastReplayEnd = Date.now();
    if (sendEnd) this.conn.send(JSON.stringify({ type: 'audio_end', uuid, name }));
    this._ev('replay_end', { uuid });
  }
  summary() {
    return { utterances: [...this.out.values()].map((u) => ({ utt_id: u.id, chunks: u.chunks, samples: u.samples, ms: Math.round(u.samples / 48), mult960: u.samples % 960 === 0, inOrder: u.seqs.every((s, i) => s === i), flushed: u.flushed })), flushes: this.flushes, errors: this.errors, speakDistance: this.speakDistance };
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const wavs = a.reduce((o, v, i) => (v === '--wav' ? [...o, a[i + 1]] : o), []);
  const sp = { uuid: get('--uuid', 'u1'), name: get('--name', 'Steve'), dist: Number(get('--dist', 3)) };
  const mod = await new FakeMod({ port: Number(get('--port', 19520)), speakers: [sp], log: (e) => console.log(JSON.stringify(e)) }).start();
  console.log('fake mod listening on', get('--port', 19520));
  (async () => { for (;;) { for (const w of wavs) { await mod.replay(w, { ...sp, silenceMs: Number(get('--silence-ms', 1500)) }); await new Promise((r) => setTimeout(r, 4000)); } if (!get('--repeat-after')) break; await new Promise((r) => setTimeout(r, Number(get('--repeat-after')) * 1000)); } })();
  const done = () => { if (get('--out')) fs.writeFileSync(get('--out'), JSON.stringify(mod.summary(), null, 1)); process.exit(0); };
  process.on('SIGINT', done); process.on('SIGTERM', done);
}
