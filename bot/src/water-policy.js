// WATER1: a hurt (hp <= 6) or night-time Wren keeps away from water.
//   waterRisk(bot)         hp <= 6 or night: water is a hazard (drowned, no regen while swimming, leaks into pits)
//   installWaterPolicy     1 Hz: pathfinder liquidCost 1 -> 18 while waterRisk (routes go around water, swim only when there is no dry way)
//   nearWater / dryCell    seepage check for dig_in / hole_and_cap sites (water within 3 blocks) and "does this target need wet feet"
//   swimToDry              the first action when in water: shortest swim to the nearest dry standable block (surface route), no bridging
import { Vec3 } from 'vec3'
import { search, walkPath, cellOf } from './reflex/nav.js'
import { DangerMap, isWater, isSolid, HARD } from './reflex/danger.js'

export const LOW_HP = 6, WET_COST = 18, DRY_COST = 1, SEEP_R = 3

const tod = (bot) => (((bot.time?.timeOfDay ?? 0) % 24000) + 24000) % 24000
export function waterRisk(bot) {
  if (!bot) return false
  if ((bot.health ?? 20) <= LOW_HP && (bot.health ?? 20) > 0) return true
  if (bot._h1ForcePhase) return bot._h1ForcePhase === 'night'
  const t = tod(bot)
  return !!bot.time && t >= 12542 && t <= 23459
}

const at = (bot, x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null } }
/** a water block within r blocks (x/z) of cell S, from 2 below the floor to 2 above the feet */
export function nearWater(bot, S, r = SEEP_R) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) {
    if (isWater(at(bot, S.x + dx, S.y + dy, S.z + dz))) return true
  }
  return false
}
/** the cell (feet / head) has water in it */
export const wetCell = (bot, x, y, z) => isWater(at(bot, x, y, z)) || isWater(at(bot, x, y + 1, z))

export function installWaterPolicy(bot, { trace = null, everyMs = 1000 } = {}) {
  let wet = null
  const tick = () => {
    const mv = bot.pathfinder?.movements; if (!mv || !bot.entity) return
    const risk = waterRisk(bot), want = risk ? WET_COST : DRY_COST
    if (mv.liquidCost !== want) mv.liquidCost = want
    if (wet !== risk) { wet = risk; trace?.event('water_policy', { risk, liquidCost: want, hp: bot.health }) }
  }
  const t = setInterval(tick, everyMs); t.unref?.(); tick()
  return () => clearInterval(t)
}

/** nearest dry standable block through the water surface; null when none within reach */
export function planSwimToDry(bot, { maxNodes = 2500, maxCost = 80 } = {}) {
  const danger = new DangerMap(() => bot)
  const start = cellOf(bot.entity.position)
  const land = (c) => isSolid(danger.blockAt(c.x, c.y - 1, c.z)) && !isWater(danger.blockAt(c.x, c.y, c.z)) && !isWater(danger.blockAt(c.x, c.y + 1, c.z))
  return search(danger, start, (c, i) => land(c) && i.cost < HARD, { maxNodes, maxCost })
}

/**
 * NIGHT2: nearest land far out in open water. The reachable-shore search above stops after ~2500 nodes (~25 blocks), so in the open ocean it says "no dry land" and
 * she trod water for 11 minutes at 100,61,100 until a drowned killed her (example case; 20x20 blocks of pure water, hp 1). Samples rings of loaded columns up to maxR
 * blocks; a shore = a solid non-water block with two passable non-water blocks above it. Nearest ring wins, ties go toward home. null when no land is loaded.
 */
export function findFarShore(bot, { maxR = 112, step = 6 } = {}) {
  const p = bot.entity?.position
  if (!p) return null
  const y0 = Math.floor(p.y)
  const home = bot.__landmarks?.home
  const dh = (x, z) => (home ? Math.hypot(x - home.x, z - home.z) : 0)
  const here = dh(p.x, p.z)
  let best = null
  for (let r = 8; r <= maxR; r += step) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2 + r * 0.37
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r)
      for (let y = y0 + 6; y >= y0 - 5; y--) {
        const b = at(bot, x, y, z)
        if (!b) break   // unloaded column
        if (b.boundingBox !== 'block' || isWater(b)) continue
        const a1 = at(bot, x, y + 1, z), a2 = at(bot, x, y + 2, z)
        if (a1 && a2 && a1.boundingBox === 'empty' && a2.boundingBox === 'empty' && !isWater(a1) && !isWater(a2)) {
          const score = r - 0.15 * Math.max(-30, Math.min(30, here - dh(x, z)))
          if (!best || score < best.score) best = { x, y: y + 1, z, r, score }
        }
        break
      }
    }
    if (best && r >= best.r + 12) break
  }
  return best
}

/** swim in a straight line toward (x,z), head up, until on land or maxMs. -> {ok, reason, left} */
export const openWaterAround = (bot) => {
  const p = bot.entity?.position
  if (!p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y + 1), z = Math.floor(p.z)
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => { const b = at(bot, x + dx, y, z + dz); return !b || b.boundingBox !== 'block' }).length >= 3   // a sealed shaft / pit is no open water
}
export async function swimToward(ctx, target, { maxMs = 20000 } = {}) {
  const { bot } = ctx
  const sig = () => !!ctx.aborted || !!ctx.signal?.aborted
  const t0 = Date.now()
  let ref = bot.entity.position.clone(), refT = t0
  try {
    while (!sig() && Date.now() - t0 < maxMs) {
      const p = bot.entity.position
      const dx = target.x + 0.5 - p.x, dz = target.z + 0.5 - p.z
      const d = Math.hypot(dx, dz)
      const wet = bot.entity.isInWater || wetCell(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (!wet && bot.entity.onGround) return { ok: true, reason: 'on_land', left: d }
      if (d < 1.2 && !wet) return { ok: true, reason: 'arrived', left: d }
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)   // swimming up keeps the head out; at a ledge the jump climbs out
      bot.setControlState('sprint', wet && (bot.food ?? 20) > 6)
      if (!(await ctx.sleep(150))) return { ok: false, reason: 'aborted' }
      if (Date.now() - refT > 3000) { if (bot.entity.position.distanceTo(ref) < 0.8) return { ok: false, reason: 'stalled', left: d }; ref = bot.entity.position.clone(); refT = Date.now() }
    }
    return { ok: false, reason: sig() ? 'aborted' : 'timeout' }
  } finally { for (const k of ['forward', 'jump', 'sprint']) { try { bot.setControlState(k, false) } catch { /* ignore */ } } }
}

/** ctx: {bot, aborted, sleep}. Walks the swim path; in open water with no reachable shore it swims to the nearest far shore. -> {ok, reason, steps} */
export async function swimToDry(ctx, { stepMs = 3500, farMs = 22000 } = {}) {
  const res = planSwimToDry(ctx.bot)
  if (!res) {
    const far = openWaterAround(ctx.bot) ? findFarShore(ctx.bot) : null
    if (!far) return { ok: false, reason: 'no_dry_land' }
    ctx.log?.('swim_far_shore', { x: far.x, y: far.y, z: far.z, r: far.r })
    const w = await swimToward(ctx, far, { maxMs: farMs })
    return { ...w, steps: 0, goal: far, far: true }
  }
  const sig = { get aborted() { return !!ctx.aborted || !!ctx.signal?.aborted } }
  const w = await walkPath({ bot: ctx.bot, signal: sig, sleep: (ms) => ctx.sleep(ms) }, res.path, { sprint: false, stepMs })
  return { ...w, steps: res.path.length, goal: res.goal }
}
