// Escalation ladder: nudge -> moveAway(5) -> escape ladder -> go home -> restart request.
// Every step is verified by ground truth (position change AND no longer trapped), logged to the trace, and the
// ladder resets on progress. Restart requests are rate-limited and persisted so restarts can never loop.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { hdist, diagnose, findDoors } from './world.js'
import { planEscape } from './skills.js'

export const LEVELS = Object.freeze({ 1: 'nudge', 2: 'move_away', 3: 'escape', 4: 'go_home', 5: 'restart' })

export class RestartStore {
  constructor({ file = null, now = Date.now } = {}) {
    this.file = file; this.now = now; this.ts = []
    try { if (file) this.ts = JSON.parse(fs.readFileSync(file, 'utf8')).restarts ?? [] } catch { /* none yet */ }
  }
  prune() { const t = this.now(); this.ts = this.ts.filter((x) => t - x < 24 * 3600e3) }
  add() { this.ts.push(this.now()); this.save() }
  save() { if (!this.file) return; try { fs.writeFileSync(this.file, JSON.stringify({ restarts: this.ts })) } catch { /* ignore */ } }
}

export class EscalationLadder extends EventEmitter {
  /**
   * run(name,args,opts) must be the RAW runner.run. getHome(bot) -> {x,y,z}|null.
   * onRestart(reason) performs the restart; default only emits.
   */
  constructor({ body, runner, run, trace = null, metrics = null, lag, now = Date.now, getHome = () => null, onRestart = null, store = new RestartStore(),
    cfg = {} }) {
    super()
    this.body = body; this.runner = runner; this.run = run; this.trace = trace; this.metrics = metrics; this.lag = lag; this.now = now
    this.getHome = getHome; this.onRestart = onRestart; this.store = store
    this.cfg = { failSkip: 3, failTtlS: 600, escapeBudgetS: 100, minMove: { 1: 0.8, 2: 3, 3: 2, 4: 10 }, restartMinIntervalS: 1800, restartMaxPerDay: 4, backoffBaseS: 30, backoffMaxS: 600, ...cfg }
    this.level = 0
    this.busy = false
    this.active = false // "unstuck mode": habits are held off, digging allowed
    this.cooldownUntil = 0
    this.topFails = 0
    this.fails = new Map() // L2: step/skill name -> { n, t }: repeated no-progress steps are skipped (cleared on real movement / teleport / spawn / recovery)
    this.n = 0
    this.stats = { episodes: 0, steps: {}, verified: {}, restarts: 0, restarts_suppressed: 0, recoveries_ms: [], max_stuck_ms: 0, escape_by: {}, lag_aborts: 0 }
  }

  /** L2 strategy escalation bookkeeping. */
  noteFail(name, ok) {
    if (ok) { this.fails.delete(name); return }
    const e = this.fails.get(name) ?? { n: 0, t: 0 }
    this.fails.set(name, { n: e.n + 1, t: this.now() })
  }
  skipped(name) {
    if (name === 'escape_descend' || name === 'escape') return false // never give up on coming down; the escape rung tracks its own skills
    const e = this.fails.get(name)
    if (!e) return false
    if (this.now() - e.t > this.cfg.failTtlS * 1000) { this.fails.delete(name); return false }
    return e.n >= this.cfg.failSkip
  }

  reset(reason = 'progress') {
    if (reason === 'moved' || reason === 'teleport' || reason === 'spawn' || String(reason).startsWith('state:')) this.fails.clear()
    if (this.level === 0 && this.topFails === 0) return
    this.trace?.event('unstuck_reset', { reason, from_level: this.level })
    this.level = 0; this.topFails = 0; this.cooldownUntil = 0
  }

