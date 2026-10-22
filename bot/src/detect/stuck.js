// Stuck monitor: decides WHEN the escalation ladder runs. All clocks are "healthy time": they freeze while the lag
// monitor reports lag, so a lag spike / chunk unload / connection stall never escalates.
import { EventEmitter } from 'node:events'
import { hdist } from '../escape/world.js'
import { diagnose } from '../escape/world.js'
import { Vec3 } from 'vec3'
import { pillboxCells } from '../habits/safety.js'
import { GlobalDisplacementWatchdog, IDLE_SKILLS, confinedShared, confinedBus, geometryGrid, digDirection, isNightTicks } from './confined.js'

/** SURV2: sealed into a pillbox whose blocks she placed herself (night shelter / dig_in / pit): that is resting, not being trapped. */
export function inOwnShelter(bot) {
  try {
    const p = bot.entity?.position, placed = bot.__placed
    if (!p || !placed) return false
    const S = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    const cells = pillboxCells(S)
    let own = 0
    for (const c of cells) {
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
      if (!(b && b.boundingBox === 'block')) return false
      if (placed.has(c)) own++
    }
    return own >= 5
  } catch { return false }
}
/** HYG1: every cell of the pillbox around her is solid (placed or natural: a dug pit counts). */
export function fullyEnclosed(bot) {
  try {
    const p = bot.entity?.position; if (!p) return false
    const S = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    return pillboxCells(S).every((c) => { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); return !!b && b.boundingBox === 'block' })
  } catch { return false }
}
/** HYG1: the longest a low-hp body is left sealed in cover before the stuck ladder may dig her out (observed case: ladder broke out of the cover at hp 4 with a pillager 7 m away). */
export const COVER_HOLD_MS = 120000
const DELIBERATE_ENCLOSURE = new Set(['dig_in', 'build', 'shelter', 'hole_and_cap'])
export class StuckMonitor extends EventEmitter {
  constructor({ body, runner, ladder, lag, trace = null, now = Date.now, cfg = {} }) {
    super()
    Object.assign(this, { body, runner, ladder, lag, trace, now })
    this.cfg = { confinedS: 15, confinedCheckS: 3, tickMs: 1000, stuckRadius: 4, globalNoProgressS: 180, progressMoveBlocks: 8, settleS: 6, resetAfterS: 120, teleportBlocks: 10, histS: 90, idleTrappedS: 30, ...cfg }
    this.hist = []
    this.lastTick = now(); this.lastPos = null; this.anchor = null
    this.noProgressMs = 0; this.idleMs = 0; this.sinceTriggerMs = 0
    this.settleUntil = 0; this.healthy = 0; this.checkAt = 0
    this.timer = null
    this.confined = new GlobalDisplacementWatchdog({ trace, cfg: cfg.confinedGlobal })
    this.gCheckAt = 0
    this.stats = { confined_global: 0, rescues: 0, frozen_ms: 0, teleports: 0, stalls_physical: 0, stalls_free: 0, triggers: 0, global_triggers: 0 }
  }
  start() { if (!this.timer) { this.lastTick = this.now(); this.timer = setInterval(() => this.tick(), this.cfg.tickMs); this.timer.unref?.() } }
  stop() { clearInterval(this.timer); this.timer = null }

  rebase() { this.confined?.rebase(); this.hist = []; this.lastPos = null; this.anchor = null; this.noProgressMs = 0; this.idleMs = 0 }

  progress(kind) {
    if (kind === 'moved' || kind === 'teleport') { confinedShared.confined = false; confinedShared.rescue = null; confinedShared.since = null; if (this.confined) this.confined.failedEpisodes = 0 }
    this.noProgressMs = 0; this.idleMs = 0
    const p = this.body.bot?.entity?.position
    if (p) this.anchor = { x: p.x, z: p.z }
    if (!this.ladder.busy) this.ladder.reset(kind)
  }

  /** Extent of recent movement over the last ms (horizontal max distance from the latest sample, vertical range). */
  extent(ms) {
    const h = this.hist
    if (!h.length) return { h: Infinity, v: Infinity, n: 0 }
    const last = h.at(-1), from = last.t - ms
    let mh = 0, vmin = last.y, vmax = last.y, n = 0
    for (const s of h) if (s.t >= from) { n++; mh = Math.max(mh, hdist(s, last)); vmin = Math.min(vmin, s.y); vmax = Math.max(vmax, s.y) }
    return { h: mh, v: vmax - vmin, n }
  }

