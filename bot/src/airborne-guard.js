// SURV3: the server kicks a player who "floats" (no block within 0.55 below, not falling) for > 80 ticks ("Flying is not enabled on this server").
// observed: gather_wood rejected 4 tree-trunk targets in a row (1.1 s of synchronous findBlocks each, no await between them), so the physics timer never ran for
// ~4.4 s while the last packet was mid-jump: the server latched "floating" and kicked her. Two defences:
//  1. AirborneGuard: airborne > maxAirMs (default 2 s) outside water/ladders/webs -> revoke the running skill + stop the body (trace airborne_guard); loop stalls
//     > stallMs are traced (loop_stall) with the airborne flag so the next case shows its cause.
//  2. whenGrounded(bot) / yieldTick(): long synchronous work first lets the physics timer run and waits until she stands (used by gather's search loop).
import { stopBody } from './body-control.js'

const CLIMB_RE = /^(ladder|vine|scaffolding|weeping_vines|twisting_vines|cave_vines|cave_vines_plant|weeping_vines_plant|twisting_vines_plant|cobweb|water|lava|bubble_column|powder_snow|honey_block|slime_block)$/

/** True when airborne in a way that is NOT a normal fall/swim/climb. */
export function isAirborne(bot) {
  const e = bot?.entity
  if (!e || bot.health <= 0 || bot.isSleeping || e.vehicle || bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator') return false
  if (e.onGround) return false
  if (e.elytraFlying) return false
  const p = e.position
  for (const dy of [0, 0.5, 1.2, -0.3]) {
    const b = bot.blockAt?.(p.offset(0, dy, 0))
    if (b && CLIMB_RE.test(b.name)) return false
  }
  return true
}

/** Let the event loop run (physics tick, packets) for ~ms. */
export const yieldTick = (ms = 0) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

/** Resolve once she stands on something (or after maxMs): call before heavy synchronous work. Returns true when grounded. */
export async function whenGrounded(bot, maxMs = 1500) {
  const t0 = Date.now()
  await yieldTick(0)
  while (isAirborne(bot) && Date.now() - t0 < maxMs) await yieldTick(50)
  return !isAirborne(bot)
}

export class AirborneGuard {
  constructor({ getBot, arbiter, trace = null, maxAirMs = 2000, stallMs = 1500, tickMs = 100, now = Date.now }) {
    Object.assign(this, { getBot, arbiter, trace, maxAirMs, stallMs, tickMs, now })
    this.since = null; this.last = now(); this.cool = 0; this.fired = 0; this.stalls = 0; this.timer = null
  }
  start() { if (!this.timer) { this.last = this.now(); this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.() } return this }
  stop() { clearInterval(this.timer); this.timer = null }
  tick() {
    const t = this.now(), gap = t - this.last; this.last = t
    const bot = this.getBot()
    const air = isAirborne(bot)
    if (gap > this.stallMs) { this.stalls++; this.trace?.event('loop_stall', { ms: gap, airborne: air, pos: bot?.entity ? [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z].map((v) => +v.toFixed(1)) : null }) }
    if (!air) { this.since = null; return null }
    this.since ??= t - (gap > this.tickMs * 2 ? gap : 0)
    const ms = t - this.since
    if (ms < this.maxAirMs || t < this.cool) return null
    this.cool = t + 3000; this.fired++
    const h = this.arbiter?.holder
    const p = bot.entity.position
    this.trace?.event('airborne_guard', { ms, vy: +(bot.entity.velocity?.y ?? 0).toFixed(2), owner: h ? `${h.owner}:${h.label}` : null, pos: [p.x, p.y, p.z].map((v) => +v.toFixed(1)) })
    try { stopBody(bot) } catch { /* ignore */ }
    this.arbiter?.revokeAll?.('airborne_guard')?.catch?.(() => {})
    this.since = null
    return { ms }
  }
}
