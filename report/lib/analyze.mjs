// Turns raw trace/metrics/heatmap/brain/mind data into one plain model object. Pure: no I/O, no clock unless `now` is passed.
import { bump, categoryOf, CATEGORIES, entropy, pct, sum, ymd, hourOf, num } from './util.mjs'

const INTERNAL = /^(unstuck_|escape_)/
const BUCKET_CHOICES_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 360]

export function parseHeat(heat) {
  const cell = num(heat?.cell, 8) || 8
  const cells = []
  for (const row of Array.isArray(heat?.counts) ? heat.counts : []) {
    if (!Array.isArray(row)) continue
    const [cx, cz] = String(row[0]).split(',').map(Number)
    if (Number.isFinite(cx) && Number.isFinite(cz)) cells.push({ cx, cz, n: num(row[1], 1) })
  }
  return { cell, cells }
}

export function analyze({ events = [], metrics = null, heat = null, landmarks = null, brain = null, mind = null, now = Date.now() } = {}) {
  const m = {
    now, empty: events.length === 0, nEvents: events.length,
    span: null, days: [], sessions: [], uptime_s: 0, running: false, latest_uptime_s: null,
    restarts: 0, restart_requests: 0, reconnects: 0, kicks: 0, errors: 0,
    deaths: [], skills: {}, categories: {}, habitCounts: {}, goalSource: 'none',
    entropyOverall: entropy({}), entropyByDay: [], bigramByHour: [],
    timeShareMs: {}, reflexes: {}, reflexFeed: [], stuck: { events: [], byType: {}, recov: [], layers: {}, unrecovered: 0, interrupted: 0 },
    lag: { p99max: null, warns: 0, maxEver: null, samples: 0 }, health: { lowHp: 0, minHp: null },
    heat: parseHeat(heat), home: null, buckets: [], bucketMin: 10, notable: [], metricsJson: metrics,
    brain: { ...summarizeBrain(brain), thoughts: Array.isArray(brain?.thoughts) ? brain.thoughts : [] }, mind,
  }
  const pl = landmarks?.places?.home
  if (pl && Number.isFinite(pl.x) && Number.isFinite(pl.z)) m.home = { x: pl.x, z: pl.z }

  m.heatStats = heatStats(m.heat, m.home)
  if (!events.length) return m

  const first = events[0].ts, last = events[events.length - 1].ts
  m.span = { first, last, ms: last - first }
  m.days = [...new Set(events.map((e) => ymd(e.ts)))]

  // sessions
  let cur = null
  const closeSession = (end, reason) => { if (cur) { cur.end = end; cur.reason = reason ?? cur.reason; m.sessions.push(cur); cur = null } }
  let lastTs = first
  const goalSeq = [] // {ts, name}
  const habitEvents = []
  const skillStarts = []
  const pendingStuck = new Map()
  let lastMetrics = null

  for (const e of events) {
    lastTs = e.ts
    switch (e.type) {
      case 'app_start': closeSession(e.ts - 1, 'restart'); cur = { start: e.ts, end: null, reason: null, pid: e.pid ?? null }; break
      case 'app_stop': closeSession(e.ts, e.reason ?? 'stop'); break
      case 'reconnect_scheduled': m.reconnects++; m.notable.push({ ts: e.ts, kind: 'reconnect', text: `reconnect scheduled (${e.after ?? 'drop'})` }); break
      case 'kicked': m.kicks++; m.notable.push({ ts: e.ts, kind: 'reconnect', text: 'kicked from server' }); break
      case 'bot_error': case 'uncaught': case 'unhandled_rejection': case 'connect_error': case 'connect_timeout': m.errors++; m.notable.push({ ts: e.ts, kind: 'error', text: `${e.type}: ${e.message ?? e.name ?? ''}`.trim() }); break
      case 'restart_request': m.restart_requests++; bump(m.stuck.layers, 'restart'); m.notable.push({ ts: e.ts, kind: 'restart', text: `restart requested (${e.reason ?? ''})` }); break
      case 'death': m.deaths.push({ ts: e.ts, pos: Array.isArray(e.pos) ? e.pos : null }); m.notable.push({ ts: e.ts, kind: 'death', text: 'died' + (e.pos ? ` at ${e.pos.map((v) => Math.round(v)).join(', ')}` : '') }); break
      case 'health': if (Number.isFinite(e.hp)) { m.health.minHp = m.health.minHp === null ? e.hp : Math.min(m.health.minHp, e.hp); if (e.hp <= 6) m.health.lowHp++ } break
      case 'habit_choice': habitEvents.push({ ts: e.ts, name: e.habit ?? e.skill }); break
      case 'skill_start': {
        const s = (m.skills[e.skill] ??= newSkill()); s.started++
        if (!INTERNAL.test(e.skill) && e.owner !== 'reflex') skillStarts.push({ ts: e.ts, name: e.skill })
        break
      }
      case 'skill_end': case 'skill_abort': case 'skill_reject': {
        const s = (m.skills[e.skill] ??= newSkill())
        const st = e.type === 'skill_reject' ? 'rejected' : e.status ?? (e.type === 'skill_abort' ? 'aborted' : 'failed')
        if (st in s) s[st]++
        if (e.reason && st !== 'done') bump(s.reasons, String(e.reason).replace(/^preempted_by:.*/, 'preempted'))
        if (Number.isFinite(e.ms) && e.type !== 'skill_reject') { s.ms += e.ms; bump(m.timeShareMs, categoryOf(e.skill), e.ms) }
        break
      }
      case 'reflex_start': bump(m.reflexes, e.name ?? '?'); m.reflexFeed.push({ ts: e.ts, name: e.name ?? '?' }); break
      case 'reflex_end': { const r = (m.reflexEnds ??= {}); const x = (r[e.name ?? '?'] ??= { ok: 0, bad: 0, ms: [] }); e.ok ? x.ok++ : x.bad++; if (Number.isFinite(e.ms)) x.ms.push(e.ms); break }
      case 'unstuck_start': {
        const ev = { ts: e.ts, ep: e.ep, reason: e.reason ?? 'unknown', level: e.level ?? 0, pos: e.pos ?? null }
        m.stuck.events.push(ev); pendingStuck.set(e.ep, ev); bump(m.stuck.byType, ev.reason)
        m.notable.push({ ts: e.ts, kind: 'stuck', text: `stuck: ${ev.reason}` })
        break
      }
      case 'unstuck_end': {
        const ev = pendingStuck.get(e.ep); if (ev) { ev.ms = e.ms; ev.verified = !!e.verified; ev.endLevel = e.level; ev.steps = e.steps }
        if (Number.isFinite(e.ms)) m.stuck.recov.push(e.ms)
        if (!e.verified) m.stuck.unrecovered++
        if (e.interrupted) m.stuck.interrupted++
        break
      }
      case 'unstuck_step': if (e.level) bump(m.stuck.layers, e.level); break
      case 'lag_warn': m.lag.warns++; break
      case 'metrics': lastMetrics = e; if (e.event_loop_lag) { m.lag.samples++; m.lag.p99max = Math.max(m.lag.p99max ?? 0, num(e.event_loop_lag.p99_ms)) } break
      default: break
    }
  }
  closeSession(lastTs, null)
  m.restarts = Math.max(0, events.filter((e) => e.type === 'app_start').length - 1)
  m.uptime_s = Math.round(sum(m.sessions.map((s) => Math.max(0, (s.end ?? lastTs) - s.start))) / 1000)
  const lastSess = m.sessions[m.sessions.length - 1]
  m.running = !!lastSess && lastSess.reason === null && now - lastTs < 120000
  m.latest_uptime_s = lastMetrics?.uptime_s ?? metrics?.uptime_s ?? null
  m.lag.maxEver = lastMetrics?.event_loop_lag_max_ever_ms ?? metrics?.event_loop_lag_max_ever_ms ?? null
  if (!m.sessions.length) m.uptime_s = Math.round((last - first) / 1000)

  // goals: habit_choice if the bot emits it, else skill starts
  const goals = habitEvents.length ? habitEvents : skillStarts
  m.goalSource = habitEvents.length ? 'habit_choice' : skillStarts.length ? 'skill_start' : 'none'
  m.goalSeq = goals
  for (const g of goals) bump(m.habitCounts, g.name)
  m.entropyOverall = entropy(m.habitCounts)
  const byDay = new Map()
  for (const g of goals) { const d = ymd(g.ts); const c = byDay.get(d) ?? {}; bump(c, g.name); byDay.set(d, c) }
  m.entropyByDay = [...byDay].map(([day, c]) => ({ day, n: sum(Object.values(c)), ...entropy(c) }))
  const seqs = new Map()
  for (let i = 1; i < skillStarts.length; i++) {
    const k = `${ymd(skillStarts[i].ts)} ${String(hourOf(skillStarts[i].ts)).padStart(2, '0')}`
    const c = seqs.get(k) ?? {}; bump(c, `${skillStarts[i - 1].name}>${skillStarts[i].name}`); seqs.set(k, c)
  }
  m.bigramByHour = [...seqs].map(([hour, c]) => ({ hour, n: sum(Object.values(c)), ...entropy(c) }))
  m.maxGoalRepeat = maxRun(goals.map((g) => g.name))
  for (const [k, v] of Object.entries(m.skills)) if (!INTERNAL.test(k)) bump(m.categories, categoryOf(k), v.started)

  // timeline buckets (<= 96 bars)
  const spanMin = (last - first) / 60000
  m.bucketMin = BUCKET_CHOICES_MIN.find((b) => spanMin / b <= 96) ?? 720
  const bms = m.bucketMin * 60000
  const t0 = Math.floor(first / bms) * bms
  const nb = Math.floor((last - t0) / bms) + 1
  m.buckets = Array.from({ length: nb }, (_, i) => ({ t0: t0 + i * bms, cats: {}, deaths: 0, reflexes: 0, stuck: 0, restarts: 0 }))
  const at = (ts) => m.buckets[Math.min(nb - 1, Math.floor((ts - t0) / bms))]
  for (const s of skillStarts) bump(at(s.ts).cats, categoryOf(s.name))
  for (const d of m.deaths) at(d.ts).deaths++
  for (const r of m.reflexFeed) at(r.ts).reflexes++
  for (const s of m.stuck.events) at(s.ts).stuck++
  for (const e of events) if (e.type === 'app_start' || e.type === 'reconnect_scheduled') at(e.ts).restarts++
  m.notable.sort((a, b) => a.ts - b.ts)

  m.uptimeDays = Math.max(m.uptime_s / 86400, 1e-9)
  m.stuck.per24h = m.stuck.events.length / m.uptimeDays
  m.stuck.maxMs = m.stuck.recov.length ? Math.max(...m.stuck.recov) : null
  m.stuck.p95Ms = pct(m.stuck.recov, 95)
  m.reflexTotal = sum(Object.values(m.reflexes))
  m.deathsPerDay = m.deaths.length / m.uptimeDays
  return m
}

