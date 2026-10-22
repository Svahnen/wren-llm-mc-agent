// Marker files (and an optional on-demand audio render) for a run, to overlay Wren onto a ReplayMod render.
//   node tools/timeline.mjs <run-dir> --out /abs/outdir [--session <id>] [--t0 <epoch ms|ISO>] [--render] [--render-thoughts] [--thoughts /abs/thoughts.jsonl] [--tts-url ...] [--fps 25]
// Thoughts (AI1, <run-dir>/thoughts.jsonl or --thoughts file) get their own track: thoughts.csv/.json/.edl/-labels.txt (track=thought, label prefix [THOUGHT]); --render-thoughts adds thoughts-timeline.wav (thoughts only).
// Always writes (text/metadata only): wren-lines.csv/.json/.edl/-labels.txt (her lines), heard.csv/.json/.edl/-labels.txt (what she heard: for
// synthesizing his lines at the right times). t0 = zero of the timeline (default: the earliest event). With --render: wren-timeline.wav
// (48 kHz mono s16le, her lines re-synthesized from the text with regen.mjs, placed at their start times, silence between; NOT archived audio).
import fs from 'node:fs'; import path from 'node:path';
import { readIndex, regen, wavFromPcm48, readThoughts, thoughtRec } from './regen.mjs';
const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const tc = (ms, fps) => { const f = Math.round(ms / 1000 * fps), s = Math.floor(f / fps); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % fps].map((n) => String(n).padStart(2, '0')).join(':'); };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export async function timeline(runDir, outDir, { session = null, t0 = null, render = false, renderThoughts = false, thoughtsFile = null, ttsBase, fps = 25 } = {}) {
  const utt = readIndex(runDir, session).filter((r) => !r.dropped).map((r) => ({ ...r, at: r.first_played_ms ?? r.start_ms })).filter((r) => r.at);
  const heard = readJsonl(path.join(runDir, 'heard.jsonl')).filter((r) => (!session || r.session === session) && r.start_ms);
  // AI1 inner thoughts: a SEPARATE track. Duration = deterministic regeneration (samples counted, audio discarded); chars estimate when the TTS is unreachable.
  const th = readThoughts(thoughtsFile || runDir).filter((r) => r.ts_ms && r.text);
  for (const r of th) { try { const g = await regen(thoughtRec(r), { ttsBase }); r.dur_ms = Math.round(g.pcm.length / 96); r.dur_src = 'regen'; } catch { r.dur_ms = Math.round(r.text.length * 65); r.dur_src = 'chars_estimate'; } }
  const all = [...utt.map((r) => r.at), ...heard.map((r) => r.start_ms), ...th.map((r) => r.ts_ms)];
  const T0 = t0 ?? Math.min(...all); fs.mkdirSync(outDir, { recursive: true });
  const w = (n, c) => fs.writeFileSync(path.join(outDir, n), c, { flag: 'wx' });
  const L = utt.map((r) => ({ utt_id: r.utt_id, speaker: 'Wren', start_ms: r.at, end_ms: r.at + (r.cut ? (r.played_ms ?? r.duration_ms) : r.duration_ms), rel_start_s: (r.at - T0) / 1000, server_start_ms: r.first_played_server_ms ?? r.start_server_ms, text: r.text, cut: r.cut, priority: r.priority, in_reply_to: r.in_reply_to }))
    .map((r) => ({ ...r, rel_end_s: (r.end_ms - T0) / 1000 })).sort((a, b) => a.start_ms - b.start_ms);
  const H = heard.map((r) => ({ id: r.id, speaker: r.name, uuid: r.uuid, start_ms: r.start_ms, end_ms: r.end_ms ?? r.start_ms, rel_start_s: (r.start_ms - T0) / 1000, rel_end_s: ((r.end_ms ?? r.start_ms) - T0) / 1000, server_start_ms: r.server_start_ms, server_end_ms: r.server_end_ms, text: r.text, addressed: r.addressed, addressed_why: r.addressed_why, dist_start: r.dist_start, dist_end: r.dist_end, discarded: r.discarded, barge: r.barge, partials: r.partials })).sort((a, b) => a.start_ms - b.start_ms);
  const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => (typeof r[c] === 'string' ? q(r[c]) : r[c] ?? '')).join(','))].join('\n') + '\n';
  const edl = (title, rows, name) => `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n` + rows.map((r, i) => `${String(i + 1).padStart(3, '0')}  AX       A     C        ${tc(0, fps)} ${tc(r.end_ms - r.start_ms, fps)} ${tc(r.rel_start_s * 1000, fps)} ${tc(r.rel_end_s * 1000, fps)}\n* FROM CLIP NAME: ${name(r)}\n* COMMENT: ${(r.text || '').replace(/\n/g, ' ')}\n`).join('\n');
  const labels = (rows, name) => rows.map((r) => `${r.rel_start_s.toFixed(3)}\t${r.rel_end_s.toFixed(3)}\t${name(r)}: ${r.text}`).join('\n') + '\n';
  w('wren-lines.csv', csv(L, ['utt_id', 'speaker', 'rel_start_s', 'rel_end_s', 'start_ms', 'end_ms', 'server_start_ms', 'cut', 'priority', 'in_reply_to', 'text']));
  w('wren-lines.json', JSON.stringify({ t0_ms: T0, fps, lines: L }, null, 1)); w('wren-lines.edl', edl('Wren lines', L, (r) => `wren_${r.utt_id}`)); w('wren-labels.txt', labels(L, () => 'Wren'));
  w('heard.csv', csv(H, ['id', 'speaker', 'uuid', 'rel_start_s', 'rel_end_s', 'start_ms', 'end_ms', 'server_start_ms', 'server_end_ms', 'addressed', 'addressed_why', 'dist_start', 'dist_end', 'discarded', 'text']));
  w('heard.json', JSON.stringify({ t0_ms: T0, fps, heard: H }, null, 1)); w('heard.edl', edl('What Wren heard', H, (r) => `${r.speaker}_${r.id ?? 'x'}`)); w('heard-labels.txt', labels(H, (r) => r.speaker));
  const TH = th.map((r) => ({ track: 'thought', thought_id: r.thought_id, speaker: 'Wren', kind: r.kind, start_ms: r.ts_ms, end_ms: r.ts_ms + r.dur_ms, rel_start_s: (r.ts_ms - T0) / 1000, rel_end_s: (r.ts_ms + r.dur_ms - T0) / 1000, duration_ms: r.dur_ms, duration_src: r.dur_src,
    game_time: r.game_time ?? null, pos: r.pos ? JSON.stringify(r.pos) : '', goal: typeof r.goal === 'object' ? JSON.stringify(r.goal) : r.goal ?? '', mood: typeof r.mood === 'object' ? JSON.stringify(r.mood) : r.mood ?? '', voice: r.tts?.voice, speed: r.tts?.speed ?? '', emotion: r.tts?.emotion, seed: r.tts?.seed, text: r.text })).sort((x, y) => x.start_ms - y.start_ms);
  if (TH.length) {
    w('thoughts.csv', csv(TH, ['track', 'thought_id', 'kind', 'rel_start_s', 'rel_end_s', 'duration_ms', 'duration_src', 'start_ms', 'end_ms', 'game_time', 'pos', 'goal', 'mood', 'voice', 'speed', 'emotion', 'seed', 'text']));
    w('thoughts.json', JSON.stringify({ t0_ms: T0, fps, track: 'thought', thoughts: TH }, null, 1)); w('thoughts.edl', edl('Wren thoughts (private, never spoken aloud)', TH, (r) => `thought_${r.thought_id}`));
    w('thoughts-labels.txt', labels(TH, () => '[THOUGHT] Wren'));
  }
  const res = { t0_ms: T0, wren_lines: L.length, heard: H.length, thoughts: TH.length, out: outDir };
  if (render && L.length) {
    const total = Math.ceil(Math.max(...L.map((r) => r.rel_end_s)) * 48000) + 48000, buf = Buffer.alloc(total * 2); let sha = {};
    for (const r of utt) {
      const g = await regen(r, { ttsBase }); sha[r.utt_id] = g.match;
      const off = Math.round((r.at - T0) / 1000 * 48000) * 2;
      for (let i = 0; i + 1 < g.pcm.length && off + i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(off + i) + g.pcm.readInt16LE(i); buf.writeInt16LE(Math.max(-32768, Math.min(32767, s)), off + i); }
    }
    fs.writeFileSync(path.join(outDir, 'wren-timeline.wav'), wavFromPcm48(buf), { flag: 'wx' }); res.rendered_ms = Math.round(total / 48); res.regen_matches_index = sha;
  }
  if (renderThoughts && TH.length) {          // thought track ALONE in one WAV (generated now, not archived)
    const total = Math.ceil(Math.max(...TH.map((r) => r.rel_end_s)) * 48000) + 48000, buf = Buffer.alloc(total * 2);
    for (const r of th) { const g = await regen(thoughtRec(r), { ttsBase }); const off = Math.round((r.ts_ms - T0) / 1000 * 48000) * 2;
      for (let i = 0; i + 1 < g.pcm.length && off + i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(off + i) + g.pcm.readInt16LE(i); buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), off + i); } }
    fs.writeFileSync(path.join(outDir, 'thoughts-timeline.wav'), wavFromPcm48(buf), { flag: 'wx' }); res.rendered_thoughts_ms = Math.round(total / 48);
  }
  return res;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const out = get('--out'); if (!a[0] || !out || !path.isAbsolute(out)) { console.error('usage: timeline.mjs <run-dir> --out /abs/outdir [--render]'); process.exit(2); }
  let t0 = get('--t0'); if (t0) t0 = /^\d+$/.test(t0) ? Number(t0) : Date.parse(t0);
  console.log(JSON.stringify(await timeline(path.resolve(a[0]), out, { session: get('--session'), t0, render: a.includes('--render'), renderThoughts: a.includes('--render-thoughts'), thoughtsFile: get('--thoughts'), ttsBase: get('--tts-url', process.env.VOICE_TTS_URL || 'http://127.0.0.1:19411'), fps: Number(get('--fps', 25)) })));
}
