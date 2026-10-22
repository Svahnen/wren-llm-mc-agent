// S2 scheduler. Priority queue + coalescing + depth cap + per-call deadline + sleep-pass rule + S2-offline mode + budget.
// `run(job, {signal, slot, deadline_ms})` does the actual work (LLM call + validation); the scheduler never interprets its result.
// Priorities (lower = more urgent): human_speech 0 > blocked/failed 1 > drive_wake/done 2 > heartbeat 3 > reflection 4 > sleep_pass 5.

export const PRIORITY = { human_speech: 0, blocked: 1, failed: 1, drive_wake: 2, done: 2, heartbeat: 3, reflection: 4, sleep_pass: 5 }
const DEFAULT_DEADLINES = { human_speech: 20000, blocked: 10000, failed: 10000, drive_wake: 15000, done: 15000, heartbeat: 20000, reflection: 60000, sleep_pass: 120000 }
// A job that waited this long in the queue is stale and dropped before it starts.
const DEFAULT_MAX_AGE = { human_speech: 30000, blocked: 20000, failed: 20000, drive_wake: 30000, done: 20000, heartbeat: 30000, reflection: 120000, sleep_pass: 600000 }
const slotOf = (kind) => (kind === 'human_speech' ? 0 : 1)

export class S2Scheduler {
  constructor({
    run, now = () => Date.now(), coalesceMs = 2000, maxDepth = 6, settleMs = 0,
    deadlines = {}, maxAgeMs = {}, humanPresent = () => false,
    budget = { windowMs: 3600_000, maxCalls: 600, maxTokens: 400_000, hardFactor: 2 },
    offline = { failThreshold: 3, probeIntervalMs: 30_000 },
    supersedeInflight = true, on = {},
  }) {
    Object.assign(this, { _run: run, now, coalesceMs, maxDepth, settleMs, humanPresent, supersedeInflight, on })
    this.deadlines = { ...DEFAULT_DEADLINES, ...deadlines }
    this.maxAge = { ...DEFAULT_MAX_AGE, ...maxAgeMs }
    this.budget = budget
    this.offlineCfg = offline
    this.queue = []
    this.inflight = [null, null]
    this.seq = 0
    this.calls = [] // {t, tokens}
    this.stats = { pushed: 0, coalesced: 0, dropped_depth: 0, dropped_stale: 0, dropped_budget: 0, dropped_offline: 0, late_dropped: 0, aborted: 0, completed: 0, failed: 0, sleep_refused: 0 }
    this.s2Offline = false
    this.offlineReason = null
    this.consecutiveFailures = 0
    this.lastProbeAt = 0
    this.closed = false
    this._timer = null
  }

  // ---- public
  push(ev) {
    const kind = ev.kind ?? this._kindOf(ev)
    if (!(kind in PRIORITY)) return { accepted: false, reason: 'unknown_kind' }
    if (this.closed) return { accepted: false, reason: 'closed' }
    this.stats.pushed++
    const t = this.now()
    const priority = PRIORITY[kind]

    if (kind === 'human_speech') this._abortBackground('human_arrived')
    if (kind === 'sleep_pass' || kind === 'reflection') {
      if (kind === 'sleep_pass' && (this.humanPresent() || this._hasKind('sleep_pass'))) { this.stats.sleep_refused++; return { accepted: false, reason: this.humanPresent() ? 'human_present' : 'already_queued' } }
    }
    if (this.s2Offline) {
      const probeDue = t - this.lastProbeAt >= this.offlineCfg.probeIntervalMs
      if (kind !== 'human_speech' && !(probeDue && !this._probing)) { this.stats.dropped_offline++; return { accepted: false, reason: 's2_offline' } }
      if (kind === 'human_speech') { this.stats.dropped_offline++; this.on.offlineEvent?.({ kind, ev }); if (!probeDue || this._probing) return { accepted: false, reason: 's2_offline' } }
    }
    const over = this._budgetState()
    if (over === 'hard' || (over === 'soft' && priority >= 2)) { this.stats.dropped_budget++; return { accepted: false, reason: 'budget' } }

    // coalesce into a queued job of the same kind
    const q = this.queue.find((j) => j.kind === kind && (t - j.firstAt <= this.coalesceMs || priority >= 2))
    if (q) {
      this._merge(q, ev, t)
      this.stats.coalesced++
      return { accepted: true, coalesced: true, job_id: q.id }
    }
    // supersede an in-flight human job: new job carries the old text so nothing is lost
    let carried = null
    if (kind === 'human_speech' && this.supersedeInflight && this.inflight[0]?.job.kind === 'human_speech') {
      carried = this.inflight[0].job.events
      this._abort(this.inflight[0], 'superseded')
    }
    const job = { id: ++this.seq, kind, priority, slot: slotOf(kind), firstAt: t, lastAt: t, notBefore: t + this.settleMs, events: carried ? [...carried, ev] : [ev], probe: this.s2Offline }
    if (this.s2Offline) { this._probing = true; this.lastProbeAt = t }
    this.queue.push(job)
    let dropped = null
    if (this.queue.length > this.maxDepth) dropped = this._dropOne()
    this._pump()
    return { accepted: true, job_id: job.id, coalesced: false, dropped }
  }

