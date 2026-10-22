// Lag awareness: server TPS (from time_update packets), packet silence, ping, event-loop drift, discontinuities.
// While `status().lagging` is true the detectors freeze their clocks and never escalate.
import { EventEmitter } from 'node:events'

export class LagMonitor extends EventEmitter {
  constructor({ now = Date.now, trace = null, loopTickMs = 250, loopLagMs = 350, tpsMin = 14, pingMaxMs = 600,
    silenceMs = 2500, graceMs = 5000, timeStaleMs = 6000, timeLateMs = 3000 } = {}) {
    super()
    Object.assign(this, { now, trace, loopTickMs, loopLagMs, tpsMin, pingMaxMs, silenceMs, graceMs, timeStaleMs, timeLateMs })
    this.tps = null; this.tpsAt = 0
    this.lastTime = null // {at, age}
    this.lastPacketAt = 0
    this.lastLoopLagAt = -Infinity; this.loopLagMaxMs = 0
    this.graceUntil = 0
    this.lastLagAt = -Infinity
    this.ping = null
    this.timer = null; this.expected = 0
    this.bot = null; this.off = null
    this.was = false
    this.stats = { lag_episodes: 0, discontinuities: 0, max_loop_lag_ms: 0, min_tps: null }
  }

  start() {
    if (this.timer) return
    this.expected = this.now() + this.loopTickMs
    this.timer = setInterval(() => {
      const t = this.now()
      const lag = t - this.expected
      if (lag > this.loopLagMs) { this.lastLoopLagAt = t; this.loopLagMaxMs = Math.max(this.loopLagMaxMs, lag); this.stats.max_loop_lag_ms = Math.round(this.loopLagMaxMs) }
      this.expected = t + this.loopTickMs
    }, this.loopTickMs)
    this.timer.unref?.()
  }
  stop() { clearInterval(this.timer); this.timer = null; this.detach() }

  attach(bot) {
    this.detach()
    this.bot = bot
    this.lastTime = null; this.tps = null; this.lastPacketAt = this.now()
    const onTime = () => this.noteTimeUpdate(bot.time?.age)
    const onPacket = () => { this.lastPacketAt = this.now() }
    bot.on?.('time', onTime)
    bot._client?.on?.('packet', onPacket)
    this.off = () => { bot.removeListener?.('time', onTime); bot._client?.removeListener?.('packet', onPacket) }
  }
  detach() { try { this.off?.() } catch { /* ignore */ } this.off = null; this.bot = null; this.lastPacketAt = 0; this.lastTime = null; this.tps = null }

  /** Feed a world-age sample (ticks). Used by the bot 'time' event and by tests. */
  noteTimeUpdate(age, at = this.now()) {
    this.lastPacketAt = at
    if (typeof age !== 'number' || !Number.isFinite(age)) return
    const p = this.lastTime
    this.lastTime = { at, age }
    if (!p) return
    const dt = at - p.at
    if (dt < 200 || age <= p.age) return
    const inst = Math.min(20, ((age - p.age) * 1000) / dt)
    this.tps = this.tps == null ? inst : 0.4 * this.tps + 0.6 * inst
    this.tpsAt = at
    if (this.stats.min_tps == null || this.tps < this.stats.min_tps) this.stats.min_tps = +this.tps.toFixed(1)
  }
  notePacket(at = this.now()) { this.lastPacketAt = at }
  /** teleport / respawn / dimension change / chunk unload: freeze clocks for graceMs. */
  noteDiscontinuity(kind = 'discontinuity') {
    this.graceUntil = this.now() + this.graceMs
    this.stats.discontinuities++
    this.trace?.event('discontinuity', { kind })
  }

  status() {
    const t = this.now()
    const reasons = []
    if (t - this.lastLoopLagAt < this.graceMs) reasons.push('event_loop')
    if (this.tps != null && t - this.tpsAt < this.timeStaleMs && this.tps < this.tpsMin) reasons.push('tps')
    // vanilla sends a time update every 20 ticks (1 s at 20 TPS): a late one is direct, immediate evidence of a slow server
    // (/tick rate 1 would otherwise stay invisible for 20 s until the second sample arrives)
    if (this.lastTime && t - this.lastTime.at > this.timeLateMs) reasons.push('time_updates_late')
    if (this.lastPacketAt && t - this.lastPacketAt > this.silenceMs) reasons.push('silence')
    const ping = this.bot?.player?.ping
    this.ping = typeof ping === 'number' ? ping : this.ping
    if (this.ping != null && this.ping > this.pingMaxMs) reasons.push('ping')
    if (t < this.graceUntil) reasons.push('discontinuity')
    if (reasons.length) this.lastLagAt = t
    const lagging = reasons.length > 0 || t - this.lastLagAt < this.graceMs
    const factor = this.tps != null && this.tps > 0 ? Math.min(6, Math.max(1, 20 / this.tps)) : 1
    if (lagging !== this.was) {
      this.was = lagging
      if (lagging) this.stats.lag_episodes++
      this.trace?.event(lagging ? 'lag_hold' : 'lag_clear', { reasons, tps: this.tps && +this.tps.toFixed(1), ping: this.ping, loop_ms: Math.round(this.loopLagMaxMs) })
      this.emit(lagging ? 'lag' : 'clear', reasons)
    }
    return { lagging, reasons, factor, tps: this.tps, ping: this.ping }
  }
}
