#!/usr/bin/env node
// DUSK1: what takes Wren from healthy to critical (hp <= 4)? Offline analysis of bot trace logs (+ server death lines).
//   node scripts/hurt-analysis.mjs [--hours 12] [--logs bot/logs] [--server server/data/logs] [--home x,z]
//        [--landmarks bot/runtime/landmarks.json] [--critical 4] [--window 30] [--json] [--episodes N]
// Reads trace-*.jsonl only (read-only). Game-derived text is untrusted data: this script only counts and prints
// structured fields (event names, numbers); free text is never printed.
// Time of day: the trace has no game clock, so it is ESTIMATED from the events that carry one (hurt_by/health
// events written by newer bots have `tod` ticks, used first), else by extrapolating the nearest anchor
// (24000 ticks = 20 real min; anchors: tod fields, or night flags fitted per +-90 min window). Marked "est".
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DUSK_TICK = 12542, DAWN_TICK = 23460, DUSK_WARN = 11000
export const bucketOf = (k) => (k == null ? 'unknown' : k >= DUSK_TICK && k < DAWN_TICK ? 'night' : k >= DUSK_WARN && k < DUSK_TICK ? 'dusk' : 'day')

export function readJsonl(file) {
  const out = []
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const l of txt.split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (Number.isFinite(o.ts)) out.push(o) } catch { /* torn line */ } }
  return out
}

/** classify the cause of one damage/critical episode. Pure. ctx: {hurt?, food?, reflexes: Set<string>} */
export const POISON_FOOD = /^(pufferfish|spider_eye|poisonous_potato|raw_chicken)$/
/** food eaten by an eat skill within the last 90 s before ts, from `intent` events. */
export function recentEat(events, ts) {
  let r = null
  for (const e of events) { if (e.ts > ts) break; if (e.type === 'intent' && e.skill === 'eat' && ts - e.ts <= 90000) r = e.args?.item ?? null }
  return r
}

export function causeOf(ctx) {
  const h = ctx.hurt
  if (h) {
    if (h.kind === 'mob') return `mob:${h.who}`
    if (h.kind === 'player') return `player:${h.who}`
    if (/fall/i.test(h.who)) return 'env:fall'
    if (ctx.reflexes?.has('drowning')) return 'env:drown'
    if (ctx.reflexes?.has('lava_fire')) return 'env:fire'
    if (ctx.food != null && ctx.food <= 0) return 'env:starvation'
    if (ctx.eat && POISON_FOOD.test(ctx.eat)) return `env:poison(${ctx.eat})`   // ticks of ~1 hp every 0.6 s after eating a bad food
    return 'env:other'
  }
  if (ctx.reflexes?.has('drowning')) return 'env:drown'
  if (ctx.reflexes?.has('lava_fire')) return 'env:fire'
  if (ctx.food != null && ctx.food <= 0) return 'env:starvation'
  return 'unknown'
}