  /** Sleep pass: only when no human present, one at a time, one slot (slot 1). */
  requestSleepPass(ev = { type: 'sleep_pass_due' }) { return this.push({ ...ev, kind: 'sleep_pass' }) }

  setOffline(flag, reason = 'manual') {
    if (flag === this.s2Offline) return
    this.s2Offline = flag; this.offlineReason = flag ? reason : null; this.consecutiveFailures = 0; this._probing = false
    if (flag) { this.lastProbeAt = this.now(); this.queue = []; for (const s of this.inflight) if (s) this._abort(s, 'offline') }
    this.on.offline?.({ offline: flag, reason })
  }

  status() {
    return {
      s2_offline: this.s2Offline, offline_reason: this.offlineReason, habits_only: this.s2Offline,
      queue_depth: this.queue.length, queue_oldest_age_ms: this.queue.length ? this.now() - Math.min(...this.queue.map((j) => j.firstAt)) : 0,
      queue: this.queue.map((j) => ({ id: j.id, kind: j.kind, age_ms: this.now() - j.firstAt, n_events: j.events.length })),
      inflight: this.inflight.map((s) => (s ? { id: s.job.id, kind: s.job.kind, ms: this.now() - s.startedAt } : null)),
      budget: this._budgetInfo(), stats: { ...this.stats }, consecutive_failures: this.consecutiveFailures,
    }
  }

  close() { this.closed = true; clearTimeout(this._timer); this.queue = []; for (const s of this.inflight) if (s) this._abort(s, 'closed') }

  // ---- internals
  _kindOf(ev) {
    if (ev.type === 'report') return ev.status === 'blocked' ? 'blocked' : ev.status === 'failed' ? 'failed' : ev.status === 'done' ? 'done' : null
    return { human_speech: 'human_speech', drive_wake: 'drive_wake', heartbeat: 'heartbeat', reflection_due: 'reflection', sleep_pass_due: 'sleep_pass' }[ev.type] ?? null
  }
  _hasKind(k) { return this.queue.some((j) => j.kind === k) || this.inflight.some((s) => s?.job.kind === k) }
  _merge(job, ev, t) {
    job.lastAt = t
    if (job.kind === 'human_speech') job.events.push(ev) // keep every utterance
    else if (job.kind === 'drive_wake') { job.events.push(ev); if (job.events.length > 4) job.events.shift() }
    else job.events = [...job.events.slice(-1), ev].slice(-2) // latest wins, keep one older for context
  }
  _dropOne() {
    // drop-oldest within the lowest-priority class so a human line is never the casualty of a flood of heartbeats
    const worst = Math.max(...this.queue.map((j) => j.priority))
    const cand = this.queue.filter((j) => j.priority === worst).sort((a, b) => a.firstAt - b.firstAt)[0]
    this.queue.splice(this.queue.indexOf(cand), 1)
    this.stats.dropped_depth++
    this.on.drop?.({ job: cand, reason: 'depth' })
    return { id: cand.id, kind: cand.kind }
  }
  _budgetInfo() {
    const t = this.now(); const w = this.budget.windowMs
    this.calls = this.calls.filter((c) => t - c.t < w)
    return { calls: this.calls.length, tokens: this.calls.reduce((a, c) => a + (c.tokens || 0), 0), maxCalls: this.budget.maxCalls, maxTokens: this.budget.maxTokens }
  }
  _budgetState() {
    const b = this._budgetInfo(); const hf = this.budget.hardFactor ?? 2
    if (b.calls >= b.maxCalls * hf || b.tokens >= b.maxTokens * hf) return 'hard'
    if (b.calls >= b.maxCalls || b.tokens >= b.maxTokens) return 'soft'
    return 'ok'
  }
  _abortBackground(reason) { for (const s of this.inflight) if (s && s.job.slot === 1 && s.job.priority >= 3) this._abort(s, reason) }   // V3: heartbeats too: a human is talking, the (single) LLM is theirs
  _abort(s, reason) { if (s.done) return; s.abortReason = reason; s.ac.abort(reason); this.stats.aborted++ }

