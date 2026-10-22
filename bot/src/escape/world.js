// World-reading helpers for the escape ladder. Pure reads of bot state; no side effects.
import { Vec3 } from 'vec3'

export const UP = new Vec3(0, 1, 0)
export const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const GRAVITY = /^(sand|red_sand|gravel|.*_concrete_powder|suspicious_.*|anvil|dragon_egg)$/
const LIQ = /^(water|lava|bubble_column)$/
const BAD_PLACE = /(tnt|chest|furnace|crafting|bed|shulker|barrel|sign|door|torch|rail|button|lever|plate|sapling|flower|carpet|slab|stair|fence|wall|glass|pane|ladder|vine|web|lantern|campfire|sponge|ore|spawner|command|barrier|bedrock|obsidian|lava|water|bucket)/

export const posOf = (bot) => bot.entity.position
export function feetCell(bot) { const p = bot.entity.position; return new Vec3(Math.floor(p.x), Math.floor(p.y + 0.001), Math.floor(p.z)) }
export const blockAt = (bot, v) => bot.blockAt(v)
export const isLiquid = (b) => !!b && LIQ.test(b.name)
export const isLava = (b) => !!b && b.name === 'lava'
export const isWeb = (b) => !!b && b.name === 'cobweb'
export const isSolid = (b) => !!b && b.boundingBox === 'block' && !isLiquid(b)
/** B1: a wooden door / non-iron fence gate (open or closed) is a way through, not a wall: it opens on the way. */
export const isWalkDoor = (b) => !!b && /_(door|fence_gate)$/.test(b.name) && !b.name.startsWith('iron_')
/** Free to stand in: empty shape, not liquid, not web, not powder snow. */
export const isPassable = (b) => !b || (b.boundingBox === 'empty' && !isLiquid(b) && !isWeb(b) && b.name !== 'powder_snow' && b.name !== 'sweet_berry_bush' && b.name !== 'fire' && b.name !== 'soul_fire')
export const isGravity = (b) => !!b && GRAVITY.test(b.name)
export const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

export function placeableItem(bot) {
  const items = bot.inventory.items().filter((i) => {
    if (BAD_PLACE.test(i.name)) return false
    const b = bot.registry.blocksByName[i.name]
    return !!b && b.boundingBox === 'block' && !b.transparent
  })
  items.sort((a, b) => (/^(cobblestone|dirt|netherrack|cobbled_deepslate|stone)$/.test(b.name) ? 1 : 0) - (/^(cobblestone|dirt|netherrack|cobbled_deepslate|stone)$/.test(a.name) ? 1 : 0))
  return items[0] ?? null
}
export const placeableCount = (bot) => bot.inventory.items().filter((i) => !BAD_PLACE.test(i.name) && bot.registry.blocksByName[i.name]?.boundingBox === 'block').reduce((n, i) => n + i.count, 0)
export function pickaxeItem(bot) {
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  const p = bot.inventory.items().filter((i) => i.name.endsWith('_pickaxe'))
  p.sort((a, b) => order.findIndex((o) => a.name.startsWith(o)) - order.findIndex((o) => b.name.startsWith(o)))
  return p[0] ?? null
}
export const cutterItem = (bot) => bot.inventory.items().find((i) => i.name.endsWith('_sword')) ?? bot.inventory.items().find((i) => i.name === 'shears') ?? null

/** Can the bot walk out from `cell` in direction d (flat or one step up)? */
export function walkable(bot, cell, d) {
  const a = cell.plus(d)
  const at = (v) => bot.blockAt(v)
  const up = (v, n) => v.offset(0, n, 0)
  const free = (b) => isPassable(b) || isWalkDoor(b) // B1: doors count as open
  // flat or step down by 1 onto solid
  if (free(at(a)) && free(at(up(a, 1))) && isSolid(at(up(a, -1)))) return true
  // step up by 1: a is solid, a+1, a+2 free, headroom above own cell
  if (isSolid(at(a)) && !isWalkDoor(at(a)) && free(at(up(a, 1))) && free(at(up(a, 2))) && isPassable(at(up(cell, 2)))) return true
  return false
}
export function exitDirs(bot, cell = feetCell(bot)) { return DIRS.filter((d) => walkable(bot, cell, d)) }

/** Liquid or a >= 2 deep drop at floor level within r blocks horizontally (radius check, not just neighbours). */
export function hazardNear(bot, r = 3) {
  const c = feetCell(bot)
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (!dx && !dz) continue
    const f = c.offset(dx, -1, dz)
    const fb = bot.blockAt(f)
    if (isLiquid(fb)) return true
    if (!isSolid(fb) && isPassable(bot.blockAt(f.offset(0, 1, 0))) && !isSolid(bot.blockAt(f.offset(0, -1, 0)))) return true
  }
  return false
}

/** Size of the flat-walkable region around the bot (BFS, stops at `limit`). */
export function reachableCount(bot, limit = 40) {
  const c0 = feetCell(bot)
  const key = (v) => `${v.x},${v.y},${v.z}`
  const seen = new Set([key(c0)])
  const q = [c0]
  while (q.length && seen.size < limit) {
    const c = q.shift()
    for (const d of DIRS) {
      if (!walkable(bot, c, d)) continue
      const a = c.plus(d)
      const n = isSolid(bot.blockAt(a)) ? a.offset(0, 1, 0) : a
      if (!seen.has(key(n))) { seen.add(key(n)); q.push(n) }
    }
  }
  return seen.size
}