/** tick estimator from anchors [{ts,tick}] (sorted) + night flags [{ts,night}] */
export function makeClock(events) {
  const anchors = events.filter((e) => Number.isFinite(e.tod)).map((e) => ({ ts: e.ts, tick: e.tod }))
  const flags = events.filter((e) => typeof e.night === 'boolean' && (e.type === 'rec2_start' || e.type === 'confined_global')).map((e) => ({ ts: e.ts, night: e.night }))
  const isN = (k) => k >= DUSK_TICK && k < DAWN_TICK
  const tickAt = (ts, phase) => (((phase + ts / 50) % 24000) + 24000) % 24000   // phase = tick - ts/50 (mod 24000)
  const phaseCache = new Map()
  function fitPhase(ts) {
    const key = Math.round(ts / 60000)
    if (phaseCache.has(key)) return phaseCache.get(key)
    const near = flags.filter((f) => Math.abs(f.ts - ts) <= 90 * 60000)
    let r = null
    if (near.length >= 3 && near.some((f) => f.night) && near.some((f) => !f.night)) {
      let best = { c: -1, p: 0 }
      for (let p = 0; p < 24000; p += 200) { let c = 0; for (const f of near) if (isN(tickAt(f.ts, p)) === f.night) c++; if (c > best.c) best = { c, p } }
      if (best.c >= near.length * 0.85) r = best.p
    }
    phaseCache.set(key, r); return r
  }
  return function ticksAt(ts, own) {
    if (Number.isFinite(own)) return { tick: own, how: 'exact' }
    let best = null
    for (const a of anchors) if (!best || Math.abs(a.ts - ts) < Math.abs(best.ts - ts)) best = a
    if (best && Math.abs(best.ts - ts) < 30 * 60000) return { tick: (((best.tick + (ts - best.ts) / 50) % 24000) + 24000) % 24000, how: 'anchor' }
    const p = fitPhase(ts)
    if (p != null) return { tick: tickAt(ts, p), how: 'night-flags' }
    if (best && Math.abs(best.ts - ts) < 4 * 3600000) return { tick: (((best.tick + (ts - best.ts) / 50) % 24000) + 24000) % 24000, how: 'anchor-far' }   // drifts with server pauses; weakest estimate
    return { tick: null, how: 'none' }
  }
}

/** builds a timeline of what she was doing. */
export function makeActivity(events) {
  const iv = [] // {kind,name,from,to}
  const open = { skill: new Map(), reflex: new Map(), playbook: new Map(), rec2: new Map() }
  const closeAt = (kind, key, ts) => { const o = open[kind].get(key); if (o) { o.to = ts; open[kind].delete(key) } }
  const openAt = (kind, key, name, ts) => { closeAt(kind, key, ts); const o = { kind, name, from: ts, to: Infinity }; open[kind].set(key, o); iv.push(o) }
  for (const e of events) {
    switch (e.type) {
      case 'skill_start': openAt('skill', e.intent_id ?? e.skill, `${e.skill}${e.owner ? '/' + e.owner : ''}`, e.ts); break
      case 'skill_end': case 'skill_abort': closeAt('skill', e.intent_id ?? e.skill, e.ts); break
      case 'reflex_start': openAt('reflex', e.name, e.name, e.ts); break
      case 'reflex_end': closeAt('reflex', e.name, e.ts); break
      case 'playbook': if (e.status) closeAt('playbook', e.id, e.ts); else openAt('playbook', e.id, String(e.playbook ?? e.target ?? '?').split(' ')[0], e.ts); break
      case 'rec2_start': openAt('rec2', e.id, 'recover', e.ts); break
      case 'rec2_end': closeAt('rec2', e.id, e.ts); break
      case 'app_start': case 'app_stop': case 'death': for (const k of Object.keys(open)) for (const key of [...open[k].keys()]) closeAt(k, key, e.ts); break
    }
  }
  const MAXLEN = 15 * 60000 // a leaked open interval is not trusted past 15 min
  return function at(ts, slackMs = 0) {
    const r = { skill: null, playbook: null, reflex: [], rec2: false }
    for (const o of iv) {
      const to = Math.min(o.to, o.from + MAXLEN) + (o.kind === 'reflex' ? slackMs : 0)
      if (o.from > ts || to < ts) continue
      if (o.kind === 'skill') r.skill = o.name; else if (o.kind === 'playbook') r.playbook = o.name
      else if (o.kind === 'reflex') r.reflex.push(o.name); else r.rec2 = true
    }
    return r
  }
}

