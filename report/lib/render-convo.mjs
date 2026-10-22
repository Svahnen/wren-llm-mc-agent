// R2 HTML sections: Conversation, Inner thoughts, Goals, Chat, Deaths & lessons, Run archive. Inline SVG/CSS only, no scripts.
import { esc, fmt, ymdhm, hm, ymd, humanize } from './util.mjs'
import { thoughtScore, topThoughts } from './convo.mjs'

export const CSS_CONVO = `
.convo{max-height:620px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:2px}
.msg{max-width:88%;padding:6px 10px;border-radius:12px;border:1px solid var(--line);font-size:.88rem;word-break:break-word}
.msg.heard{align-self:flex-start;background:var(--bg)}.msg.said{align-self:flex-end;background:color-mix(in srgb,var(--acc) 14%,var(--card));border-color:var(--acc)}
.msg.ambient{opacity:.7;border-style:dashed}.msg .meta{display:block;color:var(--mut);font-size:.74rem}
.tag{display:inline-block;margin:2px 4px 0 0;padding:0 7px;border-radius:99px;font-size:.72rem;border:1px solid var(--warn);color:var(--warn)}
.tag.lat{border-color:var(--mut);color:var(--mut)}.tag.cut{border-color:var(--bad);color:var(--bad)}
.th{padding:4px 0;border-bottom:1px solid var(--line);font-size:.86rem}.th .meta{color:var(--mut);font-size:.74rem}
.k-thought{--k:var(--c-movement)}.k-mutter{--k:var(--c-social)}.k-demoted_say{--k:var(--c-idle)}
.chip{display:inline-block;padding:0 7px;border-radius:99px;font-size:.72rem;border:1px solid var(--k,var(--mut));color:var(--k,var(--mut))}
`

const dt = (ms) => ymdhm(ms)
const empty = (t) => `<p class="mut">${esc(t)}</p>`
const sec = (id, title, body, sub = '') => `<section id="${id}"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}${body}</section>`
const tbl = (head, rows) => `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`

export function conversationSection(C, V) {
  if (!C.items.length) return sec('conversation', 'Conversation', empty(`No heard/spoken lines found${V.runId ? '' : ' (no run archive under voice/archive)'}.`))
  const s = C.stats
  const cards = `<div class="cards">${[[s.heard, 'lines heard'], [s.addressed, 'addressed to her'], [s.said, 'lines she spoke'], [s.chatIn + '/' + s.chatOut, 'chat in / out'], [s.interrupted, 'interrupted'], [s.held, 'held lines'], [s.latencyMedianMs == null ? 'n/a' : fmt(s.latencyMedianMs / 1000, 1) + ' s', 'median reply latency']].map(([v, l]) => `<div class="card"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>`
  const LIM = 300, items = C.items.slice(-LIM)
  const rows = items.map((i) => {
    const cls = `msg ${i.kind}${i.kind === 'heard' && i.addressed === false ? ' ambient' : ''}`
    const who = i.kind === 'said' ? 'Wren' : i.who
    const meta = [dt(i.ms), i.via === 'chat' ? 'chat' : 'voice', i.kind === 'heard' && Number.isFinite(i.dist) ? `${fmt(i.dist, 1)} blocks${i.in_range === false ? ', out of range' : ''}` : null, i.kind === 'heard' && i.via === 'voice' ? (i.addressed ? 'addressed' : 'ambient') : null].filter(Boolean).join(' | ')
    const tags = (i.latency_ms != null ? `<span class="tag lat">replied after ${fmt(i.latency_ms / 1000, 1)} s${i.reply_to ? ' to ' + esc(i.reply_to) : ''}</span>` : '') + i.markers.map((m) => `<span class="tag${/interrupted|cut|dropped/.test(m) ? ' cut' : ''}">${esc(m)}</span>`).join('')
    return `<div class="${cls}"><span class="meta">${esc(who)} | ${esc(meta)}</span>${esc(i.text)}${tags ? '<br>' + tags : ''}</div>`
  }).join('')
  return sec('conversation', 'Conversation', `${cards}<div class="convo">${rows}</div>${C.items.length > LIM ? `<p class="mut">Showing the latest ${LIM} of ${C.items.length}; the full set is in the run archive files below.</p>` : ''}`,
    `What people said to her (left, dashed = not addressed to her) and what she said (right), run <code>${esc(V.runId ?? 'none')}</code>. Latency = end of the person's speech to first audio.`)
}

