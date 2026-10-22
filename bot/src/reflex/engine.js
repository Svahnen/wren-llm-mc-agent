// ReflexEngine: ticks the reflex checks in priority order and runs the winner as owner 'reflex' on the arbiter.
// Guarantees: one reflex at a time; a higher-priority reflex supersedes a running lower one; every run is bounded
// (maxMs), ends with stopBody() + token release (no stuck control states); per-reflex cooldown with jitter;
// pausing (flag / handle) for non-critical reflexes; interruption events "your action X was interrupted by Y".
import { EventEmitter } from 'node:events'
import { stopBody } from '../body-control.js'
import { errInfo } from '../util.js'
import { DEFAULTS } from './defaults.js'

export class ReflexEngine extends EventEmitter {
  constructor({ body, arbiter, trace = null, metrics = null, reflexes, danger, cfg = {}, rng = Math.random, now = Date.now }) {
    super()
    this.body = body; this.arbiter = arbiter; this.trace = trace; this.metrics = metrics
    this.reflexes = [...reflexes].sort((a, b) => b.priority - a.priority)
    this.danger = danger
    this.cfg = { ...DEFAULTS, ...cfg }
    this.rng = rng; this.now = now
    this.state = {} // shared scratch for reflexes (flee log, flags)
    this.cooldownUntil = new Map()
    this.stats = Object.fromEntries(this.reflexes.map((r) => [r.name, { fired: 0, ok: 0, failed: 0, aborted: 0, last: null }]))
    this.current = null // {reflex, abort, promise, startedAt}
    this.pauses = new Set()
    this.queue = [] // recent events (ring of 100) for S1/S2 digests: drainEvents()
    this.timer = null
    this.ticking = false
    this.disabled = new Set()
    this._onPreempted = (h, by) => {
      if (h.owner !== 'reflex' && typeof by === 'string' && by.startsWith('reflex:')) {
        const name = by.slice(7)
        this.#event('reflex_interrupt', { action: h.label, owner: h.owner, by: name, text: `your action ${h.label} was interrupted by ${name}` })
      }
    }
    arbiter.on?.('preempted', this._onPreempted)
    this._onState = (e) => { if (e.to !== 'spawned') this.current?.abort.abort(`state:${e.to}`) }
    body.on?.('state', this._onState)
    this._onBot = (bot) => {
      this.state.lastHealth = 20
      bot.on('health', () => {
        if (bot.health < (this.state.lastHealth ?? 20)) this.state.lastDamageAt = this.now()
        this.state.lastHealth = bot.health
      })
    }
    body.on?.('bot', this._onBot)
    if (body.bot && body.bot.on && !body.bot.__reflexAttached) { body.bot.__reflexAttached = true; this._onBot(body.bot) }
  }

  get paused() { return this.pauses.size > 0 }
  set paused(v) {
    if (v) { if (!this._flagPause) this._flagPause = this.pause({ names: 'soft', reason: 'flag' }) } else { this._flagPause?.resume(); this._flagPause = null }
  }

  /**
   * Pause reflexes so a long action can own a behaviour. names: 'soft' (all non-critical), 'all' (needs force for critical),
   * or an array of reflex names. Critical reflexes (lava_fire, suffocation, falling_block, drowning) are only paused with force:true.
   * A pause expires after ttlMs (default 120 s) so a crashed skill can never disable the reflexes forever.
   */
  pause({ names = 'soft', reason = 'pause', force = false, ttlMs = 120000 } = {}) {
    const p = { names, reason, force }
    this.pauses.add(p)
    const timer = setTimeout(() => handle.resume(), ttlMs); timer.unref?.()
    const handle = { reason, resume: () => { clearTimeout(timer); if (this.pauses.delete(p)) this.trace?.event('reflex_resume', { reason }) } }
    this.trace?.event('reflex_pause', { names, reason, force })
    if (this.current && this.isPaused(this.current.reflex)) this.current.abort.abort('paused')
    return handle
  }
  isPaused(r) {
    if (this.disabled.has(r.name)) return true
    for (const p of this.pauses) {
      if (r.critical && !p.force) continue
      if (p.names === 'all' || (p.names === 'soft' && !r.critical) || (Array.isArray(p.names) && p.names.includes(r.name))) return true
    }
    return false
  }

