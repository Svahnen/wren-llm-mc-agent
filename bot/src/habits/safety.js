// Deterministic safety/survival logic for the habit layer (H1). Pure given a bot snapshot; no LLM, no I/O.
//   phase()          day | dusk | night (test flag: bot._h1ForcePhase)
//   rangedThreats()  skeleton-class mobs near, lineClear()/hiddenFrom() = line-of-sight geometry on bot.blockAt
//   hungerTier()     0..3 priority of getting food; FOOD_RESERVE = edible items we try to keep
//   returnReason()   when going home is justified at all
import { MOBS } from '../reflex/threats.js'
import { timeOfDay, isThunder, dist3, V } from '../skills/lib.js'

export const DUSK_START = 11200   // light starts to fall, mobs spawn from ~12000 outdoors
export const NIGHT_START = 12542
export const NIGHT_END = 23459
export const FOOD_RESERVE = 4
// PB1: material-agnostic building: ANY plain solid block she carries counts, ranked by preference (best first); logs and falling blocks last.
export const PLACEABLE = /^(cobblestone|cobbled_deepslate|blackstone|dirt|coarse_dirt|stone|andesite|diorite|granite|deepslate|tuff|netherrack|sandstone|red_sandstone|terracotta|sand|red_sand|gravel|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood)$/
const RANK = [/^(cobblestone|cobbled_deepslate|blackstone|stone|andesite|diorite|granite|deepslate|tuff)$/, /^(dirt|coarse_dirt)$/, /_planks$/, /^(sandstone|red_sandstone|terracotta|netherrack)$/, /^(sand|red_sand|gravel)$/, /_(log|wood)$/]
/** lower = preferred. Unknown names rank last. */
export const blockRank = (name) => { const i = RANK.findIndex((r) => r.test(name)); return i < 0 ? RANK.length : i }
export const SHELTER_BLOCKS = 9

export function phase(bot) {
  if (bot._h1ForcePhase) return bot._h1ForcePhase
  const t = timeOfDay(bot)
  if ((t >= NIGHT_START && t <= NIGHT_END) || isThunder(bot)) return 'night'
  if (t >= DUSK_START && t < NIGHT_START) return 'dusk'
  return 'day'
}
export const isDark = (bot) => phase(bot) !== 'day'

/** 0 = fine, 1 = should keep a reserve, 2 = hungry, 3 = starving. */
export function hungerTier(food) { return food <= 6 ? 3 : food <= 10 ? 2 : food <= 14 ? 1 : 0 }

const solid = (b) => !!b && b.boundingBox === 'block'
/** Is the straight segment a -> b free of solid blocks? (arrows are stopped by any full block) */
export function lineClear(bot, a, b, step = 0.4) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  const n = Math.max(1, Math.floor(len / step))
  for (let i = 1; i < n; i++) {
    const t = i / n
    const blk = bot.blockAt(V(Math.floor(a.x + dx * t), Math.floor(a.y + dy * t), Math.floor(a.z + dz * t)))
    if (solid(blk)) return false
  }
  return true
}

/** Ranged hostiles within r. Each {e, d, name}. */
export function rangedThreats(bot, r = 30) {
  const me = bot.entity?.position
  if (!me) return []
  const out = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !e.position) continue
    const prof = MOBS[e.name]
    if (!prof?.ranged || e.isValid === false || e.health === 0) continue
    const d = dist3(e.position, me)
    if (d <= r) out.push({ e, d, name: e.name })
  }
  return out.sort((a, b) => a.d - b.d)
}

/** True when `cell` (feet block coords) cannot be hit by any of the threats: no clear line to head AND none to the body centre. */
export function hiddenFrom(bot, cell, threats) {
  const head = { x: cell.x + 0.5, y: cell.y + 1.62, z: cell.z + 0.5 }
  const body = { x: cell.x + 0.5, y: cell.y + 0.6, z: cell.z + 0.5 }
  for (const t of threats) {
    const eye = { x: t.e.position.x, y: t.e.position.y + 1.5, z: t.e.position.z }
    if (lineClear(bot, eye, head) || lineClear(bot, eye, body)) return false
  }
  return true
}
export const exposedTo = (bot, threats) => threats.filter((t) => !hiddenFrom(bot, bot.entity.position.floored(), [t]))

/** charge a lone nearby shooter when healthy and armed; otherwise break the line of sight. */
export function chooseResponse({ hp, nThreats, nearest, hasWeapon }) {
  if (nThreats === 1 && nearest <= 12 && hp >= 12 && hasWeapon) return 'charge'
  return 'cover'
}

export function placeableCount(items) {
  return items.filter((i) => PLACEABLE.test(i.name)).reduce((s, i) => s + i.count, 0)
}

