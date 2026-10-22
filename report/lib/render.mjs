// HTML rendering of the analysis model: one self-contained page, inline CSS + SVG, no scripts, no external requests.
import { esc, fmt, fmtDur, ymdhm, hm, ymd, categoryOf, CATEGORIES, humanize, sum, topEntries, mdToHtml } from './util.mjs'
import { skillRows } from './analyze.mjs'
import { CSS_CONVO, conversationSection, thoughtsSection, goalsSection, chatSection, deathsSection, archiveSection } from './render-convo.mjs'

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#5d6878;--line:#d9dee6;--acc:#2f6fb0;--heat:#d9480f;--ok:#2b8a3e;--bad:#c92a2a;--warn:#b07d1a;--death:#c92a2a;--home:#1c7ed6;
--c-movement:#2f6fb0;--c-gathering:#3b8f4f;--c-making:#b07d2a;--c-survival:#c4503f;--c-social:#8a5ab5;--c-idle:#8793a1;--c-other:#4f969c;--c-recovery:#d4a017}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#12161c;--card:#1b2129;--fg:#e4e8ee;--mut:#9aa5b3;--line:#2d3642;--acc:#6aa6e6;--heat:#ff8c4a;--ok:#69c07c;--bad:#ff7b72;--warn:#e0b055;--death:#ff7b72;--home:#74c0fc;
--c-movement:#6aa6e6;--c-gathering:#6cc080;--c-making:#e0b055;--c-survival:#f08a78;--c-social:#b790e0;--c-idle:#9aa5b1;--c-other:#7fc3ca;--c-recovery:#f1c453}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 10px}h3{font-size:1rem;margin:14px 0 6px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
.sub,.mut{color:var(--mut)}.sub{margin:0 0 12px;font-size:.9rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.card b{display:block;font-size:1.25rem;line-height:1.2}.card span{color:var(--mut);font-size:.8rem}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:.78rem;border:1px solid currentColor}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
svg{width:100%;height:auto;display:block}svg text{fill:var(--mut);font:10px system-ui,sans-serif}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.8rem;color:var(--mut);margin:6px 0 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.bar{display:flex;align-items:center;gap:8px;margin:3px 0;font-size:.85rem}.bar .l{width:38%;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar .t{flex:1;background:var(--line);border-radius:3px;height:10px}.bar .t i{display:block;height:10px;border-radius:3px;background:var(--acc)}.bar .v{width:64px;text-align:right;font-variant-numeric:tabular-nums}
.feed{max-height:340px;overflow:auto;font-size:.85rem}.feed div{padding:2px 0;border-bottom:1px solid var(--line)}
blockquote{margin:6px 0;padding:6px 10px;border-left:3px solid var(--acc);background:var(--bg);white-space:pre-wrap;word-break:break-word}
.md h1,.md h2,.md h3{margin:12px 0 4px}.md p{margin:4px 0}.md ul{margin:4px 0;padding-left:20px}
details summary{cursor:pointer;color:var(--acc)}footer{color:var(--mut);font-size:.8rem;margin:20px 0}
nav{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:.85rem;margin:8px 0}nav a{color:var(--acc)}
${CSS_CONVO}`

const catVar = (c) => `var(--c-${c})`
const card = (v, l) => `<div class="card"><b>${esc(v)}</b><span>${esc(l)}</span></div>`
const table = (head, rows, numCols = []) => `<div class="tw"><table><thead><tr>${head.map((h, i) => `<th${numCols.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numCols.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
const empty = (t) => `<p class="mut">${esc(t)}</p>`
const sec = (id, title, body, sub = '') => `<section id="${id}"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}${body}</section>`
const bars = (obj, n = 12, fmtv = (v) => v) => {
  const rows = topEntries(obj, n); const max = Math.max(1, ...rows.map((r) => r[1]))
  return rows.map(([k, v]) => `<div class="bar"><span class="l" title="${esc(k)}">${esc(humanize(k))}</span><span class="t"><i style="width:${(100 * v / max).toFixed(1)}%;background:${catVar(categoryOf(k))}"></i></span><span class="v">${esc(fmtv(v))}</span></div>`).join('')
}

export function timelineSvg(m) {
  if (!m.buckets.length) return empty('No trace events yet.')
  const W = 800, padL = 28, padR = 6, top = 8, H = 150, mk = 16
  const n = m.buckets.length, bw = (W - padL - padR) / n
  const max = Math.max(1, ...m.buckets.map((b) => sum(Object.values(b.cats))))
  let g = ''
  m.buckets.forEach((b, i) => {
    let y = top + H
    for (const c of CATEGORIES) {
      const v = b.cats[c] ?? 0; if (!v) continue
      const h = (v / max) * H; y -= h
      g += `<rect x="${(padL + i * bw).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${catVar(c)}"><title>${esc(hm(b.t0))} ${esc(c)}: ${v}</title></rect>`
    }
  })
  const rows = [['deaths', 'death', 'var(--death)'], ['reflexes', 'reflex', 'var(--warn)'], ['stuck', 'stuck', 'var(--c-recovery)'], ['restarts', 'restart/reconnect', 'var(--home)']]
  rows.forEach(([key, label, color], r) => {
    const y = top + H + 10 + r * mk
    g += `<text x="${padL - 4}" y="${y + 4}" text-anchor="end">${esc(label.slice(0, 5))}</text><line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="var(--line)"/>`
    m.buckets.forEach((b, i) => { if (b[key]) g += `<circle cx="${(padL + i * bw + bw / 2).toFixed(1)}" cy="${y}" r="${Math.min(6, 2 + Math.log2(1 + b[key]) * 1.5).toFixed(1)}" fill="${color}"><title>${esc(hm(b.t0))} ${esc(label)}: ${b[key]}</title></circle>` })
  })
  const lab = []
  const step = Math.max(1, Math.ceil(n / 6))
  for (let i = 0; i < n; i += step) lab.push(`<text x="${(padL + i * bw).toFixed(1)}" y="${top + H + 10 + rows.length * mk + 6}">${esc(m.buckets[i].t0 && ymd(m.buckets[i].t0).slice(5))} ${esc(hm(m.buckets[i].t0))}</text>`)
  const Ht = top + H + 10 + rows.length * mk + 12
  g += `<text x="2" y="${top + 8}">${max}</text><line x1="${padL}" x2="${padL}" y1="${top}" y2="${top + H}" stroke="var(--line)"/>` + lab.join('')
  const legend = CATEGORIES.filter((c) => m.buckets.some((b) => b.cats[c])).map((c) => `<span><i style="background:${catVar(c)}"></i>${esc(c)}</span>`).join('')
  return `<svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Skill starts per ${m.bucketMin} minute bucket by category, with death, reflex, stuck and restart markers">${g}</svg><div class="legend">${legend}</div>`
}

export function heatSvg(m) {
  const h = m.heat
  if (!h.cells.length) return empty('No heatmap data (bot/runtime/heatmap.json missing or empty).')
  const xs = h.cells.map((c) => c.cx), zs = h.cells.map((c) => c.cz)
  const pts = []
  if (m.home) pts.push([m.home.x / h.cell, m.home.z / h.cell])
  for (const d of m.deaths) if (d.pos) pts.push([d.pos[0] / h.cell, d.pos[2] / h.cell])
  const minX = Math.floor(Math.min(...xs, ...pts.map((p) => p[0]))) - 1, maxX = Math.ceil(Math.max(...xs, ...pts.map((p) => p[0]))) + 2
  const minZ = Math.floor(Math.min(...zs, ...pts.map((p) => p[1]))) - 1, maxZ = Math.ceil(Math.max(...zs, ...pts.map((p) => p[1]))) + 2
  const cols = maxX - minX, rows = maxZ - minZ, W = 800
  const s = Math.min(18, W / cols), Wv = cols * s, Hv = rows * s + 14
  const maxN = Math.max(...h.cells.map((c) => c.n)), lmax = Math.log(1 + maxN)
  let g = `<rect width="${Wv}" height="${rows * s}" fill="none" stroke="var(--line)"/>`
  for (const c of h.cells) g += `<rect x="${((c.cx - minX) * s).toFixed(1)}" y="${((c.cz - minZ) * s).toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" fill="var(--heat)" fill-opacity="${(0.15 + 0.85 * Math.log(1 + c.n) / lmax).toFixed(2)}"><title>cell ${c.cx},${c.cz} (blocks ${c.cx * h.cell}..${c.cx * h.cell + h.cell - 1}, ${c.cz * h.cell}..): ${c.n} visits</title></rect>`
  if (minX <= 0 && maxX >= 0 && minZ <= 0 && maxZ >= 0) g += `<path d="M${-minX * s} 0V${rows * s}M0 ${-minZ * s}H${Wv}" stroke="var(--mut)" stroke-dasharray="3 3" stroke-width=".6" opacity=".5"/>`
  for (const d of m.deaths) if (d.pos) { const x = (d.pos[0] / h.cell - minX) * s, y = (d.pos[2] / h.cell - minZ) * s; g += `<path d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}" stroke="var(--death)" stroke-width="2.2"><title>death ${esc(hm(d.ts))} at ${d.pos.map((v) => Math.round(v)).join(', ')}</title></path>` }
  if (m.home) { const x = (m.home.x / h.cell - minX) * s, y = (m.home.z / h.cell - minZ) * s; g += `<path d="M${x} ${y - 7}L${x + 7} ${y}L${x + 5} ${y + 6}H${x - 5}L${x - 7} ${y}Z" fill="var(--home)" stroke="var(--bg)" stroke-width="1"><title>home ${m.home.x}, ${m.home.z}</title></path>` }
  g += `<text x="2" y="${rows * s + 11}">x ${minX * h.cell} .. ${maxX * h.cell}  |  z ${minZ * h.cell} (top, north) .. ${maxZ * h.cell} (bottom)  |  cell = ${h.cell} blocks</text>`
  const lg = `<div class="legend"><span><i style="background:var(--heat)"></i>visits (log scale, max ${maxN})</span>${m.home ? '<span><i style="background:var(--home)"></i>home</span>' : '<span class="mut">home not recorded</span>'}<span><b class="bad">x</b> death (${m.deaths.filter((d) => d.pos).length})</span></div>`
  return `<svg viewBox="0 0 ${Wv.toFixed(0)} ${Hv.toFixed(0)}" role="img" aria-label="Heatmap of visited 8-block cells">${g}</svg>${lg}`
}

function metricRows(m) {
  const R = []
  const add = (k, v, note = '', cls = '') => R.push([esc(k), `<span class="${cls}">${esc(v)}</span>`, `<span class="mut">${esc(note)}</span>`])
  const days = m.uptime_s / 86400
  const stuckTypes = topEntries(m.stuck.byType, 8).map(([k, v]) => `${k}: ${v}`).join(', ')
  add('Stuck events', `${m.stuck.events.length} total, ${fmt(m.stuck.per24h)} per 24 h`, stuckTypes || (m.nEvents ? 'none recorded' : ''), m.stuck.events.length ? 'warn' : 'ok')
  add('Max stuck duration / p95 recovery', `${m.stuck.maxMs === null ? 'n/a' : fmt(m.stuck.maxMs / 1000) + ' s'} / ${m.stuck.p95Ms === null ? 'n/a' : fmt(m.stuck.p95Ms / 1000) + ' s'}`, `from ${m.stuck.recov.length} unstuck_end events; M1 gate: no unrecovered stuck over 3 min`, m.stuck.maxMs > 180000 ? 'bad' : '')
  add('Unrecovered stuck episodes', String(m.stuck.unrecovered), 'unstuck_end with verified=false', m.stuck.unrecovered ? 'bad' : 'ok')
  add('Detector counts per layer', Object.entries(m.stuck.layers).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none', 'unstuck_step levels + restart_request')
  add('Restarts (app_start - 1)', String(m.restarts), `restart requests by the escape ladder: ${m.restart_requests}; reconnects: ${m.reconnects}; kicks: ${m.kicks}. M1 gate: 0 restarts in 72 h`, m.restarts ? 'warn' : 'ok')
  add('Max goal repeat (consecutive)', String(m.maxGoalRepeat ?? 0), `of ${m.goalSeq?.length ?? 0} ${m.goalSource} entries; cycle detections need the mind WantsBook (not in trace)`)
  const bg = m.bigramByHour.filter((b) => b.n >= 5)
  add('Action bigram entropy per hour', bg.length ? `mean ${fmt(sum(bg.map((b) => b.bits)) / bg.length, 2)} bits, min ${fmt(Math.min(...bg.map((b) => b.bits)), 2)}` : 'n/a', 'hours with >= 5 skill transitions')
  add('Goal/habit entropy per day', m.entropyByDay.map((d) => `${d.day}: ${fmt(d.bits, 2)} bits (${d.kinds} kinds, norm ${fmt(d.norm, 2)})`).join('; ') || 'n/a', `source: ${m.goalSource}`)
  const tot = sum(Object.values(m.timeShareMs))
  const shares = Object.entries(m.timeShareMs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(100 * v / tot, 0)}%`).join(', ')
  const top = tot ? Math.max(...Object.values(m.timeShareMs)) / tot : 0
  add('Time share per category', shares || 'n/a', 'plan: no category over 60% except survival at night', top > 0.6 ? 'warn' : '')
  const hs = m.heatStats
  add('Unique cells / chunks visited', hs.cells ? `${hs.cells} cells (${m.heat.cell} blocks), ${hs.chunks} chunks` : 'n/a', 'from heatmap.json (all-time, not per day)')
  add('Max distance from ' + (hs.refIsHome ? 'home' : 'centroid (home unknown)'), hs.maxDist === null ? 'n/a' : `${fmt(hs.maxDist, 0)} blocks`)
  const lagNote = `warnings (p99 > 100 ms): ${m.lag.warns}; max ever ${m.lag.maxEver ?? 'n/a'} ms`
  add('Event-loop lag', m.lag.p99max === null ? 'n/a' : `worst window p99 ${fmt(m.lag.p99max, 1)} ms`, lagNote)
  add('Deaths', `${m.deaths.length} (${fmt(m.deathsPerDay, 1)} per uptime day)`, 'repeat-cause deaths: ' + (m.mind?.lessons ? `${m.mind.lessons.filter((l) => l.result === 'death' && l.count > 1).length} lessons with count > 1` : 'needs mind DB'), m.deaths.length ? 'warn' : 'ok')
  const all = Object.entries(m.skills).filter(([k]) => !/^(unstuck_|escape_)/.test(k)).map(([, v]) => v)
  const fin = sum(all.map((s) => s.done + s.failed + s.aborted)), bad = sum(all.map((s) => s.failed + s.aborted))
  add('Skill failure rate (overall)', fin ? `${fmt(100 * bad / fin, 0)}% (${bad} of ${fin})` : 'n/a', 'per-skill table below')
  if (m.mind?.lessons) add('Lesson reuse', `${sum(m.mind.lessons.map((l) => l.used_count ?? 0))} retrieved, ${sum(m.mind.lessons.map((l) => l.changed_count ?? 0))} changed an action`, 'M3 gate needs the A/B ablation')
  if (m.brain.present) add('S2 valid-header rate', m.brain.intents.length + m.brain.invalid ? `${fmt(100 * m.brain.intents.length / (m.brain.intents.length + m.brain.invalid), 0)}% (${m.brain.intents.length} intents, ${m.brain.invalid} invalid)` : 'n/a', `LLM calls ok ${m.brain.llmOk}/${m.brain.llmCalls}`)
  add('Soak progress', `${fmt(days * 24, 1)} h total uptime`, 'M1 gate is a 24 h no-LLM soak on 3 seeds', days >= 1 ? 'ok' : 'warn')
  return R
}

function skillTable(m) {
  const rows = skillRows(m)
  if (!rows.length) return empty('No skill events yet.')
  return table(['skill', 'started', 'done', 'failed', 'aborted', 'rejected', 'fail rate', 'top reasons'],
    rows.map((r) => [esc(r.name) + (r.internal ? ' <span class="mut">(recovery)</span>' : ''), r.started, r.done, r.failed, r.aborted, r.rejected,
      r.failRate === null ? 'n/a' : `<span class="${r.failRate > 0.5 ? 'bad' : r.failRate > 0.2 ? 'warn' : 'ok'}">${fmt(100 * r.failRate, 0)}%</span>`,
      esc(topEntries(r.reasons, 3).map(([k, v]) => `${k} ${v}`).join(', '))]), [1, 2, 3, 4, 5, 6])
}

function mindSection(m) {
  const d = m.mind
  if (!d) return sec('mind', 'Lessons and preferences', empty('No mind SQLite DB found (looked for mind.sqlite in bot/runtime, brain/runtime, runtime, mind/runtime; override with --mind-db). Section is empty until Wren\'s mind runs.'))
  if (d.error) return sec('mind', 'Lessons and preferences', empty(`Mind DB present but could not be read: ${d.error}`))
  let b = `<p class="sub">${esc(d.file)} (read-only). Rows: ${Object.entries(d.counts).map(([k, v]) => `${k} ${v ?? '?'}`).join(', ')}</p>`
  if (d.self_summary) b += `<h3>Her self-summary (v${d.self_summary.version}, ${esc(d.self_summary.author)})</h3><blockquote>${esc(d.self_summary.text)}</blockquote>`
  b += '<h3>Lessons learned</h3>' + (d.lessons.length ? table(['goal', 'result', 'cause', 'cell', 'seen', 'used', 'changed'], d.lessons.slice(0, 25).map((l) => [esc(l.goal_type), esc(l.result), esc(l.cause), esc(l.cell ?? ''), l.count, l.used_count, l.changed_count]), [4, 5, 6]) : empty('No lessons recorded.'))
  b += '<h3>Preferences (grown from pleasant episodes)</h3>' + (d.preferences.length ? table(['activity', 'status', 'pleasant episodes', 'days'], d.preferences.map((p) => { let dc = 0; try { dc = JSON.parse(p.days).length } catch { /* ignore */ } return [esc(p.activity), esc(p.status), p.pleasant_count, dc] }), [2, 3]) : empty('No preferences yet (they need pleasant episodes on 3+ separate days).'))
  if (d.core.length) b += '<h3>Core memories</h3>' + d.core.map((c) => `<blockquote>${esc(c.text)}</blockquote>`).join('')
  if (d.reflections.length) b += '<h3>Recent reflections</h3>' + d.reflections.slice(0, 6).map((c) => `<blockquote>${esc(c.text)}</blockquote>`).join('')
  if (d.episodes.length) b += `<details><summary>Recent episodes (${Math.min(15, d.episodes.length)})</summary>${table(['t', 'kind', 'text'], d.episodes.slice(0, 15).map((e) => [esc(e.t), esc(e.kind), esc(e.text)]))}</details>`
  return sec('mind', 'Lessons and preferences', b)
}

function brainSection(m) {
  const b = m.brain
  if (!b.present) return sec('brain', 'Recent thoughts, wants and speech', empty('No brain logs yet (brain/logs/brain-*.jsonl, llm-*.jsonl). The mind/S2 side has not run, or logs are elsewhere (--brain-dir).'))
  let h = `<p class="sub">${b.intents.length} intents, ${b.reflections} reflections, ${b.llmOk}/${b.llmCalls} LLM calls ok, ${b.humanEvents} human messages seen, ${b.offline.length} S2 online/offline changes.</p>`
  const spoken = b.intents.filter((i) => i.speech)
  h += '<h3>Wants (latest intents)</h3>' + (b.intents.length ? table(['time', 'goal', 'args', 'said'], b.intents.slice(-15).reverse().map((i) => [esc(ymdhm(i.ts)), esc(i.goal), esc(JSON.stringify(i.args ?? {})), esc(i.speech ?? '')])) : empty('None.'))
  if (spoken.length) h += '<h3>Recent speech</h3>' + spoken.slice(-8).reverse().map((i) => `<blockquote>${esc(ymdhm(i.ts))}: ${esc(i.speech)}</blockquote>`).join('')
  if (b.llm.length) h += '<h3>Recent raw model output</h3>' + b.llm.slice(-6).reverse().map((l) => `<blockquote>${esc(ymdhm(l.ts))}: ${esc(l.text.slice(0, 500))}</blockquote>`).join('')
  return sec('brain', 'Recent thoughts, wants and speech', h)
}

function verified(m) {
  const V = [], N = []
  if (m.nEvents) V.push(`Counts of skills, deaths, reflexes, stuck and restarts come directly from ${m.nEvents} trace events (bot/logs/trace-*.jsonl); test-run subfolders are ignored.`)
  else N.push('No trace events found, so every trace-derived number is empty.')
  if (m.heat.cells.length) V.push('Visited-cell counts come from bot/runtime/heatmap.json; death markers come from death events.')
  else N.push('Heatmap data missing.')
  if (m.home) V.push('Home marker comes from bot/runtime/landmarks.json.'); else N.push('Home position not recorded (landmarks.json missing), so the distance metric uses the centroid.')
  if (m.mind && !m.mind.error) V.push('Lessons and preferences were read from the mind DB (read-only).'); else N.push('Mind DB absent or unreadable: lessons, preferences, lesson reuse and repeat-cause deaths are NOT measured.')
  if (m.brain.present) V.push('Wants and speech come from brain JSONL logs.'); else N.push('Brain logs absent: S2 validity rates, wants and speech are NOT measured.')
  N.push('The heatmap counts visits to 8-block cells, not a time-ordered path; it cannot show where she was at a given hour.')
  N.push('The trace records no death cause, so repeat-cause deaths need the mind lessons.')
  N.push('Nothing here is cross-checked against the Minecraft server itself; a number is only as good as the bot\'s own logging.')
  if (m.uptime_s < 86400) N.push(`Uptime is ${fmtDur(m.uptime_s)}: the 24 h M1 soak gate (3 seeds) and the 72 h zero-restart gate are NOT demonstrated by this data.`)
  return `<h3 class="ok">Verified from data present</h3><ul>${V.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h3 class="warn">Not verified / not measured</h3><ul>${N.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
}

export function renderReport(m, { journalMd = null, journalName = null, generated = new Date(), voice = null } = {}) {
  const status = m.empty ? '<span class="badge warn">no data</span>' : m.running ? '<span class="badge ok">running</span>' : '<span class="badge bad">not running (last event is old or stopped)</span>'
  const span = m.span ? `${ymdhm(m.span.first)} to ${ymdhm(m.span.last)}` : 'no events'
  const cards = [
    card(fmtDur(m.uptime_s), 'total uptime (sum of sessions)'),
    card(m.latest_uptime_s === null ? 'n/a' : fmtDur(m.latest_uptime_s), 'latest session uptime'),
    card(`${m.sessions.length} / ${m.restarts}`, 'sessions / restarts'),
    card(sum(Object.entries(m.skills).filter(([k]) => !/^(unstuck_|escape_)/.test(k)).map(([, v]) => v.started)), 'skills started'),
    card(m.deaths.length, 'deaths'), card(m.reflexTotal ?? 0, 'reflex firings'), card(m.stuck.events.length, 'stuck events'),
    card(m.heatStats.cells, 'unique cells'), card(m.heatStats.chunks, 'unique chunks'),
  ].join('')
  const notable = m.notable.slice(-40).reverse()
  const habitBars = Object.keys(m.habitCounts).length ? bars(m.habitCounts, 14) : empty('No habit/skill events yet.')
  const tsh = sum(Object.values(m.timeShareMs))
  const share = tsh ? bars(Object.fromEntries(Object.entries(m.timeShareMs).map(([k, v]) => [k, +(100 * v / tsh).toFixed(1)])), 8, (v) => v + '%') : empty('No timing data.')
  const reflexT = Object.keys(m.reflexes).length ? table(['reflex', 'fired', 'escaped ok', 'failed'], Object.entries(m.reflexes).map(([k, v]) => [esc(k), v, m.reflexEnds?.[k]?.ok ?? 0, m.reflexEnds?.[k]?.bad ?? 0]), [1, 2, 3]) : empty('No reflex firings recorded.')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Wren life report</title><style>${CSS}</style></head><body><main>
<header><h1>Wren: life report ${status}</h1><p class="sub">Data span ${esc(span)}. Generated ${esc(ymdhm(generated.getTime()))} from logs only; no GUI, no server queries. Goal source: ${esc(m.goalSource)}.</p><div class="cards">${cards}</div><nav>${['timeline', 'conversation', 'thoughts', 'goals', 'chat', 'deaths', 'events', 'habits', 'map', 'metrics', 'skills', 'mind', 'brain', 'journal', 'archive', 'verified'].map((x) => `<a href="#${x}">${x}</a>`).join('')}</nav></header>
${sec('timeline', 'Timeline', timelineSvg(m), `Skill starts per ${m.bucketMin} min by category, with markers for deaths, reflexes, stuck episodes and restarts/reconnects.`)}
${voice ? conversationSection(voice.C, voice.V) + thoughtsSection(voice.V) + goalsSection(voice.G) + chatSection(voice.C) + deathsSection(voice.D) : ''}
${sec('events', 'Notable events', notable.length ? `<div class="feed">${notable.map((e) => `<div><span class="mut">${esc(ymdhm(e.ts))}</span> <b>${esc(e.kind)}</b> ${esc(e.text)}</div>`).join('')}</div>` : empty('Nothing notable recorded.'))}
${sec('habits', 'What she chose to do', `<div>${habitBars}</div><h3>Time share by category</h3>${share}<h3>Reflexes</h3>${reflexT}`)}
${sec('map', 'Map heatmap', heatSvg(m), 'North is up (minus z). Opacity shows how often she stood in each 8-block cell.')}
${sec('metrics', 'Metrics', table(['metric', 'value', 'note'], metricRows(m)))}
${sec('skills', 'Skills', skillTable(m), 'Fail rate = (failed + aborted) / finished.')}
${mindSection(m)}
${brainSection(m)}
${journalMd ? sec('journal', `Journal: ${journalName}`, `<div class="md">${mdToHtml(journalMd)}</div>`) : ''}
${voice ? archiveSection(voice.V, voice.copied) : ''}
${sec('verified', 'Verified vs not', verified(m))}
<footer>report/build-report.mjs, plain Node, deterministic from the log files. See report/README.md.</footer></main></body></html>`
  return html
}
