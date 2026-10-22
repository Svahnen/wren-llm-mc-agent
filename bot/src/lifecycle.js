// Body lifecycle state machine: connecting / spawned / dead / respawning / disconnected.
// Owns the bot object per connection ("generation"), reconnects with exponential backoff + jitter,
// and emits 'state' synchronously on every change so listeners can cancel running skills.
//
// Events:  'bot' (bot, gen)            a fresh bot was created: load plugins NOW (before it logs in)
//          'state' ({from,to,reason,bot,gen})
//          'spawn' (bot)               every spawn packet, also while already 'spawned' (dimension change)
import { EventEmitter } from 'node:events'
import { errInfo } from './util.js'

export const STATES = Object.freeze(['connecting', 'spawned', 'dead', 'respawning', 'disconnected'])

export class Body extends EventEmitter {
  /**
   * @param {{createBot:()=>any, trace?:any, reconnect?:{baseMs:number,maxMs:number,factor:number,jitter:number},
   *          connectTimeoutMs?:number, stableMs?:number, rng?:()=>number}} o
   */
  constructor({ createBot, trace = null, reconnect = {}, connectTimeoutMs = 30000, stableMs = 30000, rng = Math.random }) {
    super()
    this.createBot = createBot
    this.trace = trace
    this.reconnectCfg = { baseMs: 1000, maxMs: 60000, factor: 2, jitter: 0.2, ...reconnect }
    this.connectTimeoutMs = connectTimeoutMs
    this.stableMs = stableMs
    this.rng = rng
    this.state = 'disconnected'
    this.bot = null
    this.gen = 0
    this.attempt = 0 // consecutive failed attempts (reset after stableMs spawned)
    this.stopping = false
    this.lastKick = null
    this.timers = { connect: null, reconnect: null, stable: null, errEnd: null }
    this.finalized = new Set()
  }

  start() {
    this.stopping = false
    if (this.state !== 'disconnected' || this.timers.reconnect) return
    this.#connect()
  }

  /** Graceful stop: no more reconnects, quit the bot, resolve when disconnected (bounded). */
  async stop(reason = 'stop') {
    this.stopping = true
    this.#clearTimers()
    const bot = this.bot
    const gen = this.gen
    if (bot && this.state !== 'disconnected') {
      const ended = new Promise((r) => bot.once?.('end', r))
      try { bot.quit(reason) } catch { /* ignore */ }
      await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))])
      try { bot.end?.(reason) } catch { /* ignore */ }
    }
    this.#finalize(gen, reason)
    this.#setState('disconnected', reason)
  }

  /** Drop the current connection on purpose (fault injection / tests). Reconnect follows. */
  forceDisconnect(reason = 'forced') {
    const bot = this.bot
    if (!bot) return
    try { bot.end(reason) } catch { /* ignore */ }
    this.#finalize(this.gen, reason)
  }

  get spawned() { return this.state === 'spawned' }

  #log(type, f) { this.trace?.event(type, f) }

  #setState(to, reason) {
    const from = this.state
    if (from === to) return
    this.state = to
    this.#log('state', { from, to, reason, gen: this.gen })
    try { this.emit('state', { from, to, reason, bot: this.bot, gen: this.gen }) } catch (e) { this.#log('listener_error', { where: 'state', ...errInfo(e) }) }
  }

  #clearTimers() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); this.timers[k] = null }
  }

  #connect() {
    this.timers.reconnect = null
    const gen = ++this.gen
    this.#setState('connecting', this.attempt === 0 ? 'start' : `attempt ${this.attempt + 1}`)
    let bot
    try {
      bot = this.createBot()
      this.bot = bot
      this.emit('bot', bot, gen)
    } catch (e) {
      this.#log('connect_error', errInfo(e))
      this.#finalize(gen, 'create_failed')
      return
    }
    const live = () => gen === this.gen
    bot.on('login', () => { if (live()) this.#log('login', { gen }) })
    bot.on('spawn', () => {
      if (!live()) return
      clearTimeout(this.timers.connect)
      clearTimeout(this.timers.errEnd)
      this.#setState('spawned', 'spawn')
      clearTimeout(this.timers.stable)
      this.timers.stable = setTimeout(() => { this.attempt = 0 }, this.stableMs)
      this.timers.stable.unref?.()
      try { this.emit('spawn', bot) } catch (e) { this.#log('listener_error', { where: 'spawn', ...errInfo(e) }) }
    })
    bot.on('death', () => { if (live()) this.#setState('dead', 'death') })
    bot.on('respawn', () => { if (live() && this.state === 'dead') this.#setState('respawning', 'respawn') })
    bot.on('kicked', (r) => {
      if (!live()) return
      this.lastKick = typeof r === 'string' ? r : JSON.stringify(r)
      this.#log('kicked', { reason: String(this.lastKick).slice(0, 300) })
    })
    bot.on('error', (e) => {
      if (!live()) return
      // Parse errors (PartialReadError) are not disconnects; only a socket/connect error while connecting is.
      this.#log('bot_error', errInfo(e))
      if (this.state === 'connecting' && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(e?.code)) {
        clearTimeout(this.timers.errEnd)
        this.timers.errEnd = setTimeout(() => this.#finalize(gen, `error:${e.code}`), 1500)
      }
    })
    bot.on('end', (r) => this.#finalize(gen, `end:${r ?? ''}`))
    clearTimeout(this.timers.connect)
    this.timers.connect = setTimeout(() => {
      if (live() && this.state === 'connecting') {
        this.#log('connect_timeout', { ms: this.connectTimeoutMs })
        try { bot.end('connect_timeout') } catch { /* ignore */ }
        this.#finalize(gen, 'connect_timeout')
      }
    }, this.connectTimeoutMs)
  }

  #finalize(gen, reason) {
    if (gen !== this.gen || this.finalized.has(gen)) return
    this.finalized.add(gen)
    if (this.finalized.size > 50) this.finalized.delete(this.finalized.values().next().value)
    clearTimeout(this.timers.connect); clearTimeout(this.timers.stable); clearTimeout(this.timers.errEnd)
    this.#setState('disconnected', reason)
    if (this.stopping) return
    const c = this.reconnectCfg
    const base = Math.min(c.maxMs, c.baseMs * c.factor ** this.attempt)
    const delay = Math.max(0, Math.round(base * (1 + (this.rng() * 2 - 1) * c.jitter)))
    this.attempt++
    this.#log('reconnect_scheduled', { in_ms: delay, attempt: this.attempt, after: reason, kick: this.lastKick })
    this.lastKick = null
    this.timers.reconnect = setTimeout(() => { if (!this.stopping) this.#connect() }, delay)
  }
}
