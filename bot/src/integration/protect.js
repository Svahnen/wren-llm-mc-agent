// Protected regions (I1): boxes the body must never dismantle (village, built structures, test map).
// - isProtected(x,y,z) / costAt(p) (Infinity inside; mind/ style cost interface) / digForbidden(p)
// - guardDig(bot, {exempt}) wraps bot.dig so NO skill and NOT the pathfinder can break a protected block, except while
//   exempt() is true (reflex survival digging, unstuck ladder). Blocked digs throw Error('protected_region') and are counted.
import fs from 'node:fs'

export class ProtectedRegions {
  constructor({ file = null, boxes = [], trace = null } = {}) {
    this.file = file
    this.trace = trace
    this.boxes = boxes
    this.stats = { dig_blocked: 0, dig_blocked_last: null }
    if (file) this.load(file)
  }
  load(file = this.file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.boxes = (j.boxes ?? []).map((b) => ({ name: b.name ?? 'box', min: b.min, max: b.max, reason: b.reason }))
        .filter((b) => Array.isArray(b.min) && Array.isArray(b.max) && b.min.length === 3 && b.max.length === 3)
    } catch (e) { this.trace?.event('protected_load_error', { file, message: String(e.message).slice(0, 120) }); this.boxes = [] }
    return this
  }
  box(x, y, z) {
    for (const b of this.boxes) if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) return b
    return null
  }
  isProtected(x, y, z) { return !!this.box(Math.floor(x), Math.floor(y), Math.floor(z)) }
  digForbidden(p) { return !!p && this.isProtected(p.x, p.y ?? 64, p.z) }
  /** cost provider for the skills' costAt interface: Infinity inside a protected box (use for DIG target selection only). */
  costAt(p) { return this.digForbidden(p) ? Infinity : 0 }

  /** Wrap bot.dig. Idempotent per bot object. exempt(): true => allow (reflex / unstuck). */
  guardDig(bot, { exempt = () => false } = {}) {
    if (!bot || bot.__digGuard) return
    if (typeof bot.dig !== 'function') { // mineflayer injects its plugins on 'inject_allowed' (after createBot returns)
      if (!bot.__digGuardWait) { bot.__digGuardWait = true; bot.once('inject_allowed', () => { bot.__digGuardWait = false; this.guardDig(bot, { exempt }) }) }
      return
    }
    const orig = bot.dig.bind(bot)
    bot.dig = (block, ...rest) => {
      const p = block?.position
      if (p && this.isProtected(p.x, p.y, p.z) && !exempt()) {
        this.stats.dig_blocked++
        this.stats.dig_blocked_last = [p.x, p.y, p.z, block.name]
        this.trace?.event('dig_blocked_protected', { at: [p.x, p.y, p.z], block: block.name })
        return Promise.reject(Object.assign(new Error('protected_region'), { name: 'ProtectedRegion' }))
      }
      return orig(block, ...rest)
    }
    bot.__digGuard = true
  }
}