  /** A skill stalled (watchdog event or runner abort no_progress/max_s). */
  onStall(info) {
    if (this.ladder.busy) return
    const ex = this.extent(Math.min(60000, (info.stalled_ms ?? 10000) + 3000))
    const physical = ex.n >= 2 && ex.h <= this.cfg.stuckRadius && ex.v <= this.cfg.stuckRadius
    this.trace?.event('stall_eval', { skill: info.skill, source: info.source, extent_h: +ex.h.toFixed(1), extent_v: +ex.v.toFixed(1), physical })
    if (physical) { this.stats.stalls_physical++; this.#trigger('stall_physical', info) } else this.stats.stalls_free++
  }

  /** idle/gesture/idle_activity finish 'done' without going anywhere: they must NEVER count as progress (W1 incident: 165 of them kept the detector blind). */
  noteSkillResult(res, name = res.skill) {
    this.confined?.noteResult(this.healthy, name, res.status, res.reason)
    // ARB1: an enclosure she built on purpose (dig_in / build / shelter) is not 'trapped' for a while after it is done
    if (res.status === 'done' && DELIBERATE_ENCLOSURE.has(name)) this.deliberateUntil = this.healthy + 120000
    if (res.status === 'done' && !IDLE_SKILLS.has(name)) this.progress('skill_done')
  }

  /** HYG1: hurt (hp <= 10) and fully walled in, or sealed in her own pillbox at night: this is cover, not a trap. Bounded by COVER_HOLD_MS so a real trap is still escaped. */
  #coverHold(bot) {
    const hold = (isNightTicks(bot) && inOwnShelter(bot)) || ((bot.health ?? 20) <= 10 && fullyEnclosed(bot))
    if (!hold) { this._holdSince = null; return false }
    this._holdSince ??= this.healthy
    // STUCK3: cooking inside the cell is the way out of hunger, not being stuck: the 120 s bound counts from the last cook activity (live: ladder dug her out of her cover 150 s after the leak was plugged)
    if ((this.runner?.current?.skill?.name ?? this.runner?.current?.name) === 'cook') this._holdSince = this.healthy
    if (this.healthy - this._holdSince > COVER_HOLD_MS && (bot.health ?? 20) <= 10 && !(isNightTicks(bot) && inOwnShelter(bot))) return false
    return true
  }

  /** Global no-displacement check (W1). Returns the verdict when it declared 'confined' and started the ladder. */
  checkConfined(relaxed = false) {
    const bot = this.body.bot, cur = this.runner.current
    if (!bot?.entity || this.ladder.busy) return null
    if (this.healthy < (this.deliberateUntil ?? 0)) return null
    if (this.#coverHold(bot)) return null
    if (isNightTicks(bot) && inOwnShelter(bot)) { if (!this._ownShelterNoted) { this._ownShelterNoted = true; this.trace?.event('confined_skipped', { why: 'own_shelter_night' }) } return null }   // SURV2: sheltered, not trapped
    const night = isNightTicks(bot)
    const cname = cur?.skill?.name ?? cur?.name
    const ctx = { awake: !bot.isSleeping, sleeping: !!bot.isSleeping, night, relaxed, deliberateShelter: !!cur && (cur.skill?.stationary || cname === 'shelter' || cname === 'sleep') }
    const v = this.confined.evaluate(this.healthy, ctx)
    if (!v) return null
    this.stats.confined_global++
    let geometry = null, dir = null
    try { geometry = geometryGrid(bot); dir = digDirection(bot) } catch { /* chunk edge */ }
    const p = bot.entity.position
    Object.assign(confinedShared, { confined: true, since: confinedShared.since ?? Date.now(), declared: confinedShared.declared + 1, geometry, dir })
    this.trace?.event('confined_global', { ...v, pos: [p.x, p.y, p.z].map((x) => +x.toFixed(1)), geometry, dig_dir: dir, night })
    if (this.ladder.level < 2) this.ladder.level = 2 // the nudge / move_away rungs are movement skills: they already failed; start at the escape rung
    this.#trigger('confined_global', {})
    return v
  }

  #trigger(reason, info = {}) {
    // REC2: while the body-level recover routine (eat / cook / wait in cover) runs, the ladder stays quiet (drowning, suffocation, fire, lava excepted: recover.suppressLadder() says so)
    if (this.suppress?.()) { if (!this._recNoted || this.healthy - this._recNoted > 30000) { this._recNoted = this.healthy; this.trace?.event('rec2_ladder_suppressed', { reason }) } return }
    if (this.ladder.busy || this.now() < this.ladder.cooldownUntil || this.healthy < this.settleUntil) return
    this.stats.triggers++
    if (reason === 'global_no_progress') this.stats.global_triggers++
    this.sinceTriggerMs = 0
    this.noProgressMs = 0
    this.ladder.trigger(reason, { stalled_ms: info.stalled_ms }).then((r) => {
      if (confinedShared.confined && r && !r.interrupted) this.#episodeDone(!!r.verified)
      if (r?.verified) this.settleUntil = this.healthy + this.cfg.settleS * 1000
      const p = this.body.bot?.entity?.position
      if (p) this.anchor = { x: p.x, z: p.z }
    }).catch(() => {})
  }