  #event(type, f) {
    const rec = { type, t: this.now(), ...f }
    this.queue.push(rec); if (this.queue.length > 100) this.queue.shift()
    this.trace?.event(type, f)
    try { this.emit('event', rec) } catch { /* listener errors never reach the engine */ }
    return rec
  }
  /** Public event emitter for reflex checks that only want to inform S1/S2 (no body needed, no preemption). */
  note(type, f = {}) { return this.#event(type, f) }
  /** Events since the last call (reflex_interrupt / reflex_end ...), for the S1/S2 digest. */
  drainEvents() { const q = this.queue; this.queue = []; return q }

  start() { if (!this.timer) { this.timer = setInterval(() => this.tick(), this.cfg.tickMs); this.timer.unref?.() } return this }
  async stop() {
    clearInterval(this.timer); this.timer = null
    this.arbiter.off?.('preempted', this._onPreempted)
    this.body.off?.('state', this._onState); this.body.off?.('bot', this._onBot)
    if (this.current) { this.current.abort.abort('engine_stop'); await this.current.promise.catch(() => {}) }
  }

  #cooldown(r, failed) {
    const base = failed ? r.failCooldownMs ?? r.cooldownMs : r.cooldownMs
    const j = this.cfg.cooldownJitter
    this.cooldownUntil.set(r.name, this.now() + Math.round(base * (1 + (this.rng() * 2 - 1) * j)))
  }

  /** One evaluation pass (exported for tests). Returns the started run's promise or null. */
  tick() {
    if (this.ticking) return null
    this.ticking = true
    try {
      if (!this.body.spawned && this.body.state !== undefined && this.body.state !== 'spawned') return null
      const bot = this.body.bot
      if (!bot?.entity) return null
      const env = { bot, danger: this.danger, cfg: this.cfg, now: this.now, state: this.state, rng: this.rng, engine: this }
      for (const r of this.reflexes) {
        if (this.current && r.priority <= this.current.reflex.priority) break // nothing at or below the running one can start
        if (this.isPaused(r)) continue
        if ((this.cooldownUntil.get(r.name) ?? 0) > this.now()) continue
        let info = null
        try { info = r.check(env) } catch (e) { this.trace?.event('reflex_check_error', { name: r.name, ...errInfo(e) }); continue }
        if (!info) continue
        if (this.current) { // supersede the lower-priority reflex that is running
          if (this.current.abort.signal.aborted) return null // SURV3: already told to stop (live: 20 identical events in 2 s while its last action finished); wait for it
          this.#event('reflex_superseded', { name: this.current.reflex.name, by: r.name })
          this.current.abort.abort(`superseded_by:${r.name}`)
          return null // it finishes, the next tick starts the winner
        }
        this.current = { reflex: r, abort: new AbortController(), startedAt: this.now(), promise: null }
        const cur = this.current
        cur.promise = this.#run(r, info, cur, env).finally(() => { if (this.current === cur) this.current = null })
        return cur.promise
      }
      return null
    } finally { this.ticking = false }
  }

  async #run(r, info, cur, env) {
    const t0 = this.now()
    const stat = this.stats[r.name]
    stat.fired++
    const token = await this.arbiter.acquire('reflex', { label: r.name })
    if (!token) { this.#cooldown(r, true); return }
    this.trace?.event('reflex_start', { name: r.name, info: safeInfo(info) })
    const timeout = setTimeout(() => cur.abort.abort('max_ms'), r.maxMs)
    const signal = AbortSignal.any([cur.abort.signal, token.signal])
    const sleep = (ms) => new Promise((res) => {
      if (signal.aborted) return res(false)
      const t = setTimeout(() => { signal.removeEventListener('abort', on); res(true) }, ms)
      const on = () => { clearTimeout(t); res(false) }
      signal.addEventListener('abort', on, { once: true })
    })
    const ctx = { ...env, signal, sleep, token, log: (type, f = {}) => this.trace?.event(type, { reflex: r.name, ...f }) }
    let res
    try { res = await r.run(ctx, info) } catch (e) { res = { ok: false, reason: 'exception', error: errInfo(e) } }
    clearTimeout(timeout)
    if (!res || typeof res !== 'object') res = { ok: !!res, reason: 'unspecified' }
    const aborted = signal.aborted
    try { stopBody(env.bot) } catch { /* ignore */ }
    token.release()
    if (aborted) stat.aborted++; else if (res.ok) stat.ok++; else stat.failed++
    stat.last = { ...res, ms: this.now() - t0 }
    this.#cooldown(r, !res.ok)
    this.#event('reflex_end', { name: r.name, ok: !!res.ok, reason: res.reason, ms: this.now() - t0, aborted, abort_reason: aborted ? String(signal.reason) : undefined })
  }

  /** Test helper: wait until no reflex is running. */
  async idle(timeoutMs = 5000) {
    const t0 = Date.now()
    while (this.current && Date.now() - t0 < timeoutMs) await this.current.promise.catch(() => {})
  }
}

function safeInfo(i) { try { return JSON.parse(JSON.stringify(i, (k, v) => (v && typeof v === 'object' && v.constructor?.name === 'Vec3' ? [v.x, v.y, v.z] : v))) } catch { return null } }
