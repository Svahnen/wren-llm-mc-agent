import { Vec3 } from 'vec3'
// Pluggable knowledge of dangerous cells. A "cell" is {x,y,z} integers = the block a player stands IN (feet).
//   danger.costAt(cell)   -> number >= 0; >= HARD means "harmful, never choose to be here"; Infinity = forbidden.
//   danger.addProvider(fn)   fn(cell, helpers) -> number | null   (mind/ feeds remembered dangers here)
//   danger.forbid(cell, ttlMs) / unforbid(cell) / forbidden cells list
// The built-in part reads live blocks (lava, fire, magma, cactus ...); providers are ADDED to it.
export const HARD = 1000

const LAVA = new Set(['lava'])
const WATER = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const HARM_IN = new Set(['fire', 'soul_fire', 'cactus', 'campfire', 'soul_campfire', 'wither_rose', 'sweet_berry_bush', 'pointed_dripstone', 'powder_snow', 'cobweb'])
const COST_IN = { fire: HARD, soul_fire: HARD, cactus: HARD, campfire: 200, soul_campfire: 200, wither_rose: 60, sweet_berry_bush: 40, pointed_dripstone: 40, powder_snow: 25, cobweb: 20 }

export const isLava = (b) => !!b && LAVA.has(b.name)
export const isWater = (b) => !!b && WATER.has(b.name)
export const isLiquid = (b) => isLava(b) || isWater(b)
/** passable = a body can occupy it (air, plants, water, lava, fire ...). Unknown (unloaded) is NOT passable. */
export const isPassable = (b) => !!b && b.boundingBox === 'empty'
export const isSolid = (b) => !!b && b.boundingBox === 'block' && !isLiquid(b)

export class DangerMap {
  constructor(getBot, { now = Date.now } = {}) {
    this.getBot = getBot
    this.now = now
    this.providers = new Set()
    this.forbiddenCells = new Map() // key -> expiry ms (Infinity = permanent)
  }

  key(c) { return `${c.x},${c.y},${c.z}` }
  addProvider(fn) { this.providers.add(fn); return () => this.providers.delete(fn) }
  forbid(cell, ttlMs = Infinity) { this.forbiddenCells.set(this.key(cell), ttlMs === Infinity ? Infinity : this.now() + ttlMs) }
  unforbid(cell) { this.forbiddenCells.delete(this.key(cell)) }
  clearForbidden() { this.forbiddenCells.clear() }
  isForbidden(cell) {
    const k = this.key(cell)
    const e = this.forbiddenCells.get(k)
    if (e === undefined) return false
    if (e !== Infinity && e < this.now()) { this.forbiddenCells.delete(k); return false }
    return true
  }

  blockAt(x, y, z) {
    const bot = this.getBot()
    if (!bot?.blockAt) return null
    try { return bot.blockAt(new Vec3(x, y, z)) ?? null } catch { return null }
  }

  /** Cost of standing with feet in `cell`. */
  costAt(cell) {
    if (this.isForbidden(cell)) return Infinity
    const { x, y, z } = cell
    let cost = 0
    const feet = this.blockAt(x, y, z)
    const head = this.blockAt(x, y + 1, z)
    const below = this.blockAt(x, y - 1, z)
    if (isLava(feet) || isLava(head)) return Infinity
    for (const b of [feet, head]) if (b && HARM_IN.has(b.name)) cost += COST_IN[b.name] ?? 50
    if (below?.name === 'magma_block') cost += 60
    if (isLava(below)) cost += HARD // would fall into lava / standing on nothing solid
    for (const [dx, dz] of DIRS) {
      const n = this.blockAt(x + dx, y, z + dz)
      if (isLava(n)) cost += 25 // flow risk, mild
      else if (n?.name === 'cactus') cost += 200
      else if (n?.name === 'fire' || n?.name === 'soul_fire') cost += 30
    }
    if (isLava(this.blockAt(x, y + 2, z))) cost += 25
    if (isWater(feet) || isWater(head)) cost += 3
    for (const p of this.providers) {
      let v = null
      try { v = p(cell, this) } catch { /* a broken provider must not blind the reflexes */ }
      if (typeof v === 'number' && v > 0) cost += v
    }
    return cost
  }

  /** Can a player stand/walk here: body space free, floor solid or water, cost below HARD. */
  standable(cell, { allowWater = true } = {}) {
    const { x, y, z } = cell
    const feet = this.blockAt(x, y, z)
    const head = this.blockAt(x, y + 1, z)
    const below = this.blockAt(x, y - 1, z)
    if (!isPassable(feet) || !isPassable(head) || isLava(feet) || isLava(head)) return false
    const wet = isWater(feet) || isWater(head)
    if (wet && !allowWater) return false
    if (!wet && !isSolid(below)) return false
    return this.costAt(cell) < HARD
  }
}

export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
