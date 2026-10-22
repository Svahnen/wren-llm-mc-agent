// Lockout list: (goal type, place) pairs, goal types or places the mind must not pick for a while (default 30 min).
// '*' = wildcard. The mind asks `isLocked(type, place)` when it builds candidate goals.
export const WILD = '*'
const key = (type, place) => `${type ?? WILD}@${place ?? WILD}`

export class LockoutList {
  constructor({ now = Date.now, defaultMs = 30 * 60e3, trace = null, max = 500 } = {}) {
    Object.assign(this, { now, defaultMs, trace, max })
    this.map = new Map()
    this.total = 0
  }
  lock({ type = null, place = null, ms = this.defaultMs, reason = 'unspecified', source = 'detect' } = {}) {
    const k = key(type, place)
    const until = this.now() + ms
    const e = { key: k, type: type ?? WILD, place: place ?? WILD, until, reason, source, since: this.now() }
    const old = this.map.get(k)
    if (old && old.until > until) return old
    this.map.set(k, e)
    this.total++
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    this.trace?.event('lockout_add', { key: k, ms, reason, source })
    return e
  }
  /** @returns the matching entry or null */
  isLocked(type, place) {
    this.prune()
    for (const k of [key(type, place), key(type, null), key(null, place)]) {
      const e = this.map.get(k)
      if (e) return e
    }
    return null
  }
  prune() {
    const t = this.now()
    for (const [k, e] of this.map) if (e.until <= t) { this.map.delete(k); this.trace?.event('lockout_expire', { key: k }) }
  }
  list() { this.prune(); return [...this.map.values()].map((e) => ({ ...e, left_ms: e.until - this.now() })) }
  clear(k) { if (k) this.map.delete(k); else this.map.clear() }
  toJSON() { return [...this.map.values()] }
  load(arr) { for (const e of arr ?? []) if (e?.key && e.until > this.now()) this.map.set(e.key, e) }
}

/** Failure budget per (goal type, place), not per goal id. Exhausted => lockout. */
export class FailureBudget {
  constructor({ lockouts, now = Date.now, maxFails = 3, windowMs = 60 * 60e3, lockMs = 30 * 60e3 }) {
    Object.assign(this, { lockouts, now, maxFails, windowMs, lockMs })
    this.fails = new Map()
  }
  record(type, place, ok) {
    const k = key(type, place)
    if (ok) { this.fails.delete(k); return null }
    const t = this.now()
    const arr = (this.fails.get(k) ?? []).filter((x) => t - x < this.windowMs)
    arr.push(t)
    this.fails.set(k, arr)
    if (arr.length >= this.maxFails) {
      this.fails.delete(k)
      return this.lockouts.lock({ type, place, ms: this.lockMs, reason: `failure_budget:${arr.length}`, source: 'budget' })
    }
    return null
  }
}
