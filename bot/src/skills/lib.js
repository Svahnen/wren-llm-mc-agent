// Shared helpers for skills. Ground-truth reads of the world/inventory; nothing here trusts a model.
import vec3 from 'vec3'
import pf from 'mineflayer-pathfinder'
const { goals } = pf
export { goals }
export const V = (x, y, z) => new vec3.Vec3(x, y, z)

export const DANGER_FLOOR = new Set(['lava', 'magma_block', 'cactus', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'cobweb', 'powder_snow', 'water', 'wither_rose', 'pointed_dripstone', 'bubble_column'])
const LIQUID = new Set(['water', 'lava', 'bubble_column', 'kelp', 'seagrass', 'tall_seagrass'])

export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
export const pos3 = (p) => (p ? [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] : null)

const isSolid = (b) => !!b && b.boundingBox === 'block'
const isFree = (b) => !!b && b.boundingBox === 'empty' && !LIQUID.has(b.name) && !DANGER_FLOOR.has(b.name)

/** Standable = solid, non-dangerous floor, two free blocks above, none liquid. Unloaded chunk => false. */
export function isStandable(bot, x, y, z) {
  const floor = bot.blockAt(V(x, y - 1, z))
  const a = bot.blockAt(V(x, y, z))
  const b = bot.blockAt(V(x, y + 1, z))
  if (!isSolid(floor) || DANGER_FLOOR.has(floor.name) || LIQUID.has(floor.name) || /leaves/.test(floor.name)) return false
  return isFree(a) && isFree(b)
}

/** Find the y of a standable cell in column (x,z), scanning around yHint. null if none. */
export function standableY(bot, x, z, yHint, up = 6, down = 10) {
  x = Math.floor(x); z = Math.floor(z); yHint = Math.floor(yHint)
  for (let d = 0; d <= Math.max(up, down); d++) {
    if (d <= up && isStandable(bot, x, yHint + d, z)) return yHint + d
    if (d > 0 && d <= down && isStandable(bot, x, yHint - d, z)) return yHint - d
  }
  return null
}

/** Open sky above (no non-transparent block in the column above). */
export function openSky(bot, p) {
  const x = Math.floor(p.x), z = Math.floor(p.z)
  for (let y = Math.floor(p.y) + 2; y < Math.floor(p.y) + 80; y++) {
    const b = bot.blockAt(V(x, y, z))
    if (!b) return true
    if (b.boundingBox === 'block' && !/leaves|glass/.test(b.name)) return false
  }
  return true
}

export const items = (bot) => bot.inventory?.items?.() ?? []
export const countItem = (bot, name) => items(bot).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
export const countMatch = (bot, re) => items(bot).filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0)
export const countAny = (bot, names) => items(bot).filter((i) => names.includes(i.name)).reduce((s, i) => s + i.count, 0)
export const freeSlots = (bot) => { try { return bot.inventory.emptySlotCount() } catch { return 36 - items(bot).length } }
export const hasItem = (bot, name) => countItem(bot, name) > 0

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
export function bestTool(bot, kind) {
  let best = null, rank = 99
  for (const it of items(bot)) {
    if (!it.name.endsWith(`_${kind}`)) continue
    const r = TIERS.indexOf(it.name.split('_')[0])
    if (r >= 0 && r < rank) { best = it; rank = r }
  }
  return best
}
export async function equipBest(bot, kind) {
  const t = bestTool(bot, kind)
  if (!t) return null
  if (bot.heldItem?.type !== t.type) await bot.equip(t, 'hand')
  return t
}

export const timeOfDay = (bot) => (((bot.time?.timeOfDay ?? 0) % 24000) + 24000) % 24000
export const isNight = (bot) => { if (bot._h1ForcePhase) return bot._h1ForcePhase === 'night'; const t = timeOfDay(bot); return t >= 12542 && t <= 23459 }
export const isThunder = (bot) => (bot.thunderState ?? 0) > 0.5
export const gameAge = (bot) => bot.time?.age ?? 0

/** Dropped item entities near p. */
export function drops(bot, p, r = 8) {
  return Object.values(bot.entities ?? {}).filter((e) => e && e.name === 'item' && e.position && dist3(e.position, p) <= r)
}

