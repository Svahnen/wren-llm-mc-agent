// DOOR3: dynamic enclosure model. Runtime, nothing hard-coded: a block is a "shell" block when it borders (4-neighbour at feet/head level, or the ceiling cell above)
// a BOUNDED walled room (flood fill, doors count as walls) and that room has a usable doorway. Shell blocks of a room with a working door are never dug
// (planner safeToBreak and bot.dig both ask `shellReason`), also the walls she placed herself. If the doorway is unusable (blocked from outside or inside) or there is an
// emergency (drowning, fire, suffocation: bot.__wallEmergency), exactly ONE shell block may be broken; the gap is then repaired after she passed (wall_repaired),
// or noted as 'hole in my wall at x,y,z' when she has no block to place.
// Trace events: wall_break_emergency {at,block,why}, wall_repaired {at,block}, wall_hole_noted {at,note}.
import { Vec3 } from 'vec3'
import { isWalkthroughDoor, isIronDoor } from './movements-protect.js'

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const cellKey = (x, y, z) => `${x},${y},${z}`
const isDoorCell = (b) => !!b && (isWalkthroughDoor(b) || isIronDoor(b))
const solid = (b) => !!b && b.boundingBox === 'block'
const TTL = 4000

/** free standing cell: feet and head not solid and not a door; floor solid. */
function freeCell(bot, x, y, z) {
  const a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z))
  if (!a || !b || isDoorCell(a) || isDoorCell(b)) return false
  return !solid(a) && !solid(b)
}
const floored = (bot, x, y, z) => solid(bot.blockAt(new Vec3(x, y - 1, z)))

/**
 * Flood fill from a free cell. Returns { bounded, cells:Set<string>, doors:Map<string,Block> } (doors = door cells touching the room).
 * Unbounded when it passes maxCells (open ground) or when it leaves through a free neighbour that is not walkable (a gap in the wall).
 */
export function floodRoom(bot, start, { maxCells = 260 } = {}) {
  const cells = new Set(), doors = new Map(), blockedDoors = new Set(), q = [start]
  cells.add(cellKey(...start))
  while (q.length) {
    const [x, y, z] = q.shift()
    if (cells.size > maxCells) return { bounded: false, cells, doors, blockedDoors }
    for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz
      const f = bot.blockAt(new Vec3(nx, y, nz)), h = bot.blockAt(new Vec3(nx, y + 1, nz))
      if (solid(f) || solid(h)) { // a door right behind a blocker (rubble / a block placed in front of it) is a blocked doorway
        const g = bot.blockAt(new Vec3(nx + dx, y, nz + dz)), g2 = bot.blockAt(new Vec3(nx + dx, y + 1, nz + dz))
        const d = isDoorCell(g) ? g : isDoorCell(g2) ? g2 : null
        if (d) blockedDoors.add(cellKey(d.position.x, d.position.y, d.position.z))
      }
      if (isDoorCell(f) || isDoorCell(h)) { const d = isDoorCell(f) ? f : h; doors.set(cellKey(d.position.x, Math.min(d.position.y, f?.position?.y ?? d.position.y), d.position.z), d); continue }
      let moved = false
      for (const ny of [y, y - 1, y + 1]) {
        if (!freeCell(bot, nx, ny, nz)) continue
        // the step must not be blocked by a solid block at the old level above the head (rare); accept
        if (!floored(bot, nx, ny, nz)) { if (ny === y) { /* a hole in the floor: the room continues downwards */ continue } else continue }
        const k = cellKey(nx, ny, nz)
        moved = true
        if (!cells.has(k)) { cells.add(k); q.push([nx, ny, nz]) }
        break
      }
      if (!moved && !solid(f) && !solid(h) && f && h) {
        // free air neighbour without a floor: a pit/gap, treat as leaving the room unless the floor is just one deeper
        if (!floored(bot, nx, y - 1, nz)) return { bounded: false, cells, doors, blockedDoors }
      }
    }
  }
  return { bounded: true, cells, doors, blockedDoors }
}

/** a doorway is usable when both of its sides (along the door facing) have a free standing cell, or it is a (powered/plate/trigger) iron door. */
export function doorUsable(bot, d) {
  const props = (() => { try { return d.getProperties?.() ?? {} } catch { return {} } })()
  const f = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[props.facing]
  if (!f) return false
  const lower = props.half === 'upper' ? (bot.blockAt(d.position.offset(0, -1, 0)) ?? d) : d
  const y = lower.position.y
  const side = (s) => { const x = lower.position.x + f[0] * s, z = lower.position.z + f[1] * s; return [y, y - 1, y + 1].some((ny) => freeCell(bot, x, ny, z)) }
  return side(1) && side(-1)
}

