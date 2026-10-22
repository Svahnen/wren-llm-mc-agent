// mindlink (M3): connects the body (createApp result) to mind/ (child process, JSON lines) and brain/ (HTTP). Uses ONLY the hooks built by I1:
//   hooks.setDrivesProvider, hooks.addCostProvider, hooks.setLockoutProvider, hooks.events (tick/death/status), app.submitIntent.
// No main.js edit. Habits stay the fallback: when the brain is down/offline/expired no intent is submitted and intents.hasLive() is false.
import { FoodEpisodes } from './foodepisodes.js'
import { isIgnoredPlayer } from '../ignore-players.js'
import fs from 'node:fs'
import path from 'node:path'
import { MindClient } from './mind-client.js'
import { BrainClient } from './brain-client.js'
import { confinedBus } from '../detect/confined.js'
import { Vec3 } from 'vec3'
import { foodSecurityFacts, nearestWaterM } from './foodsec.js'
import { worldFacts, confinedNote, brainDigest, mindTickDigest, mindRawDigest, scanHazards, scanSightings, hazardExtent, timePhase, entityKind } from './digest.js'
import { translate, goalDescriptor, capExempt } from './translate.js'
import { wantDriveOf } from './drive-link.js'
import { fitSpeech, SpeechQueue, DANGER_RE } from './speech.js'
import { chatLines, sanitizeChatOut, ChatLimiter, stateImportance, appendJsonl } from './chatchan.js'
import { AbortLog, invCounts, invGain } from './aborted.js'
import { VoiceLink, voiceText, voiceHeaders } from './voice-link.js'
import { createVoiceBody } from './voice-body.js'
import { PeopleBook } from './people.js'
import { createHurtTracker, describeHurt } from './hurtby.js'
import { HAZARDS, zoneDist } from '../../../mind/lessons-to-constraints.js'
import { cellKey } from '../../../mind/util.js'
import { createScreen } from '../screen.js'
import { ThoughtLog, speakDecision, muttersAllowed, HEARING_RANGE } from './thoughts.js'
import { steerView } from '../habits/steer.js'
import { createStack, classifyIntent } from '../s1/stack.js'
import { cleanSpeech } from '../../../brain/goaltypes.js'
import { exploredSummary } from '../s1/explored.js'
import { applyPlaceOps } from '../s1/places.js'
import { classify } from '../../../voice/src/turntake.js'
import { isAck, convoFact, answerGate, CONVO_MS } from './converse.js'
import { ACK_DELAY_MS, ackDecision, ackEnabled, pickAck } from './ack.js'
import { CommitmentBook, commitmentFromIntent, ABSENT_NOTICE_MS } from './commitments.js'

// SEC2/N4: text that a player or the speech recogniser produced goes into S2 events as ONE JSON-quoted line (no newlines, capped), names as plain Minecraft-name characters only.
const fq = (t, max) => JSON.stringify(String(t ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max))
const sn = (n) => String(n ?? '?').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || '?'

const ABSENT_NOTICE_S = ABSENT_NOTICE_MS / 1000

const MIN_SAY_GAP_MS = 20000
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()

