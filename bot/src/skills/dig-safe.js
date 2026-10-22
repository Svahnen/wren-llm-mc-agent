// D1: dig safety. Pure functions over bot.blockAt; used by gather/collect before every bot.dig.
// Rules: never remove a block when it would leave the bot standing over / stepping into a drop > MAX_DROP (3), never dig straight down
// unless the cell below-below is solid, never next to lava; targets beside an open drop (> 3) are rejected; dark places are rejected
// unless the resource is mined by tunnelling (stone/coal/iron).
export const MAX_DROP = 3
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
import { V } from './lib.js'
import { builtReason } from './movements-protect.js'
const at = (bot, x, y, z) => bot.blockAt(V(x, y, z))
const isLava = (b) => !!b && (b.name === 'lava' || b.name === 'magma_block')
const isOpen = (b) => !b || (b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava')

/** Cells of free fall below (x,y,z) (exclusive); `lava` if lava is the landing or within the scan. Unloaded counts as open. */
export function columnBelow(bot, x, y, z, max = 8) {
  let empty = 0
  for (let k = 1; k <= max; k++) {
    const b = at(bot, x, y - k, z)
    if (isLava(b)) return { empty, lava: true }
    if (isOpen(b)) { empty++; continue }
    return { empty, lava: false }
  }
  return { empty, lava: false }
}

/** null when digging block position `p` (with the bot at its current spot) is safe, else a reason string. */
export function digRisk(bot, p) {
  const me = bot.entity.position, fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
  if (builtReason(bot, at(bot, px, py, pz))) return 'player_built' // B1: never take a player's door / planks / hut wall (own placed blocks are fine)
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) if (isLava(at(bot, px + dx, py + dy, pz + dz))) return 'lava_adjacent'
  if (px === fx && pz === fz && py <= fy - 1) {
    // straight down: only when the cell below-below is solid (and not lava)
    const b = at(bot, px, py - 1, pz)
    return !isOpen(b) && !isLava(b) && py === fy - 1 ? null : 'dig_down_unsafe'
  }
  if (Math.abs(px - fx) <= 1 && Math.abs(pz - fz) <= 1 && py <= fy) {
    // a hole she may step into: floor-level neighbour (fall = 1 + empties below) or wall cell (fall = empties below)
    const c = columnBelow(bot, px, py, pz)
    const fall = c.empty + (py === fy - 1 ? 1 : 0)
    if (c.lava || fall > MAX_DROP) return 'drop_beside'
  }
  return null
}

/** A target whose neighbourhood has an open drop > MAX_DROP at its level or below (a ledge / ravine edge): too risky to work at. */
export function ledgeRisk(bot, p) {
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
  for (const [dx, dz] of DIRS8) {
    const x = px + dx, z = pz + dz
    for (const y of [py, py + 1]) {
      if (!isOpen(at(bot, x, y, z)) || !isOpen(at(bot, x, y + 1, z))) continue
      const c = columnBelow(bot, x, y, z)
      if (c.lava || c.empty > MAX_DROP) return 'ledge'
      break
    }
  }
  return null
}

/** Effective light for a position: block light or sky light (night reduced by the caller via `light`). */
export function tooDark(light, min = 4) { return light < min }
