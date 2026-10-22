// Deterministic third-person journal text for one local day. No LLM, no clock, no randomness: same input, same output.
import { ymd, hm, hourOf, bump, topEntries, humanize, compass, fmt, fmtDur, pct, sum, entropy } from './util.mjs'
import { mindEpoch } from './data.mjs'
import { buildConversation, buildGoals, buildDeaths, topThoughts } from './convo.mjs'

const INTERNAL = /^(unstuck_|escape_)/
const DONE_VERB = {
  gather_wood: 'gathered wood', gather_stone: 'gathered stone', collect: 'collected items', pick_flowers: 'picked flowers', craft: 'crafted things',
  eat: 'ate', hunt: 'hunted', place_torch: 'placed torches', set_home: 'set her home', sleep: 'slept', rest: 'rested', shelter: 'built a shelter',
  explore: 'explored', wander: 'wandered', return_home: 'returned home', gesture: 'made a gesture', idle_activity: 'idled about', move_to: 'walked to a spot',
  deposit: 'stored items', fish: 'fished', mine: 'mined',
}
const doneVerb = (s) => DONE_VERB[s] ?? `completed ${humanize(s)}`
const times = (n) => (n === 1 ? 'once' : `${n} times`)
const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`)
const pos = (p) => p.map((v) => Math.round(v)).join(', ')

export function journalDays(events) { return [...new Set(events.map((e) => ymd(e.ts)))].sort() }

const dayRange = (day) => { const [y, m, d] = day.split('-').map(Number); return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() } }
const sayq = (t, n = 160) => `"${String(t).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, n)}"`
const secs = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace(/\.0$/, '')} s`

/** R2: deterministic narrative sentences for one hour from the voice archive / thoughts / goals / deaths. */
function voiceHour(h, { C, G, D, V, win, deathsDone }) {
  const S = []
  const items = C.items.filter((i) => hourOf(i.ms) === h)
  const heard = items.filter((i) => i.kind === 'heard'), said = items.filter((i) => i.kind === 'said')
  const used = new Set(), lines = []
  for (const sa of said) {
    const prev = sa.reply_to ? heard.filter((x) => x.who === sa.reply_to && x.ms <= sa.ms && x.addressed).pop() : null
    if (prev) used.add(prev)
    const lat = sa.latency_ms != null ? ` after ${secs(sa.latency_ms)}` : ''
    const mk = sa.markers.filter((m) => /^interrupted|^held/.test(m)).map((m) => (m.startsWith('held') ? 'she held her line' : 'she was cut off')).join(' and ')
    if (prev) lines.push(`${prev.who}${prev.dist != null ? ` (${prev.dist.toFixed(0)} blocks away)` : ''} said ${sayq(prev.text)} and she answered${lat}: ${sayq(sa.text)}${mk ? ` (${mk})` : ''}.`)
    else lines.push(`${sa.via === 'chat' ? 'She wrote in chat' : 'She said'} ${sayq(sa.text)}${mk ? ` (${mk})` : ''}.`)
  }
  const unanswered = heard.filter((x) => !used.has(x) && x.addressed && x.via === 'voice')
  for (const x of unanswered.slice(0, 2)) lines.push(`${x.who} said ${sayq(x.text)} to her and got no spoken answer.`)
  if (lines.length) { S.push(...lines.slice(0, 6)); if (lines.length > 6) S.push(`${lines.length - 6} more exchanges followed.`) }
  const amb = heard.filter((x) => !x.addressed && x.via === 'voice').length
  if (amb) S.push(`She overheard ${amb} remark${amb === 1 ? '' : 's'} not meant for her.`)
  const thh = (V.thoughts ?? []).filter((t) => t.ts_ms >= win.from && t.ts_ms < win.to && hourOf(t.ts_ms) === h)
  if (thh.length) {
    const top = topThoughts({ thoughts: thh }, 2)
    S.push(`She had ${thh.length} private thought${thh.length === 1 ? '' : 's'}; the most notable: ${top.map((t) => `${hm(t.ts_ms)} ${sayq(t.text, 200)}`).join(' and ')}.`)
  }
  for (const c of G.changes.filter((c) => hourOf(c.ms) === h && !c.kind.startsWith('objective'))) {
    const verb = { goal_new: 'set the goal', goal_done: 'finished the goal', goal_abandoned: 'abandoned the goal', goal_active: 'kept the goal' }[c.kind] ?? c.kind.replace(/_/g, ' ')
    S.push(`At ${hm(c.ms)} she ${verb} ${c.id}: ${sayq(c.text, 120)}${c.reason ? ` (${c.reason})` : ''}.`)
  }
  const ob = G.changes.filter((c) => hourOf(c.ms) === h && c.kind.startsWith('objective_') && c.kind !== 'objective_start')
  if (ob.length) { const n = {}; for (const c of ob) bump(n, c.kind.replace('objective_', '')); S.push(`Objectives ended: ${list(topEntries(n, 4).map(([k, v]) => `${k} x${v}`))}.`) }
  return S
}

