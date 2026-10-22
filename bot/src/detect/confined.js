// W1: GLOBAL no-displacement watchdog, independent of skill type. Observed twice: Wren stood in a pit for 30+ min while movement skills
// failed (not_reached / not_far_enough / ...) and the habit layer chose idle_activity/gesture (which finish 'done' and used to count as progress).
// Declares 'confined' when she barely moved over a long window AND (many movement failures OR mostly idle/gesture in daylight).
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

export const MOVE_FAIL_RE = /^(not_reached|no_path|not_far_enough|no_reachable_target|unreachable|unreachable_animal|no_movement)$/
export const MOVE_SKILLS = new Set(['approach', 'return_home', 'flee', 'hunt', 'collect', 'explore', 'wander', 'go_to', 'gather_wood', 'gather_stone', 'return_to_surface', 'follow', 'seek_food'])
export const IDLE_SKILLS = new Set(['idle_activity', 'gesture', 'look_at'])
export const isNightTicks = (bot) => { const t = (((bot?.time?.timeOfDay ?? 1000) % 24000) + 24000) % 24000; return t >= 12542 && t <= 23459 }

/** Shared module-level state + bus, so habits/mindlink can read it without main.js wiring. */
export const confinedBus = new EventEmitter()
export const confinedShared = { confined: false, since: null, declared: 0, rescue: null, rescues: 0, geometry: null, dir: null, idleStreakChecks: 0, checkRequested: false }
export function resetConfinedShared() { Object.assign(confinedShared, { confined: false, since: null, declared: 0, rescue: null, rescues: 0, geometry: null, dir: null, idleStreakChecks: 0, checkRequested: false }) }

const cls = (bot, v) => {
  const b = bot.blockAt?.(v)
  if (b && /_(door|fence_gate)$/.test(b.name) && !b.name.startsWith('iron_')) return 'A' // B1: a wooden door is a way out, not a wall
  if (!b || b.boundingBox === 'empty') return b && /water|lava/.test(b.name) ? 'L' : 'A'
  if (/water|lava|bubble/.test(b.name)) return 'L'
  return b.boundingBox === 'block' ? 'S' : 'A'
}
/** 3x3 horizontal x 4 vertical (feet-1 .. feet+2) grid, S solid / A air / L liquid. layers[0] = below feet; rows = z, chars = x. */
export function geometryGrid(bot) {
  const p = bot.entity.position
  const c = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.001), Math.floor(p.z))
  const layers = []
  for (let dy = -1; dy <= 2; dy++) {
    const rows = []
    for (let dz = -1; dz <= 1; dz++) { let r = ''; for (let dx = -1; dx <= 1; dx++) r += cls(bot, c.offset(dx, dy, dz)); rows.push(r) }
    layers.push(rows.join('/'))
  }
  return { origin: [c.x, c.y, c.z], layers, legend: 'layers y-1,y,y+1,y+2; rows z-1..z+1; chars x-1..x+1; S solid A air L liquid' }
}
/** Direction (of 4) with the thinnest solid wall to open space within 8 blocks: the best way to dig out. */
export function digDirection(bot) {
  const p = bot.entity.position
  const c = new Vec3(Math.floor(p.x), Math.floor(p.y + 0.001), Math.floor(p.z))
  const dirs = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }
  let best = null
  for (const [name, [dx, dz]] of Object.entries(dirs)) {
    let thick = 0, found = false
    for (let k = 1; k <= 8; k++) {
      const a = c.offset(dx * k, 0, dz * k), h = c.offset(dx * k, 1, dz * k), g = c.offset(dx * k, -1, dz * k)
      const open = cls(bot, a) === 'A' && cls(bot, h) === 'A'
      if (open && cls(bot, g) === 'S') { if (thick > 0) { found = true; break } continue } // free cells of her own cell/room before the first wall do not count as the way out
      if (cls(bot, a) === 'L') break
      thick++
    }
    if (found && (!best || thick < best.thickness)) best = { dir: name, thickness: thick }
  }
  return best ?? { dir: 'up', thickness: 0 }
}