export function installMindlink(app, opts = {}) {
  const { cfg, body, hooks, intents, runner, pack, trace } = app
  // AI1: WREN_AUTONOMY=high|classic (default high). classic = the pre-AI1 behaviour (hard validator, habit takeover, mind caps enforced).
  const AUTONOMY = (opts.autonomy ?? process.env.WREN_AUTONOMY ?? 'high') === 'classic' ? 'classic' : 'high'
  const HIGH = AUTONOMY === 'high'
  const dir = cfg.runtimeDir
  const mindOn = opts.mind !== false, brainOn = opts.brain !== false
  const logFile = path.join(cfg.logDir, 'mindlink.jsonl')
  fs.mkdirSync(cfg.logDir, { recursive: true })
  let logBytes = 0
  const log = (ev, data = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ev, ...data }) + '\n'
    try { if (logBytes < 40e6) { fs.appendFileSync(logFile, line); logBytes += line.length } } catch { /* ignore */ }
    if (ev.startsWith('error') || ev.endsWith('_error')) trace.event('mindlink_' + ev, data)
  }
  const mind = new MindClient({ dbPath: opts.dbPath ?? path.join(dir, 'mind.sqlite'), env: { BOT_NAME: cfg.username, S2_BASE_URL: opts.s2BaseUrl ?? process.env.S2_BASE_URL ?? 'http://127.0.0.1:19400/v1' }, log })
  const S = {
    drives: null, mindT: 0, zones: [], lockouts: [], hazards: [], goals: new Map(), speeches: new Map(), sayHistory: [], lastSayAt: 0, aborts: new AbortLog(),
    lastIntentId: null, speechKinds: new Map(), lastMutterAt: 0, lastTemplateAt: 0, goalsRev: -1, gstore: null, steer: null, lastBeatAt: 0, lastBiome: null, lastAmbientBeat: 0, intentMeta: new Map(), startMods: {}, lastHumanVia: null, lastHumanName: null, lastHeardId: null, lastHeard: null, unspoken: null, urgentUntil: 0, lastBrainEventAt: 0, nextHeartbeatMs: 60000, failStreak: 0, events: [], chat: [], chatCount: new Map(),
    recent: [], pursuing: new Map(), activity: null, s2Offline: false, resting: false, lastSleepDay: -1, lastSleepMindT: null, sleeping: false, ring: [],
    seen: new Set(), seenFile: path.join(dir, 'mindlink-seen.json'), lastHabit: null, ticks: 0,
    stats: { ticks: 0, drive_wakes: 0, intents_in: 0, intents_submitted: 0, blocked_by_mind: 0, rejected: 0, reports: 0, said: 0, say_skipped: 0, none: 0, lessons: 0, deaths: 0, sleep_passes: 0, sleep_errors: 0, habits_logged: 0, aborted_episodes: 0, heartbeats: 0, idle_beats: 0, event_beats: 0, say_demoted: 0, thoughts: 0, mutters: 0, mutter_limited: 0, advisory_pass: 0, goal_authored: 0, human_msgs: 0, voice_ambient: 0, discoveries: 0, mind_errors: 0, brain_errors: 0 },
  }
  S.foodEp = new FoodEpisodes({ file: path.join(dir, 'food-episodes.json') })   // FOOD4
  try { for (const k of JSON.parse(fs.readFileSync(S.seenFile, 'utf8'))) S.seen.add(k) } catch { /* first run */ }
  const bot = () => body.bot
  const evAt = new Map()   // SURV1: when an event line was pushed, so the digest can say how old it is (an old repeat_cap refusal is not a current one)
  const pushEvent = (s) => { S.events.push(s); evAt.set(s, Date.now()); if (S.events.length > 12) evAt.delete(S.events.shift()) }
  const agedEvents = () => S.events.filter((s) => !evAt.has(s) || Date.now() - evAt.get(s) < 15 * 60000).map((s) => { const a = evAt.has(s) ? (Date.now() - evAt.get(s)) / 1000 : 0; return a > 90 ? `${s} (${a < 5400 ? Math.round(a / 60) + ' min' : Math.round(a / 360) / 10 + ' h'} ago, over)` : a >= 15 ? `${s} (${Math.round(a)} s ago)` : s })   // GATH1: every event line older than 15 s carries its age
  const mcall = async (req, t) => { const r = await mind.call(req, t); if (!r.ok) { S.stats.mind_errors++; log('mind_call_failed', { op: req.op, error: r.error }) } return r }
  const landmarks = () => pack.env.landmarks
  // ---------------------------------------------------------------- G2: goal stack (objective + interruptions + default resume), see s1/stack.js
  const RESUME_AFTER_MS = Number(opts.resumeAfterMs ?? process.env.WREN_RESUME_S * 1000) || 20000
  const RATE_DWELL_MS = Number(opts.rateDwellMs ?? 30000)
  const stack = createStack({
    log: (ev, d) => log(ev, d), decisionLog: app.decisionLog, resumeAfterMs: RESUME_AFTER_MS,
    onInterruptionOver: ({ objective, interruption }) => {
      if (!HIGH) return
      S.stats.interrupt_events = (S.stats.interrupt_events ?? 0) + 1
      pushEvent(`${interruption.label} is over. You were ${objective.last_action || 'working on'} for your objective "${objective.text}"${objective.serves ? ` (it serves ${objective.serves})` : ''}: continue? If you say nothing, your body goes back to it in about ${Math.round(RESUME_AFTER_MS / 1000)} s.`)
      heartbeat('interruption_over')
    },
    onResume: async (intent) => {
      if (app.s1?.active() || intents.hasLive()) return { skipped: 'body_busy' }   // the body is already on it (S1 resumes its own goal after a reflex)
      const it = { ...intent, intent_id: `rs-${Date.now().toString(36)}`, think: null, mutter: null, chat: null, value: null, place_ops: [], objective: null, job_kind: 'resume', answers: undefined }
      S.stats.resumes = (S.stats.resumes ?? 0) + 1
      await handleIntent(it, { resume: true })
      return { resumed: true }
    },
  })
  S.stack = stack

  // ---------------------------------------------------------------- PVP1: who hurt her (perception + memory; the reflex layer never retaliates)
  const hurt = createHurtTracker()
  const placeNear = (pos) => { try { const l = (landmarks()?.list?.() ?? []).map((x) => ({ x, d: Math.hypot(x.x - pos.x, x.z - pos.z) })).filter((x) => x.d <= 25).sort((a, b) => a.d - b.d)[0]; return l ? `near ${l.x.kind === 'home' ? 'home' : (l.x.id ?? l.x.kind)}` : null } catch { return null } }
  const gameDay = () => Math.floor((bot()?.time?.age ?? 0) / 24000)
  const hurtFacts = () => describeHurt(hurt, (n) => people.hurtHistory(n, gameDay()), { where: placeNear })
  const hurtBursts = new Map()   // player -> {n, amount, timer, pos, first}: one remembered episode per burst of hits, written when it goes quiet
  const BURST_QUIET_MS = Number(opts.hurtBurstMs ?? 8000)
  async function flushBurst(name) {
    const b = hurtBursts.get(name); if (!b) return; hurtBursts.delete(name); clearTimeout(b.timer)
    const where = b.pos ? placeNear(b.pos) : null
    const text = `${name} hit me ${b.n === 1 ? 'once' : b.n + ' times'} (-${b.amount.toFixed(0)} hp)${where ? ' ' + where : ''}`
    if (!mindOn) return
    await mcall({ op: 'interaction', name, affinityDelta: 0, note: text.slice(0, 80) })   // a fact in the relationship notes, no affinity change: she decides what it means
    await mcall({ op: 'event', type: 'social', appraise: false, text, pos: b.pos ?? undefined, importance: Math.min(0.8, 0.4 + 0.1 * b.n), damage: b.amount })
  }
  const onHurt = (h) => {
    trace.event('hurt_by', { who: h.who, kind: h.kind, amount: h.amount, via: h.via, tod: Number.isFinite(body?.bot?.time?.timeOfDay) ? body.bot.time.timeOfDay : undefined, pos: h.pos ? [Math.round(h.pos.x), Math.round(h.pos.y), Math.round(h.pos.z)] : null })
    if (h.kind !== 'player') return
    people.hurt(h.who, { amount: h.amount, day: h.day, where: h.pos ? placeNear(h.pos) : null })
    const b = hurtBursts.get(h.who) ?? { n: 0, amount: 0 }; clearTimeout(b.timer)
    b.n++; b.amount += h.amount; b.pos = h.pos; b.timer = setTimeout(() => flushBurst(h.who).catch(() => {}), BURST_QUIET_MS); b.timer.unref?.()
    hurtBursts.set(h.who, b)
    if (Date.now() - (S.lastHurtBeat ?? 0) > 10000) { S.lastHurtBeat = Date.now(); S.stats.hurt_by_player = (S.stats.hurt_by_player ?? 0) + 1; heartbeat('hurt_by_player') }   // S2 gets the facts now and chooses; the body only keeps her safe
  }
  S.hurt = hurt

  // ---------------------------------------------------------------- brain digest + events
  const digest = (extra = {}) => {
    const b = bot(); if (!b?.entity) return null
    const talker = vbody.who()
    const promises = commits.reminders(presentOf)
    const holes = (b.__wallHoles ?? []).filter((h) => { const k = b.blockAt?.(new Vec3(h.at[0], h.at[1], h.at[2])); return !(k && k.boundingBox === 'block') }).slice(-2).map((h) => `${h.text} (an opening in your own shelter or house that you could not close; a block there would fix it)`)   // GATH1
    const evs0 = talker ? [...agedEvents(), ...holes, `you are in a voice conversation with ${talker} (they spoke to you within the last 45 s)`].slice(-12) : [...agedEvents(), ...holes]
    const hurtD = hurtFacts()   // PVP1: who hurt her, as plain facts, newest last so the digest's slice(-6) keeps them
    const evs = [...promises, ...evs0.slice(-(12 - promises.length - hurtD.lines.length))].concat(hurtD.lines)   // V3: promises are shown first, every prompt
    const d0 = brainDigest(b, { drives: S.drives, landmarks: landmarks(), chat: extra.chat ?? [], events: evs, confined: confinedNote(b), recent_intents: S.recent.slice(-8), activity: S.activity, explored: exploredNow(b), foodSeen: pack.env.foodSeen, failures: recentFailures(), hazards: S.hazards.length ? S.hazards : undefined })
    if (hurtD.structured.length) d0.hurt_by = hurtD.structured
    { const fs = foodSecurityFacts(b, landmarks()); if (fs && (fs.farm || fs.pen || fs.rod || fs.berries)) d0.food_security = fs }   // FARM1
    { try { S.foodEp.tick(b); const fe = S.foodEp.facts(b); if (fe) d0.food_episodes = fe } catch { /* ignore */ } }   // FOOD4
    { const w = nearestWaterM(b); if (w !== undefined) d0.water_near_m = w }   // HOME2: fishing is offered only with water in range
    { const sc = screen.recent(120, 3); if (sc.length) d0.screen = sc }
    { const pbv = app.s1?.playbooks?.view?.(); if (pbv) d0.playbook = pbv; const cds = app.s1?.playbooks?.cooldowns?.(); if (cds?.length) d0.playbook_cooldowns = cds.map((c) => ({ name: c.name, text: c.line, left_s: c.left_s })) }   // PB1: active playbook + step k/n
    if (HIGH) { const v = S.stack?.view(); if (v) d0.objective = v; const h = b.heldItem?.name; if (h) d0.holding = h }   // G2: objective + interruption state, what she holds
    return d0
  }
  // SURV1: what a player would SEE on screen (action bar / system lines / titles): "You can sleep only at night or during thunderstorms"
  const screen = createScreen({ onMessage: (e) => { trace.event('screen', { text: e.text, position: e.position }); think(`On screen: "${e.text}"`, { kind: 'screen', importance: 0.2 }) } })
  let screenOff = null
  const recentFailures = () => S.recent.filter((x) => x.status === 'failed' || x.status === 'blocked').slice(-4).map((x) => { const sc = x.at ? screen.near(x.at) : null; return { what: x.goal === 'pursue' ? `wanted ${x.args?.type ?? '?'}` : x.goal, reason: x.reason ?? x.status, ago_s: x.at ? Math.round((Date.now() - x.at) / 1000) : undefined, ...(sc ? { screen: sc.text } : {}) } })
  const biomesSeen = new Set()
  function exploredNow(b) {
    try {
      const me = b.entity.position
      const bn = worldFacts(b).biome; if (bn) biomesSeen.add(bn)
      return exploredSummary(pack.env.heatmap, me, biomesSeen)
    } catch { return undefined }
  }
  const brain = new BrainClient({ url: opts.brainUrl, token: opts.brainToken, log, onIntent: (r) => onBrainPoll(r) })
  async function send(ev) {
    if (!brainOn) return { ok: false, error: 'brain_disabled' }
    const d = ev.digest === undefined ? digest() : ev.digest
    const r = await brain.postEvent({ ...ev, digest: d ?? undefined })
    S.lastBrainEventAt = Date.now()
    if (!r.ok) { S.stats.brain_errors++; log('brain_post_failed', { type: ev.type, error: r.error, status: r.status, errors: r.errors }) }
    return r
  }
  const report = (intent_id, status, reason_code = 'ok') => { S.stats.reports++; return send({ type: 'report', intent_id, status, reason_code }) }

  // ---------------------------------------------------------------- speech: voice service (spoken) + in-game chat (subtitle / fallback), rate limited, deduped
  // MINDLINK_CHAT=on: chat AND voice. off: voice only. fallback (default): chat only when the voice service / mod is not connected (or the human wrote in chat).
  const voiceOn = opts.voice !== false && process.env.MINDLINK_VOICE !== 'off'
  const voice = voiceOn ? new VoiceLink({ url: opts.voiceUrl ?? process.env.VOICE_URL, chatMode: opts.chatMode ?? process.env.MINDLINK_CHAT, log, fetchFn: opts.voiceFetch, answerPriority: opts.answerPriority ?? process.env.VOICE_ANSWER_PRIORITY, statusMs: opts.voiceStatusMs }) : null
  const vbody = createVoiceBody({ getBot: bot, runner, arbiter: app.arbiter, log })
  const runId = process.env.WREN_RUN_ID
  const archiveRoot = process.env.VOICE_ARCHIVE_DIR || path.resolve(cfg.logDir, '../../voice/archive')
  const thoughts = new ThoughtLog({ file: path.join(cfg.logDir, 'thoughts.jsonl'), extraFile: runId ? path.join(archiveRoot, runId, 'thoughts.jsonl') : null,
    voiceCfg: () => ({ voice: process.env.VOICE_VOICE || 'af_heart', speed: process.env.VOICE_SPEED ? Number(process.env.VOICE_SPEED) : null, emotion: 'calm' }) })
  const playersNear = (r = HEARING_RANGE) => {
    const b = bot(), me = b?.entity?.position, out = []
    if (me) for (const p of Object.values(b.players ?? {})) { if (!p || p.username === b.username || /^Wren/i.test(p.username) || isIgnoredPlayer(p.username)) continue; const d = p.entity?.position?.distanceTo?.(me); if (Number.isFinite(d) && d <= r) out.push({ name: p.username, dist: Math.round(d) }) }
    for (const l of voice?.status?.listeners ?? []) if (Number.isFinite(l.dist) && l.dist <= r && l.name && !/^Wren/i.test(l.name) && !out.some((o) => o.name === l.name)) out.push({ name: l.name, dist: Math.round(l.dist) })
    return out
  }
  /** a private thought: logged in full (thoughts.jsonl), kept as a memory episode; never rate limited, never spoken. */
  function think(text, { kind = 'thought', intent_id = null, job_id = null, importance = null, why = null } = {}) {
    const b = bot(); const p = b?.entity?.position, near = playersNear()
    const g = S.steer?.goalId ?? null
    const mood = S.drives?.mood ? { label: S.drives.mood.label, p: S.drives.mood.p, a: S.drives.mood.a, d: S.drives.mood.d } : null
    const rec = thoughts.add({ text, kind, goal: g, mood, pos: p ? [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] : null, gameTime: b?.time ? { age: b.time.age, day: b.time.day, timeOfDay: b.time.timeOfDay } : null,
      players: near, humanNear: near.length > 0, job_id, intent_id, importance, why })
    if (!rec) return null
    S.stats.thoughts++
    if (mindOn) mcall({ op: 'event', type: 'thought', magnitude: 0.1, appraise: false, text: ('I thought: ' + rec.text).slice(0, 700), importance: importance ?? (kind === 'thought' ? 0.25 : 0.3), pos: p && { x: p.x, y: p.y, z: p.z } })
    return rec
  }
  const gateSpeech = (text, why, kind, urgent) => {
    if (process.env.WREN_SPEAK_GATE === 'off') return { speak: true, why: 'gate_off', near: [] } // legacy tests only
    const near = playersNear(), answering = Date.now() - (S.lastHumanAt ?? 0) < 90000
    const d = speakDecision({ kind: why === 'template' ? 'template' : kind, near: near.length, answering, urgent, sinceTemplateMs: Date.now() - S.lastTemplateAt })
    if (d.speak && why === 'template') S.lastTemplateAt = Date.now()
    return { ...d, near }
  }
  function mutter(text, ctx = {}) {
    text = fitSpeech(text, 160); if (!text) return false
    if (!muttersAllowed(S.lastMutterAt, Date.now())) { S.stats.mutter_limited++; log('mutter_limited', { text }); think(text, { kind: 'mutter', why: 'rate_limited', ...ctx }); return false }
    S.lastMutterAt = Date.now(); S.stats.mutters++
    think(text, { kind: 'mutter', ...ctx })
    log('mutter', { text })
    if (voice?.connected && process.env.WREN_MUTTER_VOICE === 'on') { // quiet: temporarily narrow the global speak distance (VS2 has no per-utterance distance yet)
      fetch((voice.url ?? 'http://127.0.0.1:19521') + '/speak_distance', { method: 'POST', headers: voiceHeaders(voice.token, true), body: JSON.stringify({ d: 4 }) }).catch(() => {})
      voice.speak(text, {}).catch(() => {})
      setTimeout(() => fetch((voice.url ?? 'http://127.0.0.1:19521') + '/speak_distance', { method: 'POST', headers: voiceHeaders(voice.token, true), body: JSON.stringify({ d: HEARING_RANGE }) }).catch(() => {}), 9000).unref?.()
    }
    return true
  }
  const commits = new CommitmentBook({ file: path.join(dir, 'mindlink-commitments.json') })
  const presentOf = (name) => { // perception: is this person within hearing range? -> {dist} | null
    const near = playersNear(48).find((p) => p.name === name); return near ? { dist: near.dist } : null
  }
  const sq = new SpeechQueue({ gap: MIN_SAY_GAP_MS })
  const people = new PeopleBook(path.join(dir, 'mindlink-people.json'))
  // conversation threads, one per person (key = name as typed): never merged, each with its own heard id for in_reply_to
  S.threads = new Map(); S.intentImp = new Map(); S.sayImp = new Map(); S.intentJob = new Map(); S.talk = null; S.lastVoiceSay = null
  const activeThreads = (ms = 90000) => [...S.threads.values()].filter((t) => Date.now() - t.lastAt < ms)
  /** Who is this line for? A name inside the text wins; else the closest unanswered voice speaker; else the latest person. */
  const pickAddressee = (text) => {
    const act = activeThreads(); if (!act.length) return null
    const low = String(text).toLowerCase()
    const named = act.find((t) => new RegExp(`\\b${t.name.toLowerCase().replace(/[^a-z0-9_]/g, '.')}\\b`).test(low))
    if (named) return named
    const open = act.filter((t) => !t.answered).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99) || a.lastAt - b.lastAt)
    return open[0] ?? act.sort((a, b) => b.lastAt - a.lastAt)[0]
  }
  const chatOut = (text, why) => {
    const safe = sanitizeChatOut(text)   // SEC1: model text must never become a slash command (or another mod's command prefix)
    if (!safe) { S.stats.say_skipped++; log('say_skipped', { reason: 'unsafe_or_empty_chat', text: String(text).slice(0, 120), why }); return false }
    try { bot().chat(safe) } catch (e) { S.stats.say_skipped++; log('say_skipped', { reason: 'chat_error:' + e.message, text, why }); return false }
    return true
  }
  // ---- chat channel (V4): global text, any distance. Transcript (text only) goes to the bot log and the run archive.
  const chatFiles = () => [path.join(cfg.logDir, 'chat.jsonl'), runId ? path.join(archiveRoot, runId, 'chat.jsonl') : null]
  const chatLimiter = new ChatLimiter()
  const chatLog = (rec) => appendJsonl(chatFiles(), { ts: new Date().toISOString(), ms: Date.now(), ...rec })
  /** S2 chose to write in the in-game chat. -> number of lines sent. Never a command, <= 240 chars per line, rate limited (over the limit becomes a thought, not lost). */
  function chatSay(text, ctx = {}) {
    const b = bot(); if (!b || !body.spawned) return 0
    const lines = chatLines(text)
    if (!lines.length) { log('chat_out_rejected', { text: String(text).slice(0, 120), reason: String(text).trim().startsWith('/') ? 'command' : 'empty' }); return 0 }
    const lim = chatLimiter.take(lines.length)
    if (!lim.ok) { S.stats.chat_limited = (S.stats.chat_limited ?? 0) + 1; log('chat_out_limited', { text, retry_ms: lim.retryMs }); think(text, { kind: 'demoted_say', why: 'chat_rate_limited', ...ctx }); return 0 }
    let sent = 0
    for (const l0 of lines) { const l = sanitizeChatOut(l0); if (!l) continue; try { b.chat(l); sent++; chatLog({ dir: 'out', name: b.username, text: l, via: 'chat', intent_id: ctx.intent_id ?? null }) } catch (e) { log('chat_out_error', { error: e.message, text: l }) } }
    S.stats.chat_out = (S.stats.chat_out ?? 0) + sent; log('chat_out', { lines, intent_id: ctx.intent_id ?? null })
    return sent
  }
  const sayNow = (text, why) => {
    const answering = Date.now() - (S.lastHumanAt ?? 0) < 90000
    const who = answering ? pickAddressee(text) : null
    const viaVoice = !!who && who.via === 'voice'
    const mode = voice?.chatMode ?? 'on'
    const voiceUp = !!voice && voice.connected
    const wantVoice = voiceUp
    const wantChat = !voice || mode === 'on' || (mode === 'fallback' && (!voiceUp || (answering && !viaVoice)))
    if (!wantChat && !wantVoice) { S.stats.say_skipped++; log('say_skipped', { reason: 'voice_down_chat_off', text, why }); return false }
    if (wantChat && !chatOut(text, why) && !wantVoice) return false
    if (wantVoice) {
      const urgent = DANGER_RE.test(text) || S.urgentUntil > Date.now() || (answering && voice.answerPriority === 'urgent')
      voice.speak(text, { urgent, inReplyTo: viaVoice ? who.heardId ?? null : null, heard: viaVoice ? who.heard : null, importance: S.sayImp.get(norm(text)) ?? stateImportance(text) }).then((r) => {
        if (!r.ok && r.error !== 'empty_after_trim' && !wantChat && mode !== 'off') { if (chatOut(text, 'voice_failed')) log('say_chat_fallback', { text, why, error: r.error }) }
      }).catch(() => {})
      S.lastVoiceSay = { text, at: Date.now() }; if (viaVoice && S.talk) S.talk.at = Date.now()
      if (viaVoice) { who.answered = true; who.answeredId = who.heardId ?? who.answeredId; vbody.face(who.name, who.dist) } // the gaze follows the person she is answering
    }
    S.lastSayAt = Date.now(); S.sayHistory.push(norm(text)); if (S.sayHistory.length > 14) S.sayHistory.shift()
    S.stats.said++; log('say', { text, why, to: who?.name, chat: wantChat, voice: wantVoice, voice_text: wantVoice ? voiceText(text) : undefined })
    return true
  }
  function say(text, why = 'intent', { urgent = false, kind = 'say', intent_id = null } = {}) {
    if (why === 'template') { S.stats.template_suppressed = (S.stats.template_suppressed ?? 0) + 1; log('template_suppressed', { text }); return false }
    const b = bot(); text = fitSpeech(cleanSpeech(text), 240)   // never let a contract token reach voice/chat
    if (!text) return false
    const gate = gateSpeech(text, why, kind, urgent || DANGER_RE.test(text))
    if (!gate.speak) { S.stats.say_demoted++; log('say_demoted', { text, why, kind, reason: gate.why }); think(text, { kind: 'demoted_say', why: `${why}:${gate.why}`, intent_id }); return false }
    const n = norm(text)
    if (Number.isFinite(S.intentImp.get(intent_id))) { S.sayImp.set(n, S.intentImp.get(intent_id)); if (S.sayImp.size > 30) S.sayImp.delete(S.sayImp.keys().next().value) }
    if (voice?.connected && why !== 'template' && !urgent && !DANGER_RE.test(text)) { // V3: one answer per human utterance
      const who = pickAddressee(text)
      const meta = S.intentJob.get(intent_id)
      if (who && meta?.jobKind && who.via === 'voice' && Date.now() - who.lastAt < 90000) {
        const g = answerGate({ th: who, jobKind: meta.jobKind, answers: meta.answers ?? [], lastSayAt: S.lastVoiceSay?.at ?? 0, lastSays: S.sayHistory.slice(-4), text, now: Date.now() })
        if (!g.ok) { S.stats.say_demoted++; S.stats['answer_gate_' + g.reason] = (S.stats['answer_gate_' + g.reason] ?? 0) + 1; log('say_demoted', { text, why, kind, reason: 'answer_gate:' + g.reason, job: meta.jobKind, answers: meta.answers }); think(text, { kind: 'demoted_say', why: `${why}:${g.reason}`, intent_id }); return false }
        if (g.followup) log('say_followup', { text, to: who.name })
      }
    }
    const skip = (reason) => { S.stats.say_skipped++; log('say_skipped', { reason, text, why }); return false }
    if (!b || !body.spawned) return skip('not_spawned')
    if (S.sayHistory.includes(n)) return skip('duplicate')
    // M4: lines answering a human (within 90 s of their message) and death/danger reports are protected; otherwise the newest pending line wins
    const protect = urgent || Date.now() - (S.lastHumanAt ?? 0) < 90000 || DANGER_RE.test(text)
    if (urgent) S.urgentUntil = Date.now() + 3000 // the (possibly immediate) sayNow below speaks this one with urgent priority
    const before = sq.dropped
    const r = sq.offer(text, { protect })
    if (sq.dropped > before) { S.stats.say_skipped++; log('say_skipped', { reason: 'superseded_by_newer', why }) }
    if (r.send) return sayNow(r.send, why)
    log('say_queued', { text, why, protect })
    return false
  }
  /** Execution of HER chosen follow + tell S2 when the person has been gone a while. No rule ends or changes a promise here. */
  function commitmentTick() {
    const b = bot(); if (!b?.entity || !body.spawned) return
    for (const { c, logged_off } of commits.checkPresence(presentOf, (n) => !b.players?.[n])) {
      const s = `${c.person} ${logged_off ? 'logged off' : 'left hearing range'} ${Math.round(ABSENT_NOTICE_S)} s ago; you had promised to ${c.kind === 'follow' ? 'follow them' : c.kind}: what do you want to do?`
      pushEvent(s); log('commitment_absent', { id: c.id, person: c.person, logged_off }); if (HIGH) heartbeat('commitment_check')
    }
    const f = commits.active().find((c) => c.kind === 'follow')
    if (f && !intents.hasLive?.() && b.players?.[f.person]?.entity && Date.now() - (S.lastCommitRun ?? 0) > 5000) {
      S.lastCommitRun = Date.now(); S.stats.commit_follow = (S.stats.commit_follow ?? 0) + 1
      const r = app.submitIntent({ intent_id: `commit-${f.id}-${S.stats.commit_follow}`, goal: 'follow', args: { target: f.person, duration_s: 60 }, ttl_s: 30, interruptible: true, created_at_ms: Date.now() })
      if (!r.ok) log('commit_follow_rejected', { res: r })
    }
  }
  const drainSpeech = () => { const t = sq.drain(); if (t && !S.sayHistory.includes(norm(t))) sayNow(t, 'queued'); }

  // one human utterance (typed in chat or spoken through the voice mod) -> mind + brain at top scheduler priority
  function onHuman(username, message, extra = {}) {
    const b = bot(); if (!b) return false
    const n = (S.chatCount.get(username) ?? []).filter((t) => Date.now() - t < 60000); n.push(Date.now()); S.chatCount.set(username, n)
    if (n.length > 6) return false // per-player conversation budget
    const via = extra.via ?? 'chat', uuid = extra.uuid ?? b.players?.[username]?.uuid ?? null
    S.stats.human_msgs++; S.lastHumanAt = Date.now(); S.lastHumanVia = via; S.lastHumanName = username
    const th = S.threads.get(username) ?? { name: username }; S.threads.set(username, th)
    Object.assign(th, { uuid, via, lastAt: Date.now(), answered: false, dist: extra.dist ?? th.dist, heardId: extra.heardId ?? null, heard: extra.heard ?? null, heardAt: Date.now() })
    S.talk = { name: username, dist: extra.dist ?? th.dist, at: Date.now() }
    const m = people.meet(username, { uuid, topic: message, via, dist: extra.dist })
    if (m.first) pushEvent(`I met ${sn(username)} for the first time`)
    if (m.uuidChanged) pushEvent(`someone using the name ${sn(username)} has a different account than before`)
    log('human_speech', { from: username, uuid, text: message, via, dist: extra.dist, ...(extra.overlap ? { overlap: extra.overlap } : {}) })
    if (mindOn) {
      mcall({ op: 'event', type: 'social', magnitude: 0.6, text: `${username} said to me${via === 'voice' ? ' out loud' : ''}: "${String(message).slice(0, 120)}"`, social: true, pos: b.entity?.position && { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } })
      mcall({ op: 'interaction', name: username, affinityDelta: 0.02, note: String(message).slice(0, 60) })
    }
    const { heard, heardId, ...wire } = extra
    send({ type: 'human_speech', utt_id: heardId ?? undefined, from: username, text: message, via, uuid, ts: extra.ts ?? Date.now(), ...wire, digest: digest({ chat: [{ from: username, text: message }] }) ?? undefined })
    return true
  }

  // VAL2: one short spoken filler when S2 has not answered ~1.5 s after a human addressed her (WREN_ACK=on|off, default on). Archive kind 'ack'.
  const ackDone = new Set()
  function scheduleAck(it) {
    if (!ackEnabled() || !voice) return
    const sentAt = Date.now()
    let p50 = null
    brain.status().then((st) => { const v = st?.brain?.total_p50_ms; if (Number.isFinite(v)) p50 = v }).catch(() => {})
    const t = setTimeout(() => {
      const th = S.threads.get(it.name), st = voice.status ?? {}
      const elapsed = Date.now() - sentAt
      const d = ackDecision({ enabled: ackEnabled(), heardId: it.id, doneIds: ackDone, voiceUp: voice.connected, answered: !!th && th.answered && th.answeredId === it.id, lastSayAt: S.lastVoiceSay?.at ?? 0, sentAt,
        speaking: !!st.speaking, queued: (st.queue_len ?? 0) > 0, humanTalking: (st.listeners ?? []).some((l) => l.in_utt && (l.dist ?? 99) <= 16), etaMs: p50 != null ? p50 - elapsed : null })
      if (!d.ok) { S.stats.ack_skipped = (S.stats.ack_skipped ?? 0) + 1; log('ack_skipped', { id: it.id, reason: d.reason }); return }
      ackDone.add(it.id); if (ackDone.size > 40) ackDone.delete(ackDone.values().next().value)
      const text = pickAck(it.text, { last: S.lastAckText })
      S.lastAckText = text; S.stats.ack_said = (S.stats.ack_said ?? 0) + 1
      voice.speak(text, { kind: 'ack', importance: 0.2 }).then((r) => log('ack', { id: it.id, text, ok: r.ok, utt_id: r.utt_id ?? null, after_ms: Date.now() - sentAt })).catch(() => {})
    }, ACK_DELAY_MS)
    t.unref?.()
  }

  // voice in: addressed transcripts are human_speech (top priority); ambient talk is only context; interruptions tell the brain what was left unsaid
  const voiceHandlers = {
    async onAddressed(it) {
      if (!it.name || it.name === bot()?.username || /^Wren/i.test(it.name)) return
      const others = activeThreads(8000).filter((t) => t.name !== it.name && !t.answered && t.via === 'voice')
      S.lastHeardId = it.id; S.lastHeard = it
      sq.pending = null // an idle thought queued before the human spoke is stale now
      // V3: NO flush here. The voice service's turnscore is the ONE barge-in authority (backchannels/fillers never cut her; real interruptions arrive as onInterrupted).
      const th0 = S.threads.get(it.name)
      if (isAck(it.text, { classify, lastSayText: S.lastVoiceSay?.text, lastSayAt: S.lastVoiceSay?.at, now: Date.now() })) { // 'Yeah.' / 'mhm' / 'okay': acknowledgement, not a question -> no answer job
        S.stats.voice_ack_in = (S.stats.voice_ack_in ?? 0) + 1
        if (th0) th0.lastAt = Date.now() // keeps the conversation alive
        if (S.talk?.name === it.name) { S.talk.at = Date.now(); S.talk.dist = it.dist ?? S.talk.dist }
        vbody.touch(it.name, it.dist); log('voice_backchannel', { from: it.name, text: it.text, dist: it.dist })
        pushEvent(`[${sn(it.name)}, ${Math.round(it.dist ?? 0)} m] ${fq(it.text, 60)} (an acknowledgement while talking with you; no question, answer only if you want to)`) // context for S2, no answer job
        return
      }
      const un = S.unspoken && Date.now() - S.unspoken.at < 90000 ? S.unspoken.text : undefined
      S.unspoken = null
      const ov = it.overlap?.length ? it.overlap : S.overlap && Date.now() - S.overlap.at < 10000 && S.overlap.names.includes(it.name) ? S.overlap.names : null
      if (ov) { pushEvent(`${ov.map(sn).join(' and ')} spoke at the same time; ask who you should answer`); log('voice_overlap', { names: ov }) }
      // gaze goes to the closest of those waiting for an answer
      const first = [{ name: it.name, dist: it.dist }, ...others].sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99))[0]
      vbody.onAddressed(first.name, first.dist).catch(() => {}) // gaze at once, never waits for the brain
      const accepted = onHuman(it.name, it.text, { via: 'voice', uuid: it.uuid, dist: it.dist, ts: it.ts, heardId: it.id, heard: it, ...(it.uncertain_words?.length ? { misheard: it.uncertain_words.slice(0, 5) } : {}), ...(it.corrected ? { stt_corrected: true, stt_raw: it.text_stream } : {}), ...(un ? { unspoken: un } : {}), ...(ov ? { overlap: ov } : {}) })
      if (accepted) scheduleAck(it)
      // a second person waits: say so by name now (no LLM), the answer to the closest comes from the brain
      for (const o of others) {
        const waiting = (it.dist ?? 99) < (o.dist ?? 99) ? o : S.threads.get(it.name)
        if (!waiting || Date.now() - (waiting.ackAt ?? 0) < 15000 || !voice.connected) continue
        waiting.ackAt = Date.now()
        voice.speak(`One moment, ${waiting.name}.`, { inReplyTo: waiting.heardId ?? null, heard: null })
        log('voice_ack', { to: waiting.name })
      }
    },
    onAmbient(it) {
      if (!it.name || /^Wren/i.test(it.name) || String(it.text).trim().length < 4) return
      S.stats.voice_ambient++
      pushEvent(`[${sn(it.name)}, ${Math.round(it.dist ?? 0)} m, ${String(it.addressed_why ?? 'not clearly to me').replace(/[^A-Za-z0-9 _,.-]/g, ' ').slice(0, 60)}] ${fq(it.text, 100)}`)   // V3: label = perception confidence, S2 decides whether to answer
      if (HIGH && Date.now() - S.lastAmbientBeat > 20000 && Date.now() - S.lastBeatAt > 10000) { S.lastAmbientBeat = Date.now(); S.stats.event_beats++; heartbeat('heard_human') }
    },
    onInterrupted(ev) {
      S.unspoken = { text: ev.unspoken, spoken: ev.spoken, at: Date.now() }
      pushEvent(`I was cut off while speaking; I had not yet said: ${fq(ev.unspoken, 120)}${ev.auto_resume ? ' (it is held and will be said at the next pause in the conversation unless you say something newer)' : ''}`)
    },
    onStatus(st) {
      vbody.onStatus(st.listeners).catch(() => {})
      const talking = (st.listeners ?? []).filter((l) => l.in_utt && (l.dist ?? 99) <= 16).map((l) => l.name)
      if (talking.length >= 2) { const key = [...talking].sort().join('|'); if (S.overlap?.key !== key) log('voice_overlap_seen', { names: talking }); S.overlap = { key, names: talking, at: Date.now() } }
    },
  }
  app.habits?.setConversing?.(() => vbody.conversing())
  app.recover?.on?.('event', (t) => pushEvent(String(t).slice(0, 160)))   // REC2: S2 is told what the body-level recovery routine does
  hooks.events.on('death', () => { voice?.flush('death').catch?.(() => {}) })

  // ---------------------------------------------------------------- brain poll -> intents
  async function onBrainPoll(r) {
    if (r.s2_offline !== S.s2Offline) { S.s2Offline = !!r.s2_offline; log('s2_offline', { offline: S.s2Offline }); pushEvent(S.s2Offline ? 'my thinking went offline, I keep to routines' : 'my thinking is back') }
    for (const id of r.cancel_utterances ?? []) S.speeches.delete(String(id).replace(/^u-/, ''))
    if (r.speech?.text) { S.speeches.set(r.speech.intent_id, r.speech.text); S.speechKinds.set(r.speech.intent_id, r.speech.kind ?? 'legacy') }
    if (HIGH && r.goals && r.goals_rev !== S.goalsRev) { S.goalsRev = r.goals_rev; S.gstore = r.goals; if (mindOn) mcall({ op: 'goals_save', snapshot: r.goals }) }
    if (r.template_line?.text) { log('template_suppressed', { text: r.template_line.text }); pushEvent('(system) your last action or answer did not work out; decide yourself whether to say anything') } // canned lines are never spoken; S2 gets an event
    const it = r.intent
    if (!it || r.expired || r.s2_offline || it.intent_id === S.lastIntentId) return
    S.lastIntentId = it.intent_id; S.stats.intents_in++
    await handleIntent(it)
  }

  /** caution (S2's modulator) moves the low-health flee threshold inside a bounded body-safe band; null restores the default. */
  function tuneReflex(m) {
    try { const b = bot(); if (b) b._urgency = m?.urgency ?? 0 } catch { /* ignore */ }   // PB1: S2's urgency modulator unlocks sprinting (sprint-policy.js)
    const eng = app.reflex; if (!eng?.cfg) return
    eng.cfg.fleeHealth = m ? Math.min(11, Math.max(6, 8 + Math.round(((m.caution ?? 0.3) - 0.3) * 6))) : 8
  }
  if (HIGH) app.habits?.setSteer?.(() => steerView(S))
  if (HIGH) app.habits?.setGrace?.(() => (stack.objective() ? 9000 : 6500))   // G2: while an objective exists, habit fillers wait longer in the gaps between S2 decisions; VAL2: 3500 -> 6500 without one (S2 answers in ~5.7 s, so fillers started at 3.5 s were replaced a moment later: ~40% of VAL2 thrash switches)
  app.arbiter.on('granted', (t) => { stack.noteStart(t.label, t.owner); if (HIGH && t.owner === 'reflex') stack.reflexStart(t.label) })
  app.arbiter.on('released', (t) => { if (HIGH && t.owner === 'reflex') stack.reflexEnd() })
  const liveKey = (it) => (it.goal === 'pursue' ? `pursue:${it.goal_spec?.type ?? it.args?.type}:${it.goal_spec?.target ?? ''}:${it.goal_spec?.hash ?? ''}` : `${it.goal}:${JSON.stringify(it.args ?? {})}`)
  async function handleIntent(it, hopts = {}) {
    const b = bot(); if (!b?.entity || !body.spawned) { log('intent_dropped', { id: it.intent_id, why: 'not_spawned' }); return }
    const me = b.entity.position
    // G2 thrash control (high autonomy): an identical intent while it is still running is not a new decision; a change that came only from a timer/idle heartbeat
    // (no new event: nobody spoke, nothing finished or failed, no drive crossed a threshold) must not cut an action short in its first RATE_DWELL_MS.
    if (HIGH && !hopts.resume && it.goal !== 'none' && (intents.hasLive() || app.s1?.active()) && S.live && !it.objective) {
      const same = S.live.key === liveKey(it), age = Date.now() - S.live.at
      const timerDriven = it.job_kind === 'heartbeat' && !it.answers?.length
      if (same || (timerDriven && age < RATE_DWELL_MS)) {
        S.stats.rate_limited = (S.stats.rate_limited ?? 0) + 1
        log('intent_rate_limited', { id: it.intent_id, goal: it.goal, args: it.args, why: same ? 'identical_to_running' : 'timer_change_in_dwell', live_age_s: Math.round(age / 1000) })
        S.speeches.delete(it.intent_id)
        if (it.think) think(it.think, { intent_id: it.intent_id, job_id: it.job_id ?? null, importance: it.importance ?? null })
        return
      }
    }
    if (HIGH) { const role = stack.noteIntent(it); if (role.role !== 'none') log('stack_role', { id: it.intent_id, ...role, goal: it.goal }) }
    const speech = S.speeches.get(it.intent_id) ?? null
    const skind = S.speechKinds.get(it.intent_id) ?? 'legacy'
    S.intentJob.set(it.intent_id, { jobKind: it.job_kind, answers: it.answers }); if (Number.isFinite(it.importance)) { S.intentImp.set(it.intent_id, it.importance); if (S.intentImp.size > 40) S.intentImp.delete(S.intentImp.keys().next().value) }; if (S.intentJob.size > 40) S.intentJob.delete(S.intentJob.keys().next().value)
    for (const c of commits.onChosen(it, it.think ?? '')) { log('commitment_ended', { id: c.id, person: c.person, kind: c.kind, how: c.status, why: c.why }); think(`I am no longer ${c.kind === 'follow' ? 'following' : 'keeping my promise to'} ${c.person}: ${c.why}`, { kind: 'commitment', intent_id: it.intent_id }) }
    log('intent_in', { id: it.intent_id, goal: it.goal, args: it.args, speech, speech_kind: skind, serves: it.serves ?? null, autonomy: AUTONOMY })
    if (it.think) think(it.think, { intent_id: it.intent_id, job_id: it.job_id ?? null, importance: it.importance ?? null })
    if (it.mutter) mutter(it.mutter, { intent_id: it.intent_id, job_id: it.job_id ?? null })
    if (it.chat) chatSay(it.chat, { intent_id: it.intent_id })
    if (it.value && mindOn) mcall({ op: 'core_add', text: String(it.value).slice(0, 200) })
    if (HIGH) {
      const gs = S.gstore?.goals ?? []; const g0 = gs.find((x) => x.id === it.serves && x.status === 'active')
      if (gs.some((x) => x.status === 'active') && !S.authoredSeen?.has(S.goalsRev)) { (S.authoredSeen ??= new Set()).add(S.goalsRev); S.stats.goal_authored = gs.length }
      S.steer = { ...(S.steer ?? {}), goalId: g0?.id ?? null, goalText: g0?.text ?? null, mods: it.modulators ?? {}, intentId: it.intent_id, at: Date.now() }
      if (it.goal !== 'none') Object.assign(S.steer, { skill: null, args: null, status: 'pending', repeats: 0 })
    }
    // S1G: place notes in HER words apply whatever the act is (code only writes what she chose)
    if (it.place_ops?.length) {
      const done = applyPlaceOps(landmarks(), it.place_ops, me)
      log('place_ops', { id: it.intent_id, done })
      for (const d of done) pushEvent(d.ok ? (d.op === 'remember' ? `you saved "${d.name}" here at ${d.at.map(Math.round).join(',')}` : d.op === 'forget' ? `you forgot the place "${d.name}"` : `you renamed "${d.name}" to "${d.to}"`) : `place note "${d.op} ${d.name}" did not apply: ${d.why}`)
    }
    // PB1: steering lines for the running playbook (skip / abort / set); S2 never has to plan its steps
    for (const op of it.playbook_ops ?? []) {
      const pb = app.s1?.playbooks; if (!pb) break
      if (op.op === 'continue') continue
      const r = await pb.steer(op.op === 'skip' ? { skip: true } : op.op === 'abort' ? { abort: op.reason } : { set: op.set })
      log('playbook_steer', { id: it.intent_id, op, res: r }); pushEvent(r.ok ? `playbook steered: ${op.op}${r.step ? ' (step ' + r.step + ')' : ''}` : `playbook steer "${op.op}" did not apply: ${r.reason}`)
    }
    if (it.goal !== 'none' && app.s1?.active()) await app.s1.cancel('new_intent') // a new S2 decision replaces whatever goal S1 was pursuing ('none' = keep going: PB1 playbooks must survive speech-only answers)
    if (it.goal === 'pursue' && app.s1) return startGoal(it, speech, skind)
    const tr = translate(it, { landmarks: landmarks(), me, hazards: S.hazards })
    if (HIGH && !tr.skip && !tr.fail) Object.assign(S.steer, { skill: tr.goal, args: tr.args })
    if (tr.skip) { S.stats.none++; if (speech) say(speech, 'none', { kind: skind, intent_id: it.intent_id }); return }
    if (tr.fail) { await report(it.intent_id, 'failed', tr.fail); return }
    { // V3: conversation facts for S2 (perception, not a rule): she walks if she chose to
      const t = S.talk, d = t ? (vbody.realDist?.(t.name) ?? t.dist) : null
      const f = convoFact({ goal: tr.goal, talk: t, dist: d })
      if (f) { S.stats.convo_away_fact = (S.stats.convo_away_fact ?? 0) + 1; log('convo_away_fact', { id: it.intent_id, goal: tr.goal, with: t.name, dist: d, job: it.job_kind }); pushEvent(f) }
    }
    // mind: repeat caps, attempt/fail budgets, lockouts (needs/safety acts are exempt)
    const desc = goalDescriptor(tr.goal, tr.args, cellKey(me.x, me.z))
    let goalId = null
    if (mindOn && !capExempt(tr.goal, tr.args)) {
      const cs = await mcall({ op: 'can_start', goal: desc })
      const tkey = `${tr.goal}:${desc.target ?? ''}:${desc.place}`; const nowMs = Date.now()
      ;(S.startLog ??= []).push({ k: tkey, t: nowMs }); S.startLog = S.startLog.filter((x) => nowMs - x.t < 600000)
      const thrash = S.startLog.filter((x) => x.k === tkey).length >= 7 // anti-thrash plumbing: the same start 7 times in 10 min is blocked even in high autonomy
      if (cs.ok && cs.result.ok === false && HIGH && !thrash) {
        S.stats.advisory_pass++; log('advisory_pass', { id: it.intent_id, goal: tr.goal, desc, reason: cs.result.reason })
        pushEvent(`note: ${tr.goal} here has hit "${cs.result.reason}" (many tries today or a repeating cycle); you may still try it`)
      } else if (cs.ok && cs.result.ok === false) {
        S.stats.blocked_by_mind++; pushEvent(`I could not start ${tr.goal}: ${cs.result.reason}`); log('blocked_by_mind', { id: it.intent_id, goal: tr.goal, desc, reason: cs.result.reason })
        S.recent.push({ goal: it.goal, args: it.args, status: 'blocked' })
        S.failStreak++ // same back-off as a failure: a refused goal must not turn into a tight ask-refuse loop
        await new Promise((r) => setTimeout(r, Math.min(20000, 1500 * 2 ** Math.min(4, S.failStreak - 1))))
        await report(it.intent_id, 'blocked', 'precondition_failed'); return
      }
      const gs = await mcall({ op: 'goal_start', goal: { ...desc, args: tr.args, text: speech ?? '' } })
      if (gs.ok) { goalId = gs.result.goal.id; if (gs.result.cycle) { pushEvent(`I noticed I am repeating a cycle: ${gs.result.cycle.tokens.join(', ')}`); log('cycle', gs.result.cycle); refreshConstraints() } }
    }
    if (speech && mindOn) { // her stated reason becomes a want, in her own words
      const wd = wantDriveOf(it.goal, it.args, S.drives?.urgencies, { humansOnline: Object.keys(b.players ?? {}).some((n) => n !== b.username && !/^Wren/i.test(n)) })
      mcall({ op: 'want', want: { text: speech.slice(0, 200), reason: `${it.goal} ${JSON.stringify(it.args)}`.slice(0, 120), drive: wd.drive, strength: wd.strength } })
    }
    S.goals.set(it.intent_id, { goalId, goal: it.goal, args: it.args, tr, startedAt: Date.now(), pos: [me.x, me.y, me.z] })
    tuneReflex(HIGH ? it.modulators : null)
    const res = app.submitIntent({ intent_id: it.intent_id, goal: tr.goal, args: tr.args, ttl_s: 30, interruptible: it.interruptible, urgent: it.urgent === true, created_at_ms: Date.now() })
    S.stats.intents_submitted++
    if (res.ok) S.live = { key: liveKey(it), at: Date.now(), id: it.intent_id }
    if (res.ok) {
      const cm = commitmentFromIntent(it, { jobKind: it.job_kind, speech, talkName: S.talk?.name, knownPlayer: (n) => !!n && !!b.players?.[n] })
      if (cm) { const rec = commits.add(cm, speech); log('commitment', { id: rec.id, person: rec.person, kind: rec.kind, goal: rec.goal, said: speech }); think(`I promised ${rec.person} to ${rec.kind}${speech ? ': ' + speech : ''}`, { kind: 'commitment', intent_id: it.intent_id }) }
    }
    if (!res.ok) {
      S.stats.rejected++; log('submit_rejected', { id: it.intent_id, res })
      S.recent.push({ goal: it.goal, args: it.args, status: 'failed' })
      pushEvent(`${it.goal} was rejected: ${res.errors?.[0] ?? res.reason_code}`)
      if (goalId) mcall({ op: 'goal_finish', id: goalId, outcome: 'failed' })
      S.goals.delete(it.intent_id)
      await report(it.intent_id, 'failed', res.reason_code === 'blocked' ? 'precondition_failed' : (res.reason_code ?? 'invalid_args'))
    }
  }

  /** S1G: S2 stated WHAT she wants; S1 chooses the skills. Escalation back to S2 is a normal report (done / failed with what was tried). */
  async function startGoal(it, speech, skind) {
    const b = bot(), me = b.entity.position, gs = it.goal_spec ?? { type: it.args?.type ?? 'custom', target: it.args?.target ?? null, text: '' }
    const spec = { type: gs.type, target: gs.target ?? null, text: gs.text ?? '', mods: it.modulators ?? {} }
    S.stats.goals_in = (S.stats.goals_in ?? 0) + 1
    S.pursuing.set(it.intent_id, { it, spec, startedAt: Date.now(), pos: [me.x, me.y, me.z] })
    S.activity = { intent_id: it.intent_id, goal: `pursue ${spec.type}${spec.target ? ' ' + spec.target : ''}`, status: 'started', detail: spec.text.slice(0, 80) }
    S.live = { key: liveKey(it), at: Date.now(), id: it.intent_id }
    log('goal_start', { id: it.intent_id, spec })
    if (spec.text && mindOn) mcall({ op: 'want', want: { text: spec.text.slice(0, 200), reason: `${spec.type} ${spec.target ?? ''}`.trim().slice(0, 120), ...wantDriveOf(spec.type === 'get_food' ? 'hunt' : spec.type === 'rest' ? 'sleep' : spec.type === 'talk' || spec.type === 'follow_person' ? 'follow' : 'explore', {}, S.drives?.urgencies, { humansOnline: Object.keys(b.players ?? {}).some((n) => n !== b.username && !/^Wren/i.test(n)) }) } })
    tuneReflex(HIGH ? it.modulators : null)
    app.s1.pursue(spec, { intent_id: it.intent_id })
    await report(it.intent_id, 'started')
    if (speech) { say(speech, 'started', { kind: skind, intent_id: it.intent_id }); S.speeches.delete(it.intent_id) }
    if (spec.type === 'follow_person' && spec.target) {
      const cm = commitmentFromIntent({ ...it, goal: 'follow', args: { target: spec.target } }, { jobKind: it.job_kind, speech, talkName: S.talk?.name, knownPlayer: (n) => !!n && !!b.players?.[n] })
      if (cm) { const rec = commits.add(cm, speech); log('commitment', { id: rec.id, person: rec.person, kind: rec.kind, goal: rec.goal, said: speech }) }
    }
  }
  app.s1?.setOnFinish(async (e) => {
    const g = S.pursuing.get(e.intent_id); if (!g) return
    stack.reactionEnded(e.intent_id)
    S.pursuing.delete(e.intent_id); tuneReflex(null)
    const ok = e.status === 'done'
    if (ok) S.failStreak = 0; else S.failStreak++
    S.recent.push({ goal: 'pursue', args: g.it.args, status: e.status, text: g.spec.text, reason: e.summary?.slice(0, 120) ?? e.reason, at: Date.now() }); if (S.recent.length > 16) S.recent.shift()
    S.activity = { intent_id: e.intent_id, goal: `pursue ${g.spec.type}`, status: e.status }
    if (S.steer?.intentId === e.intent_id) S.steer.status = e.status
    pushEvent(`${ok ? 'your body reached what you wanted' : 'your body could not get you what you wanted'} (${e.summary})`)
    log('goal_end', { id: e.intent_id, status: e.status, reason: e.reason, summary: e.summary, steps: e.steps, ms: e.ms })
    if (mindOn) mcall({ op: 'event', type: ok ? 'goal_done' : 'goal_failed', magnitude: 0.6, appraise: false, text: `I wanted ${g.spec.text || g.spec.type}: ${ok ? 'my body got it done' : 'it did not work out (' + e.reason + ')'}`.slice(0, 700), importance: 0.4 })
    const delay = ok ? 0 : Math.min(20000, 1500 * 2 ** Math.min(4, S.failStreak - 1))
    if (delay) await new Promise((r) => setTimeout(r, delay))
    await report(e.intent_id, e.status, e.reason_code)
  })

  // PB1: playbook progress reaches S2 as plain events (facts, never scripted speech); cues wake her so SHE decides what to say
  const PB_WAKE = new Set(['show_start', 'show_arrived', 'person_lost', 'person_behind', 'person_not_visible'])
  app.s1?.setPlaybookHooks?.({
    notify: (kind, text) => { S.stats.pb_events = (S.stats.pb_events ?? 0) + 1; pushEvent(`playbook: ${text}`); log('playbook_event', { kind, text }); if (HIGH && PB_WAKE.has(kind)) heartbeat('playbook_' + kind) },
    log: (ev, d) => log(ev, d), screenRecent: (a, n) => screen.recent(a, n),
  })

  // intent lifecycle from the body (hooks.events 'status')
  hooks.events.on('status', async (e0) => {
    let e = e0
    const g = S.goals.get(e.intent_id)
    log('status', e)
    if (!g) return // not ours (or already finished)
    const b = bot(), pos = b?.entity?.position, me0 = () => bot()?.entity?.position
    if (e.status === 'started') { await report(e.intent_id, 'started'); const sp = S.speeches.get(e.intent_id); if (sp) { say(sp, 'started', { kind: S.speechKinds.get(e.intent_id) ?? 'legacy', intent_id: e.intent_id }); S.speeches.delete(e.intent_id) } return }
    if (!['done', 'failed', 'preempted', 'blocked'].includes(e.status)) return
    S.goals.delete(e.intent_id)
    stack.reactionEnded(e.intent_id)
    if (S.steer?.intentId === e.intent_id) { S.steer.status = e.status === 'preempted' && ['no_progress', 'timeout', 'stuck', 'unreachable', 'path_failed'].includes(e.reason_code) ? 'failed' : e.status; tuneReflex(null) }
    S.recent.push({ goal: g.goal, args: g.args, status: e.status, reason: e.detail ? `${e.reason_code ?? e.reason}: ${e.detail}`.slice(0, 200) : (e.reason_code ?? e.reason), at: Date.now() })
    if (S.recent.length > 16) S.recent.shift()
    // a preemption that is really the skill giving up (no progress, timeout, stuck, unreachable) counts as a failure for S2 and the mind
    if (e.status === 'preempted' && ['no_progress', 'timeout', 'stuck', 'unreachable', 'path_failed'].includes(e.reason_code)) e = { ...e, status: 'failed' }
    const ok = e.status === 'done'
    if (ok) S.failStreak = 0; else if (e.status === 'failed' || e.status === 'blocked') S.failStreak++
    pushEvent(`${g.goal} ${e.status}${ok ? '' : ': ' + (e.reason_code ?? e.reason ?? '')}`)
    if (mindOn) {
      if (g.goalId) await mcall({ op: 'goal_finish', id: g.goalId, outcome: ok ? 'done' : e.status === 'failed' ? 'failed' : e.status === 'preempted' ? 'preempted' : 'failed' })
      if (e.status === 'done' || e.status === 'failed') mcall({ op: 'event', type: ok ? 'goal_done' : 'goal_failed', magnitude: 0.6, appraise: false, text: `I tried to ${g.goal.replace(/_/g, ' ')}${g.args && Object.keys(g.args).length ? ' ' + JSON.stringify(g.args) : ''}: ${ok ? 'it worked' : 'it failed (' + (e.reason_code ?? e.reason) + ')'}`, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined, activity: g.goal, goal_type: g.goal, outcome: ok ? 'done' : 'failed', satisfied: [] })
      // she looked at / walked up to / hunted it: that sighting is examined now (else "Not yet examined: sheep" stays in every prompt forever)
      if (ok && ['approach', 'interact', 'look_at', 'hunt'].includes(g.goal) && typeof g.args?.target === 'string' && !/^(player|human)/i.test(g.args.target)) {
        const near = pos ?? me0(); mcall({ op: 'examine', name: g.args.target.replace(/_\d+$/, ''), x: near?.x, z: near?.z, radius: 24 })
      }
      refreshConstraints()
    }
    // failures back off before waking S2 again (no tight failure loops); done goes straight on
    const delay = ok || e.status === 'preempted' ? 0 : Math.min(20000, 1500 * 2 ** Math.min(4, S.failStreak - 1))
    if (delay) await new Promise((r) => setTimeout(r, delay))
    await report(e.intent_id, e.status, e.reason_code ?? 'ok')
  })

  // ---------------------------------------------------------------- 1 Hz mind tick
  let tickBusy = false, lastTickAt = Date.now()
  hooks.events.on('tick', async () => {
    const b = bot()
    if (!mindOn || tickBusy || !b?.entity || !body.spawned) return
    tickBusy = true
    try {
      const now = Date.now(), dt = Math.min(5, (now - lastTickAt) / 1000); lastTickAt = now
      S.hazards = scanHazards(b, 12, 3)
      const p = b.entity.position
      S.ring.push({ t: now, x: p.x, y: p.y, z: p.z, hp: b.health, hazards: S.hazards.filter((h) => h.dist <= 6).map((h) => h.kind) }); if (S.ring.length > 12) S.ring.shift()
      const r = await mcall({ op: 'tick', dt, digest: mindTickDigest(b, { hazards: S.hazards, resting: S.resting }) })
      if (!r.ok) return
      S.stats.ticks++; S.drives = r.result.drives; S.mindT = r.result.t
      for (const ev of r.result.events) {
        if (ev.type === 'drive_threshold') {
          S.stats.drive_wakes++; log('drive_threshold', ev)
          // PB1 priority: while a playbook runs, a hunger wake only goes to S2 when hunger really matters (food <= 6 and hurt / food close); else it is the playbook's "after this" note
          const pbe = app.s1?.playbooks
          if (HIGH && ev.drive === 'hunger' && pbe?.active() && !pbe.hungerWouldInterrupt(bot())) { S.stats.hunger_wakes_deferred = (S.stats.hunger_wakes_deferred ?? 0) + 1; pbe.noteAfterThis(`get food (food ${Math.round(bot().food ?? 0)}/20)`); log('hunger_wake_deferred', { food: bot().food }) }
          else send({ type: 'drive_wake', drive: ev.drive, level: ev.level })
        }
      }
    } finally { tickBusy = false }
  })
  confinedBus.on('rescue_requested', (ev) => { log('rescue_requested', ev); pushEvent(ev.text); trace.event('mindlink_rescue_requested', { dig_dir: ev.dig_dir }) })
  hooks.setDrivesProvider(() => S.drives?.levels)

  // ---------------------------------------------------------------- lessons -> constraints in S1
  let constraintsAt = 0
  async function refreshConstraints() {
    if (!mindOn) return
    constraintsAt = Date.now()
    const r = await mcall({ op: 'constraints' })
    if (r.ok) { S.zones = r.result.zones ?? []; S.lockouts = r.result.lockouts ?? []; if (!S.constraintsLoaded) { S.constraintsLoaded = true; log('constraints_loaded', { zones: S.zones.length, lockouts: S.lockouts.length }) } }
  }
  hooks.addCostProvider((p) => {
    let c = 0
    for (const z of S.zones) {
      const d = zoneDist(p, z)
      if (z.forbid > 0 && d <= z.forbid) return Infinity
      if (d < z.radius) c += (HAZARDS[z.cause] ?? HAZARDS.other).cost * (1 - d / z.radius)
    }
    for (const f of S.fallZones) { // D1: a fall just survived: the cliff edge is a short-lived hazard zone
      if (f.until < Date.now()) continue
      const d = zoneDist(p, { x: f.x, y: f.y, z: f.z })
      if (d <= 1 + f.extent) return Infinity
      if (d < HAZARDS.fall.radius + f.extent) c += HAZARDS.fall.cost * (1 - d / (HAZARDS.fall.radius + f.extent))
    }
    return c
  })
  hooks.setLockoutProvider((intent) => {
    if (HIGH) return null // AI1: lockouts from the mind are advice (pushed to S2 as events), not a veto
    const b = bot(); const me = b?.entity?.position; if (!me || capExempt(intent.goal, intent.args)) return null
    const tok = `${intent.goal}@${cellKey(me.x, me.z)}`
    const l = S.lockouts.find((x) => x.token === tok || (x.type === intent.goal && x.place === cellKey(me.x, me.z)))
    return l ? `mind_lockout:${l.token ?? tok}:${l.reason ?? ''}` : null
  })

  // D1: fast fall tracker (the 1 Hz ring misses a 30-block fall). Keeps the last 8 s of y; a landing after a fall >= 5 blocks becomes a 'fall' hazard.
  const yHist = []
  S.fallZones = []
  let lastGround = null, airFall = false
  const fallTimer = setInterval(() => {
    const b = bot(); const e = b?.entity; if (!e || !body.spawned) return
    const now = Date.now(); yHist.push({ t: now, x: e.position.x, y: e.position.y, z: e.position.z }); while (yHist.length && now - yHist[0].t > 8000) yHist.shift()
    if (e.onGround) {
      if (airFall && lastGround && b.health > 0) {
        const drop = lastGround.y - e.position.y
        if (drop >= 5 && now - (S.lastFallNote ?? 0) > 4000) {
          S.lastFallNote = now
          const extent = Math.min(4, Math.ceil(drop / 10)), cell = { x: Math.floor(lastGround.x), y: Math.floor(lastGround.y), z: Math.floor(lastGround.z) }
          S.fallZones.push({ ...cell, until: now + 600000, extent }); if (S.fallZones.length > 20) S.fallZones.shift()
          log('fall_survived', { drop: +drop.toFixed(1), from: cell, extent })
          pushEvent(`I fell ${Math.round(drop)} blocks near ${cell.x},${cell.z} and survived; that edge is dangerous`)
          if (mindOn) mcall({ op: 'lesson', lesson: { goal_type: S.activity?.goal ?? S.lastHabit ?? 'unknown', x: cell.x, y: cell.y, z: cell.z, result: 'fail', cause: 'fall', approach: 'fell', extent } }).catch(() => {})
        }
      }
      airFall = false; lastGround = { x: e.position.x, y: e.position.y, z: e.position.z }
    } else if (e.velocity?.y < -0.5 && !e.isInWater) { airFall = true; S.fallFlagAt = now }
  }, 250)
  fallTimer.unref?.()

  // death -> episode + lesson with hazard extent
  hooks.events.on('death', async ({ pos }) => {
    S.stats.deaths++
    const b = bot(), ring = S.ring.filter((r) => Date.now() - r.t < 5000)
    const at = pos ? { x: pos[0], y: pos[1], z: pos[2] } : ring.at(-1)
    if (!at) return
    const hz = new Set(ring.flatMap((r) => r.hazards))
    const maxY = Math.max(...ring.map((r) => r.y), ...yHist.filter((r) => Date.now() - r.t < 8000).map((r) => r.y), at.y) // D1: the fast tracker sees falls the 1 Hz ring misses
    let cause = hz.has('lava') ? 'lava' : (hz.has('fire') || hz.has('magma_block')) ? 'fire' : hz.has('cactus') ? 'cactus' : null
    if (!cause && b) {
      const hostile = Object.values(b.entities ?? {}).some((e) => e && e !== b.entity && e.position && entityKind(e)?.cat === 'hostile' && e.position.distanceTo(b.entity.position ?? e.position) < 12)
      const wet = b.blockAt?.(b.entity?.position?.offset?.(0, 1, 0))?.name === 'water'
      cause = maxY - at.y >= 5 && (Date.now() - (S.fallFlagAt ?? 0) < 8000 || ring.some((r) => r.y - at.y >= 5)) ? 'fall' : wet ? 'drown' : hostile ? 'mob' : 'other'
    }
    const fallDrop = maxY - at.y
    const extent = cause === 'fall' ? Math.min(4, Math.ceil(fallDrop / 10)) : b && (cause === 'lava' || cause === 'fire') ? hazardExtent(b, { x: at.x, y: at.y, z: at.z }, cause === 'lava' ? 'lava' : 'fire') : 0
    const activity = S.activity?.goal ?? S.lastHabit ?? 'unknown'
    log('death', { at, cause, extent, activity })
    pushEvent(`I died (${cause}) near ${Math.round(at.x)},${Math.round(at.z)}`)
    if (mindOn) {
      await mcall({ op: 'event', type: 'death', magnitude: 1, text: `I died (${cause}) at ${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)} while doing ${activity}`, pos: at, activity, goal_type: activity, outcome: 'died', damage: 20, importance: 0.95 })
      const l = await mcall({ op: 'lesson', lesson: { goal_type: activity, x: at.x, y: at.y, z: at.z, result: 'death', cause, approach: activity, extent } })
      S.stats.lessons++; log('lesson', { cause, extent, res: l.result })
      for (const [id, g] of S.goals) if (g.goalId) { await mcall({ op: 'goal_finish', id: g.goalId, outcome: 'died' }); S.goals.delete(id) }
      await refreshConstraints()
    }
  })
  body.on('state', (e) => { if (['dead', 'respawning', 'disconnected'].includes(e.to)) send({ type: 'body_state', state: e.to, digest: null }); if (e.to === 'spawned') setTimeout(() => heartbeat('spawn'), 4000).unref?.() })

  // damage / chat / social on the live bot
  body.on('bot', (b) => {
    try { screenOff?.(); screenOff = screen.attach(b) } catch { /* ignore */ }
    b.__hurtBy = hurt; try { S.hurtOff?.(); S.hurtOff = hurt.attach(b, onHurt) } catch { /* ignore */ }
    let lastHp = 20, lastDmgEp = 0
    b.on('health', () => {
      const d = lastHp - b.health; lastHp = b.health
      if (d >= 2 && mindOn && Date.now() - lastDmgEp > 5000) {
        lastDmgEp = Date.now(); const p = b.entity?.position
        mcall({ op: 'event', type: 'damage', magnitude: Math.min(1, d / 10), text: `I took ${d.toFixed(0)} damage${S.hazards[0] && S.hazards[0].dist < 3 ? ' near ' + S.hazards[0].kind : ''} at ${p ? Math.round(p.x) + ',' + Math.round(p.z) : '?'}`, pos: p ? { x: p.x, y: p.y, z: p.z } : undefined, damage: d, hpMin: b.health })
      }
    })
    b.on('chat', (username, message) => { // chat is global: no distance gate (her 48-block hearing range is for VOICE only); distance is passed along when the player is loaded
      if (username === b.username || /^Wren/i.test(username)) return
      const me = b.entity?.position, pp = b.players?.[username]?.entity?.position, d = me && pp ? Math.round(pp.distanceTo(me)) : null
      chatLog({ dir: 'in', name: username, dist: d, text: String(message).slice(0, 500), via: 'chat' })
      onHuman(username, message, { via: 'chat', dist: d ?? undefined })
    })
    b.on('playerJoined', (pl) => { if (pl.username !== b.username && !/^Wren/i.test(pl.username)) pushEvent(`${sn(pl.username)} joined the server`) })
    b.on('playerLeft', (pl) => { if (pl.username !== b.username && !/^Wren/i.test(pl.username)) pushEvent(`${sn(pl.username)} left the server`) })
  })

  // habit activity -> episodes (memory of what she actually did), resting flag for the energy drive, last activity for death lessons
  const origRun = runner.run.bind(runner)
  const QUIET = new Set(['gesture', 'look_at', 'idle_activity', 'set_home'])
  runner.run = async (name, args, o) => {
    S.activity = { goal: name, status: 'running', owner: o?.owner }
    const rest = (name === 'idle_activity' && (args?.kind === 'rest' || args?.kind === 'sit')) || name === 'shelter' // waiting out the night sealed in a pillbox is rest too
    if (rest) S.resting = true
    const t0 = Date.now(), p0 = bot()?.entity?.position?.clone?.() ?? null, inv0 = invCounts(bot()?.inventory?.items?.())
    const res = await origRun(name, args, o)
    S.resting = false; S.activity = { goal: name, status: res.status, owner: o?.owner }
    // M4: an aborted skill that ran >= 30 s or made progress still happened to her: one compact 'aborted' episode (deduped, rate limited, not appraised again)
    if (mindOn && res.status === 'aborted' && !QUIET.has(name)) {
      try {
        const p1 = bot()?.entity?.position
        const ep = S.aborts.note({ goal: name, reason: res.reason, ms: res.ms ?? Date.now() - t0, moved: p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : 0, gains: invGain(inv0, invCounts(bot()?.inventory?.items?.())) })
        if (ep) writeAbortEpisode(ep, p1)
      } catch (e) { log('error_abort_episode', { error: String(e?.message ?? e) }) }
    }
    if (o?.owner === 's1') {
      S.lastHabit = name
      if (mindOn && !QUIET.has(name) && (res.status === 'done' || res.status === 'failed')) {
        S.stats.habits_logged++
        const p = bot()?.entity?.position
        mcall({ op: 'event', type: res.status === 'done' ? 'activity' : 'frustration', magnitude: 0.1, text: `Routine: ${name.replace(/_/g, ' ')} ${res.status === 'done' ? 'done' : 'failed (' + res.reason + ')'}`, activity: name, goal_type: name, outcome: res.status, pos: p && { x: p.x, y: p.y, z: p.z } })
      }
    }
    return res
  }

  function writeAbortEpisode(ep, p) {
    S.stats.aborted_episodes++
    mcall({ op: 'event', type: 'activity', magnitude: 0.1, appraise: false, text: ep.text, activity: ep.goal, goal_type: ep.goal, outcome: 'aborted', pos: p && { x: p.x, y: p.y, z: p.z } })
  }

  // ---------------------------------------------------------------- discoveries (from HER observations)
  async function sightings() {
    const b = bot(); if (!mindOn || !b?.entity || !body.spawned) return
    let changed = false
    for (const s of scanSightings(b)) {
      const key = `${s.kind}:${s.name}`
      await mcall({ op: 'sighting', sighting: s })
      if (!S.seen.has(key)) {
        S.seen.add(key); changed = true; S.stats.discoveries++
        if (HIGH && s.kind === 'structure' && Date.now() - S.lastBeatAt > 15000) { S.stats.event_beats++; heartbeat('new_structure') }
        mcall({ op: 'event', type: 'discovery', magnitude: 0.5, text: `I saw ${s.name.replace(/_/g, ' ')} for the first time near ${Math.round(s.x)},${Math.round(s.z)}`, pos: { x: s.x, y: s.y, z: s.z }, novelty: true })
        pushEvent(`first time seeing ${s.name.replace(/_/g, ' ')}`)
      }
    }
    if (changed) try { fs.writeFileSync(S.seenFile, JSON.stringify([...S.seen])) } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- context, heartbeat, sleep pass, stats
  async function pushContext() {
    const b = bot(); if (!mindOn || !brainOn || !b?.entity) return
    const r = await mcall({ op: 'digest', raw: mindRawDigest(b, { hazards: S.hazards, confined: confinedNote(b) }) })
    if (!r.ok) return
    const d = r.result, mem = []
    for (const c of d.core ?? []) mem.push(c)
    for (const l of d.lessons ?? []) mem.push(`I once ${l.what === 'death' || String(l.what).startsWith('death') ? 'died' : 'failed'} while doing ${l.goal}${String(l.what).includes(':') ? ' (' + String(l.what).split(':')[1] + ')' : ''}${Array.isArray(l.at) ? ` at ${l.at.join(',')}` : ''}${l.ago || l.dist != null ? ` (${[l.ago, l.dist != null ? l.dist + ' m from here' : null].filter(Boolean).join(', ')})` : ''}`)
    for (const w of d.wants ?? []) mem.push(/^\(/.test(w) ? w.replace(/^(\([^)]*\)) /, '$1 I wanted: ') : `I wanted: ${w}`)
    for (const p of d.preferences ?? []) mem.push(`I seem to enjoy ${p}`)
    for (const c of d.curiosity ?? []) mem.push(`Not yet examined: ${c.what} at ${c.at.join(',')} (${c.dist}m away)`)
    for (const e of d.episodes ?? []) mem.push(e)
    const around = Object.keys(bot()?.players ?? {}).filter((n) => n !== bot().username && !/^Wren/i.test(n) && !isIgnoredPlayer(n))
    for (const l of people.nearbyLines(around)) mem.unshift('People you know nearby: ' + l)
    const ctx = { self_summary: d.self_summary ?? '', self_summary_age_s: d.self_summary_age_s ?? undefined, memories: mem.slice(0, 14) }
    if (HIGH && brain.last?.goals_rev === 0 && (S.gstore?.goals?.length || S.goalsStored?.goals?.length)) ctx.goals_restore = S.gstore?.goals?.length ? S.gstore : S.goalsStored
    if (S.goalsReplace && (S.gstore?.reviewSeq ?? 0) < (S.goalsReplace.reviewSeq ?? 0)) ctx.goals_replace = S.goalsReplace; else S.goalsReplace = null
    S.ctx = ctx
    await brain.postContext(ctx)
  }
  async function heartbeat(why = 'timer') {
    if (!brainOn || !body.spawned || !bot()?.entity) return
    S.stats.heartbeats++; S.lastBeatAt = Date.now(); log('heartbeat', { why })
    await pushContext().catch(() => {})
    await send({ type: 'heartbeat' })
    S.nextHeartbeatMs = 45000 + Math.floor(Math.random() * 45000) // 45-90 s
  }
  let sleeping = false
  async function sleepPass(reason = 'night') {
    if (!mindOn || sleeping) return null
    sleeping = true
    try {
      S.stats.sleep_passes++; log('sleep_pass_start', { reason })
      const r = await mcall({ op: 'sleep' }, 150000)
      S.lastSleepMindT = r.ok && r.result?.error ? S.mindT - 1.6 * 1200 + 300 : S.mindT // a failed reflection is retried after ~5 game minutes, a good one after the next night
      const res = r.ok ? r.result : { error: r.error }
      log('sleep_pass_done', { reason, applied: res.applied, error: res.error, merged: res.merged, pruned: res.pruned, digest_empty: res.digest?.empty })
      if (res.error) S.stats.sleep_errors++
      if (res.applied?.self_summary) {
        const j = path.join(dir, 'mind-journal.md')
        const sm = await mcall({ op: 'digest', raw: mindRawDigest(bot(), { hazards: [] }) })
        try { fs.appendFileSync(j, `\n## ${new Date().toISOString()} (day ${timePhase(bot()).day}, ${reason})\n${sm.ok ? sm.result.self_summary : ''}\n`) } catch { /* ignore */ }
        await pushContext().catch(() => {})
      }
      try { // G2: the nightly review may have changed the long-term goals in the mind's store: hand that version to the brain
        const gl = await mcall({ op: 'goals_load' })
        if (gl.ok && (gl.result?.snapshot?.reviewSeq ?? 0) > (S.gstore?.reviewSeq ?? 0)) { S.goalsReplace = gl.result.snapshot; log('goals_review_applied', { reviewSeq: S.goalsReplace.reviewSeq }); await pushContext().catch(() => {}) }
      } catch { /* ignore */ }
      await refreshConstraints()
      return res
    } finally { sleeping = false }
  }
  const humansOnline = () => Object.values(bot()?.players ?? {}).filter((p) => p.username !== bot().username && !/^Wren/i.test(p.username)).length
  function writeStats() {
    try {
      const f = path.join(dir, 'mindlink.json')
      fs.writeFileSync(f + '.tmp', JSON.stringify({ t: new Date().toISOString(), autonomy: AUTONOMY, goals_active: (S.gstore?.goals ?? []).filter((g) => g.status === 'active').length, mode: S.s2Offline || !brain.last || brain.errors >= 3 ? 'habits' : 's2', s2_offline: S.s2Offline, brain_errors_in_row: brain.errors, brain_last_ok_ago_s: brain.lastOkAt ? Math.round((Date.now() - brain.lastOkAt) / 1000) : null, mind_up: mind.up, mind_restarts: mind.restarts, drives: S.drives, zones: S.zones.length, lockouts: S.lockouts.length, stack: stack.metrics(), objective: stack.view(), live_intent: intents.hasLive(), stats: S.stats, voice: voice ? { connected: voice.connected, service_up: voice.serviceUp, chat_mode: voice.chatMode, conversing: vbody.who(), ...voice.stats, last_latency: voice.recentLatency ?? null, body: vbody.stats } : null }, null, 1))
      fs.renameSync(f + '.tmp', f)
    } catch { /* ignore */ }
  }

  const timers = []
  return {
    S, mind, brain, handleIntent, chatSay, voice, vbody, people, onHuman, say, heartbeat, sleepPass, pushContext, refreshConstraints, writeStats,
    start() {
      if (mindOn) mind.start()
      if (voice) voice.start(voiceHandlers)
      if (brainOn) brain.start()
      // L1: lesson zones must be in force from the first seconds (status showed zones 0 until the first 5 s tick found the mind child up)
      if (mindOn) timers.push(setInterval(() => { if (!S.constraintsLoaded) refreshConstraints() }, 1000))
      timers.push(setInterval(() => { if (Date.now() - constraintsAt > 15000) refreshConstraints() }, 5000))
      timers.push(setInterval(() => { if (mindOn) mind.call({ op: 'save' }) }, 60000))
      timers.push(setInterval(sightings, 2000))
      timers.push(setInterval(() => { // AI1: new surroundings wake S2
        const b = bot(); if (!HIGH || !b?.entity || !body.spawned) return
        let bn = null; try { bn = b.blockAt(b.entity.position)?.biome?.name ?? null } catch { /* ignore */ }
        if (bn && S.lastBiome && bn !== S.lastBiome && Date.now() - S.lastBeatAt > 15000) { pushEvent(`you have entered a ${bn.replace(/_/g, ' ')} area`); S.stats.event_beats++; heartbeat('new_biome') }
        if (bn) S.lastBiome = bn
      }, 4000))
      timers.push(setInterval(async () => { if (!HIGH || !mindOn || S.goalsLoaded) return; const r = await mind.call({ op: 'goals_load' }); if (r.ok) { S.goalsLoaded = true; S.goalsStored = r.result?.snapshot ?? null } }, 2000))
      timers.push(setInterval(drainSpeech, 2000))
      if (HIGH) { timers.push(setInterval(() => { stack.tick().catch(() => {}) }, 1000)); timers.push(setInterval(() => stack.logMetrics(), 60000)) }
      timers.push(setInterval(commitmentTick, 4000))
      timers.push(setInterval(() => { if (mindOn) for (const ep of S.aborts.flush()) writeAbortEpisode(ep, bot()?.entity?.position) }, 30000))
      timers.push(setInterval(writeStats, 10000))
      timers.push(setInterval(() => { // operator/test trigger: write 'sleep_pass' or 'heartbeat' into <runtimeDir>/mindlink.trigger
        const f = path.join(dir, 'mindlink.trigger')
        let t; try { t = fs.readFileSync(f, 'utf8').trim(); fs.unlinkSync(f) } catch { return }
        log('trigger', { what: t })
        if (t === 'sleep_pass') sleepPass('trigger'); else if (t === 'heartbeat') heartbeat('trigger')
      }, 3000))
      timers.push(setInterval(() => { // heartbeat: 45-90 s; with a live S2 intent only after 150 s so a long walk is not cut short
        const gap = Date.now() - S.lastBrainEventAt
        if (HIGH && !intents.hasLive() && !app.s1?.active() && body.spawned && gap >= 45000 && Date.now() - S.lastBeatAt >= 45000) { S.stats.idle_beats++; heartbeat('idle'); return } // AI1: think again after ~45 s of idleness
        if (gap >= S.nextHeartbeatMs && ((!intents.hasLive() && !app.s1?.active()) || gap >= 150000)) heartbeat('timer')
      }, 5000))
      timers.push(setInterval(() => { // nightly sleep pass (game night, nobody human on the server); fallback every 1.6 game days if the sky never turns dark
        const b = bot(); if (!mindOn || !b?.entity || !body.spawned) return
        const tp = timePhase(b)
        const due = tp.night && S.lastSleepDay !== tp.day
        const stale = S.lastSleepMindT !== null && S.mindT - S.lastSleepMindT > 1.6 * 1200
        if ((due || stale) && humansOnline() === 0) { S.lastSleepDay = tp.day; sleepPass(due ? 'night' : 'stale') }
        else if (S.lastSleepMindT === null && S.mindT > 0) S.lastSleepMindT = S.mindT
      }, 20000))
      log('start', { mind: mindOn, brain: brainOn, db: mind.dbPath, autonomy: AUTONOMY }); trace.event('autonomy', { mode: AUTONOMY })
    },
    async stop() {
      for (const t of timers) clearInterval(t)
      voice?.stop(); brain.stop(); writeStats()
      try { fs.writeFileSync(S.seenFile, JSON.stringify([...S.seen])) } catch { /* ignore */ }
      runner.run = origRun
      await mind.stop()
      log('stop')
    },
  }
}