function parseServerDeaths(dir, hours, nowMs) {
  const out = []
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /\.log(\.gz)?$/.test(f)) } catch { return out }
  for (const f of files) {
    const full = path.join(dir, f)
    let txt = ''
    try { const b = fs.readFileSync(full); txt = f.endsWith('.gz') ? zlib.gunzipSync(b).toString('utf8') : b.toString('utf8') } catch { continue }
    let day = null
    const m = f.match(/^(\d{4})-(\d\d)-(\d\d)-/)
    if (m) day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    else { try { const st = fs.statSync(full); day = new Date(st.mtime); day.setUTCHours(0, 0, 0, 0) } catch { continue } }   // server log clock is UTC
    for (const l of txt.split('\n')) {
      const mm = l.match(/^\[(\d\d):(\d\d):(\d\d)\] \[[^\]]*\]: Wren (was (?:slain|shot|blown up|impaled|pricked|burned|killed|squashed|fireballed|struck|pummeled|stung|skewered)\b.*|fell .*|drowned.*|burned to death.*|starved.*|suffocated.*|hit the ground.*|tried to swim in lava.*|went up in flames.*|withered away.*|died.*|experienced kinetic.*|was kicked.*)$/)
      if (!mm) continue
      const ts = day.getTime() + ((+mm[1] * 60 + +mm[2]) * 60 + +mm[3]) * 1000
      if (nowMs - ts > hours * 3600e3 + 3600e3) continue
      if (/kicked/.test(mm[4])) continue
      out.push({ ts, text: mm[4].replace(/\s+/g, ' ').slice(0, 80) })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export function analyze(events, opts = {}) {
  const critical = opts.critical ?? 4, windowMs = (opts.window ?? 30) * 1000
  events = [...events].sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0))
  const end = events.length ? events[events.length - 1].ts : Date.now()
  const since = opts.since ?? end - (opts.hours ?? 12) * 3600e3
  const home = opts.home ?? null
  const places = opts.places ?? []
  const ticksAt = makeClock(events)
  const act = makeActivity(events)
  const posSamples = events.filter((e) => Array.isArray(e.pos)).map((e) => ({ ts: e.ts, x: e.pos[0], y: e.pos[1], z: e.pos[2] }))
  const posAt = (ts) => { let b = null; for (const p of posSamples) { if (p.ts > ts + 30000) break; if (!b || Math.abs(p.ts - ts) < Math.abs(b.ts - ts)) b = p } return b && Math.abs(b.ts - ts) <= 90000 ? b : null }
  const d2 = (p, q) => Math.round(Math.hypot(p.x - q[0], p.z - q[1]))
  const dists = (p) => { if (!p) return { home: null, shelter: null }; let sh = null; for (const q of places) { const d = d2(p, q); if (sh == null || d < sh) sh = d } return { home: home ? d2(p, home) : null, shelter: sh } }
  const reflexAt = (ts) => { const s = new Set(); for (const e of events) { if (e.ts > ts) break; if (e.ts >= ts - 8000 && e.type === 'reflex_start') s.add(e.name) } return s }
  const inRange = events.filter((e) => e.ts >= since)

  // ---- hurt_by events
  const hurts = []
  for (const e of inRange) if (e.type === 'hurt_by') {
    const p = Array.isArray(e.pos) ? { x: e.pos[0], y: e.pos[1], z: e.pos[2] } : posAt(e.ts)
    const lastHealth = [...events].reverse().find((h) => h.type === 'health' && h.ts <= e.ts && h.ts >= e.ts - 4000)
    const cause = causeOf({ hurt: e, food: lastHealth?.food, reflexes: reflexAt(e.ts), eat: recentEat(events, e.ts) })
    const t = ticksAt(e.ts, e.tod)
    const a = act(e.ts, 8000)
    hurts.push({ ts: e.ts, cause, amount: e.amount ?? 0, tick: t.tick, tod: bucketOf(t.tick), todHow: t.how, ...dists(p), activity: a })
  }

  // ---- critical episodes: hp crosses from > critical to <= critical
  const episodes = []
  let prev = null
  const healths = events.filter((e) => e.type === 'health')
  for (const h of healths) {
    if (prev && prev.hp > critical && h.hp <= critical && h.ts >= since && h.ts - prev.ts < 120000) {
      const hurt = [...inRange].reverse().find((x) => x.type === 'hurt_by' && x.ts <= h.ts && x.ts >= prev.ts - 3000)
      const reflexes = reflexAt(h.ts)
      const cause = causeOf({ hurt, food: h.food, reflexes, eat: recentEat(events, h.ts) })
      const t = ticksAt(h.ts, h.tod)
      const p = posAt(h.ts)
      const before = inRange.filter((x) => x.ts >= h.ts - windowMs && x.ts <= h.ts && ['hurt_by', 'reflex_start', 'skill_start', 'playbook', 'health', 'rec2_start', 'skill_abort', 'arb_preempt', 'shelter'].includes(x.type))
        .map((x) => ({ dt: +((x.ts - h.ts) / 1000).toFixed(1), type: x.type, what: x.type === 'hurt_by' ? `${x.who} -${x.amount}` : x.type === 'health' ? `hp ${(+x.hp).toFixed(1)}` : x.type === 'reflex_start' ? x.name : x.type === 'skill_start' ? x.skill : x.type === 'playbook' ? String(x.playbook ?? x.status ?? '') : x.type === 'skill_abort' ? `${x.skill} ${String(x.reason ?? '').slice(0, 40)}` : x.type === 'shelter' ? `${x.reflex} ${x.ok}` : '' }))
      const walking = (act(h.ts, 8000).skill || '').split('/')[0]
      episodes.push({ ts: h.ts, from: +prev.hp.toFixed(1), hp: +h.hp.toFixed(1), food: h.food, cause, tick: t.tick, tod: bucketOf(t.tick), todHow: t.how, ...dists(p), activity: act(h.ts, 8000), walkingSkill: walking, before })
    }
    prev = h
  }

  // ---- deaths
  const deaths = []
  for (const e of inRange) if (e.type === 'death') {
    const hurt = [...inRange].reverse().find((x) => x.type === 'hurt_by' && x.ts <= e.ts && x.ts >= e.ts - 20000)
    const lastH = [...events].reverse().find((x) => x.type === 'health' && x.ts <= e.ts)
    const t = ticksAt(e.ts)
    const p = { x: e.pos?.[0], y: e.pos?.[1], z: e.pos?.[2] }
    deaths.push({ ts: e.ts, cause: causeOf({ hurt, food: lastH?.food, reflexes: reflexAt(e.ts), eat: recentEat(events, e.ts) }), tod: bucketOf(t.tick), todHow: t.how, ...dists(p), activity: act(e.ts - 2000, 8000) })
  }
  return { range: { from: since, to: end }, hurts, episodes, deaths }
}