export function thoughtsSection(V, { from = null, to = null } = {}) {
  const T = (V.thoughts ?? []).filter((t) => (from == null || t.ts_ms >= from) && (to == null || t.ts_ms < to))
  if (!T.length) return sec('thoughts', 'Inner thoughts', empty('No thoughts logged (bot/logs/thoughts.jsonl).'))
  const counts = {}; for (const t of T) counts[t.kind] = (counts[t.kind] ?? 0) + 1
  const t0 = T[0].ts_ms, t1 = Math.max(T.at(-1).ts_ms, t0 + 1), W = 800, kinds = ['thought', 'mutter', 'demoted_say'], H = 18 * kinds.length + 22
  let g = ''
  kinds.forEach((k, r) => {
    const y = 12 + r * 18
    g += `<text x="2" y="${y + 3}">${esc(k.replace('_', ' ').slice(0, 6))}</text><line x1="48" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/>`
    for (const t of T) if (t.kind === k) g += `<circle cx="${(48 + (W - 54) * (t.ts_ms - t0) / (t1 - t0)).toFixed(1)}" cy="${y}" r="${(2 + 3 * thoughtScore(t)).toFixed(1)}" fill="var(--c-${k === 'thought' ? 'movement' : k === 'mutter' ? 'social' : 'idle'})" fill-opacity=".7"><title>${esc(hm(t.ts_ms))} ${esc(t.text.slice(0, 120))}</title></circle>`
  })
  g += `<text x="48" y="${H - 2}">${esc(dt(t0))}</text><text x="${W}" y="${H - 2}" text-anchor="end">${esc(dt(t1))}</text>`
  const top = topThoughts(V, 8, { from, to }), recent = T.slice(-30).reverse()
  const row = (t) => `<div class="th k-${esc(t.kind)}"><span class="meta">${esc(dt(t.ts_ms))} <span class="chip">${esc(t.kind)}</span>${t.goal ? ' ' + esc(t.goal) : ''}${t.mood?.label ? ' | ' + esc(t.mood.label) : ''}${t.human_near ? ' | someone near' : ''}${t.why ? ' | ' + esc(t.why) : ''} | score ${fmt(thoughtScore(t), 2)}</span><br>${esc(t.text.slice(0, 700))}</div>`
  return sec('thoughts', 'Inner thoughts', `<p class="sub">${T.length} thoughts: ${Object.entries(counts).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}. Dot size = importance (logged value, else a keyword/mood heuristic since the logger writes none yet).</p><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Thought timeline by kind">${g}</svg><h3>Most notable</h3>${top.map(row).join('')}<details><summary>Latest ${recent.length}</summary>${recent.map(row).join('')}</details>`)
}