const cache = new WeakMap()
const roomCache = new WeakMap()
/** The shell verdict for a solid block: null (not shell) | { kind: 'door_ok' | 'door_blocked', room, doors } . Cached ~4 s per block. */
export function shellInfo(bot, pos) {
  let c = cache.get(bot); if (!c) { c = new Map(); cache.set(bot, c) }
  const k = cellKey(pos.x, pos.y, pos.z), t = Date.now(), hit = c.get(k)
  if (hit && t - hit.t < TTL) return hit.v
  if (c.size > 3000) c.clear()
  let v = null
  const px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z)
  const seeds = []
  for (const [dx, dz] of DIRS) for (const dy of [0, -1]) { // a room cell whose feet/head is next to the block
    const x = px + dx, y = py + dy, z = pz + dz
    if (freeCell(bot, x, y, z) && floored(bot, x, y, z)) seeds.push([x, y, z])
  }
  for (const dy of [-2, -3]) { const x = px, y = py + dy, z = pz; if (freeCell(bot, x, y, z) && floored(bot, x, y, z)) seeds.push([x, y, z]) } // block is the ceiling of a room
  const done = new Set()
  for (const s of seeds) {
    if (done.has(cellKey(...s))) continue
    let rc = roomCache.get(bot); if (!rc || t - rc.t > TTL) { rc = { t, m: new Map() }; roomCache.set(bot, rc) }
    let r = rc.m.get(cellKey(...s))
    if (!r) { r = floodRoom(bot, s); if (rc.m.size > 20000) rc.m.clear(); for (const ck of r.cells) rc.m.set(ck, r) }
    for (const ck of r.cells) done.add(ck)
    if (!r.bounded || !(r.doors.size || r.blockedDoors.size)) continue
    const doors = [...r.doors.values()]
    const ok = doors.some((d) => doorUsable(bot, d))
    doors.push(...[...r.blockedDoors].map((k) => bot.blockAt(new Vec3(...k.split(',').map(Number)))))
    const kind = ok ? 'door_ok' : 'door_blocked'
    if (!v || kind === 'door_ok') v = { kind, room: r.cells.size, doors: doors.map((d) => [d.position.x, d.position.y, d.position.z]) }
  }
  c.set(k, { t, v })
  return v
}

export const clearEnclosureCache = (bot) => cache.delete(bot)

/** why this block may not be dug: 'shell' (working door nearby, use it) or null. Blocked doorway / emergency: allowed once (see wallBreakAllowed). */
export function shellReason(bot, block) {
  if (!block?.position || !solid(block)) return null
  if (isDoorCell(block)) return null
  const s = shellInfo(bot, block.position)
  if (!s) return null
  if (s.kind === 'door_ok' && !bot.__wallEmergency) return 'shell'
  return null
}

// ------------------------------------------------------------------------------------------------ structure blocks (collect / gather / pathfinder never take them)
const ANCHOR_RE = /(_bed|^crafting_table|^chest|^trapped_chest|^barrel|^furnace|^blast_furnace|^smoker|torch$|^lantern|_sign$|^ladder|^bookshelf|^enchanting_table|^anvil|^brewing_stand|^cauldron|^composter|^lectern|^loom|^smithing_table|^cartography_table|^fletching_table|^grindstone|^stonecutter|_door$|_fence_gate$|_trapdoor$|_pressure_plate$|_button$|^lever$|^campfire|^flower_pot)/
const PLACE_KINDS = /^(home|bed|shelter|base|house|chest|workshop|camp)/
const anchorCache = new WeakMap()
function anchors(bot) {
  const c = anchorCache.get(bot) ?? { t: -1e9, list: [] }
  if (Date.now() - c.t < 3000) return c.list
  let list = []
  try {
    const ids = bot.registry?.blocksArray?.filter((b) => ANCHOR_RE.test(b.name)).map((b) => b.id) ?? []
    if (ids.length && typeof bot.findBlocks === 'function') list = bot.findBlocks({ matching: ids, maxDistance: 40, count: 200 })
  } catch { list = [] }
  anchorCache.set(bot, { t: Date.now(), list }); return list
}
/** places she knows (bot.__landmarks.places or bot.__placeRecords): home / bed / shelter / chest within 7 blocks horizontally, 5 vertically. */
function inPlaceRecord(bot, pos) {
  const places = bot.__landmarks?.places ?? bot.__placeRecords ?? {}
  for (const [id, v] of Object.entries(places)) {
    if (!v || typeof v.x !== 'number') continue
    if (!(PLACE_KINDS.test(id) || PLACE_KINDS.test(v.kind ?? ''))) continue
    if (Math.abs(v.x - pos.x) <= 7 && Math.abs(v.z - pos.z) <= 7 && Math.abs(v.y - pos.y) <= 5) return true
  }
  return false
}
/**
 * Structure-protection verdict for a block (any placer): 'shell' (wall/roof of a room with a working doorway) | 'near_structure' (within 2 blocks of a bed, workstation, chest, torch, door ...)
 * | 'known_place' (inside a home/shelter record) | null. Natural ground far from all of that is free.
 */
