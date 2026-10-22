// Skill runner. Contract:
//   { name, max_s, progress_fn(ctx), run(ctx), precondition?(ctx), abort?(reason, ctx), stall_s? }
// - progress_fn returns a comparable value (number/string/small object); a CHANGE means progress.
//   Prefer measures that cannot oscillate (best distance so far, inventory count, new chunks seen).
//   The watchdog samples it every tickMs regardless of pathfinder state; no change for stall_s => abort.
// - max_s is a hard wall-clock limit.
// - abort(reason) is skill-specific cleanup; the runner ALWAYS also clears control states, stops digging
//   and sets pathfinder goal null, and always resolves within abortGraceMs, even if the skill ignores abort.
// - One skill at a time: the body owner token (arbiter) is the mutex. A higher-priority run preempts.
import { stopBody } from '../body-control.js'
import { PRIORITY } from '../arbiter.js'
import { mayPreemptForFood } from '../food-preempt.js'
import { settleWithin, errInfo } from '../util.js'

const stable = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

export class SkillRunner {
  constructor({ arbiter, getBot, trace = null, metrics = null, tickMs = 1000, abortGraceMs = 2000, now = Date.now }) {
    this.arbiter = arbiter
    this.getBot = getBot
    this.trace = trace
    this.metrics = metrics
    this.tickMs = tickMs
    this.abortGraceMs = abortGraceMs
    this.now = now
    this.skills = new Map()
    this.current = null
    this.state = 'idle' // idle | running | aborting
    // ARB1: busy rejections are logged once per hold (key -> {holder, n}); rate for the S1 decision log
    this.busyHolds = new Map()
    this.busyTimes = []
    arbiter?.on?.('released', () => this.#flushBusy())
  }

  #flushBusy() {
    for (const [k, e] of this.busyHolds) if (e.n > 1) this.trace?.event('skill_reject_busy_hold', { skill: e.skill, owner: e.owner, intent_id: e.intent_id, rejects: e.n, holder: e.holderLabel })
    this.busyHolds.clear()
  }

  /** ARB1: busy rejections in the last 60 s (every one, also the suppressed repeats). */
  busyRejectsPerMin() {
    const t = this.now(); while (this.busyTimes.length && t - this.busyTimes[0] > 60000) this.busyTimes.shift()
    return this.busyTimes.length
  }

  /** ARB1: true when a request by `owner` would be denied right now (holder of equal or higher priority). */
  isHeld(owner = 's1') {
    const h = this.arbiter?.holder
    return !!h && PRIORITY[owner] <= h.priority
  }

  /** ARB1: resolves true when the body is free (arb_release), false after ms. Callers re-evaluate ONCE after it instead of polling. */
  waitFree(ms = 15000) {
    const a = this.arbiter
    if (!a?.busy) return Promise.resolve(true)
    return new Promise((res) => {
      let timer = null
      const done = (v) => { clearTimeout(timer); a.off('released', on); res(v) }
      const on = () => { if (!a.busy) done(true) }
      a.on('released', on)
      timer = setTimeout(() => done(false), ms)
      timer.unref?.()
    })
  }

  register(skill) {
    const bad = (m) => { throw new Error(`skill registration rejected (${skill?.name ?? '?'}): ${m}`) }
    if (!skill || typeof skill.name !== 'string' || !skill.name) bad('name missing')
    if (this.skills.has(skill.name)) bad('duplicate name')
    if (typeof skill.run !== 'function') bad('run() missing')
    if (typeof skill.progress_fn !== 'function') bad('progress_fn missing (a skill without a progress signal may not be added)')
    if (!(skill.max_s > 0)) bad('max_s must be > 0')
    if (skill.stall_s !== undefined && !(skill.stall_s > 0)) bad('stall_s must be > 0')
    for (const f of ['precondition', 'abort']) if (skill[f] !== undefined && typeof skill[f] !== 'function') bad(`${f} must be a function`)
    this.skills.set(skill.name, skill)
    return this
  }

  /** Abort the running skill (if any). Resolves when it is over (bounded). */
  async abort(reason = 'abort') {
    const e = this.current
    if (e) await this.#abort(e, reason)
  }