/** Walk onto nearby dropped items so they are picked up (bounded). */
export async function collectDrops(ctx, p, { r = 7, max = 4 } = {}) {
  const bot = ctx.bot
  for (let i = 0; i < max && !ctx.aborted; i++) {
    const d = drops(bot, p, r).sort((a, b) => dist3(a.position, bot.entity.position) - dist3(b.position, bot.entity.position))[0]
    if (!d) return
    if (dist3(d.position, bot.entity.position) > 1.2) await ctx.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.6), { timeoutMs: 5000 })
    await ctx.sleep(250)
  }
}

const DOORISH = /(_door|_fence_gate)$/
/**
 * HOME2: true when cell (x,y,z) lies in the keep-out zone of a door or gate: the 3x3 ring around the door cell, or the two cells on each side along its walk axis
 * (door `facing` axis). Nothing she places for herself (torch ring, shelter pillbox, table, chest) goes there: a pillbox built beside her home door used the door as
 * its 4th wall and the walk axis was blocked by her own blocks. Doors and gates themselves are not blocked by this.
 */
export function doorKeepout(bot, x, y, z) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
    const b = bot.blockAt(V(x + dx, y + dy, z + dz))
    if (!b || !DOORISH.test(b.name)) continue
    // the door is at (x+dx, z+dz); our cell relative to it is (-dx, -dz)
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) return true
    const f = b.getProperties?.().facing
    const axisX = f === 'east' || f === 'west'
    if (axisX ? (dz === 0) : (dx === 0)) return true
  }
  return false
}

const REPLACEABLE = new Set(['air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow'])
/** Place `itemName` on a free solid-floor spot near the bot (not on its own feet). Returns the block position or null. */
export async function placeNearby(bot, itemName, { avoid = [], radius = 0 } = {}) {
  const item = items(bot).find((i) => i.name === itemName)
  if (!item) return null
  await bot.equip(item, 'hand')
  const me = bot.entity.position.floored()
  const offs = []
  const R = radius || (itemName.endsWith('_bed') ? 3 : 2)
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) if (dx || dz) offs.push([dx, dz])
  offs.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))
  for (const [dx, dz] of offs) {
    const t = me.offset(dx, 0, dz)
    const ref = bot.blockAt(t.offset(0, -1, 0))
    const at = bot.blockAt(t)
    const above = bot.blockAt(t.offset(0, 1, 0))
    if (!isSolid(ref) || DANGER_FLOOR.has(ref.name) || !at || !REPLACEABLE.has(at.name) || !above || above.name !== 'air') continue
    if (avoid.some((a) => a.equals?.(t))) continue
    if (!DOORISH.test(itemName) && doorKeepout(bot, t.x, t.y, t.z)) continue   // HOME2
    if (itemName.endsWith('_bed')) { // F1: a bed is 2 cells long and extends away from the player (facing me -> t): the far cell needs floor + air as well, else cannot_place_bed
      const f = t.offset(Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0, 0, Math.abs(dx) >= Math.abs(dz) ? 0 : Math.sign(dz))
      const fRef = bot.blockAt(f.offset(0, -1, 0)), fAt = bot.blockAt(f), fAbove = bot.blockAt(f.offset(0, 1, 0))
      if (!isSolid(fRef) || DANGER_FLOOR.has(fRef.name) || !fAt || !REPLACEABLE.has(fAt.name) || !fAbove || fAbove.name !== 'air') continue
    }
    try {
      await bot.placeBlock(ref, V(0, 1, 0))
      const after = bot.blockAt(t)
      if (after && after.name === itemName) return t
      if (after && itemName.endsWith('_bed') && /_bed$/.test(after.name)) return t
    } catch { /* try next spot */ }
  }
  // PB2: inside a cramped shelter cell there is no free floor tile: a torch can hang on a wall (live: place_torch no_spot at light 0 inside her shelter)
  if (itemName === 'torch') {
    const cells = [[0, 0], ...offs]
    for (const [dx, dz] of cells) {
      const t = me.offset(dx, 0, dz), at = bot.blockAt(t)
      if (!at || !REPLACEABLE.has(at.name)) continue
      for (const [wx, wz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const wall = bot.blockAt(t.offset(wx, 0, wz))
        if (!isSolid(wall) || DANGER_FLOOR.has(wall.name)) continue
        if (avoid.some((a) => a.equals?.(t))) continue
        try { await bot.placeBlock(wall, V(-wx, 0, -wz)); const after = bot.blockAt(t); if (after && /torch/.test(after.name)) return t } catch { /* next */ }
      }
    }
  }
  return null
}

export function pickRng(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length] }