  _pump() {
    if (this.closed) return
    clearTimeout(this._timer)
    const t = this.now()
    // stale jobs
    this.queue = this.queue.filter((j) => {
      if (t - j.firstAt > (this.maxAge[j.kind] ?? 30000)) { this.stats.dropped_stale++; this.on.drop?.({ job: j, reason: 'stale' }); return false }
      return true
    })
    this.queue.sort((a, b) => a.priority - b.priority || a.firstAt - b.firstAt)
    let wake = Infinity
    for (const slot of [0, 1]) {
      if (this.inflight[slot]) continue
      // background work waits while dialogue is active or queued
      const dialogueBusy = !!this.inflight[0] || this.queue.some((j) => j.slot === 0)
      if (slot === 1 && dialogueBusy) continue
      if (slot === 1 && !this.inflight[0] && this.queue.some((j) => j.kind === 'sleep_pass') && this.humanPresent()) {
        this.queue = this.queue.filter((j) => j.kind !== 'sleep_pass'); this.stats.sleep_refused++
      }
      const j = this.queue.find((x) => x.slot === slot && x.notBefore <= t)
      if (!j) { const nb = this.queue.filter((x) => x.slot === slot).map((x) => x.notBefore); if (nb.length) wake = Math.min(wake, Math.min(...nb) - t); continue }
      this.queue.splice(this.queue.indexOf(j), 1)
      this._start(j, slot)
    }
    if (wake < Infinity) this._timer = setTimeout(() => this._pump(), Math.max(1, wake))
  }

  _start(job, slot) {
    const ac = new AbortController()
    const deadline_ms = this.deadlines[job.kind] ?? 15000
    const s = { job, ac, startedAt: this.now(), done: false, abortReason: null }
    job.waitMs = s.startedAt - job.firstAt; this.waits = [...(this.waits ?? []).slice(-49), { kind: job.kind, wait_ms: job.waitMs }]
    this.on.start?.({ job, wait_ms: job.waitMs })
    this.inflight[slot] = s
    const timeout = setTimeout(() => { s.timedOut = true; this._abort(s, 'deadline') }, deadline_ms)
    const finish = (outcome) => {
      if (s.done) return
      s.done = true; clearTimeout(timeout)
      this.inflight[slot] = null
      if (job.probe) this._probing = false
      const ms = this.now() - s.startedAt
      if (outcome.kind === 'ok') {
        this.calls.push({ t: this.now(), tokens: outcome.result?.tokens ?? 0 })
        this.stats.completed++; this.consecutiveFailures = 0
        if (this.s2Offline) this.setOffline(false)
        this.on.result?.({ job, result: outcome.result, ms })
      } else {
        this.calls.push({ t: this.now(), tokens: 0 })
        const ours = s.abortReason && s.abortReason !== 'deadline' // we aborted on purpose: not an S2 fault
        if (!ours) {
          this.stats.failed++; this.consecutiveFailures++
          if (!this.s2Offline && this.consecutiveFailures >= this.offlineCfg.failThreshold) this.setOffline(true, `${this.consecutiveFailures} consecutive failures (${outcome.error?.message ?? outcome.kind})`)
        }
        this.on.error?.({ job, error: outcome.error, reason: s.abortReason ?? outcome.kind, ms })
      }
      this._pump()
    }
    Promise.resolve().then(() => this._run(job, { signal: ac.signal, slot, deadline_ms })).then(
      (result) => {
        if (s.timedOut || s.abortReason) { this.stats.late_dropped++; this.on.late?.({ job, reason: s.abortReason }); return finish({ kind: s.timedOut ? 'timeout' : 'aborted', error: new Error(s.abortReason) }) }
        finish({ kind: 'ok', result })
      },
      (error) => finish({ kind: s.timedOut ? 'timeout' : s.abortReason ? 'aborted' : 'error', error }),
    )
    // the deadline is enforced even if run() ignores the signal: do not wait for it
    s.ac.signal.addEventListener('abort', () => { setTimeout(() => finish({ kind: s.timedOut ? 'timeout' : 'aborted', error: new Error(s.abortReason ?? 'aborted') }), 0) }, { once: true })
  }
}
