// R2: conversation / thoughts / goals / deaths / chat model built from the voice run archive (voice/archive/<run>/),
// bot/logs/{thoughts,chat,mindlink}.jsonl and the mind DB goal snapshot. Pure and deterministic; every loader tolerates missing files.
import fs from 'node:fs'
import path from 'node:path'
import { readJsonl, readJson, mindEpoch } from './data.mjs'

export const IN_RANGE_BLOCKS = 16
const isoMs = (v) => (Number.isFinite(v) ? v : Date.parse(v ?? '') || null)
const clipText = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** newest run dir under voice/archive that has an utterances/heard/thoughts file (the "synth" folder never counts). */
export function findRun(archiveRoot, runId = null) {
  let names = []
  try { names = fs.readdirSync(archiveRoot) } catch { return null }
  const cands = names.filter((n) => n !== 'synth' && (!runId || n === runId)).map((n) => path.join(archiveRoot, n))
    .filter((d) => { try { return fs.statSync(d).isDirectory() && ['utterances.jsonl', 'heard.jsonl', 'thoughts.jsonl'].some((f) => fs.existsSync(path.join(d, f))) } catch { return false } })
  if (!cands.length) return null
  const stamp = (d) => { const m = readJson(path.join(d, 'MANIFEST.json')); return m?.created_ms ?? fs.statSync(d).mtimeMs }
  cands.sort((a, b) => stamp(a) - stamp(b))
  return cands.at(-1)
}

export function loadVoice({ root, archiveRoot, runId = null, logsDir } = {}) {
  const ar = archiveRoot ?? path.join(root, 'voice', 'archive')
  const ld = logsDir ?? path.join(root, 'bot', 'logs')
  const runDir = findRun(ar, runId)
  const rd = (f) => (runDir ? readJsonl(path.join(runDir, f)) : [])
  const files = []
  if (runDir) for (const f of ['MANIFEST.json', 'utterances.jsonl', 'heard.jsonl', 'turn_decisions.jsonl', 'thoughts.jsonl', 'chat.jsonl']) {
    try { const st = fs.statSync(path.join(runDir, f)); files.push({ name: f, bytes: st.size, path: path.join(runDir, f) }) } catch { /* absent */ }
  }
  const ml = readJsonl(path.join(ld, 'mindlink.jsonl')).map((r) => ({ ...r, ms: isoMs(r.t) })).filter((r) => r.ms)
  // thoughts: full bot log plus the run copy, deduped by thought_id
  const th = new Map()
  for (const r of [...readJsonl(path.join(ld, 'thoughts.jsonl')), ...rd('thoughts.jsonl')]) if (r.text && (r.ts_ms || r.ts_iso)) { r.ts_ms = r.ts_ms ?? isoMs(r.ts_iso); th.set(r.thought_id ?? `${r.ts_ms}:${r.text.slice(0, 20)}`, r) }
  return {
    runId: runDir ? path.basename(runDir) : null, runDir, files,
    utterances: rd('utterances.jsonl'), heard: rd('heard.jsonl'), decisions: rd('turn_decisions.jsonl'),
    thoughts: [...th.values()].sort((a, b) => a.ts_ms - b.ts_ms),
    chatRaw: [...readJsonl(path.join(ld, 'chat.jsonl')), ...rd('chat.jsonl')],
    mindlink: ml,
  }
}

const inWin = (ms, from, to) => Number.isFinite(ms) && (from == null || ms >= from) && (to == null || ms < to)

