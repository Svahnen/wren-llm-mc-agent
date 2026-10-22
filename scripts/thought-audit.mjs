#!/usr/bin/env node
// SURV1: self-report auditor. Scans the last N minutes of Wren's own words (bot/logs/thoughts.jsonl), the mindlink log, the trace and the brain log for
// (a) complaints / bug reports she writes herself (stuck, loop, can't reach, keep failing, confusing, no options, not working, dying, interrupted) and
// (b) objective signals (deaths, hp/food minima, repeat_cap refusals, skill failures by reason, S2 options named in text without an action line).
// Deterministic counting; an OPTIONAL --llm pass asks the local model for a 5-10 line "top suspected bugs" summary (only when the brain queue is empty).
// Output: docs/audit/thought-audit-<date>.md (full detail, appended per run, quotes deduplicated), docs/audit/latest.md (<= 15 lines: only NEW or GROWING issues
// since the last run, from docs/audit/.state.json). Usage: node scripts/thought-audit.mjs [--minutes 15] [--llm] [--logs DIR] [--brain-logs DIR] [--out DIR] [--now ISO]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) }
const MIN = Number(opt('minutes', 15)), LOGS = path.resolve(opt('logs', path.join(ROOT, 'bot/logs'))), BLOGS = path.resolve(opt('brain-logs', path.join(ROOT, 'brain/logs')))
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/audit'))), NOW = opt('now', null) ? new Date(opt('now')) : new Date(), WANT_LLM = !!opt('llm', false)
const sinceIso = new Date(NOW.getTime() - MIN * 60000).toISOString(), nowIso = NOW.toISOString()
const day = nowIso.slice(0, 10)

// ---------------------------------------------------------------- readers
function lines(file, getIso) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const l of txt.split('\n')) {
    if (!l) continue
    const m = /"(?:t|ts_iso|ts)":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/.exec(l.slice(0, 120))   // cheap pre-filter on the first bytes
    if (m && (m[1] < sinceIso || m[1] > nowIso)) continue
    try { const j = JSON.parse(l); const iso = getIso(j); if (iso >= sinceIso && iso <= nowIso) out.push(j) } catch { /* partial line */ }
  }
  return out
}
const thoughts = lines(path.join(LOGS, 'thoughts.jsonl'), (j) => j.ts_iso ?? new Date(j.ts_ms).toISOString())
const mlink = lines(path.join(LOGS, 'mindlink.jsonl'), (j) => j.t)
const traceFiles = (() => { try { return fs.readdirSync(LOGS).filter((f) => /^trace-.*\.jsonl$/.test(f)).map((f) => ({ f, m: fs.statSync(path.join(LOGS, f)).mtimeMs })).filter((x) => x.m >= NOW.getTime() - MIN * 60000 - 60000).map((x) => path.join(LOGS, x.f)) } catch { return [] } })()
const trace = traceFiles.flatMap((f) => lines(f, (j) => j.t))
const brainLog = lines(path.join(BLOGS, `brain-${day}.jsonl`), (j) => j.ts)
const llmLog = (() => { const f = path.join(BLOGS, `llm-${day}.jsonl`); try { if (fs.statSync(f).size > 80e6) return []; } catch { return [] } return lines(f, (j) => j.ts) })()