  #episodeDone(verified) {
    const act = this.confined.noteEpisode(this.healthy, verified)
    if (act !== 'rescue') return
    const bot = this.body.bot, p = bot?.entity?.position
    const dir = confinedShared.dir?.dir ?? 'up'
    const text = `you are confined and cannot move; try dig out in direction ${dir}`
    const ev = { pos: p && [p.x, p.y, p.z].map((x) => +x.toFixed(1)), dig_dir: dir, failed_episodes: this.confined.failedEpisodes, geometry: confinedShared.geometry, text }
    this.stats.rescues++; confinedShared.rescues++
    confinedShared.rescue = { ...ev, at: Date.now() }
    this.trace?.event('rescue_requested', ev)
    this.ladder.emit('help_needed', { why: 'rescue_requested', ...ev })
    confinedBus.emit('rescue_requested', ev)
  }

  tick() {
    const t = this.now()
    const dt = Math.max(0, Math.min(t - this.lastTick, 10000))
    this.lastTick = t
    const bot = this.body.bot
    if (!this.body.spawned || !bot?.entity) { this.rebase(); return }
    const pos = bot.entity.position
    if (this.lastPos && Math.hypot(pos.x - this.lastPos.x, pos.y - this.lastPos.y, pos.z - this.lastPos.z) > this.cfg.teleportBlocks) {
      this.stats.teleports++
      this.lag.noteDiscontinuity('teleport')
      this.rebase(); this.ladder.reset('teleport'); confinedShared.confined = false; confinedShared.rescue = null; this.confined.failedEpisodes = 0
      this.lastPos = { x: pos.x, y: pos.y, z: pos.z }
      return
    }
    this.lastPos = { x: pos.x, y: pos.y, z: pos.z }
    const ls = this.lag.status()
    if (ls.lagging) { this.stats.frozen_ms += dt; return }
    const hdt = dt / ls.factor
    this.healthy += hdt
    this.hist.push({ t: this.healthy, x: pos.x, y: pos.y, z: pos.z })
    while (this.hist.length && this.healthy - this.hist[0].t > this.cfg.histS * 1000) this.hist.shift()
    this.confined.sample(this.healthy, pos)
    if (this.healthy >= this.gCheckAt && !this.ladder.busy) {
      const rel = confinedShared.checkRequested; confinedShared.checkRequested = false
      this.gCheckAt = this.healthy + 5000
      try { this.checkConfined(rel) } catch (e) { this.trace?.event('confined_check_error', { message: String(e?.message ?? e).slice(0, 200) }) }
    }
    if (!this.anchor) this.anchor = { x: pos.x, z: pos.z }
    if (hdist(pos, this.anchor) >= this.cfg.progressMoveBlocks) this.progress('moved')
    if (this.ladder.busy) return
    this.sinceTriggerMs += hdt
    if (this.ladder.level > 0 && this.sinceTriggerMs >= this.cfg.resetAfterS * 1000) { this.ladder.reset('quiet'); this.sinceTriggerMs = 0 }
    if (this.runner.current) { this.idleMs = 0; if (!this.#coverHold(bot)) this.noProgressMs += hdt }   // STUCK3: sealed + hurt = cover hold, not 'no progress'
    else {
      this.idleMs += hdt
      if (this.idleMs >= this.cfg.idleTrappedS * 1000) {
        const dg = diagnose(bot)
        if (dg.elevated && this.healthy >= this.checkAt) { this.checkAt = this.healthy + this.cfg.confinedCheckS * 1000; this.stats.elevated = (this.stats.elevated ?? 0) + 1; this.#trigger('elevated_column'); return } // L2: idle on a column
        if (dg.trapped && this.healthy >= (this.deliberateUntil ?? 0) && !this.#coverHold(bot)) this.noProgressMs += hdt;   // STUCK3: cover hold (hurt + sealed) is not 'no progress' else this.noProgressMs = 0
      }
    }
    // Confined + trapped by GROUND TRUTH, independent of the skill's progress_fn (which water drift or bobbing can fool).
    // Skills that legitimately stand in an enclosed spot (sleep in a shelter, mine) declare `stationary: true`.
    const cur = this.runner.current
    if (cur && !cur.skill?.stationary && this.healthy >= this.checkAt && !this.#coverHold(bot)) {
      this.checkAt = this.healthy + this.cfg.confinedCheckS * 1000
      const ex = this.extent(this.cfg.confinedS * 1000)
      const covered = this.hist.length && this.healthy - this.hist[0].t >= this.cfg.confinedS * 1000 - 2000
      if (covered && ex.h <= this.cfg.stuckRadius && diagnose(bot).trapped) { this.stats.confined = (this.stats.confined ?? 0) + 1; this.#trigger('confined_trapped'); return }
    }
    if (this.noProgressMs >= this.cfg.globalNoProgressS * 1000) this.#trigger('global_no_progress')
  }
}
