// Metrics: event-loop lag (perf_hooks), skill/reflex/state counters, intent age.
import { monitorEventLoopDelay } from 'node:perf_hooks'

const ms = (ns) => Math.round(ns / 1e4) / 100 // ns -> ms with 2 decimals

export class Metrics {
  constructor({ resolution = 10, now = Date.now } = {}) {
    this.now = now
    this.startedAt = now()
    this.h = monitorEventLoopDelay({ resolution })
    this.h.enable()
    this.lagMaxEver = 0
    this.skills = { started: 0, done: 0, failed: 0, aborted: 0, rejected: 0 }
    this.abortReasons = {}
    this.reflexes = {}
    this.states = {}
    this.intents = 0
    this.intentAge = { count: 0, last: 0, max: 0, sum: 0 }
    this.progressTicks = 0
    this.reconnects = 0
    this.deaths = 0
  }

  skill(kind, reason) {
    if (kind in this.skills) this.skills[kind]++
    if (kind === 'aborted' && reason) this.abortReasons[reason] = (this.abortReasons[reason] ?? 0) + 1
  }
  reflex(name) { this.reflexes[name] = (this.reflexes[name] ?? 0) + 1 }
  state(to) {
    this.states[to] = (this.states[to] ?? 0) + 1
    if (to === 'dead') this.deaths++
    if (to === 'connecting' && this.states.connecting > 1) this.reconnects++
  }
  intent() { this.intents++ }
  /** Age of an intent when it began executing (ms). */
  age(msAge) {
    const a = this.intentAge
    a.count++; a.last = msAge; a.sum += msAge
    if (msAge > a.max) a.max = msAge
  }
  progress() { this.progressTicks++ }

  /** Snapshot; lag histogram is windowed (reset after each snapshot) unless reset=false. */
  snapshot({ reset = true } = {}) {
    const h = this.h
    const has = h.count > 0
    const lag = has
      ? { p50_ms: ms(h.percentile(50)), p99_ms: ms(h.percentile(99)), max_ms: ms(h.max), mean_ms: ms(h.mean), samples: h.count }
      : { p50_ms: 0, p99_ms: 0, max_ms: 0, mean_ms: 0, samples: 0 }
    if (lag.max_ms > this.lagMaxEver) this.lagMaxEver = lag.max_ms
    if (reset) h.reset()
    return {
      uptime_s: Math.round((this.now() - this.startedAt) / 1000),
      event_loop_lag: lag,
      event_loop_lag_max_ever_ms: this.lagMaxEver,
      skills: { ...this.skills },
      abort_reasons: { ...this.abortReasons },
      reflexes: { ...this.reflexes },
      states: { ...this.states },
      intents: this.intents,
      intent_age_ms: { count: this.intentAge.count, last: this.intentAge.last, max: this.intentAge.max, mean: this.intentAge.count ? Math.round(this.intentAge.sum / this.intentAge.count) : 0 },
      progress_ticks: this.progressTicks,
      reconnects: this.reconnects,
      deaths: this.deaths,
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    }
  }

  stop() { this.h.disable() }
}