// DUSK1: leave for home early enough. 11 of 13 zombie/skeleton hits in the last 12 h landed 40..87 blocks from home (the observed death: 86 blocks out,
// night, hole_and_cap with a zombie already adjacent). Cutoff: seconds until dusk <= homeDist / effective walking speed + margin.
export const WALK_BPS = 3.0        // effective blocks/s on real terrain (walk 4.3, sprint 5.6, detours, stops)
export const DUSK_MARGIN_S = 75
export const HOME_FAR_M = 25       // nearer than this she is "at home" for the day-trip rule
/** seconds of daylight left before DUSK_START at world tick t (0 when already dusk/night). Pure. */
export const secsToDusk = (t) => (Number.isFinite(t) && t >= 0 && t < DUSK_START ? (DUSK_START - t) / 20 : 0)
/** true when she should already be walking home to be inside before dusk. Pure; c: {ticks, hasHome, homeDist}. */
export function shouldLeaveForDusk(c) {
  if (!c.hasHome || !Number.isFinite(c.ticks) || c.homeDist <= HOME_FAR_M) return false
  if (c.ticks >= DUSK_START || c.ticks < 0) return false   // dusk/night: the dark-time habits handle it
  return secsToDusk(c.ticks) <= c.homeDist / WALK_BPS + DUSK_MARGIN_S
}

// ROAM1: while roaming (a multi-day trip) home may be 380 m away. Then the choice at dusk is "camp here" or "go home"; the rule only reports the facts and, when home
// cannot be reached before dusk, stops dragging her home (the camp is the way to be safe). c: {ticks, hasHome, homeDist, roaming?}.
export const CAMP_LEAD_S = 100     // a camp (torch + pit or pillbox) takes about this long to set up: start before dusk
/** seconds left of daylight, walking time home, whether home is reachable before dusk. Pure. */
export function duskFacts(c) {
  const secs = c.ticks >= NIGHT_END ? (DUSK_START + 24000 - c.ticks) / 20 : secsToDusk(c.ticks), walk = c.hasHome ? c.homeDist / WALK_BPS : Infinity
  return { secs, walk, homeReachable: !!c.hasHome && walk + 15 <= secs }
}
/** the honest digest line for S2 (no advice beyond the two ways out); null when it does not apply (night, at home, no clock). */
export function duskLine(c) {
  if (!Number.isFinite(c.ticks) || c.ticks < 0 || c.ticks >= NIGHT_START) return null
  if (c.hasHome && c.homeDist <= HOME_FAR_M) return null
  const f = duskFacts(c), mins = Math.max(1, Math.ceil(((c.ticks < DUSK_START ? DUSK_START - c.ticks : 0) + (NIGHT_START - Math.max(c.ticks, DUSK_START))) / 1200))
  if (c.ticks < DUSK_START && f.secs > (c.hasHome ? f.walk : 0) + DUSK_MARGIN_S + 180) return null   // plenty of daylight: no line
  const where = c.hasHome ? `home is ${Math.round(c.homeDist)} m away` : 'no home is set'
  return `${where}; dark in ${mins} min: ${f.homeReachable ? 'go home (go_home) or camp here (make_camp)' : 'home is too far to reach before dark: camp here (make_camp)'}`
}
/** when (if at all) the roaming rule says "camp here": dusk is close and home cannot be reached in time. Pure. */
export function campReason(c) {
  if (!c.roaming || !Number.isFinite(c.ticks) || c.ticks < 0 || c.ticks >= NIGHT_START) return null
  const f = duskFacts(c)
  if (f.secs > CAMP_LEAD_S && c.ticks < DUSK_START) return null
  if (f.homeReachable && c.ticks < DUSK_START) return null
  return 'dusk_far_from_home'
}

/** Why (if at all) a trip home is justified. null = not needed. Pure. */
export function returnReason(c, { sinceReturnMs = Infinity, cooldownMs = 300000 } = {}) {
  if (shouldLeaveForDusk(c) && c.roaming && !duskFacts(c).homeReachable) return null   // ROAM1: roaming and home too far for the daylight left: camp (campReason), do not march home into the dark
  if (shouldLeaveForDusk(c) && sinceReturnMs >= 30000) return 'before_dusk'   // DUSK1: not rate-limited by the 5 min cooldown (she is simply late)
  if (!c.hasHome || c.homeDist <= 40) return null
  if (sinceReturnMs < cooldownMs) return null
  if (c.homeDist > 160) return 'far'
  if ((c.bot.health ?? 20) <= 8) return 'low_health'
  if (c.inv.free <= 2 && (c.chestKnown || c.inv.chest > 0)) return 'inventory_full'
  if (c.hostiles >= 2 && (c.bot.health ?? 20) <= 12) return 'danger'
  return null
}

/** Ring of cells that must be solid for a 1x1x2 pillbox around feet cell S, in placement order, and the roof. */
export function pillboxCells(S) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const cells = []
  for (const [dx, dz] of dirs) cells.push({ x: S.x + dx, y: S.y, z: S.z + dz })
  for (const [dx, dz] of dirs) cells.push({ x: S.x + dx, y: S.y + 1, z: S.z + dz })
  cells.push({ x: S.x + 1, y: S.y + 2, z: S.z })
  cells.push({ x: S.x, y: S.y + 2, z: S.z })
  return cells
}

/** How many of the 10 pillbox cells are still open (0 = sealed). */
export function openCells(bot, S) {
  return pillboxCells(S).filter((c) => !solid(bot.blockAt(V(c.x, c.y, c.z)))).length
}
