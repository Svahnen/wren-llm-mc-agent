// Dead-state checks. HOOKS ONLY: this module detects the condition and emits 'dead_state';
// the skills that resolve it (drop_junk/store, torches, breadcrumb walk-back, food gathering) belong to T4/mind.
import { EventEmitter } from 'node:events'
import { inOwnShelter } from './stuck.js'
import { floodRoom } from '../skills/enclosure.js'

/** GATH1: a dark cell that is not a problem: open sky at night (outdoors is always dark then), or safely inside her own shelter / a bounded house room. */
export function darkIsHarmless(bot, sky) {
  if ((sky ?? 0) >= 12) return 'open_sky_night'
  try { if (inOwnShelter(bot)) return 'own_shelter' } catch { /* ignore */ }
  try {
    const p = bot.entity.position.floored()
    const r = floodRoom(bot, [p.x, p.y, p.z], { maxCells: 160 })
    if (r.bounded && (r.doors.size || r.blockedDoors.size)) return 'house_room'
  } catch { /* ignore */ }
  return null
}

export class DeadStateMonitor extends EventEmitter {
  /**
   * hooks: { getBreadcrumb(bot) -> trail|null (absent hook => reported as 'needs_breadcrumb_hook'),
   *          lightMin (default 7, torch rule), undergroundY (default 58), foodMax (default 6) }
   */
  constructor({ getBot, lag, trace = null, now = Date.now, hooks = {}, intervalMs = 5000, cooldownMs = 60000, undergroundS = 90 }) {
    super()
    Object.assign(this, { getBot, lag, trace, now, hooks, intervalMs, cooldownMs, undergroundS })
    this.state = new Map() // kind -> {since, lastEmit}
    this.timer = null
    this.undergroundMs = 0
    this.last = now()
    this.counts = {}
    this.episodes = {}   // SURV4: kind -> {lastSeen}; 'no_light' is one trace per episode (flapping at night fired 15-30x per 15 min)
    this.episodeMs = hooks.noLightEpisodeMs ?? 600000
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.check(), this.intervalMs); this.timer.unref?.() } }
  stop() { clearInterval(this.timer); this.timer = null }
  active() { return [...this.state.keys()] }
  has(kind) { return this.state.has(kind) }

  /** Evaluate all conditions now. Returns the list of active kinds. */
  check(bot = this.getBot()) {
    const t = this.now(), dt = t - this.last
    this.last = t
    if (!bot?.entity || !bot.inventory || this.lag?.status().lagging) return this.active()
    const found = {}
    const info = {}
    // inventory full
    try { if (bot.inventory.emptySlotCount() === 0) found.inventory_full = { slots: bot.inventory.slots.filter(Boolean).length } } catch { /* ignore */ }
    // no light (torch rule): effective light at feet
    try {
      const b = bot.blockAt(bot.entity.position.floored())
      if (b && typeof b.light === 'number') {
        const day = (bot.time?.timeOfDay ?? 6000) < 12000
        const eff = Math.max(b.light, day ? (b.skyLight ?? 0) : 0)
        const min = this.hooks.lightMin ?? 7
        if (eff <= min) {
          const why = darkIsHarmless(bot, b.skyLight)
          if (why) { if (this._lastDarkOk !== why) { this._lastDarkOk = why; this.trace?.event('dead_state_skipped', { kind: 'no_light', why, light: b.light, sky: b.skyLight }) } } else { this._lastDarkOk = null; found.no_light = { light: b.light, sky: b.skyLight, min } }
        }
        info.light = eff
        // disoriented underground: dark/sunless and low for a long time, no trail back
        const under = (b.skyLight ?? 15) === 0 && bot.entity.position.y < (this.hooks.undergroundY ?? 58)
        this.undergroundMs = under ? this.undergroundMs + dt : 0
        if (this.undergroundMs >= this.undergroundS * 1000) {
          const trail = this.hooks.getBreadcrumb ? this.hooks.getBreadcrumb(bot) : undefined
          if (!trail) found.disoriented_underground = { y: +bot.entity.position.y.toFixed(1), needs: this.hooks.getBreadcrumb ? 'trail_empty' : 'needs_breadcrumb_hook' }
        }
      }
    } catch { /* ignore */ }
    // hunger with no food
    try {
      if (typeof bot.food === 'number' && bot.food <= (this.hooks.foodMax ?? 6)) {
        const foods = bot.registry?.foodsByName ?? {}
        if (!bot.inventory.items().some((i) => foods[i.name])) found.hunger_no_food = { food: bot.food }
      }
    } catch { /* ignore */ }
    for (const [kind, d] of Object.entries(found)) {
      const s = this.state.get(kind)
      if (!s) { this.state.set(kind, { since: t, lastEmit: -Infinity }) }
      const st = this.state.get(kind)
      if (kind === 'no_light') {
        // SURV4: dark <-> lit flapping is ONE episode until the dark has been absent for episodeMs; later flaps are only counted
        const ep = this.episodes.no_light
        if (ep && t - ep.lastSeen < this.episodeMs) { ep.lastSeen = t; this.counts.no_light_suppressed = (this.counts.no_light_suppressed ?? 0) + 1; continue }
        this.episodes.no_light = { lastSeen: t }
      }
      if (t - st.lastEmit >= this.cooldownMs) {
        st.lastEmit = t
        this.counts[kind] = (this.counts[kind] ?? 0) + 1
        this.trace?.event('dead_state', { kind, ...d, active_s: Math.round((t - st.since) / 1000) })
        this.emit('dead_state', kind, d)
        this.hooks.onDeadState?.(kind, d)
      }
    }
    if (found.no_light && this.episodes.no_light) this.episodes.no_light.lastSeen = t
    for (const kind of [...this.state.keys()]) if (!(kind in found)) { this.state.delete(kind); if (kind !== 'no_light') this.trace?.event('dead_state_clear', { kind }); this.emit('clear', kind) }
    return this.active()
  }
}