// ---------------------------------------------------------------- complaint patterns (her own words)
const COMPLAINTS = [
  ['stuck', /\b(stuck|trapped|can'?t move|cannot move|not moving|confined)\b/i],
  ['loop', /\b(loop|going in circles|again and again|over and over|same thing (?:again|over)|keep (?:going|doing|trying|repeating)|repeat(?:ing|ed)? the same)\b/i],
  ['cant_reach', /\b(can'?t reach|cannot reach|unreachable|no path|can'?t get (?:to|there|close)|too far to reach|won'?t let me)\b/i],
  ['keeps_failing', /\b(keep(?:s)? (?:failing|dying)|(?:fail(?:ed|s|ing)?|failure) (?:again|repeatedly|every)|nothing (?:is )?work(?:s|ing)?|failed again)\b/i],
  ['confusing', /\b(confus\w+|don'?t understand|doesn'?t make sense|makes? no sense|weird|strange|odd that|something'?s off|something is off)\b/i],
  ['no_options', /\b(no options|no (?:other )?way|nothing (?:i|else) can do|out of options|no food|nothing to eat|can'?t do anything|no choice)\b/i],
  ['not_working', /\b(not working|doesn'?t work|didn'?t work|isn'?t working|broken|bug|glitch|malfunction)\b/i],
  ['dying', /\b(dying|about to die|going to die|i died|i keep dying|health is 0|basically dead|nearly dead|almost dead|starving)\b/i],
  ['interrupted', /\b(interrupt\w*|cut short|keeps? (?:getting )?(?:cut|interrupted))\b/i],
  ['words_not_actions', /\b(i (?:said|wrote|thought) .{0,40}but (?:nothing|it didn'?t)|nothing happened|my body (?:didn'?t|did not|doesn'?t))\b/i],
]
const ACTION_WORDS = /\b(?:i (?:will|should|need to|must|can|could|have to|'ll)|let me|i'm going to|going to|maybe i|then i)\b[^.]{0,60}\b(?:eat|cook|dig|build|shelter|sleep|flee|run|fight|hunt|go home|go to|walk|stop moving|stay)\b/i

const items = new Map()  // id -> {id,kind,label,count,quotes:[]}
const add = (id, kind, label, quote, n = 1) => { let it = items.get(id); if (!it) items.set(id, it = { id, kind, label, count: 0, quotes: [] }); it.count += n; if (quote) it.quotes.push(String(quote).replace(/\s+/g, ' ').trim().slice(0, 170)) }
const spread = (qs) => { const u = [...new Set(qs)]; if (u.length <= 3) return u; return [u[0], u[Math.floor(u.length / 2)], u[u.length - 1]] }

for (const t of thoughts) {
  if (!['thought', 'mutter', 'demoted_say'].includes(t.kind)) continue
  const hits = COMPLAINTS.filter(([, re]) => re.test(t.text))
  for (const [k] of hits) add('complaint:' + k, 'complaint', `she writes: ${k.replace(/_/g, ' ')}`, t.text)
  if (t.kind === 'demoted_say' && ACTION_WORDS.test(t.text)) add('signal:say_not_action', 'signal', 'an intended action came out as SAY (demoted_say)', t.text)
}
// ---- objective signals
const deaths = mlink.filter((e) => e.ev === 'death')
if (deaths.length) add('signal:deaths', 'signal', 'deaths', deaths.slice(-3).map((d) => `${d.t.slice(11, 19)} ${d.cause ?? d.reason ?? JSON.stringify(d).slice(0, 80)}`).join(' | '), deaths.length)
const deadStates = trace.filter((e) => e.type === 'state' && e.to === 'dead')
if (deadStates.length && !deaths.length) add('signal:deaths', 'signal', 'deaths (trace)', null, deadStates.length)
const hp = trace.filter((e) => e.type === 'health' && Number.isFinite(e.hp))
if (hp.length) { const lo = hp.reduce((a, b) => (b.hp < a.hp ? b : a)), fo = hp.reduce((a, b) => (b.food < a.food ? b : a)); const crit = hp.filter((h) => h.hp <= 6).length
  if (lo.hp <= 6) add('signal:hp_low', 'signal', 'health at or below 6', `min hp ${lo.hp} at ${lo.t.slice(11, 19)}, food ${lo.food}; ${crit} low-health readings`, crit)
  if (fo.food <= 6) add('signal:food_low', 'signal', 'food at or below 6', `min food ${fo.food} at ${fo.t.slice(11, 19)}, hp ${fo.hp}`, hp.filter((h) => h.food <= 6).length) }
for (const e of mlink) if (e.ev === 'blocked_by_mind') add('signal:repeat_cap:' + (e.reason ?? '?'), 'signal', `body refused an intent (${e.reason ?? '?'})`, `${e.goal} ${JSON.stringify(e.desc ?? {}).slice(0, 80)}`)
for (const e of mlink) if (e.ev === 'say_demoted' && !(e.reason === 'nobody_near')) add('signal:say_demoted', 'signal', 'speech demoted to a thought', e.text ?? e.why)
for (const e of mlink) if (e.ev === 'mind_call_failed' || e.ev === 'brain_post_failed') add('signal:' + e.ev, 'signal', e.ev.replace(/_/g, ' '), e.error ?? e.op)
for (const e of trace) if (e.type === 'skill_end' && ['failed', 'rejected'].includes(e.status)) add(`signal:skill_fail:${e.skill}:${e.reason}`, 'signal', `skill ${e.skill} ${e.status}: ${e.reason}`, `${e.t.slice(11, 19)} ${e.skill} ${e.reason} (${e.ms ?? '?'} ms)`)
for (const e of trace) if (e.type === 'skill_reject') add(`signal:skill_reject:${e.skill}:${e.reason}`, 'signal', `skill ${e.skill} rejected: ${e.reason}`, `${e.t.slice(11, 19)} ${e.skill} ${e.reason}`)
for (const e of trace) if (e.type === 'dead_state') add('signal:dead_state:' + e.kind, 'signal', `body stuck detector: ${e.kind}`, `${e.t.slice(11, 19)} ${e.kind} ${e.active_s ?? ''}s`)
for (const e of trace) if (e.type === 'screen') add('signal:screen', 'signal', 'game screen messages', e.text)
// S2 options without an action line
let optNoAct = 0
const hasNoneLog = brainLog.some((x) => x.ev === 'action_none')
for (const r of llmLog) {
  if (!r.text || r.kind === 'blocked') continue
  if (!hasNoneLog && /^\{\s*act\s*:\s*none/.test(r.text) && ACTION_WORDS.test(r.text.slice(r.text.indexOf('---') + 3))) { optNoAct++; add('signal:s2_options_no_action', 'signal', 'S2 named an option in text but its header was {act:none}', r.text.split('---')[1]?.trim()) }
}
for (const e of brainLog) {
  if (e.ev === 'action_none' && ['ambiguous', 'alternatives', 'no_option'].includes(e.why)) add('signal:action_none:' + e.why, 'signal', `S2 named no single option and chose nothing (${e.why}); the body-continues cases are excluded`, e.kinds?.join(', ') ?? null)
  if (e.ev === 'action_inferred') add('signal:action_inferred', 'signal', 'text option mapped to an intent by the parser', `${e.from} -> ${e.to} ${JSON.stringify(e.args ?? '')}`)
  if (e.ev === 'action_reprompt') add('signal:action_reprompt', 'signal', 'S2 re-prompted for an action line', `ok=${e.ok} act=${e.act ?? e.goal ?? ''}`)
  if (e.ev === 'invalid') add('signal:s2_invalid:' + (e.errors ?? []).join('+'), 'signal', `S2 answer invalid: ${(e.errors ?? []).join(', ')}`, e.text)
}

// ---------------------------------------------------------------- state (new / growing)
fs.mkdirSync(OUT, { recursive: true })
const stateFile = path.join(OUT, '.state.json')
let state = { counts: {}, quotes: [], lastRun: null }; try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) } } catch { /* first run */ }
const all = [...items.values()].sort((a, b) => b.count - a.count)
const flagged = []
for (const it of all) {
  const prev = state.counts[it.id] ?? 0
  it.prev = prev
  it.status = prev === 0 ? 'NEW' : it.count >= prev + 2 && it.count >= prev * 1.5 ? 'GROWING' : 'known'
  if (it.status !== 'known') flagged.push(it)
}
// ---------------------------------------------------------------- optional LLM summary
async function llmSummary() {
  const brainUrl = process.env.BRAIN_STATUS_URL || 'http://127.0.0.1:19500/status'
  try {
    const st = await (await fetch(brainUrl, { signal: AbortSignal.timeout(3000) })).json()
    if (st.queue_depth !== 0 || (st.inflight ?? []).some(Boolean)) return null   // the live brain is busy: skip quietly
  } catch { return null }
  let base = process.env.S2_BASE_URL || null
  if (!base) { try { const pid = fs.readFileSync(path.join(ROOT, 'brain/runtime/brain.pid'), 'utf8').trim(); base = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((x) => x.startsWith('S2_BASE_URL='))?.slice(12) } catch { /* ignore */ } }
  if (!base) { try { base = (await import(path.join(ROOT, 'brain/llm.js'))).DEFAULT_BASE_URL } catch { return null } }
  const ev = (flagged.length ? flagged : all).slice(0, 12).map((it) => `- [${it.status}] ${it.label}: ${it.count}x (before: ${it.prev}); e.g. "${(it.quotes[0] ?? '').slice(0, 120)}"`).join('\n')
  const prompt = `You are reviewing automated logs of an AI-controlled Minecraft bot called Wren (a language-model planner "S2" gives goals, a reflex/skill layer "S1" executes them). Below are grouped counts from the last ${MIN} minutes, including quotes of the bot's own thoughts.\n\n${ev}\n\nWrite 5 to 10 short lines: the top suspected software bugs or design problems, most important first. Each line: the issue, its count, one short quote, and your best guess at the cause. No preamble.`
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: process.env.S2_MODEL || 's2-brain', messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0.3, stream: false }) })
    if (!r.ok) return null
    return String((await r.json()).choices?.[0]?.message?.content ?? '').trim().split('\n').filter(Boolean).slice(0, 10).join('\n') || null
  } catch { return null }
}
const llmText = WANT_LLM ? await llmSummary() : null

// ---------------------------------------------------------------- write
const known = new Set(state.quotes)
const hhmm = nowIso.slice(11, 16)
const D = []
D.push(`\n## Run ${nowIso.slice(0, 16)}Z (last ${MIN} min; ${thoughts.length} thoughts, ${mlink.length} mindlink, ${trace.length} trace, ${llmLog.length} S2 calls)`)
if (!all.length) D.push('Nothing to report.')
for (const it of all) {
  D.push(`- **${it.label}**: ${it.count}x [${it.status}${it.prev ? `, was ${it.prev}` : ''}] \`${it.id}\``)
  let shown = 0
  for (const q of spread(it.quotes)) { if (known.has(q)) continue; known.add(q); D.push(`  - "${q}"`); shown++ }
  if (!shown && it.quotes.length) D.push('  - (quotes already listed in an earlier run)')
}
if (llmText) { D.push('\n### Suspected bugs (local model)'); D.push(llmText) }
const detail = path.join(OUT, `thought-audit-${day}.md`)
if (!fs.existsSync(detail)) fs.writeFileSync(detail, `# Wren self-report audit ${day}\n(generated by scripts/thought-audit.mjs; appended per run)\n`)
fs.appendFileSync(detail, D.join('\n') + '\n')

const L = [`# Audit digest ${nowIso.slice(0, 16)}Z (last ${MIN} min, vs ${state.lastRun ? state.lastRun.slice(11, 16) + 'Z' : 'first run'})`]
if (!flagged.length) L.push('No new or growing issues.')
for (const it of flagged.slice(0, llmText ? 6 : 10)) L.push(`- ${it.status} ${it.label}: ${it.count}x${it.prev ? ` (was ${it.prev})` : ''}${it.quotes[0] ? ` e.g. "${it.quotes[0].slice(0, 70)}"` : ''}`)
if (flagged.length > (llmText ? 6 : 10)) L.push(`- ... and ${flagged.length - (llmText ? 6 : 10)} more, see thought-audit-${day}.md`)
if (llmText) for (const l of llmText.split('\n').slice(0, 5)) L.push('> ' + l.slice(0, 140))
fs.writeFileSync(path.join(OUT, 'latest.md'), L.slice(0, 15).join('\n') + '\n')
// new baseline: counts of this window (a window that no longer shows an issue resets it, so it is NEW again when it returns)
fs.writeFileSync(stateFile, JSON.stringify({ lastRun: nowIso, counts: Object.fromEntries(all.map((i) => [i.id, i.count])), quotes: [...known].slice(-400) }))
console.log(`audit ${hhmm}Z: ${all.length} groups, ${flagged.length} new/growing -> ${path.join(OUT, 'latest.md')}`)