export function structureReason(bot, block) {
  if (!block?.position || !solid(block) || isDoorCell(block)) return null
  const sh = shellReason(bot, block)
  if (sh) return sh
  const p = block.position
  for (const a of anchors(bot)) if (Math.abs(a.x - p.x) <= 2 && Math.abs(a.z - p.z) <= 2 && Math.abs(a.y - p.y) <= 2 && !(a.x === p.x && a.y === p.y && a.z === p.z)) return 'near_structure'
  if (inPlaceRecord(bot, p)) return 'known_place'
  return null
}

/** Called by the dig guard after a dig on a shell block of a room whose doorway is unusable (or an emergency): arms the repair. Returns the breach record. */
export function noteBreach(bot, block, why, trace) {
  const at = [block.position.x, block.position.y, block.position.z]
  const rec = { at, name: block.name, why, t: Date.now(), passed: false, tries: 0 }
  bot.__wallBreach = rec
  try { trace?.event('wall_break_emergency', { at, block: block.name, why }) } catch { /* ignore */ }
  return rec
}

const PLACEABLE = ['cobblestone', 'dirt', 'stone', 'cobbled_deepslate', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'coarse_dirt', 'sand', 'andesite', 'diorite', 'granite']
/** Repair loop: once she is at least 2 blocks from the gap (passed through it), put a block back. Attach once; ticks on physics. */
export function installWallRepair(bot, { trace = null, note = null, now = Date.now } = {}) {
  if (!bot || bot.__wallRepair) return
  bot.__wallRepair = true
  let busy = false
  const tick = async () => {
    const rec = bot.__wallBreach
    if (!rec || busy || !bot.entity) return
    busy = true
    try {
      const me = bot.entity.position
      const gap = new Vec3(rec.at[0], rec.at[1], rec.at[2])
      const d = Math.hypot(me.x - (gap.x + 0.5), me.z - (gap.z + 0.5))
      if (d < 1.7 && now() - rec.t < 60000) return // still in or at the gap
      if (now() - rec.t < 300) return
      const cur = bot.blockAt(gap)
      if (cur && cur.boundingBox === 'block') { bot.__wallBreach = null; return }
      const item = bot.inventory?.items?.().find((i) => i.name === rec.name) ?? bot.inventory?.items?.().find((i) => PLACEABLE.includes(i.name)) ?? bot.inventory?.items?.().find((i) => /(_planks|_log|cobblestone|dirt|stone)$/.test(i.name))
      let done = false
      if (item && d <= 4.6) {
        try {
          await bot.equip(item, 'hand')
          // reference block: any solid neighbour (not the head cell above the gap)
          for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const ref = bot.blockAt(gap.offset(dx, dy, dz))
            if (!solid(ref)) continue
            await Promise.race([bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)), new Promise((r) => setTimeout(r, 1500))])
            if (solid(bot.blockAt(gap))) { done = true; break }
          }
        } catch { /* try again below */ }
      }
      if (done) { bot.__wallBreach = null; try { trace?.event('wall_repaired', { at: rec.at, block: bot.blockAt(gap)?.name }) } catch { /* ignore */ } return }
      if (++rec.tries >= 6 || !item || d > 4.6) {
        bot.__wallBreach = null
        const text = `hole in my wall at ${rec.at.join(',')}`
        try { note?.(text, rec.at) } catch { /* ignore */ }
        bot.__wallHoles = [...(bot.__wallHoles ?? []), { at: rec.at, text }]
        try { trace?.event('wall_hole_noted', { at: rec.at, note: text }) } catch { /* ignore */ }
      }
    } catch { /* ignore */ } finally { busy = false }
  }
  let last = 0
  bot.on('physicsTick', () => { const t = Date.now(); if (t - last < 150) return; last = t; tick().catch(() => {}) })
}