  /** ARB1 (c): an escape step is not requested while a reflex / another skill holds the body: wait for the release (bounded), then request once. */
  async #runFree(name, args, opts) {
    const rn = this.runner
    if (rn?.isHeld?.('s1')) {
      this.#log('escape_wait_free', { skill: name, holder: rn.arbiter?.holder ? `${rn.arbiter.holder.owner}:${rn.arbiter.holder.label}` : null })
      await rn.waitFree(10000)
    }
    return this.run(name, args, opts)
  }

  #pos() { return this.body.bot?.entity?.position?.clone?.() ?? null }
  #log(type, f) { this.trace?.event(type, f) }

  /** Run one episode: chain levels until one is verified (or the top is reached). */
  async trigger(reason, extra = {}) {
    if (this.busy) return null
    this.busy = true; this.active = true
    const ep = { id: ++this.n, reason, t0: this.now(), anchor: this.#pos(), gen: this.body.gen, steps: [], stalled_ms: extra.stalled_ms ?? 0 }
    this.stats.episodes++
    this.#log('unstuck_start', { ep: ep.id, reason, level: this.level, pos: ep.anchor && [ep.anchor.x, ep.anchor.y, ep.anchor.z].map((v) => +v.toFixed(1)) })
    const bot0 = this.body.bot
    const mv = bot0?.pathfinder?.movements
    const oldDig = mv?.canDig
    if (mv) mv.canDig = true // digging is allowed ONLY while unstuck mode is active
    let result = { verified: false, ep: ep.id }
    try {
      for (;;) {
        await this.runner.abort('unstuck').catch(() => {})
        if (this.#interrupted(ep)) { result.interrupted = true; break }
        let lvl = this.level >= 5 ? 3 : this.level + 1
        while ((this.cfg.skip?.includes(lvl) || (lvl < 5 && this.skipped(LEVELS[lvl]))) && lvl < 5) { // test/ops switch + L2: skip rungs that failed >= failSkip times
          if (!this.cfg.skip?.includes(lvl)) this.#log('unstuck_skip', { ep: ep.id, level: LEVELS[lvl], fails: this.fails.get(LEVELS[lvl])?.n })
          this.level = lvl; lvl++
        }
        const ostep = await this.#doorFirst(ep) // B1: a door within reach beats every digging rung
        if (ostep) { ep.steps.push(ostep); if (ostep.interrupted) { result.interrupted = true; break } if (ostep.verified) { result = { verified: true, ep: ep.id, level: 3, by: 'escape_open_door' }; this.fails.clear(); break } }
        const dstep = await this.#descendFirst(ep) // L2: elevated on a column/ledge -> come down before any other rung
        if (dstep) { ep.steps.push(dstep); if (dstep.interrupted) { result.interrupted = true; break } if (dstep.verified) { result = { verified: true, ep: ep.id, level: 3, by: 'escape_descend' }; this.fails.clear(); break } }
        const step = await this.#level(lvl, ep)
        this.level = lvl
        ep.steps.push(step)
        if (step.interrupted) { result.interrupted = true; break }
        if (step.verified) { result = { verified: true, ep: ep.id, level: lvl, by: step.by }; break }
        if (lvl === 5) {
          this.topFails++
          const back = Math.min(this.cfg.backoffMaxS, this.cfg.backoffBaseS * 2 ** (this.topFails - 1))
          this.cooldownUntil = this.now() + back * 1000
          this.#log('unstuck_backoff', { ep: ep.id, backoff_s: back })
          break
        }
      }
    } catch (e) { this.#log('unstuck_error', { ep: ep.id, message: String(e?.message ?? e) }) } finally {
      if (mv && oldDig !== undefined) mv.canDig = oldDig
      this.busy = false; this.active = false
    }
    const ms = this.now() - ep.t0 + ep.stalled_ms
    if (result.verified) { this.stats.recoveries_ms.push(ms); this.stats.max_stuck_ms = Math.max(this.stats.max_stuck_ms, ms) }
    this.#log('unstuck_end', { ep: ep.id, verified: result.verified, interrupted: !!result.interrupted, level: this.level, ms, steps: ep.steps.map((s) => `${LEVELS[s.level]}${s.by ? ':' + s.by : ''}=${s.verified ? 'ok' : 'no'}`) })
    this.emit('episode', { ...result, ms })
    return result
  }

  #interrupted(ep) {
    if (!this.body.spawned || this.body.gen !== ep.gen) { this.#log('unstuck_interrupted', { ep: ep.id, why: 'state_change' }); this.level = 0; return true }
    if (this.lag.status().lagging) { this.stats.lag_aborts++; this.#log('unstuck_interrupted', { ep: ep.id, why: 'lag' }); return true }
    return false
  }

  verify(startPos, level) {
    const bot = this.body.bot
    if (!bot?.entity || !startPos) return { ok: false, moved: 0 }
    const p = bot.entity.position
    const moved = hdist(p, startPos)
    const dy = p.y - startPos.y
    const d = diagnose(bot)
    const ok = (moved >= (this.cfg.minMove[level] ?? 2) || dy >= 1.5 || dy <= -1.5) && !d.trapped
    return { ok, moved: +moved.toFixed(2), dy: +dy.toFixed(2), trapped: d.trapped }
  }

  async #level(level, ep) {
    const name = LEVELS[level]
    const t0 = this.now()
    const start = this.#pos()
    this.stats.steps[name] = (this.stats.steps[name] ?? 0) + 1
    this.metrics?.reflex?.(`unstuck_${name}`) // counted with the reflex counters (no extra metrics API)
    let by = null, detail = {}
    if (level === 1 || level === 2) {
      const r = await this.#runFree(level === 1 ? 'unstuck_nudge' : 'unstuck_move_away', { unstuck: true }, { owner: 's1', intent_id: `unstuck-${ep.id}-${name}` })
      detail = { status: r.status, reason: r.reason }
    } else if (level === 3) {
      const r = await this.#escape(ep)
      by = r.by; detail = r
    } else if (level === 4) {
      const h = this.getHome(this.body.bot) ?? (this.body.bot?.spawnPoint ? { x: this.body.bot.spawnPoint.x, y: this.body.bot.spawnPoint.y, z: this.body.bot.spawnPoint.z } : null)
      const r = h ? await this.#runFree('unstuck_go_home', { unstuck: true, home: h }, { owner: 's1', intent_id: `unstuck-${ep.id}-home` }) : { status: 'rejected', reason: 'no_home' }
      detail = { status: r.status, reason: r.reason, home: h }
    } else {
      detail = this.#restart(ep)
      const step = { level, verified: false, ...detail }
      this.#log('unstuck_step', { ep: ep.id, level: name, verified: false, ms: this.now() - t0, ...detail })
      return step
    }
    if (this.#interrupted(ep) && !this.body.spawned) return { level, verified: false, interrupted: true }
    const v = this.verify(start, level)
    if (v.ok) { this.stats.verified[name] = (this.stats.verified[name] ?? 0) + 1; if (by) this.stats.escape_by[by] = (this.stats.escape_by[by] ?? 0) + 1 }
    this.noteFail(name, v.ok)
    this.#log('unstuck_step', { ep: ep.id, level: name, by, verified: v.ok, moved: v.moved, dy: v.dy, trapped: v.trapped, ms: this.now() - t0, ...detail })
    return { level, verified: v.ok, by }
  }

  /** B1: a wooden door / gate within reach: open it and walk through before nudging, pathing or digging. At most 2 tries per episode. */
  async #doorFirst(ep) {
    const bot = this.body.bot
    if (!bot?.entity || (ep.doorTries ?? 0) >= 2 || !findDoors(bot, 4.6, { includeOpen: true }).length) return null
    ep.doorTries = (ep.doorTries ?? 0) + 1
    const t0 = this.now(), start = this.#pos()
    this.stats.steps.open_door = (this.stats.steps.open_door ?? 0) + 1
    const r = await this.#runFree('escape_open_door', { unstuck: true }, { owner: 's1', intent_id: `unstuck-${ep.id}-door` })
    if (this.#interrupted(ep) && !this.body.spawned) return { level: 3, verified: false, interrupted: true }
    const v = this.verify(start, 3)
    if (v.ok) { this.stats.verified.open_door = (this.stats.verified.open_door ?? 0) + 1; this.stats.escape_by.escape_open_door = (this.stats.escape_by.escape_open_door ?? 0) + 1 }
    this.#log('unstuck_step', { ep: ep.id, level: 'open_door', by: 'escape_open_door', verified: v.ok, moved: v.moved, dy: v.dy, trapped: v.trapped, ms: this.now() - t0, status: r.status, reason: r.reason })
    return { level: 3, verified: v.ok, by: 'escape_open_door' }
  }

  /** L2: if standing elevated with no walkable neighbour, run escape_descend (it mines/steps down). Returns a step record or null. */
  async #descendFirst(ep) {
    if (!diagnose(this.body.bot).elevated) return null
    const t0 = this.now(), start = this.#pos()
    this.stats.steps.descend = (this.stats.steps.descend ?? 0) + 1
    this.metrics?.reflex?.('unstuck_descend')
    const r = await this.#runFree('escape_descend', { unstuck: true }, { owner: 's1', intent_id: `unstuck-${ep.id}-descend` })
    if (this.#interrupted(ep) && !this.body.spawned) return { level: 3, verified: false, interrupted: true }
    const v = this.verify(start, 3)
    if (v.ok) { this.stats.verified.descend = (this.stats.verified.descend ?? 0) + 1; this.stats.escape_by.escape_descend = (this.stats.escape_by.escape_descend ?? 0) + 1 }
    this.#log('unstuck_step', { ep: ep.id, level: 'descend', by: 'escape_descend', verified: v.ok, moved: v.moved, dy: v.dy, trapped: v.trapped, ms: this.now() - t0, status: r.status, reason: r.reason })
    return { level: 3, verified: v.ok, by: 'escape_descend' }
  }

  /** The escape rung: run the applicable escape skills in order, re-planning after each, until free. */
  async #escape(ep) {
    const t0 = this.now()
    const tried = new Set()
    const log = []
    let startPos = this.#pos()
    while (this.now() - t0 < this.cfg.escapeBudgetS * 1000) {
      const bot = this.body.bot
      if (!bot?.entity || this.#interrupted(ep)) return { by: null, log, interrupted: true }
      const { cands, diag } = planEscape(bot)
      if (!diag.trapped && this.verify(startPos, 3).ok) return { by: log.at(-1)?.skill ?? null, log }
      const next = cands.find((c) => !tried.has(c) && !this.skipped(c))
      if (!next) break
      tried.add(next)
      const before = this.#pos()
      const ts = this.now()
      const r = await this.#runFree(next, { unstuck: true }, { owner: 's1', intent_id: `unstuck-${ep.id}-${next}` })
      const after = this.#pos()
      const moved = before && after ? +hdist(before, after).toFixed(2) : 0
      if (r.status !== 'rejected') this.noteFail(next, r.status === 'done')
      log.push({ skill: next, status: r.status, reason: r.reason, ms: this.now() - ts, moved })
      this.#log('escape_try', { ep: ep.id, skill: next, status: r.status, reason: r.reason, ms: this.now() - ts, moved })
      if (r.status === 'done') for (const k of [...tried]) if (k !== 'escape_jump_spam' && k !== 'escape_place_under') tried.delete(k) // the world changed: retry the heavy skills (cheap probes once per episode)
      if (r.status === 'rejected' && r.reason === 'busy') { if (this.runner?.waitFree) await this.runner.waitFree(10000); else await new Promise((res) => setTimeout(res, 150)); tried.delete(next) }
    }
    return { by: log.filter((l) => l.status === 'done').at(-1)?.skill ?? null, log }
  }

  #restart(ep) {
    this.store.prune()
    const t = this.now(), last = this.store.ts.at(-1) ?? -Infinity
    const why = t - last < this.cfg.restartMinIntervalS * 1000 ? 'min_interval' : this.store.ts.length >= this.cfg.restartMaxPerDay ? 'max_per_day' : null
    if (why) {
      this.stats.restarts_suppressed++
      this.#log('restart_suppressed', { ep: ep.id, why, last_ago_s: Math.round((t - last) / 1000), in_last_day: this.store.ts.length })
      this.emit('help_needed', { why })
      return { restart: false, suppressed: why }
    }
    this.store.add()
    this.stats.restarts++
    this.#log('restart_request', { ep: ep.id, reason: ep.reason, in_last_day: this.store.ts.length })
    this.emit('restart', ep.reason)
    try { this.onRestart?.(ep.reason) } catch (e) { this.#log('restart_error', { message: String(e?.message ?? e) }) }
    return { restart: true }
  }
}