/** Chronological interleaving of what she heard and what she said (voice and chat), with latency and interruption markers. */
export function buildConversation(V, { from = null, to = null } = {}) {
  const items = []
  const decBy = new Map()
  for (const d of V.decisions ?? []) { const k = `${d.session}|${d.utt_id}`; (decBy.get(k) ?? decBy.set(k, []).get(k)).push(d) }
  for (const h of V.heard ?? []) {
    if (h.discarded || !h.text || !inWin(h.start_ms, from, to)) continue
    const dist = h.dist_start ?? h.dist_end ?? null
    const inRange = h.in_range ?? (dist == null ? null : dist <= IN_RANGE_BLOCKS)
    const mk = []
    if (h.barge) mk.push(`cut her off (${h.barge.option ?? 'barge'})`)
    else if (h.overlap_utt_id) mk.push('spoke over her')
    if (inRange === false) mk.push('out of earshot')
    if (!h.addressed) mk.push('not addressed to her')
    items.push({ ms: h.start_ms, kind: 'heard', via: 'voice', who: h.name ?? '?', text: clipText(h.text), dist, in_range: inRange, addressed: !!h.addressed, why: h.addressed_why ?? null, key: `${h.session}|${h.id}`, markers: mk, uncertain: h.uncertain_words ?? [] })
  }
  for (const u of V.utterances ?? []) {
    if (u.dropped) { if (inWin(u.queued_ms, from, to)) items.push({ ms: u.queued_ms, kind: 'said', via: 'voice', who: 'Wren', text: clipText(u.text), markers: [`dropped (${u.why ?? 'unspoken'})`], latency_ms: null }); continue }
    const ms = u.start_ms ?? u.queued_ms
    if (!u.text || !inWin(ms, from, to)) continue
    const mk = []
    if (u.cut) mk.push(`interrupted${u.cut_why ? ' (' + u.cut_why + ')' : ''}${u.cut_by?.name ? ' by ' + u.cut_by.name : ''}, ${Math.round((u.played_ms_at_cut ?? u.played_ms ?? 0) / 100) / 10} s of ${Math.round((u.duration_ms ?? 0) / 100) / 10} s played`)
    const ds = decBy.get(`${u.session}|${u.utt_id}`) ?? []
    if (ds.some((d) => d.held)) mk.push('held line (kept talking until the sentence ended)')
    const ans = u.answered
    items.push({ ms, kind: 'said', via: 'voice', who: 'Wren', text: clipText(u.text), reply_to: ans?.name ?? null, reply_to_text: ans ? clipText(ans.text, 120) : null, latency_ms: ans?.end_ms ? Math.max(0, ms - ans.end_ms) : null, markers: mk, utt_id: u.utt_id, kindTag: u.kind ?? null })
  }
  // chat: bot chat.jsonl / run chat.jsonl (dir in|out) plus mindlink chat_out and typed human speech; dedupe by direction+text within 4 s
  const chat = []
  for (const c of V.chatRaw ?? []) { const ms = c.ms ?? isoMs(c.ts); if (ms && c.text) chat.push({ ms, dir: c.dir === 'in' ? 'in' : 'out', name: c.name ?? (c.dir === 'in' ? '?' : 'Wren'), text: clipText(c.text) }) }
  for (const r of V.mindlink ?? []) {
    if (r.ev === 'chat_out') for (const l of r.lines ?? []) chat.push({ ms: r.ms, dir: 'out', name: 'Wren', text: clipText(l) })
    else if (r.ev === 'human_speech' && r.via && r.via !== 'voice' && r.from && r.from !== 'Server' && r.text) chat.push({ ms: r.ms, dir: 'in', name: r.from, text: clipText(r.text) })
  }
  chat.sort((a, b) => a.ms - b.ms)
  const chatLog = []
  for (const c of chat) if (!chatLog.some((x) => x.dir === c.dir && x.text === c.text && Math.abs(x.ms - c.ms) < 4000)) chatLog.push(c)
  for (const c of chatLog) if (inWin(c.ms, from, to)) items.push({ ms: c.ms, kind: c.dir === 'in' ? 'heard' : 'said', via: 'chat', who: c.name, text: c.text, markers: [], addressed: true })
  items.sort((a, b) => a.ms - b.ms || (a.kind === 'heard' ? -1 : 1))
  const said = items.filter((i) => i.kind === 'said' && i.via === 'voice')
  const lat = said.map((i) => i.latency_ms).filter(Number.isFinite).sort((a, b) => a - b)
  return {
    items, chat: chatLog.filter((c) => inWin(c.ms, from, to)),
    stats: { heard: items.filter((i) => i.kind === 'heard' && i.via === 'voice').length, addressed: items.filter((i) => i.kind === 'heard' && i.via === 'voice' && i.addressed).length, said: said.length, chatIn: items.filter((i) => i.via === 'chat' && i.kind === 'heard').length, chatOut: items.filter((i) => i.via === 'chat' && i.kind === 'said').length,
      interrupted: said.filter((i) => i.markers.some((m) => m.startsWith('interrupted'))).length, held: said.filter((i) => i.markers.some((m) => m.startsWith('held'))).length, latencyMedianMs: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null, latencyMaxMs: lat.length ? lat.at(-1) : null },
  }
}

const KEYWORDS = /\b(die[ds]?|dead|death|lava|creeper|skeleton|zombie|help|friend|home|bed|afraid|scared|lonely|alone|thank|sorry|hungry|starv\w*|promise|plan|goal|learn\w*|wonder\w*|beautiful|love|glad|happy|frighten\w*|careful|never again)\b/gi
/** Importance of a thought: the logged value when present, else a deterministic heuristic (kind, people near, keywords, mood intensity). 0..1 */
export function thoughtScore(t) {
  if (Number.isFinite(t.importance)) return t.importance
  let s = 0.25
  if (t.kind === 'mutter') s += 0.1
  if (t.kind === 'demoted_say') s -= 0.05
  if (t.human_near) s += 0.15
  s += Math.min(0.3, 0.08 * ((t.text ?? '').match(KEYWORDS) ?? []).length)
  if (t.mood && Number.isFinite(t.mood.p)) s += 0.1 * Math.min(1, Math.hypot(t.mood.p, t.mood.a ?? 0) / 1.2)
  const len = (t.text ?? '').length
  if (len > 60 && len < 400) s += 0.05
  return Math.min(1, Math.max(0, +s.toFixed(3)))
}
export function topThoughts(V, k, { from = null, to = null } = {}) {
  return (V.thoughts ?? []).filter((t) => inWin(t.ts_ms, from, to)).map((t) => ({ t, s: thoughtScore(t) }))
    .sort((a, b) => b.s - a.s || a.t.ts_ms - b.t.ts_ms).slice(0, k).sort((a, b) => a.t.ts_ms - b.t.ts_ms).map((x) => x.t)
}