  /**
   * Run a skill as owner. Resolves with {status: done|failed|aborted|rejected, reason, skill, intent_id, ms}.
   * Never throws.
   */
  async run(name, args = {}, { owner = 's1', intent_id = null, created_at = this.now(), precondition = null, _covered = false } = {}) {
    const bkey = `${owner}|${name}|${intent_id}`
    // ARB1: the same (skill, intent) already rejected busy under the SAME hold: no re-evaluation, no new log line, just a count
    const hb = this.busyHolds.get(bkey), hh = this.arbiter.holder
    if (hb && hh && hb.holder === hh.id && PRIORITY[owner] <= hh.priority && !(owner !== 'reflex' && mayPreemptForFood(this.getBot(), name, hh).yes)) {
      hb.n++; this.busyTimes.push(this.now()); this.metrics?.skill('rejected')
      return { status: 'rejected', reason: 'busy', ...(hh ? { holder: `${hh.owner}:${hh.label}` } : {}), skill: name, intent_id, ms: 0 }
    }
    let preDetail = null
    const rej = (reason) => {
      if (reason === 'busy') {
        this.busyTimes.push(this.now())
        const h = this.arbiter.holder
        this.busyHolds.set(bkey, { holder: h?.id ?? null, holderLabel: h ? `${h.owner}:${h.label}` : null, n: 1, skill: name, owner, intent_id })
        this.trace?.event('skill_reject', { skill: name, owner, intent_id, reason, holder: h ? `${h.owner}:${h.label}` : null })
      } else this.trace?.event('skill_reject', { skill: name, owner, intent_id, reason, ...(preDetail ? { detail: preDetail } : {}) })
      this.metrics?.skill('rejected')
      const hd = reason === 'busy' ? this.arbiter.holder : null
      return { status: 'rejected', reason, ...(preDetail ? { detail: preDetail } : {}), ...(hd ? { holder: `${hd.owner}:${hd.label}` } : {}), skill: name, intent_id, ms: 0 }
    }
    this.trace?.event('intent', { skill: name, owner, intent_id, args, age_ms: this.now() - created_at })
    this.metrics?.intent()
    const skill = this.skills.get(name)
    if (!skill) return rej('unknown_skill')
    const bot = this.getBot()
    if (!bot?.entity) return rej('no_body')

    const checkPre = async () => {
      const ctx0 = { bot: this.getBot(), args, name }
      for (const fn of [precondition, skill.precondition]) {
        if (!fn) continue
        try {
          const r = await fn(ctx0)
          if (r === false || r?.ok === false) { preDetail = r?.detail ?? null; return r?.reason ?? 'precondition' }
        } catch (e) { return `precondition_error:${e?.message}` }
      }
      return null
    }
    let why = await checkPre()
    if (why) {
      const h0 = this.arbiter.holder
      // VAL1: the covering reflex already took the last target: the intent is satisfied
      if (why === 'no_target_found' && h0?.owner === 'reflex' && owner !== 'reflex' && skill.coveredBy?.includes(h0.label)) return { status: 'done', reason: 'reflex_handled', skill: name, intent_id, ms: 0 }
      return rej(why)
    }

    const entry = { name, owner, intent_id, skill, aborting: false, abortReason: null, abortPromise: null, settled: false, orphaned: false }
    const token = await this.arbiter.acquire(owner, { label: name, onPreempt: (r) => this.#abort(entry, r), mayTake: owner === 'reflex' ? null : (h) => mayPreemptForFood(this.getBot(), name, h) })   // FOOD4
    if (!token) {
      // VAL1: a reflex that already does this skill's job (mob_defense fights with the best weapon) holds the body: wait for it instead of
      // a busy-rejection loop, then report the intent as satisfied (or run the skill if a target is still left). Other reflexes (flee, fire) stay a plain busy.
      const h = this.arbiter.holder
      if (!_covered && h?.owner === 'reflex' && owner !== 'reflex' && skill.coveredBy?.includes(h.label)) {
        const ok = await this.#waitRelease(h, (skill.coverWaitMs ?? 32000))
        this.trace?.event('skill_covered', { skill: name, owner, intent_id, by: h.label, released: ok })
        if (!ok) return rej('busy')
        const r = await this.run(name, args, { owner, intent_id, created_at, precondition, _covered: true })
        if (r.status === 'rejected' && r.reason === 'no_target_found') return { status: 'done', reason: 'reflex_handled', skill: name, intent_id, ms: this.now() - created_at }
        return r
      }
      return rej('busy')
    }
    why = await checkPre() // the world may have changed while we preempted
    if (why || !token.active) { token.release(); return rej(why ?? 'revoked') }

    entry.token = token
    entry.started = true
    entry.startedAt = this.now()
    entry.lastProgressAt = entry.startedAt
    entry.hasSig = false
    entry.sig = undefined
    entry.controller = new AbortController()
    const done = new Promise((res) => { entry.resolve = res })
    this.current = entry
    this.state = 'running'
    this.metrics?.age(entry.startedAt - created_at)
    this.metrics?.skill('started')
    this.trace?.event('skill_start', { skill: name, owner, intent_id, max_s: skill.max_s, age_ms: entry.startedAt - created_at })

    const ctx = this.#makeCtx(entry, args)
    entry.ctx = ctx
    entry.timer = setInterval(() => this.#watchdog(entry), this.tickMs)
    entry.timer.unref?.()

    entry.runDone = (async () => {
      let r
      try { r = await skill.run(ctx) } catch (e) { r = { ok: false, reason: 'exception', error: errInfo(e) } }
      return r
    })().then((r) => { entry.runResult = r; this.#settle(entry, r); return r })
    return done
  }

  #waitRelease(token, ms) {
    return new Promise((res) => {
      if (this.arbiter.holder !== token) return res(true)
      const done = (v) => { clearTimeout(t); this.arbiter.off?.('released', on); this.arbiter.off?.('preempted', on); res(v) }
      const on = (x) => { if (x === token) done(true) }
      const t = setTimeout(() => done(false), ms)
      this.arbiter.on?.('released', on); this.arbiter.on?.('preempted', on)
    })
  }

  #makeCtx(entry, args) {
    const runner = this
    const ctx = {
      name: entry.name,
      args,
      intent_id: entry.intent_id,
      state: {},
      get bot() { return runner.getBot() },
      get signal() { return entry.controller.signal },
      get aborted() { return entry.aborting },
      log: (type, f = {}) => runner.trace?.event(`skill_${type}`, { skill: entry.name, intent_id: entry.intent_id, ...f }),
      /** Declare progress made (e.g. a declared wait tick). */
      progress: () => { entry.lastProgressAt = runner.now() },
      /** Abortable sleep: true if it completed, false if aborted. */
      sleep: (ms) => new Promise((res) => {
        if (entry.aborting) return res(false)
        const t = setTimeout(() => { entry.controller.signal.removeEventListener('abort', onAbort); res(true) }, ms)
        const onAbort = () => { clearTimeout(t); res(false) }
        entry.controller.signal.addEventListener('abort', onAbort, { once: true })
      }),
      /** pathfinder.goto that never throws (PathStopped etc. => {ok:false, reason}), bounded by timeoutMs. */
      goto: async (goal, { timeoutMs = 30000 } = {}) => {
        const bot = runner.getBot()
        if (entry.aborting) return { ok: false, reason: 'aborted' }
        if (!bot?.pathfinder) return { ok: false, reason: 'no_pathfinder' }
        let t
        // Q1: a goto that gets nowhere from inside our own sealed pillbox (mineflayer-pathfinder either throws NoPath or resolves on an
        // empty path) opens a one-block door once and retries; real Wren told S2 "path_failed" 5 ms after S2 replaced her night shelter.
        const door = async () => {
          if (entry.doorTried || entry.aborting || !runner.onNoPath) return false
          entry.doorTried = true
          let opened = false
          const hb = setInterval(() => { entry.lastProgressAt = runner.now() }, 2000)   // NAV1: opening a hut door by hand takes ~15 s: that is progress, not a stall
          try { opened = await runner.onNoPath(bot) } catch { /* ignore */ } finally { clearInterval(hb) }
          runner.trace?.event('skill_door', { skill: entry.name, intent_id: entry.intent_id, opened })
          if (opened && !entry.aborting) { await new Promise((r) => setTimeout(r, 600)) }   // NAV1: let the block updates land / drop the stale empty path before the retry (live: the retry resolved at once without moving)
          return opened && !entry.aborting
        }
        const p0 = bot.entity?.position, x0 = p0 && { x: p0.x, y: p0.y, z: p0.z }
        try {
          const to = new Promise((_, rej) => { t = setTimeout(() => { rej(Object.assign(new Error('goto timeout'), { name: 'GotoTimeout' })); try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } }, timeoutMs) })
          await Promise.race([bot.pathfinder.goto(goal), to])
          entry.lastProgressAt = runner.now()
          const p1 = bot.entity?.position
          if (x0 && p1 && Math.hypot(p1.x - x0.x, p1.y - x0.y, p1.z - x0.z) < 0.6 && await door()) return ctx.goto(goal, { timeoutMs })
          return { ok: true }
        } catch (e) {
          const reason = e?.name === 'PathStopped' ? (entry.aborting ? 'aborted' : 'path_stopped') : (e?.name || 'error')
          if (reason === 'NoPath' && await door()) return ctx.goto(goal, { timeoutMs })
          // NIGHT2: "Timeout" = the A* thinkTimeout hit with only a PARTIAL path (live: 6x move_to Timeout on the way to the bed, each after ~3 s without a step). The
          // pathfinder keeps walking that partial path after the promise rejects, so give it a moment and plan again from where she then stands; only while she makes headway.
          if (reason === 'Timeout' && !entry.aborting && (entry.tmoRetries ?? 0) < 4) {
            entry.tmoRetries = (entry.tmoRetries ?? 0) + 1
            await new Promise((r) => setTimeout(r, 1500))
            const p2 = bot.entity?.position
            const moved = x0 && p2 ? Math.hypot(p2.x - x0.x, p2.y - x0.y, p2.z - x0.z) : 0
            runner.trace?.event('skill_goto_timeout_retry', { skill: entry.name, intent_id: entry.intent_id, n: entry.tmoRetries, moved: +moved.toFixed(1) })
            if (!entry.aborting && (moved >= 0.8 || entry.tmoRetries === 1)) return ctx.goto(goal, { timeoutMs })
          }
          let why = null
          if (reason === 'NoPath') { try { why = runner.explainNoPath?.(bot) ?? null } catch { /* ignore */ } }   // NAV1: an immediate NoPath says WHY (sealed hut / pit) instead of a bare code
          return { ok: false, reason, message: String(e?.message ?? e).slice(0, 200), ...(why ? { why } : {}) }
        } finally { clearTimeout(t) }
      },
    }
    return ctx
  }

  async #watchdog(entry) {
    if (entry.aborting || entry.settled || entry.sampling) return
    const now = this.now()
    const s = entry.skill
    if (now - entry.startedAt > s.max_s * 1000) { this.#abort(entry, 'max_s'); return }
    entry.sampling = true
    try {
      const v = stable(await s.progress_fn(entry.ctx))
      if (!entry.hasSig) { entry.hasSig = true; entry.sig = v }
      else if (v !== entry.sig) { entry.sig = v; entry.lastProgressAt = now; this.metrics?.progress() }
    } catch (e) {
      this.trace?.event('progress_fn_error', { skill: entry.name, ...errInfo(e) })
    } finally { entry.sampling = false }
    if (!entry.aborting && !entry.settled && this.now() - entry.lastProgressAt > (s.stall_s ?? 20) * 1000) this.#abort(entry, 'no_progress')
  }

  #abort(entry, reason) {
    if (entry.abortPromise) return entry.abortPromise
    if (!entry.started) { // preempted while still checking preconditions: run() sees token.active=false and rejects
      entry.aborting = true
      return (entry.abortPromise = Promise.resolve())
    }
    entry.aborting = true
    entry.abortReason = reason
    if (this.current === entry) this.state = 'aborting'
    this.trace?.event('skill_abort_begin', { skill: entry.name, intent_id: entry.intent_id, reason })
    try { entry.controller.abort(reason) } catch { /* ignore */ }
    stopBody(this.getBot())
    entry.abortPromise = (async () => {
      const deadline = this.now() + this.abortGraceMs
      const left = () => Math.max(1, deadline - this.now())
      if (entry.skill.abort) {
        const r = await settleWithin(entry.skill.abort(reason, entry.ctx), left())
        if (r.error) this.trace?.event('skill_abort_error', { skill: entry.name, ...errInfo(r.error) })
      }
      stopBody(this.getBot())
      const r = await settleWithin(entry.runDone, left())
      if (r.timedOut) entry.orphaned = true
      this.#settle(entry, { ok: false, reason: 'aborted' })
    })()
    return entry.abortPromise
  }

  #settle(entry, r) {
    if (entry.settled) return
    entry.settled = true
    clearInterval(entry.timer)
    const ms = this.now() - entry.startedAt
    let status, reason, detail
    if (entry.aborting) { status = 'aborted'; reason = entry.abortReason }
    else if (r === false || r?.ok === false) { status = 'failed'; reason = r?.reason ?? 'failed'; detail = r?.detail }
    else { status = 'done'; reason = r?.reason }
    stopBody(this.getBot())
    entry.token.release()
    if (this.current === entry) { this.current = null; this.state = 'idle' }
    this.metrics?.skill(status, status === 'aborted' ? String(reason).split(':')[0] : undefined)
    this.trace?.event(status === 'aborted' ? 'skill_abort' : 'skill_end', {
      skill: entry.name, owner: entry.owner, intent_id: entry.intent_id, status, reason, ms, orphaned: entry.orphaned || undefined,
      error: r?.error, detail,
    })
    entry.resolve({ status, reason, detail, skill: entry.name, intent_id: entry.intent_id, ms, orphaned: entry.orphaned || undefined })
  }
}