export function goalsSection(G) {
  const lt = G.longTerm
  let b = ''
  b += '<h3>Long-term goals and projects (written by her)</h3>' + (lt.length ? tbl(['id', 'goal', 'status', 'created', 'ended', 'why / notes'], lt.slice().reverse().map((g) => [esc(g.id), esc(g.text), `<span class="${g.status === 'active' ? 'warn' : g.status === 'done' ? 'ok' : 'mut'}">${esc(g.status)}</span>`, esc(g.created_ms ? dt(g.created_ms) : ''), esc(g.ended_ms ? dt(g.ended_ms) : ''), esc([g.why, g.reason, ...(g.notes ?? []).slice(-2)].filter(Boolean).join(' | ').slice(0, 260))])) : empty('No goals stored in the mind DB.'))
  b += `<h3>Objectives (what the body was asked to do)</h3><p class="sub">${Object.entries(G.objCounts).map(([k, v]) => `${esc(k)} ${v}`).join(', ') || 'none'}</p>`
  b += G.objectives.length ? tbl(['started', 'objective', 'status', 'took', 'result'], G.objectives.slice(-25).reverse().map((o) => [esc(o.start_ms ? dt(o.start_ms) : ''), esc(`${o.type}${o.target ? ' ' + o.target : ''}`), esc(o.status + (o.reason ? ': ' + o.reason : '')), o.start_ms && o.end_ms ? `${fmt((o.end_ms - o.start_ms) / 1000, 0)} s` : '', esc(o.summary ?? o.text ?? '')])) : empty('No objectives logged.')
  b += '<h3>Change log</h3>' + (G.changes.length ? `<div class="feed">${G.changes.slice(-40).reverse().map((c) => `<div><span class="mut">${esc(dt(c.ms))}</span> <b>${esc(humanize(c.kind))}</b> ${esc(c.id)} ${esc(c.text.slice(0, 140))}${c.reason ? ' <span class="mut">(' + esc(c.reason) + ')</span>' : ''}</div>`).join('')}</div>` : empty('No changes.'))
  return sec('goals', 'Goals', b, esc(G.historyNote))
}

export function chatSection(C) {
  const rows = C.chat.slice(-60).reverse()
  return sec('chat', 'Chat', rows.length ? `<div class="feed">${rows.map((c) => `<div><span class="mut">${esc(dt(c.ms))}</span> <b>${esc(c.name)}</b> ${esc(c.text)}</div>`).join('')}</div>` : empty('No text chat logged (bot/logs/chat.jsonl, mindlink chat_out).'), `${C.chat.length} chat lines. Spoken (voice) lines are in the Conversation section.`)
}

export function deathsSection(D) {
  if (!D.deaths.length) return sec('deaths', 'Deaths and lessons', empty('No deaths recorded.'))
  const rep = D.repeats.length ? `<p class="bad">Repeat causes: ${D.repeats.map(([c, n]) => esc(c) + ' x' + n).join(', ')}</p>` : '<p class="ok">No cause repeated.</p>'
  return sec('deaths', 'Deaths and lessons', rep + tbl(['when', 'cause', 'doing', 'where', 'lesson in memory', 'her thoughts afterwards'], D.deaths.slice().reverse().map((d) => [esc(dt(d.ms)), esc(d.cause ? `${d.cause}${d.extent ? ' (' + d.extent + ')' : ''}` : 'unknown'), esc(humanize(d.activity ?? '')), esc(d.pos ? d.pos.map((v) => Math.round(v)).join(', ') : ''), d.lesson ? esc(`${humanize(d.lesson.goal_type)}: ${d.lesson.result}, seen ${d.lesson.count}x, used ${d.lesson.used_count}x`) : '<span class="mut">none matched</span>', esc(d.after.join(' / ').slice(0, 300))])), `${D.deaths.length} deaths. Cause and activity come from the mindlink log; older deaths only have time and position from the trace.`)
}

export function archiveSection(V, copied) {
  if (!V.runDir) return sec('archive', 'Run archive', empty('No run archive found under voice/archive.'))
  const rows = V.files.map((f) => [copied ? `<a href="archive/${esc(V.runId)}/${esc(f.name)}">${esc(f.name)}</a>` : esc(f.name), `${fmt(f.bytes / 1024, 1)} KB`, `<code>${esc(f.path)}</code>`])
  return sec('archive', 'Run archive', tbl(['file', 'size', 'on disk'], rows), `Run <code>${esc(V.runId)}</code>. Text and metadata only, no audio. ${copied ? 'Copies are served next to this page.' : ''}`)
}