/** Long-term goals (mind snapshot), objectives (mindlink goal_start/goal_end) and a change log. Commitments are not stored by the mind, so none are reported. */
export function buildGoals(V, mind, { from = null, to = null } = {}) {
  const snap = mind?.goals?.goals ?? []
  const longTerm = snap.map((g) => ({ ...g, created_ms: mindEpoch(g.created_ms) ?? g.created_ms, ended_ms: g.ended_ms }))
  const objs = new Map(), order = []
  for (const r of V.mindlink ?? []) {
    if (r.ev === 'goal_start') { objs.set(r.id, { id: r.id, type: r.spec?.type ?? '?', target: r.spec?.target ?? null, text: clipText(r.spec?.text ?? '', 240), start_ms: r.ms, end_ms: null, status: 'active', reason: null, summary: null }); order.push(r.id) }
    else if (r.ev === 'goal_end') { const o = objs.get(r.id); if (o) { o.end_ms = r.ms; o.status = r.status ?? 'ended'; o.reason = r.reason ?? null; o.summary = clipText(r.summary ?? '', 200) } else { objs.set(r.id, { id: r.id, type: '?', target: null, text: '', start_ms: null, end_ms: r.ms, status: r.status ?? 'ended', reason: r.reason ?? null, summary: clipText(r.summary ?? '', 200) }); order.push(r.id) } }
  }
  const objectives = order.map((i) => objs.get(i)).filter((o) => inWin(o.start_ms ?? o.end_ms, from, to))
  const changes = []
  for (const g of longTerm) {
    if (inWin(g.created_ms, from, to)) changes.push({ ms: g.created_ms, kind: 'goal_new', id: g.id, text: g.text })
    if (g.ended_ms && inWin(g.ended_ms, from, to)) changes.push({ ms: g.ended_ms, kind: 'goal_' + g.status, id: g.id, text: g.text, reason: g.reason })
  }
  for (const o of objectives) {
    if (o.start_ms) changes.push({ ms: o.start_ms, kind: 'objective_start', id: o.id, text: `${o.type}${o.target ? ' ' + o.target : ''}` })
    if (o.end_ms) changes.push({ ms: o.end_ms, kind: 'objective_' + o.status, id: o.id, text: `${o.type}${o.target ? ' ' + o.target : ''}`, reason: o.reason })
  }
  changes.sort((a, b) => a.ms - b.ms)
  const objCounts = {}; for (const o of objectives) objCounts[o.status] = (objCounts[o.status] ?? 0) + 1
  return { longTerm, objectives, changes, objCounts, historyNote: 'The goal store keeps only created/ended time and current status per goal (no per-change history); status changes are read from those two timestamps and from the mindlink goal_start/goal_end log. The mind stores no separate commitments.' }
}

/** Deaths merged from the trace (time, position) and the mindlink log (cause, extent, activity), with the mind lesson and the first thoughts afterwards. */
export function buildDeaths(V, traceEvents, mind, { from = null, to = null } = {}) {
  const out = []
  const mdeaths = (V.mindlink ?? []).filter((r) => r.ev === 'death')
  for (const d of traceEvents.filter((e) => e.type === 'death')) out.push({ ms: d.ts, pos: d.pos ?? null, cause: null, extent: null, activity: null })
  for (const m of mdeaths) {
    const hit = out.find((o) => Math.abs(o.ms - m.ms) < 8000)
    if (hit) Object.assign(hit, { cause: m.cause ?? null, extent: m.extent ?? null, activity: m.activity ?? null, pos: hit.pos ?? (m.at ? [m.at.x, m.at.y, m.at.z] : null) })
    else out.push({ ms: m.ms, pos: m.at ? [m.at.x, m.at.y, m.at.z] : null, cause: m.cause ?? null, extent: m.extent ?? null, activity: m.activity ?? null })
  }
  out.sort((a, b) => a.ms - b.ms)
  const lessons = (mind?.lessons ?? []).filter((l) => l.result === 'death')
  const causeCount = {}
  for (const d of out) {
    if (d.cause) causeCount[d.cause] = (causeCount[d.cause] ?? 0) + 1
    d.lesson = lessons.find((l) => d.cause && l.cause === d.cause && (!d.pos || l.x == null || Math.hypot(l.x - d.pos[0], (l.z ?? 0) - d.pos[2]) < 40)) ?? null
    d.after = (V.thoughts ?? []).filter((t) => t.ts_ms >= d.ms && t.ts_ms < d.ms + 120000 && t.kind !== 'demoted_say').slice(0, 2).map((t) => clipText(t.text, 220))
  }
  const win = out.filter((d) => inWin(d.ms, from, to))
  return { deaths: win, causeCount, repeats: Object.entries(causeCount).filter(([, n]) => n > 1) }
}