export function buildJournal({ events = [], brain = null, mind = null, landmarks = null, day, voice = null }) {
  const evs = events.filter((e) => ymd(e.ts) === day)
  const home = landmarks?.places?.home && Number.isFinite(landmarks.places.home.x) ? landmarks.places.home : null
  const bdayAll = (brain?.brain ?? []).filter((r) => ymd(r.ts) === day)
  const win = dayRange(day)
  const VC = voice ? { V: voice, C: buildConversation(voice, win), G: buildGoals(voice, mind, win), D: buildDeaths(voice, events, mind, win), win } : null
  const L = []
  L.push(`# Wren's life journal: ${day}`, '')
  L.push('_Generated automatically and deterministically from the bot trace, the mind database and the brain logs. Times are local. This is a log summary, not her own words._', '')
  if (!evs.length && !bdayAll.length && !(VC && (VC.C.items.length || VC.V.thoughts.length))) {
    L.push('No trace or brain data was recorded for this day.', '')
    return L.join('\n')
  }

  // ---- facts for the day
  const starts = evs.filter((e) => e.type === 'skill_start' && !INTERNAL.test(e.skill) && e.owner !== 'reflex')
  const ends = evs.filter((e) => (e.type === 'skill_end' || e.type === 'skill_abort') && !INTERNAL.test(e.skill))
  const deaths = evs.filter((e) => e.type === 'death')
  const stuck = evs.filter((e) => e.type === 'unstuck_start')
  const stuckEnd = evs.filter((e) => e.type === 'unstuck_end')
  const appStarts = evs.filter((e) => e.type === 'app_start')
  const targets = evs.filter((e) => e.type === 'skill_target' && Number.isFinite(e.x) && Number.isFinite(e.z))
  const first = evs[0]?.ts, last = evs[evs.length - 1]?.ts
  const counts = {}; for (const s of starts) bump(counts, s.skill)
  const refPt = home ?? null
  const far = targets.length && refPt ? targets.reduce((a, t) => (Math.hypot(t.x - refPt.x, t.z - refPt.z) > Math.hypot(a.x - refPt.x, a.z - refPt.z) ? t : a)) : null
  const humanMsgs = bdayAll.filter((r) => r.ev === 'event' && r.type === 'human_speech').length
  const speech = bdayAll.filter((r) => r.ev === 'intent' && r.speech)
  const mindEps = (mind?.episodes ?? []).filter((e) => { const t = mindEpoch(e.t); return t !== null && ymd(t) === day })
  const lessonsToday = (mind?.lessons ?? []).filter((l) => { const t = mindEpoch(l.created_t); return t !== null && ymd(t) === day })

  // ---- highlights
  L.push('## Highlights', '')
  if (first !== undefined) L.push(`- Activity was logged from ${hm(first)} to ${hm(last)} (${fmtDur((last - first) / 1000)} span).`)
  if (starts.length) L.push(`- She started ${starts.length} activities; the most frequent was ${humanize(topEntries(counts, 1)[0][0])} (${topEntries(counts, 1)[0][1]}).`)
  const e = entropy(counts)
  if (starts.length > 4) L.push(`- Variety of activities: ${e.kinds} ${e.kinds === 1 ? 'kind' : 'kinds'}, entropy ${fmt(e.bits, 2)} bits${e.norm < 0.4 ? ' (narrow: she mostly repeated the same things)' : ''}.`)
  const okN = ends.filter((x) => x.status === 'done').length
  if (ends.length) L.push(`- ${okN} of ${ends.length} finished activities succeeded.`)
  if (far) L.push(`- Farthest destination: about (${Math.round(far.x)}, ${Math.round(far.z)}), ${compass(far.x - refPt.x, far.z - refPt.z)}.`)
  L.push(deaths.length ? `- She died ${times(deaths.length)}: ${deaths.map((d) => `${hm(d.ts)}${d.pos ? ` at (${pos(d.pos)})` : ''}`).join('; ')}.` : '- She did not die.')
  if (stuck.length) {
    const longest = Math.max(0, ...stuckEnd.map((x) => x.ms ?? 0))
    L.push(`- She got stuck ${times(stuck.length)}${stuckEnd.length ? `; the longest recovery took ${fmt(longest / 1000)} s` : ''}.`)
  }
  if (appStarts.length > 1) L.push(`- The body process was started ${appStarts.length} times (restarts at ${appStarts.slice(1).map((a) => hm(a.ts)).join(', ')}).`)
  const refl = evs.filter((x) => x.type === 'reflex_start')
  if (refl.length) L.push(`- Her safety reflexes fired ${times(refl.length)}.`)
  if (humanMsgs || speech.length) L.push(`- Conversation: ${humanMsgs} message${humanMsgs === 1 ? '' : 's'} from humans, ${speech.length} line${speech.length === 1 ? '' : 's'} she chose to say.`)
  if (VC && (VC.C.items.length || VC.V.thoughts.some((t) => t.ts_ms >= win.from && t.ts_ms < win.to))) {
    const st = VC.C.stats, nth = VC.V.thoughts.filter((t) => t.ts_ms >= win.from && t.ts_ms < win.to).length
    L.push(`- Voice: she heard ${st.heard} spoken line${st.heard === 1 ? '' : 's'} (${st.addressed} addressed to her) and spoke ${st.said}${st.interrupted ? `, ${st.interrupted} of them cut off` : ''}${st.latencyMedianMs != null ? `; median time to answer ${secs(st.latencyMedianMs)}` : ''}. She had ${nth} private thought${nth === 1 ? '' : 's'}.`)
    if (VC.G.longTerm.some((g) => g.created_ms >= win.from && g.created_ms < win.to)) L.push(`- Goals: ${VC.G.changes.filter((c) => c.kind === 'goal_new').length} new long-term goal(s), ${VC.G.changes.filter((c) => c.kind === 'goal_done').length} finished; objectives ${Object.entries(VC.G.objCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`)
    if (VC.D.repeats.length) L.push(`- Repeated causes of death so far: ${VC.D.repeats.map(([c, n]) => `${c} x${n}`).join(', ')}.`)
  }
  if (lessonsToday.length) L.push(`- She recorded ${lessonsToday.length} new lesson${lessonsToday.length === 1 ? '' : 's'}.`)
  if (!home) L.push('- Her home position is not recorded, so distances relative to home are omitted.')
  L.push('')

  // ---- hour by hour
  L.push('## Hour by hour', '')
  const hours = [...new Set([...evs.map((x) => hourOf(x.ts)), ...bdayAll.map((r) => hourOf(r.ts)), ...(VC ? [...VC.C.items.map((i) => i.ms), ...VC.V.thoughts.filter((t) => t.ts_ms >= win.from && t.ts_ms < win.to).map((t) => t.ts_ms), ...VC.G.changes.map((c) => c.ms)].map((t) => hourOf(t)) : [])])].sort((a, b) => a - b)
  for (const h of hours) {
    const he = evs.filter((x) => hourOf(x.ts) === h)
    const hb = bdayAll.filter((r) => hourOf(r.ts) === h)
    const S = []
    const hs = he.filter((x) => x.type === 'app_start'), hstop = he.filter((x) => x.type === 'app_stop')
    for (const a of hs) S.push(`The body started up at ${hm(a.ts)}.`)
    for (const a of hstop) S.push(`It shut down at ${hm(a.ts)} (${a.reason ?? 'stopped'}).`)
    const rc = he.filter((x) => x.type === 'reconnect_scheduled')
    if (rc.length) S.push(`The connection to the server dropped ${times(rc.length)}${he.some((x) => x.type === 'kicked') ? ', including a kick' : ''}, and she reconnected.`)
    const hstarts = he.filter((x) => x.type === 'skill_start' && !INTERNAL.test(x.skill) && x.owner !== 'reflex')
    const hc = {}; for (const s of hstarts) bump(hc, s.skill)
    if (hstarts.length) S.push(`She began ${hstarts.length} activities, mainly ${list(topEntries(hc, 4).map(([k, v]) => `${humanize(k)} (${v})`))}.`)
    const hend = he.filter((x) => (x.type === 'skill_end' || x.type === 'skill_abort') && !INTERNAL.test(x.skill))
    const done = {}; for (const x of hend) if (x.status === 'done') bump(done, x.skill)
    const doneEntries = topEntries(done, 6)
    if (doneEntries.length) S.push(`Completed: ${list(doneEntries.map(([k, v]) => `${doneVerb(k)}${v > 1 ? ` (${v}x)` : ''}`))}.`)
    if (he.some((x) => x.type === 'skill_table_placed')) S.push('She placed a crafting table.')
    const bad = hend.filter((x) => x.status !== 'done' && x.status !== 'rejected')
    if (bad.length) {
      const why = {}; for (const x of bad) bump(why, `${x.skill}${x.reason ? ': ' + String(x.reason).replace(/^preempted_by:.*/, 'preempted') : ''}`)
      S.push(`${bad.length} of ${hend.length} finished activities did not work out (${list(topEntries(why, 3).map(([k, v]) => `${humanize(k)} x${v}`))}).`)
    }
    const ht = he.filter((x) => x.type === 'skill_target' && Number.isFinite(x.x) && Number.isFinite(x.z))
    if (ht.length) {
      const xs = ht.map((t) => t.x), zs = ht.map((t) => t.z)
      const cx = sum(xs) / ht.length, cz = sum(zs) / ht.length
      S.push(`Her destinations centred on (${Math.round(cx)}, ${Math.round(cz)})${home ? `, ${compass(cx - home.x, cz - home.z)}` : ''}, spanning x ${Math.round(Math.min(...xs))} to ${Math.round(Math.max(...xs))} and z ${Math.round(Math.min(...zs))} to ${Math.round(Math.max(...zs))}.`)
    }
    const rf = {}; for (const x of he) if (x.type === 'reflex_start') bump(rf, x.name ?? 'reflex')
    if (Object.keys(rf).length) {
      const rends = he.filter((x) => x.type === 'reflex_end'); const okr = rends.filter((x) => x.ok).length
      S.push(`Danger: her reflexes fired ${list(topEntries(rf, 4).map(([k, v]) => `${humanize(k)} x${v}`))}${rends.length ? `; ${okr} of ${rends.length} ended in a clean escape` : ''}.`)
    }
    const low = he.filter((x) => x.type === 'health' && Number.isFinite(x.hp)).map((x) => x.hp)
    if (low.length && Math.min(...low) <= 6) S.push(`Her health fell as low as ${Math.min(...low)} of 20.`)
    for (const d of he.filter((x) => x.type === 'death')) {
      let t = `She died at ${hm(d.ts)}${d.pos ? ` near (${pos(d.pos)})` : ''}.`
      const les = (mind?.lessons ?? []).find((l) => l.result === 'death' && (() => { const et = mindEpoch(l.created_t) ?? mindEpoch(l.last_t); return et !== null && Math.abs(et - d.ts) < 120000 })())
      const dm = VC?.D.deaths.find((x) => Math.abs(x.ms - d.ts) < 8000)
      if (dm?.cause) t += ` Cause: ${dm.cause}${dm.activity ? ` while ${humanize(dm.activity)}` : ''}.`
      if (dm?.after?.length) t += ` Her first thought afterwards: ${sayq(dm.after[0], 200)}.`
      if (les) t += ` The lesson she recorded: ${les.cause ? 'cause ' + les.cause : 'cause unknown'}${les.goal_type ? ' while doing ' + humanize(les.goal_type) : ''}.`
      S.push(t)
    }
    const hst = he.filter((x) => x.type === 'unstuck_start')
    if (hst.length) {
      const rs = {}; for (const x of hst) bump(rs, x.reason ?? 'unknown')
      const hen = he.filter((x) => x.type === 'unstuck_end'); const ok = hen.filter((x) => x.verified).length
      const med = pct(hen.map((x) => x.ms), 50)
      S.push(`She got stuck ${times(hst.length)} (${list(topEntries(rs, 3).map(([k, v]) => `${humanize(k)} x${v}`))}); ${ok} of ${hen.length} recoveries were verified${med !== null ? `, median ${fmt(med / 1000)} s` : ''}.`)
    }
    const hrestart = he.filter((x) => x.type === 'restart_request')
    if (hrestart.length) S.push(`The escape ladder asked for a restart ${times(hrestart.length)}.`)
    const hhum = hb.filter((r) => r.ev === 'event' && r.type === 'human_speech')
    if (hhum.length) S.push(`A human spoke to her ${times(hhum.length)}${list([...new Set(hhum.map((r) => r.from).filter(Boolean))]).length ? ' (' + list([...new Set(hhum.map((r) => r.from).filter(Boolean))]) + ')' : ''}.`)
    for (const r of hb.filter((r) => r.ev === 'intent').slice(0, 3)) S.push(`She decided to ${humanize(r.goal)}${r.args && Object.keys(r.args).length ? ' ' + JSON.stringify(r.args) : ''}${r.speech ? ` and said: "${String(r.speech).replace(/\s+/g, ' ').slice(0, 200)}"` : ''}.`)
    const refs = hb.filter((r) => r.ev === 'reflection').length
    if (refs) S.push(`She reflected on her recent experience ${times(refs)}.`)
    for (const ep of mindEps.filter((x) => hourOf(mindEpoch(x.t)) === h).sort((a, b) => b.importance - a.importance).slice(0, 2)) S.push(`Memory: ${String(ep.text).replace(/\s+/g, ' ').slice(0, 200)}`)
    if (VC) S.push(...voiceHour(h, VC))
    if (!S.length) continue
    L.push(`### ${String(h).padStart(2, '0')}:00`, '', S.join(' '), '')
  }

  // ---- memory (mind DB), only when present
  if (mind && !mind.error) {
    L.push('## What she holds in memory', '')
    if (mind.self_summary) L.push(`Her latest self-summary (version ${mind.self_summary.version}): ${String(mind.self_summary.text).replace(/\s+/g, ' ')}`, '')
    const ls = (mind.lessons ?? []).slice(0, 8)
    if (ls.length) { L.push('Lessons:'); for (const l of ls) L.push(`- ${humanize(l.goal_type)}: ${l.result}${l.cause ? ' (' + l.cause + ')' : ''}${l.cell ? ' at cell ' + l.cell : ''}, seen ${l.count}x, used ${l.used_count}x.`); L.push('') }
    const pf = (mind.preferences ?? []).slice(0, 6)
    if (pf.length) { L.push('Preferences that have formed:'); for (const p of pf) L.push(`- ${humanize(p.activity)} (${p.status}, ${p.pleasant_count} pleasant episodes).`); L.push('') }
    if (!ls.length && !pf.length && !mind.self_summary) L.push('The mind database exists but holds no lessons, preferences or self-summary yet.', '')
  } else {
    L.push('## What she holds in memory', '', 'No mind database was found, so lessons and preferences are not part of this entry.', '')
  }
  return L.join('\n')
}
