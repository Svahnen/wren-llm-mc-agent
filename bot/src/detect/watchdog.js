// Per-skill progress watchdog. Runs on its own timer REGARDLESS of pathfinder state, samples each
// running skill's declared progress_fn, and is lag-aware: while the lag monitor says "lagging" it freezes the stall
// clock and shields the runner's own watchdog (refreshes lastProgressAt, shifts startedAt) so a lag spike / chunk
// unload can never abort a skill or escalate.
import { EventEmitter } from 'node:events'
import { errInfo } from '../util.js'

const stable = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

export class SkillWatchdog extends EventEmitter {
  constructor({ runner, lag, trace = null, now = Date.now, tickMs = 1000 }) {
    super()
    Object.assign(this, { runner, lag, trace, now, tickMs })
    this.cur = null
    this.timer = null
    this.sampling = false
    this.lastPlace = null
    this.lastStallAt = -Infinity
    this.stats = { stalls: 0, shielded_ms: 0, progress_fn_errors: 0, max_s_backstops: 0 }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { this.tick().catch(() => {}) }, this.tickMs); this.timer.unref?.() } }
  stop() { clearInterval(this.timer); this.timer = null }

  async tick() {
    if (this.sampling) return
    const e = this.runner.current
    if (!e || !e.started || e.settled) { this.cur = null; return }
    const t = this.now()
    if (!this.cur || this.cur.e !== e) {
      this.cur = { e, sig: undefined, has: false, stallMs: 0, lastTick: t, emitted: false }
      this.lastPlace = null
    }
    const c = this.cur
    const dt = Math.min(t - c.lastTick, 10000)
    c.lastTick = t
    const tg = e.ctx?.state?.target ?? e.ctx?.args
    if (tg && Number.isFinite(tg.x) && Number.isFinite(tg.z)) this.lastPlace = `${Math.floor(tg.x / 16)},${Math.floor(tg.z / 16)}`
    const ls = this.lag.status()
    this.sampling = true
    let changed = false
    try {
      const v = stable(await e.skill.progress_fn(e.ctx))
      if (!c.has) { c.has = true; c.sig = v } else if (v !== c.sig) { c.sig = v; changed = true }
    } catch (err) { this.stats.progress_fn_errors++; this.trace?.event('progress_fn_error', { skill: e.name, ...errInfo(err) }) } finally { this.sampling = false }
    if (changed) { c.stallMs = 0; this.emit('progress', { skill: e.name }) }
    if (ls.lagging) { // shield the runner's own (unscaled) watchdog and max_s clock
      try { e.ctx.progress?.() } catch { /* ignore */ }
      e.startedAt += dt
      this.stats.shielded_ms += dt
      return
    }
    if (!changed) c.stallMs += dt / ls.factor
    const limit = (e.skill.stall_s ?? 20) * 1000
    if (!e.aborting && !c.emitted && c.stallMs >= limit) {
      c.emitted = true
      this.stats.stalls++
      this.lastStallAt = t
      const info = { skill: e.name, kind: 'no_progress', stalled_ms: Math.round(c.stallMs), source: 'watchdog', place: this.lastPlace }
      this.trace?.event('stall', info)
      this.emit('stall', info)
      this.runner.abort('no_progress').catch(() => {})
    }
    // backstop if the runner's own max_s check did not fire (e.g. its timer died)
    if (!e.aborting && t - e.startedAt > e.skill.max_s * 1000 + 5000) {
      this.stats.max_s_backstops++
      this.runner.abort('max_s').catch(() => {})
    }
  }
}