export class GlobalDisplacementWatchdog {
  /** All times are the caller's clock in ms (StuckMonitor passes its lag-frozen healthy clock). */
  constructor({ trace = null, cfg = {} } = {}) {
    this.trace = trace
    this.cfg = { windowS: 150, maxDisp: 2.5, minFails: 3, idleShare: 0.6, minSkills: 6, minSpanS: 140, redeclareS: 45, rescueAfter: 3, rescueEveryS: 300, ...cfg }
    this.samples = []; this.results = []
    this.lastDeclare = -Infinity; this.lastRescue = -Infinity; this.failedEpisodes = 0
  }
  rebase() { this.samples = []; this.results = [] }
  sample(t, p) {
    this.samples.push({ t, x: p.x, y: p.y, z: p.z })
    const cut = t - (this.cfg.windowS + 20) * 1000
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift()
  }
  noteResult(t, skill, status, reason) {
    if (status === 'rejected') return
    this.results.push({ t, skill, status, reason })
    const cut = t - (this.cfg.windowS + 20) * 1000
    while (this.results.length && this.results[0].t < cut) this.results.shift()
  }
  /** Displacement over the window: max 3D distance of any sample from the latest one; span = seconds covered. */
  displacement(t, win = this.cfg.windowS) {
    const from = t - win * 1000
    const w = this.samples.filter((s) => s.t >= from)
    if (w.length < 2) return { disp: Infinity, spanS: 0, n: w.length }
    const last = w.at(-1)
    let m = 0
    for (const s of w) m = Math.max(m, Math.hypot(s.x - last.x, s.y - last.y, s.z - last.z))
    return { disp: m, spanS: (last.t - w[0].t) / 1000, n: w.length }
  }
  /** ctx: {awake, sleeping, night, deliberateShelter}. Returns a verdict object or null. */
  evaluate(t, ctx = {}) {
    const c = this.cfg
    if (ctx.sleeping || ctx.awake === false) return null
    if (ctx.night && ctx.deliberateShelter) return null
    const win = ctx.relaxed ? 90 : c.windowS, minSpan = ctx.relaxed ? 80 : c.minSpanS // relaxed: the habit layer saw an idle streak while driven
    const d = this.displacement(t, win)
    if (d.disp >= c.maxDisp || d.spanS < minSpan) return null
    const from = t - win * 1000
    const rs = this.results.filter((r) => r.t >= from)
    const moveFails = rs.filter((r) => r.status !== 'done' && r.status !== 'aborted' && MOVE_FAIL_RE.test(r.reason ?? '')).length
    const idle = rs.filter((r) => IDLE_SKILLS.has(r.skill)).length
    const share = rs.length ? idle / rs.length : 0
    let why = null
    if (moveFails >= (ctx.relaxed ? 2 : c.minFails)) why = 'move_failures'
    else if (!ctx.night && rs.length >= c.minSkills && share > c.idleShare) why = 'idle_share'
    if (!why) return null
    if (t - this.lastDeclare < c.redeclareS * 1000) return null
    this.lastDeclare = t
    return { why, disp: +d.disp.toFixed(2), span_s: Math.round(d.spanS), move_fails: moveFails, idle_share: +share.toFixed(2), skills: rs.length }
  }
  /** Result of a confined episode. Returns 'rescue' when the ladder failed enough times and the rate limit allows a request. */
  noteEpisode(t, verified) {
    if (verified) { this.failedEpisodes = 0; confinedShared.confined = false; confinedShared.rescue = null; this.rebase(); return null }
    this.failedEpisodes++
    if (this.failedEpisodes >= this.cfg.rescueAfter && t - this.lastRescue >= this.cfg.rescueEveryS * 1000) { this.lastRescue = t; return 'rescue' }
    return null
  }
}