/** L2: how far would a step off the standing cell drop? Per horizontal direction: fall = number of non-solid, non-liquid cells under the
 *  neighbour cell before the first solid/liquid one (scan <= maxScan). Returns the best (smallest fall, non-lava preferred):
 *  { drop, landing: 'solid'|'water'|'lava'|'void', dir } ; a solid wall neighbour is skipped. */
export function groundBelow(bot, cell = feetCell(bot), maxScan = 40) {
  let best = null
  for (const d of DIRS) {
    const n = cell.plus(d)
    if (!isPassable(bot.blockAt(n)) || !isPassable(bot.blockAt(n.offset(0, 1, 0)))) continue
    let drop = 0, landing = 'void'
    for (let k = 1; k <= maxScan; k++) {
      const b = bot.blockAt(n.offset(0, -k, 0))
      if (!b || (b.boundingBox === 'empty' && !isLiquid(b))) { drop++; continue }
      landing = isLava(b) ? 'lava' : isLiquid(b) ? 'water' : 'solid'
      break
    }
    const cand = { drop, landing, dir: d }
    const rank = (c) => (c.landing === 'lava' || c.landing === 'void' ? 1e6 : 0) + c.drop
    if (!best || rank(cand) < rank(best)) best = cand
  }
  return best ?? { drop: 0, landing: 'solid', dir: null }
}
/** Elevated: no walkable neighbour and the ground (or liquid) is more than 3 blocks below. */
export const ELEVATED_DROP = 3

/** Pillar cells we placed ourselves (escape_pillar_up). Shared per bot so a later escape_descend can undo them. */
export function pillarCells(bot) { return (bot.__pillarCells ??= []) }
/** Contiguous own pillar height ending at the cell under the feet. */
export function ownPillarHeight(bot, cell = feetCell(bot)) {
  const set = new Set(pillarCells(bot).map((c) => `${c.x},${c.y},${c.z}`))
  let n = 0
  while (set.has(`${cell.x},${cell.y - 1 - n},${cell.z}`)) n++
  return n
}

/** Ground-truth description of the situation. */
export function diagnose(bot) {
  const cell = feetCell(bot)
  const at = (dy) => bot.blockAt(cell.offset(0, dy, 0))
  const feet = at(0), head = at(1), below = at(-1)
  const e = bot.entity
  const inWater = isWeb(feet) ? false : (!!e.isInWater || feet?.name === 'water' || head?.name === 'water')
  const inLava = !!e.isInLava || isLava(feet) || isLava(head)
  const inWeb = !!e.isInWeb || isWeb(feet) || isWeb(head)
  const inPowder = feet?.name === 'powder_snow' || head?.name === 'powder_snow'
  const exits = exitDirs(bot, cell)
  const ceiling = [2, 3, 4].map((dy) => at(dy)).filter(Boolean).findIndex((b) => isSolid(b))
  const liquidAround = DIRS.some((d) => isLiquid(bot.blockAt(cell.plus(d).offset(0, -1, 0))))
  const voidAround = DIRS.some((d) => !isSolid(bot.blockAt(cell.plus(d).offset(0, -1, 0))) && isPassable(bot.blockAt(cell.plus(d))))
  const doors = findDoors(bot)
  const gapAround = liquidAround || voidAround || hazardNear(bot, 3)
  const enclosed = gapAround && exits.length > 0 && reachableCount(bot, 40) < 40
  const gb = exits.length === 0 && !inWater && !inLava ? groundBelow(bot, cell) : { drop: 0, landing: 'solid' }
  const elevated = exits.length === 0 && !inWater && !inLava && gb.drop > ELEVATED_DROP && !!below && isSolid(below) && !!gb.dir
  return {
    elevated, dropBelow: gb.drop, landing: gb.landing,
    cell, inWater, inLava, inWeb, inPowder, exits,
    trapped: exits.length === 0 || enclosed || inWater || inLava || inWeb || inPowder, enclosed,
    ceilingSolid: ceiling >= 0, ceilingDy: ceiling >= 0 ? ceiling + 2 : null,
    gapAround, doors,
    onGround: !!e.onGround, belowName: below?.name,
  }
}

export function findDoors(bot, reach = 4.2, { includeOpen = false } = {}) {
  const p = bot.entity.position.offset(0, 1.6, 0)
  const out = []
  const c = feetCell(bot)
  for (let dx = -4; dx <= 4; dx++) for (let dy = -3; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    const b = bot.blockAt(c.offset(dx, dy, dz))
    if (!b || !/(trapdoor|_door|fence_gate)$/.test(b.name) || b.name.startsWith('iron_')) continue
    if (!includeOpen && b.getProperties?.().open === true) continue
    if (/_door$/.test(b.name) && b.getProperties?.().half === 'upper') continue // one entry per door (lower half)
    const d = b.position.offset(0.5, 0.5, 0.5).distanceTo(p)
    if (d <= reach) out.push({ block: b, d })
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.block)
}

/** Is it safe to dig `b`: no liquid next to it, no gravity block above it. */
export function safeToDig(bot, b) {
  if (!b || b.name === 'bedrock' || b.hardness === undefined || b.hardness < 0) return false
  for (const o of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    const n = bot.blockAt(b.position.offset(...o))
    if (isLiquid(n)) return false
  }
  if (isGravity(bot.blockAt(b.position.offset(0, 1, 0)))) return false
  return true
}