const count = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + 1) } return [...m.entries()].sort((a, b) => b[1] - a[1]) }
const sumBy = (arr, f, g) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + g(x)) } return [...m.entries()].sort((a, b) => b[1] - a[1]) }
const fmtT = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
const actStr = (a) => [a.skill && `skill=${a.skill}`, a.playbook && `playbook=${a.playbook}`, a.reflex.length && `reflex=${a.reflex.join('+')}`, a.rec2 && 'recover'].filter(Boolean).join(' ') || 'idle/none'
const bandOf = (d) => (d == null ? 'unknown' : d <= 15 ? '0-15 (at home)' : d <= 40 ? '16-40' : d <= 100 ? '41-100' : '>100')

export function render(res, serverDeaths = []) {
  const L = []
  const { hurts, episodes, deaths } = res
  L.push(`# hurt analysis ${fmtT(res.range.from)} .. ${fmtT(res.range.to)}`)
  L.push(`hurt_by events: ${hurts.length} (total ${hurts.reduce((s, h) => s + h.amount, 0).toFixed(1)} hp); critical episodes (hp crossed <= threshold): ${episodes.length}; deaths in trace: ${deaths.length}; server-log death lines: ${serverDeaths.length}`)
  L.push('\n## hurt_by by attacker/cause (count, hp)')
  const hp = new Map(sumBy(hurts, (h) => h.cause, (h) => h.amount))
  for (const [k, n] of count(hurts, (h) => h.cause)) L.push(`- ${k}: ${n}x, ${hp.get(k).toFixed(1)} hp`)
  L.push('\n## hurt_by by game time of day (est.)')
  for (const [k, n] of count(hurts, (h) => h.tod)) L.push(`- ${k}: ${n}`)
  L.push('\n## hurt_by by activity at the time')
  for (const [k, n] of count(hurts, (h) => actStr(h.activity).replace(/\/s[12]/g, ''))) L.push(`- ${k}: ${n}`)
  L.push('\n## hurt_by by distance from home (blocks, xz)')
  for (const [k, n] of count(hurts, (h) => bandOf(h.home))) L.push(`- ${k}: ${n}`)
  L.push('\n## critical episodes (hp > crit -> <= crit) by cause / time / distance / activity')
  for (const [k, n] of count(episodes, (e) => e.cause)) L.push(`- cause ${k}: ${n}`)
  for (const [k, n] of count(episodes, (e) => e.tod)) L.push(`- time ${k}: ${n}`)
  for (const [k, n] of count(episodes, (e) => bandOf(e.home))) L.push(`- home distance ${k}: ${n}`)
  for (const [k, n] of count(episodes, (e) => (e.activity.skill || e.activity.playbook || (e.activity.rec2 ? 'recover' : 'none')).split('/')[0])) L.push(`- activity ${k}: ${n}`)
  L.push('\n### cause x time of day')
  for (const [k, n] of count(episodes, (e) => `${e.cause} @ ${e.tod}`)) L.push(`- ${k}: ${n}`)
  L.push('\n## deaths (trace)')
  for (const d of deaths) L.push(`- ${fmtT(d.ts)} cause=${d.cause} ${d.tod} home=${d.home ?? '?'} shelter=${d.shelter ?? '?'} ${actStr(d.activity)}`)
  L.push('\n## deaths (server log text, local time)')
  const dc = count(serverDeaths, (d) => d.text.replace(/^was /, ''))
  for (const [k, n] of dc) L.push(`- ${k}: ${n}`)
  L.push('\n## episodes, newest 12: the 30 s before each drop to <= crit')
  for (const e of episodes.slice(-12)) {
    L.push(`\n- ${fmtT(e.ts)} hp ${e.from}->${e.hp} food ${e.food} cause=${e.cause} ${e.tod}(${e.todHow}) home=${e.home ?? '?'} shelter=${e.shelter ?? '?'} ${actStr(e.activity)}`)
    L.push('  ' + e.before.map((b) => `${b.dt}s ${b.type}:${b.what}`).filter((s, i, a) => i < 18).join(' | '))
  }
  return L.join('\n')
}

