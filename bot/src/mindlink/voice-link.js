// VINT: Wren's voice link. Client of the voice service (voice/, HTTP 127.0.0.1:19521): speech out (POST /speak), speech in (long-poll GET /heard),
// status (GET /status), cut-off (POST /flush). Pure plumbing + decisions, no bot access: index.js wires it. Zero deps (Node >= 22 fetch).
// Degrades silently: when the service is down every call resolves {ok:false}; nothing throws, the mindlink falls back to in-game chat.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** SEC1: shared secret for the voice API (env VOICE_TOKEN, else VOICE_TOKEN=... in voice/secrets.env, mode 600, gitignored; override path with VOICE_SECRETS_FILE). '' = none. */
export function loadVoiceToken(env = process.env, file = env.VOICE_SECRETS_FILE || fileURLToPath(new URL('../../../voice/secrets.env', import.meta.url))) {
  if (env.VOICE_TOKEN) return env.VOICE_TOKEN.trim()
  try { const m = fs.readFileSync(file, 'utf8').match(/^VOICE_TOKEN=(.*)$/m); return m ? m[1].trim() : '' } catch { return '' }
}
/** Headers for every call to the voice service: token always (an unauthenticated old service ignores it), JSON content-type on POST. */
export function voiceHeaders(token = loadVoiceToken(), post = false) {
  return { ...(token ? { 'x-voice-token': token } : {}), ...(post ? { 'content-type': 'application/json' } : {}) }
}

const STAGE_RES = [/\*[^*\n]{0,80}\*/g, /_[^_\n]{1,80}_/g, /\([^()\n]{0,80}\)/g, /\[[^\[\]\n]{0,80}\]/g, /<[^<>\n]{0,80}>/g]
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu

