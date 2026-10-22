// Body arbitration: ONE owner token in front of the bot. Priority reflex > s1 > s2.
// A higher priority takes the body immediately (pathfinder stopped, keys cleared, lower token revoked),
// the previous holder is told via onPreempt and given a bounded time to wind down.
// Equal or lower priority requesters are denied (null). Tokens are released on completion.
import { EventEmitter } from 'node:events'
import { stopBody } from './body-control.js'
import { settleWithin, errInfo } from './util.js'

export const PRIORITY = Object.freeze({ reflex: 3, s1: 2, s2: 1 })

let tokenSeq = 0

export class Token {
  constructor(arbiter, owner, label, onPreempt) {
    this.id = ++tokenSeq
    this.arbiter = arbiter
    this.owner = owner
    this.priority = PRIORITY[owner]
    this.label = label
    this.onPreempt = onPreempt
    this.active = true
    this.revokedReason = null
    this.controller = new AbortController()
  }
  /** Aborted when the token is revoked (preempted or state change). */
  get signal() { return this.controller.signal }
  _revoke(reason) {
    if (!this.active) return
    this.active = false
    this.revokedReason = reason
    this.controller.abort(reason)
  }
  /** Release on completion. No-op if already revoked/released. */
  release() { this.arbiter._release(this) }
}

export class Arbiter extends EventEmitter {
  constructor({ getBot = () => null, trace = null, metrics = null, preemptTimeoutMs = 2500 } = {}) {
    super()
    this.getBot = getBot
    this.trace = trace
    this.metrics = metrics
    this.preemptTimeoutMs = preemptTimeoutMs
    this.holder = null // Token
    this.transition = null // Promise while a preemption is in progress
    this.waiting = new Set() // acquire() calls in flight
  }

  get owner() { return this.holder?.owner ?? null }
  get busy() { return this.holder !== null || this.transition !== null }

  /** @returns {Promise<Token|null>} null = denied (holder has equal or higher priority). */
  async acquire(owner, { label = owner, onPreempt = null, mayTake = null } = {}) {
    if (!(owner in PRIORITY)) throw new Error(`unknown owner ${owner}`)
    const me = { prio: PRIORITY[owner] }
    this.waiting.add(me)
    try { return await this.#acquire(owner, label, onPreempt, me, mayTake) } finally { this.waiting.delete(me) }
  }

  async #acquire(owner, label, onPreempt, me, mayTake = null) {
    for (;;) {
      if (this.transition) { await this.transition; continue }
      const h = this.holder
      if (!h) {
        // among simultaneous waiters the highest priority gets the body, not the fastest to wake up
        if ([...this.waiting].some((w) => w.prio > me.prio)) { await Promise.resolve(); continue }
        const t = new Token(this, owner, label, onPreempt)
        this.holder = t
        this.trace?.event('arb_grant', { owner, label, token: t.id })
        if (owner === 'reflex') { this.trace?.event('reflex', { name: label, token: t.id }); this.metrics?.reflex(label) }
        this.emit('granted', t)
        return t
      }
      if (PRIORITY[owner] > h.priority) {
        await this.#runTransition(h, `${owner}:${label}`)
        continue
      }
      // FOOD4: the requester says this holder may be taken from (non-urgent same-priority work); logged, never for reflexes
      if (mayTake && h.owner !== 'reflex' && PRIORITY[owner] >= h.priority) { let r = null; try { r = mayTake(h) } catch { /* ignore */ }
        if (r?.yes) { this.trace?.event('arb_food_preempt', { owner, label, holder: h.owner, holder_label: h.label, why: r.why }); await this.#runTransition(h, `${owner}:${label}`); continue } }
      this.trace?.event('arb_deny', { owner, label, holder: h.owner, holder_label: h.label })
      return null
    }
  }

  async #runTransition(h, by) {
    const p = this.#preempt(h, by)
    this.transition = p
    try { await p } finally { if (this.transition === p) this.transition = null }
  }

  async #preempt(h, by) {
    h._revoke(`preempted_by:${by}`)
    stopBody(this.getBot()) // synchronous part: the body is stopped before anyone awaits
    this.trace?.event('arb_preempt', { owner: h.owner, label: h.label, by, token: h.id })
    this.emit('preempted', h, by)
    if (h.onPreempt) {
      const r = await settleWithin(h.onPreempt(h.revokedReason), this.preemptTimeoutMs)
      if (r.timedOut) this.trace?.event('arb_preempt_timeout', { owner: h.owner, label: h.label, ms: this.preemptTimeoutMs })
      else if (r.error) this.trace?.event('arb_preempt_error', { owner: h.owner, ...errInfo(r.error) })
    }
    if (this.holder === h) this.holder = null // forced even if the holder never released
    stopBody(this.getBot())
  }

  _release(t) {
    if (this.holder !== t) { t._revoke('released'); return }
    t._revoke('released')
    this.holder = null
    stopBody(this.getBot())
    this.trace?.event('arb_release', { owner: t.owner, label: t.label, token: t.id })
    this.emit('released', t)
  }

  /** Revoke whoever holds the body (state change, shutdown). Resolves when the holder wound down (bounded). */
  async revokeAll(reason) {
    if (this.transition) await this.transition
    const h = this.holder
    if (!h) return
    await this.#runTransition(h, reason)
  }

  /** Run fn(token) as owner; releases afterwards. Returns {ok:false,reason:'denied'} if the body is not available. */
  async runAs(owner, label, fn) {
    const t = await this.acquire(owner, { label })
    if (!t) return { ok: false, reason: 'denied' }
    try { return { ok: true, value: await fn(t) } } finally { t.release() }
  }
}