// ---- CLI
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : (process.argv[i + 1] ?? true) }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const logs = path.resolve(arg('logs', path.join(ROOT, 'bot/logs')))
  const hours = +arg('hours', 12)
  const files = fs.readdirSync(logs).filter((f) => /^trace-.*\.jsonl$/.test(f)).map((f) => path.join(logs, f))
  const events = files.flatMap(readJsonl)
  let home = null, places = []
  const lmFile = path.resolve(arg('landmarks', path.join(ROOT, 'bot/runtime/landmarks.json')))
  try {
    const lm = JSON.parse(fs.readFileSync(lmFile, 'utf8'))
    for (const [id, v] of Object.entries(lm.places ?? {})) { if (id === 'home' || v.kind === 'home') home = [v.x, v.z]; if (/^(home|bed|shelter)/.test(v.kind ?? '') || id === 'home') places.push([v.x, v.z]) }
  } catch { /* no landmarks */ }
  const h = arg('home', null); if (h) home = String(h).split(',').map(Number)
  if (home && !places.length) places = [home]
  const res = analyze(events, { hours, home, places, critical: +arg('critical', 4), window: +arg('window', 30) })
  const sd = parseServerDeaths(path.resolve(arg('server', path.join(ROOT, 'server/data/logs'))), hours, res.range.to)
    .filter((d) => d.ts >= res.range.from - 3 * 3600e3)
  if (arg('json', false)) console.log(JSON.stringify({ ...res, serverDeaths: sd }, null, 1))
  else console.log(render(res, sd))
}