/** Text for the mouth: no stage directions, no emoji, no speaker label, at most `maxSentences` sentences and `maxChars` characters. */
export function voiceText(text, { maxSentences = 2, maxChars = 220 } = {}) {
  let t = String(text ?? '')
  for (const re of STAGE_RES) t = t.replace(re, ' ')
  t = t.replace(EMOJI_RE, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/^\s*(wren|me)\s*:\s*/i, '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const sents = t.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [t]
  let out = sents.slice(0, maxSentences).join(' ')
  if (out.length > maxChars) {
    const first = sents[0]
    if (first.length <= maxChars) out = first
    else { const head = out.slice(0, maxChars); const sp = head.lastIndexOf(' '); out = (sp > 40 ? head.slice(0, sp) : head).replace(/[,;:\s]+$/, '') + '.' }
  }
  return out
}

export const CHAT_MODES = ['on', 'off', 'fallback']
export const normChatMode = (m) => (CHAT_MODES.includes(String(m ?? '').toLowerCase()) ? String(m).toLowerCase() : 'fallback')

export class VoiceLink {
  /** opts: url, chatMode (on|off|fallback), log(ev,data), now(), fetchFn, timeoutMs, statusMs, answerPriority ('urgent'|'normal') */
  constructor({ url = 'http://127.0.0.1:19521', chatMode = 'fallback', log = () => {}, now = Date.now, fetchFn = (...a) => fetch(...a), timeoutMs = 2500, statusMs = 500, answerPriority = 'normal', token = loadVoiceToken() } = {}) {
    Object.defineProperty(this, 'token', { value: token, enumerable: false })
    Object.assign(this, { url: url.replace(/\/$/, ''), chatMode: normChatMode(chatMode), log, now, fetchFn, timeoutMs, statusMs, answerPriority })
    this.status = null; this.statusAt = 0; this.statusFails = 0
    this.running = false; this.since = null; this.ac = null
    this.handlers = {}
    this.metrics = []          // pending reply-latency measurements
    this.lastUnspokenTs = null
    this.stats = { speak: 0, speak_urgent: 0, speak_failed: 0, flush: 0, heard: 0, heard_addressed: 0, heard_ambient: 0, interrupts: 0, replies_timed: 0, down_polls: 0 }
    this.lastSpeakPriority = null
    this.pollStop = false
  }

  /** The voice path can carry speech right now (service reachable, mod connected, bot known to the mod). */
  get connected() {
    return !!this.status && this.now() - this.statusAt < 6000 && this.status.connected_mod === true && this.status.bot_online !== false
  }
  get serviceUp() { return !!this.status && this.now() - this.statusAt < 6000 }

  async #req(method, path, body, timeoutMs = this.timeoutMs) {
    try {
      const r = await this.fetchFn(this.url + path, { method, headers: voiceHeaders(this.token, method === 'POST'), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
      const j = await r.json().catch(() => null)
      return r.ok ? { ok: true, data: j } : { ok: false, status: r.status, error: j?.error ?? 'http_' + r.status }
    } catch (e) { return { ok: false, error: String(e?.cause?.code ?? e?.message ?? e) } }
  }

  async refresh() {
    const r = await this.#req('GET', '/status')
    if (!r.ok || !r.data) { this.statusFails++; this.status = null; return null }
    const was = this.connected
    this.status = r.data; this.statusAt = this.now(); this.statusFails = 0
    if (was !== this.connected) this.log('voice_connected', { connected: this.connected, mod: r.data.connected_mod, bot_online: r.data.bot_online })
    this.#afterStatus(r.data)
    return r.data
  }

  #afterStatus(st) {
    // service restarted (ids start again at 1): do not wait for ids that will never come
    if (this.since !== null && st.heard_last_id < this.since) { this.log('voice_heard_reset', { was: this.since, now: st.heard_last_id }); this.since = st.heard_last_id }
    // the service cut her off by its own rules (barge-in): the unspoken remainder goes to the brain
    const u = st.unspoken
    if (this.lastUnspokenTs === null) this.lastUnspokenTs = u?.ts ?? 0
    else if (u && u.ts > this.lastUnspokenTs) {
      this.lastUnspokenTs = u.ts
      if (!this.ownFlushTs || Math.abs(u.ts - this.ownFlushTs) > 1500) this.#interrupted(u, 'service')
    }
    // reply latency: tts_first_ms is final once it changed after our /speak
    for (const m of [...this.metrics]) {
      const tf = st.last_latency_ms?.tts_first_ms
      const done = (tf != null && (tf !== m.ttsBefore || this.now() - m.postedAt > 700)) || this.now() - m.postedAt > 6000
      if (!done) continue
      this.metrics.splice(this.metrics.indexOf(m), 1)
      const tts = tf != null && tf !== m.ttsBefore ? tf : null
      const lat = m.heard ? { endpoint_ms: m.heard.endpoint_ms, stt_ms: m.heard.stt_ms } : {}
      const eos_to_audio_ms = m.heard && tts != null && lat.endpoint_ms != null && lat.stt_ms != null ? Math.round(lat.endpoint_ms + lat.stt_ms + (m.postedAt - m.heard.receivedAt) + tts) : null
      this.stats.replies_timed++
      this.log('voice_latency', { utt_id: m.utt_id, in_reply_to: m.inReplyTo, ...lat, brain_ms: m.heard ? m.postedAt - m.heard.receivedAt : null, tts_first_ms: tts, eos_to_audio_ms })
      this.recentLatency = { utt_id: m.utt_id, eos_to_audio_ms, tts_first_ms: tts, ...lat }
    }
    this.handlers.onStatus?.(st)
  }

  #interrupted(u, by) {
    this.stats.interrupts++
    const ev = { utt_id: u.utt_id, spoken: u.spoken ?? '', unspoken: u.text ?? '', why: u.why ?? by, by, ...(u.auto_resume ? { auto_resume: true } : {}) }
    this.log('voice_interrupted', ev)
    if (ev.unspoken) this.handlers.onInterrupted?.(ev)
  }

  /** Say it. -> {ok, utt_id}. `text` is trimmed for the mouth here. */
  async speak(text, { urgent = false, inReplyTo = null, heard = null, importance = null, kind = null } = {}) {
    const t = voiceText(text)
    if (!t) return { ok: false, error: 'empty_after_trim' }
    const priority = urgent ? 'urgent' : 'normal'
    const ttsBefore = this.status?.last_latency_ms?.tts_first_ms ?? null
    const r = await this.#req('POST', '/speak', { text: t, priority, ...(inReplyTo != null ? { in_reply_to: inReplyTo } : {}), ...(Number.isFinite(importance) ? { importance } : {}), ...(kind ? { kind } : {}) })
    if (!r.ok) { this.stats.speak_failed++; this.log('voice_speak_failed', { error: r.error, text: t }); return { ok: false, error: r.error } }
    this.stats.speak++; if (urgent) this.stats.speak_urgent++
    this.lastSpeakPriority = priority; this.lastSpokenAt = this.now()
    const utt_id = r.data?.utt_id ?? null
    this.log('voice_speak', { utt_id, priority, in_reply_to: inReplyTo, text: t })
    if (inReplyTo != null || heard) this.metrics.push({ utt_id, inReplyTo, heard, postedAt: this.now(), ttsBefore })
    return { ok: true, utt_id, text: t, priority }
  }

  /** Cut everything off. -> {ok, interrupted} (the unspoken remainder, also reported to the brain). */
  async flush(why = 'flush') {
    const r = await this.#req('POST', '/flush', {})
    if (!r.ok) return { ok: false, error: r.error }
    this.stats.flush++
    const i = r.data?.interrupted ?? null
    this.log('voice_flush', { why, flushed: r.data?.flushed, interrupted: i })
    if (i) { this.ownFlushTs = i.ts ?? this.now(); if (i.text) this.#interrupted({ ...i, ts: this.ownFlushTs, why }, 'bot') }
    return { ok: true, interrupted: i }
  }

  /** True while a NORMAL (cuttable) utterance of hers is being spoken or queued. */
  get speakingNormal() {
    const s = this.status
    return !!s && (s.speaking || s.queue_len > 0) && this.lastSpeakPriority !== 'urgent'
  }

  /** handlers: {onAddressed(item), onAmbient(item), onInterrupted(ev), onStatus(st)} */
  start(handlers = {}) {
    if (this.running) return this
    this.running = true; this.handlers = handlers
    this.#statusLoop(); this.#heardLoop()
    return this
  }
  stop() { this.running = false; this.ac?.abort() }

  async #statusLoop() {
    while (this.running) {
      const st = await this.refresh().catch(() => null)
      if (!st) this.stats.down_polls++
      await this.#sleep(st ? this.statusMs : 3000)
    }
  }

  async #heardLoop() {
    while (this.running) {
      if (this.since === null) { // start AFTER what was said before we came up
        const st = this.status ?? (await this.refresh())
        if (!st) { await this.#sleep(1500); continue }
        this.since = st.heard_last_id ?? 0
      }
      this.ac = new AbortController()
      let r
      try {
        const res = await this.fetchFn(`${this.url}/heard?since=${this.since}&wait=25`, { headers: voiceHeaders(this.token), signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(32000)]) })
        r = res.ok ? await res.json() : null
      } catch { r = null }
      if (!this.running) return
      if (!Array.isArray(r)) { await this.#sleep(2000); continue }
      if (r.length) await this.refresh() // fresh endpoint_ms / stt_ms for the reply-latency metric
      for (const it of r) {
        if (it.id > this.since) this.since = it.id
        this.stats.heard++
        const item = { ...it, receivedAt: this.now(), endpoint_ms: this.status?.last_latency_ms?.endpoint_ms ?? null, stt_ms: this.status?.last_latency_ms?.stt_ms ?? null }
        this.log('voice_heard', { id: it.id, name: it.name, dist: it.dist, addressed: it.addressed, text: it.text })
        try {
          if (it.addressed) { this.stats.heard_addressed++; await this.handlers.onAddressed?.(item) }
          else { this.stats.heard_ambient++; await this.handlers.onAmbient?.(item) }
        } catch (e) { this.log('error_voice_handler', { error: String(e?.message ?? e) }) }
      }
    }
  }
  #sleep(ms) { return new Promise((res) => { const t = setTimeout(res, ms); t.unref?.() }) }
}