const newSkill = () => ({ started: 0, done: 0, failed: 0, aborted: 0, rejected: 0, reasons: {}, ms: 0 })

export function skillRows(m) {
  return Object.entries(m.skills).map(([name, s]) => {
    const fin = s.done + s.failed + s.aborted
    return { name, ...s, failRate: fin ? (s.failed + s.aborted) / fin : null, internal: INTERNAL.test(name) }
  }).sort((a, b) => b.started - a.started || a.name.localeCompare(b.name))
}

function maxRun(a) {
  let best = 0, run = 0
  for (let i = 0; i < a.length; i++) { run = i && a[i] === a[i - 1] ? run + 1 : 1; best = Math.max(best, run) }
  return best
}

function heatStats(h, home) {
  const cells = h.cells
  if (!cells.length) return { cells: 0, chunks: 0, visits: 0, maxDist: null, top: null }
  const chunks = new Set(cells.map((c) => `${Math.floor((c.cx * h.cell) / 16)},${Math.floor((c.cz * h.cell) / 16)}`))
  const ref = home ?? { x: sum(cells.map((c) => c.cx * h.cell)) / cells.length, z: sum(cells.map((c) => c.cz * h.cell)) / cells.length }
  const maxDist = Math.max(...cells.map((c) => Math.hypot((c.cx + 0.5) * h.cell - ref.x, (c.cz + 0.5) * h.cell - ref.z)))
  const top = cells.reduce((a, b) => (b.n > a.n ? b : a))
  return { cells: cells.length, chunks: chunks.size, visits: sum(cells.map((c) => c.n)), maxDist, top, refIsHome: !!home }
}

function summarizeBrain(b) {
  const out = { present: false, intents: [], reflections: 0, llm: [], offline: [], invalid: 0, humanEvents: 0, files: 0, llmCalls: 0, llmOk: 0 }
  if (!b || (!b.brain?.length && !b.llm?.length)) return out
  out.present = true; out.files = b.files?.length ?? 0
  for (const r of b.brain ?? []) {
    if (r.ev === 'intent') out.intents.push({ ts: r.ts, goal: r.goal, args: r.args, speech: r.speech ?? null, human: !!r.human })
    else if (r.ev === 'reflection') out.reflections++
    else if (r.ev === 's2_offline') out.offline.push({ ts: r.ts, offline: r.offline, reason: r.reason })
    else if (r.ev === 'invalid') out.invalid++
    else if (r.ev === 'event' && r.type === 'human_speech') out.humanEvents++
  }
  for (const r of b.llm ?? []) {
    out.llmCalls++; if (r.ok) out.llmOk++
    if (r.ok && typeof r.text === 'string' && r.text.trim()) out.llm.push({ ts: r.ts, text: r.text.trim(), total_ms: r.total_ms ?? null, kind: r.kind ?? r.purpose ?? null })
  }
  return out
}

export { CATEGORIES }
