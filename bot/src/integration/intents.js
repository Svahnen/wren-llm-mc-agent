// Intent plumbing (I1): a (later) brain submits S2 intents, the body runs them as owner `s2` and emits status events;
// when there is no live intent (none submitted, finished, expired, superseded away) the habit layer is the fallback.
//   intents.submitIntent({intent_id, goal, args, ttl_s, max_s?, interruptible?, created_at_ms?}) -> {ok, intent_id} | {ok:false, reason_code, errors}
//   intents.on('status', {intent_id, goal, status: started|done|failed|preempted|blocked, reason_code, reason, ms})
//   intents.hasLive() -> boolean (habits run only while false);  intents.cancel(reason)
// Priority: reflex > s1 (habits, unstuck) > s2. A submitted intent ABORTS a running habit first (habits skip while hasLive()).
import { EventEmitter } from 'node:events'
import { validateArgs, SKILL_NAMES } from '../skills/schema.js'
import { sleep, errInfo } from '../util.js'

/** Map a runner result to the brain's REASON_CODES (brain/contract.js). */
export function reasonCode(res) {
  const r = String(res.reason ?? '')
  if (res.status === 'done') return 'ok'
  if (/^preempted_by:reflex/.test(r)) return 'reflex'
  if (/^preempted_by/.test(r)) return 'human_override'
  if (r === 'superseded') return 'superseded'
  if (/^state:dead/.test(r) || /^state:respawning/.test(r)) return 'died'
  if (/^state:/.test(r)) return 'disconnected'
  if (r === 'no_progress') return 'no_progress'
  if (r === 'max_s' || r === 'GotoTimeout') return 'timeout'
  if (r === 'NoPath' || r === 'no_reachable_target' || r === 'no_escape_route') return 'unreachable'
  if (r === 'target_gone' || r === 'target_moved') return 'target_gone'
  if (r === 'inventory_full') return 'inventory_full'
  if (r === 'no_tool') return 'no_tool'
  if (r === 'unknown_skill') return 'unknown_skill'
  if (r === 'invalid_args') return 'invalid_args'
  if (r === 'unstuck_active') return 'stuck'
  if (r.startsWith('locked_out')) return 'precondition_failed'
  if (res.status === 'aborted') return 'aborted'
  if (res.status === 'rejected') return 'precondition_failed'
  if (res.status === 'failed') return /path|Path|not_reached/.test(r) ? 'path_failed' : 'precondition_failed'
  return 'aborted'
}

export class IntentManager extends EventEmitter {
  constructor({ runner, arbiter, trace = null, metrics = null, now = Date.now, canStart = null, busyWaitMs = 6000 }) {
    super()
    Object.assign(this, { runner, arbiter, trace, metrics, now, canStart, busyWaitMs })
    this.current = null  // {intent, started}
    this.pending = null
    this.loop = null
    this.stats = { submitted: 0, rejected: 0, started: 0, done: 0, failed: 0, preempted: 0, blocked: 0, expired: 0, superseded: 0 }
    this.history = []
    arbiter.on('granted', (t) => {
      const c = this.current
      if (c && !c.started && t.owner === 's2' && t.label === c.intent.goal) { c.started = true; this.stats.started++; this.#emit(c.intent, 'started', 'ok') }
    })
  }

  hasLive() { return !!(this.current || this.pending) }

  #emit(intent, status, reason_code, extra = {}) {
    const e = { intent_id: intent.intent_id, goal: intent.goal, status, reason_code, ...extra }
    this.history.push({ ...e, t: this.now() }); if (this.history.length > 100) this.history.shift()
    this.trace?.event('intent_status', e)
    try { this.emit('status', e) } catch (err) { this.trace?.event('intent_listener_error', errInfo(err)) }
  }

  submitIntent(raw) {
    this.stats.submitted++
    const bad = (reason_code, errors) => { this.stats.rejected++; this.trace?.event('intent_rejected', { intent_id: raw?.intent_id, goal: raw?.goal, reason_code, errors }); return { ok: false, reason_code, errors, intent_id: raw?.intent_id ?? null } }
    if (!raw || typeof raw !== 'object') return bad('invalid_args', ['intent must be an object'])
    const intent_id = String(raw.intent_id ?? `i-${this.now()}`)
    const created = Number.isFinite(raw.created_at_ms) ? raw.created_at_ms : this.now()
    const ttl_s = Number.isFinite(raw.ttl_s) ? raw.ttl_s : 120
    if (raw.goal === 'none') { // "keep doing what you do": no body action, habits stay in charge
      this.#emit({ intent_id, goal: 'none' }, 'done', 'ok')
      return { ok: true, intent_id, noop: true }
    }
    if (!SKILL_NAMES.includes(raw.goal)) return bad('unknown_skill', [`unknown skill "${raw.goal}"`, `valid: ${SKILL_NAMES.join(',')}`])
    const v = validateArgs(raw.goal, raw.args ?? {})
    if (!v.ok) return bad('invalid_args', v.errors)
    if (this.now() - created > ttl_s * 1000) { this.stats.expired++; return bad('expired', ['ttl elapsed before submit']) }
    const intent = { intent_id, goal: raw.goal, args: v.args, ttl_s, created_at_ms: created, interruptible: raw.interruptible !== false, urgent: raw.urgent === true }
    const lock = this.canStart?.(intent)
    if (lock) { this.stats.blocked++; this.#emit(intent, 'blocked', 'precondition_failed', { reason: String(lock) }); return { ok: false, reason_code: 'blocked', errors: [String(lock)], intent_id } }
    if (this.pending) { this.stats.superseded++; this.#emit(this.pending, 'preempted', 'superseded') }
    this.pending = intent
    if (this.current) this.runner.abort('superseded').catch(() => {}) // latest wins; loop picks up pending
    this.loop ??= this.#drive().finally(() => { this.loop = null })
    return { ok: true, intent_id }
  }

  /** Cancel the running/pending intent (e.g. human override); habits take over. */
  async cancel(reason = 'human_override') {
    if (this.pending) { this.#emit(this.pending, 'preempted', reason === 'superseded' ? 'superseded' : 'human_override'); this.pending = null }
    if (this.current) await this.runner.abort(reason)
  }

  async #drive() {
    while (this.pending) {
      const intent = this.pending; this.pending = null
      this.current = { intent, started: false }
      try { await this.#execute(intent) } catch (e) { this.trace?.event('intent_error', { intent_id: intent.intent_id, ...errInfo(e) }); this.#emit(intent, 'failed', 'aborted', { reason: 'exception' }) }
      this.current = null
    }
  }

  async #execute(intent) {
    const dead = () => this.now() - intent.created_at_ms > intent.ttl_s * 1000
    if (dead()) { this.stats.expired++; return this.#emit(intent, 'failed', 'expired') }
    if (this.arbiter.owner === 's1') await this.runner.abort('intent') // a habit holds the body: habits are the fallback, not an obstacle
    const t0 = this.now()
    let res
    // L1: was a retry every 400 ms (12 rejects in 5 s behind lava_fire/eat). Now at most 3 tries with 1 s, 2 s backoff, and no retry
    // at all while a reflex that lasts (hazard / flee reflexes) holds the body: the situation the intent was written for is gone anyway.
    const LASTING = new Set(['lava_fire', 'suffocation', 'drowning', 'low_health_flee', 'falling_block'])
    const backoff = [1000, 2000]
    for (let attempt = 0; ; attempt++) {
      res = await this.runner.run(intent.goal, intent.args, { owner: 's2', intent_id: intent.intent_id, created_at: intent.created_at_ms })
      const transient = res.status === 'rejected' && (res.reason === 'busy' || res.reason === 'unstuck_active' || res.reason === 'revoked')
      const h = this.arbiter.holder
      const lasting = !!h && h.owner === 'reflex' && LASTING.has(h.label)
      if (!transient || this.pending || dead() || this.now() - t0 > this.busyWaitMs || attempt >= backoff.length || lasting) break
      await sleep(backoff[attempt]) // a short reflex / the unstuck ladder holds the body for a moment
    }
    const c = this.current
    const rc = reasonCode(res)
    if (res.status === 'done') { this.stats.done++; return this.#emit(intent, 'done', 'ok', { ms: res.ms }) }
    if (res.status === 'aborted') {
      this.stats.preempted++
      return this.#emit(intent, 'preempted', rc, { reason: res.reason, ms: res.ms })
    }
    if (res.status === 'rejected' && ['busy', 'unstuck_active', 'revoked'].includes(res.reason)) { this.stats.blocked++; return this.#emit(intent, 'blocked', rc, { reason: res.reason }) }
    if (c && !c.started) this.#emit(intent, 'started', 'ok') // rejected/failed before the grant event: keep the started->end pair
    this.stats.failed++
    return this.#emit(intent, 'failed', rc, { reason: res.reason, detail: res.detail, ms: res.ms })
  }
}
