// B1: player-built blocks are protected. Example: a player-built hut with a door; the stuck ladder / pathfinder
// (canDig during unstuck) / openDoor (shelter) dug her out of it again instead of using the door.
// Rules (all enforced centrally by wrapping bot.dig, and planned around by DoorMovements.safeToBreak):
//  - doors, fence gates, trapdoors are NEVER broken unless she placed them herself or S2 explicitly allowed it;
//  - crafted/building blocks (planks, glass, wool, bricks, cobblestone, slabs, stairs, fences, walls, ...) are protected unless she placed them;
//  - natural-looking material (dirt, stone, logs, sand ...) is protected when a door is within DOOR_CONTEXT blocks (it is part of a hut);
//  - blocks she placed herself (pillbox, pillar, torches, crafting table) are always hers to remove. Tracked by wrapping bot.placeBlock.
import fs from 'node:fs'
import { Vec3 } from 'vec3'
import { structureReason, shellInfo, noteBreach, installWallRepair } from './enclosure.js' // DOOR3

export const DOOR_CONTEXT = 5
export const DOORISH_RE = /(_door|_fence_gate|_trapdoor)$/
export const WALKTHROUGH_RE = /_(door|fence_gate)$/
export const isWalkthroughDoor = (b) => !!b && WALKTHROUGH_RE.test(b.name) && !b.name.startsWith('iron_')
export const isIronDoor = (b) => !!b && b.name === 'iron_door'
export const isTrapdoor = (b) => !!b && /_trapdoor$/.test(b.name) && !b.name.startsWith('iron_')
export const isTrigger = (b) => !!b && /(^lever$|_button$)/.test(b.name)
export const isDoorish = (b) => !!b && DOORISH_RE.test(b.name)
export const BUILD_RE = /(_planks|_fence|_wall|_glass|_glass_pane|_wool|_carpet|_bricks|_concrete|_terracotta|_slab|_stairs|_bed|_sign|_hanging_sign|_shulker_box|_banner)$|^(glass|glass_pane|bricks|cobblestone|mossy_cobblestone|stone_bricks|packed_mud|mud_bricks|crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|bookshelf|torch|wall_torch|lantern|ladder|iron_bars|hay_block|glowstone|sea_lantern|smooth_stone|smooth_sandstone|campfire|loom|anvil|grindstone|stonecutter|cartography_table|fletching_table|smithing_table|lectern|composter|jukebox|note_block|redstone_lamp|scaffolding)$|^(polished_|cut_|chiseled_|smooth_|stripped_)/
export const CONTEXT_RE = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|sand|red_sand|sandstone|red_sandstone|gravel|clay|stone|andesite|diorite|granite|deepslate|tuff|netherrack|snow_block|moss_block|.*_log|.*_wood|.*_stem|.*_hyphae|.*_leaves)$/

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

/** Blocks she placed herself. Optionally persisted to a small JSON file (survives restarts). */
export class PlacedBlocks {
  constructor({ file = null, max = 6000, now = Date.now } = {}) {
    this.file = file; this.max = max; this.now = now; this.map = new Map(); this._t = null
    if (file) { try { for (const [k, t] of JSON.parse(fs.readFileSync(file, 'utf8')).cells ?? []) this.map.set(k, t) } catch { /* none yet */ } }
  }
  add(p) { this.map.delete(key(p)); this.map.set(key(p), this.now()); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); this._save() }
  has(p) { return this.map.has(key(p)) }
  delete(p) { if (this.map.delete(key(p))) this._save() }
  get size() { return this.map.size }
  _save() {
    if (!this.file || this._t) return
    this._t = setTimeout(() => { this._t = null; try { fs.writeFileSync(this.file, JSON.stringify({ cells: [...this.map] })) } catch { /* ignore */ } }, 2000)
    this._t.unref?.()
  }
}

/** Positions of doors/gates/trapdoors near the bot, cached a few seconds (the pathfinder asks thousands of times per plan). */
export function nearbyDoors(bot, { radius = 24, ttlMs = 3000, now = Date.now } = {}) {
  const c = (bot.__doorCache ??= { t: -1e9, list: [] })
  if (now() - c.t < ttlMs) return c.list
  c.t = now()
  const ids = bot.registry?.blocksArray?.filter((b) => DOORISH_RE.test(b.name)).map((b) => b.id) ?? []
  try { c.list = ids.length && typeof bot.findBlocks === 'function' ? bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 }) : [] } catch { c.list = [] }
  return c.list
}
export function doorNear(bot, p, r = DOOR_CONTEXT, opts) {
  return nearbyDoors(bot, opts).some((d) => Math.abs(d.x - p.x) <= r && Math.abs(d.z - p.z) <= r && Math.abs(d.y - p.y) <= 3)
}

/** SURV2: is she standing in a closed 1x1 cell (4 sides solid at feet level) right next to `block`? */
function sealedBeside(bot, block) {
  try {
    const p = bot.entity?.position
    if (!p || Math.abs(block.position.x + 0.5 - p.x) > 2.2 || Math.abs(block.position.z + 0.5 - p.z) > 2.2 || Math.abs(block.position.y - p.y) > 3) return false
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => bot.blockAt(new Vec3(x + dx, y, z + dz))?.boundingBox === 'block')
  } catch { return false }
}

/** GATH1: is `pos` one of the 10 pillbox cells around her feet cell (4 walls at feet, 4 at head, 2 cap cells)? */
function inPillbox(bot, pos) {
  const p = bot.entity?.position; if (!p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
  if (dy === 2) return (dx === 0 && dz === 0) || (dx === 1 && dz === 0)
  return (dy === 0 || dy === 1) && Math.abs(dx) + Math.abs(dz) === 1
}

/** null when `block` may be broken, else why not: 'door' | 'built_block' | 'structure_context'. */
export function builtReason(bot, block, opts) {
  if (!block?.position || !block.name) return null
  const sh = opts?.noShell ? null : structureReason(bot, block) // DOOR3: shell of a room with a working door / beside bed, workstation, door / known place; any placer
  if (sh === 'shell') return sh
  // SURV2: a block she placed herself is hers to remove even inside a known place / next to a bed: observed the escape ladder was refused 20x ('known_place') on her OWN
  // night pillbox and she sat sealed in for 10+ min. Only a 'shell' of a room with a working doorway (DOOR3, above) stays protected for any placer.
  const r0 = builtReason0(bot, block, opts)
  if (r0) return r0
  // sealed in a 1x1 cell with no doorway: the walls around her are her way out, whoever placed them (placed-blocks.json can lose entries across a restart)
  if ((sh === 'known_place' || sh === 'near_structure') && sealedBeside(bot, block)) return null
  if (!bot.__placed?.has(block.position)) return sh
  if (sh === 'known_place') return null
  return sh
}
function builtReason0(bot, block, opts) {
  const placed = bot.__placed
  if (placed?.has(block.position)) return null
  if (isDoorish(block)) return 'door'
  if (BUILD_RE.test(block.name)) return 'built_block'
  if (block.boundingBox === 'block' && CONTEXT_RE.test(block.name) && doorNear(bot, block.position, DOOR_CONTEXT, opts)) return 'structure_context'
  return null
}

/** S2 (or a reflex) explicitly allows breaking built blocks for `ms`. Doors need allowDoors. */
export function allowBuiltBreak(bot, ms = 20000, { doors = false } = {}) {
  bot.__builtAllowUntil = Date.now() + ms; bot.__builtAllowDoors = doors
}
const allowed = (bot, why) => !['shell', 'near_structure', 'known_place'].includes(why) && Date.now() < (bot.__builtAllowUntil ?? 0) && (why !== 'door' || bot.__builtAllowDoors === true)

/**
 * Wrap bot.placeBlock (track own blocks) and bot.dig (refuse built blocks). Idempotent. Throws Error('built_protected') from dig.
 * exemptReflex(): true for the suffocation reflex, which may dig through built blocks (but never doors) to stay alive.
 */
export function installBuiltGuard(bot, { file = null, trace = null, exemptReflex = () => false } = {}) {
  if (!bot || bot.__builtGuard) return bot?.__placed ?? null
  if (typeof bot.dig !== 'function' || typeof bot.placeBlock !== 'function') {
    if (!bot.__builtGuardWait) { bot.__builtGuardWait = true; bot.once('inject_allowed', () => { bot.__builtGuardWait = false; installBuiltGuard(bot, { file, trace, exemptReflex }) }) }
    return null
  }
  const placed = (bot.__placed = new PlacedBlocks({ file }))
  bot.__builtStats = { blocked: 0, last: null }
  const place0 = bot.placeBlock.bind(bot)
  bot.placeBlock = async (ref, face, ...rest) => {
    const r = await place0(ref, face, ...rest)
    try { if (ref?.position && face) placed.add({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }) } catch { /* ignore */ }
    return r
  }
  const dig0 = bot.dig.bind(bot)
  bot.dig = (block, ...rest) => {
    const why = builtReason(bot, block)
    if (why && !allowed(bot, why) && !(why !== 'door' && exemptReflex())) {
      bot.__builtStats.blocked++; bot.__builtStats.last = [block.position.x, block.position.y, block.position.z, block.name, why]
      trace?.event('dig_blocked_built', { at: [block.position.x, block.position.y, block.position.z], block: block.name, why })
      return Promise.reject(Object.assign(new Error('built_protected'), { name: 'BuiltProtected', why }))
    }
    const pos = block?.position
    // DOOR3: a shell block of a room whose doorway is unusable (or an emergency: reflex) may be broken ONCE; the repair loop puts a block back
    let breach = null
    try { const si = pos && block.boundingBox === 'block' ? shellInfo(bot, pos) : null; if (si) breach = si.kind === 'door_ok' ? 'emergency' : 'door_blocked' } catch { /* ignore */ }
    // GATH1: she opens her OWN sealed shelter (wall or cap) to leave: remember the gap so the repair loop puts a block back (or notes the hole)
    if (!breach && pos && placed.has(pos) && sealedBeside(bot, block) && inPillbox(bot, pos)) breach = 'shelter_exit'
    if (breach) noteBreach(bot, block, breach, trace)
    const caller = digCaller()
    return Promise.resolve(dig0(block, ...rest)).then((r) => {
      if (pos) placed.delete(pos)
      try { trace?.event('block_broken', { at: [pos.x, pos.y, pos.z], block: block.name, caller, protected: !!why, breach: breach ?? undefined }) } catch { /* ignore */ }
      return r
    })
  }
  bot.__builtGuard = true
  installWallRepair(bot, { trace }) // DOOR3: repairs the one emergency gap in a shell
  return placed
}

/** who called bot.dig: skill file / pathfinder / unstuck(escape) / reflex, from the stack. */
function digCaller() {
  try {
    const st = new Error().stack.split('\n').slice(3, 14).join('\n')
    if (/mineflayer-pathfinder/.test(st)) return 'pathfinder'
    const m = [...st.matchAll(/src\/([\w\/.-]+?)\.js/g)].map((x) => x[1]).filter((x) => !/movements-protect/.test(x))
    return m[0] ?? 'unknown'
  } catch { return 'unknown' }
}

/** S2 perception: what kind of structure is she in. { enclosed, doors:[{x,y,z,name,open,d}], text } ; text is the sentence for the prompt. */
export function structureInfo(bot, { builder = null, radius = 6 } = {}) {
  const me = bot.entity?.position
  if (!me) return { enclosed: false, doors: [], text: '' }
  const doors = []
  for (const p of nearbyDoors(bot, { radius: 16, ttlMs: 1500 })) {
    const d = Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z, (p.y + 0.5 - me.y) * 0.5)
    if (d > radius * 2) continue
    const b = bot.blockAt(p)
    if (!b || b.name.endsWith('_trapdoor')) continue
    if (b.getProperties?.().half === 'upper') continue
    doors.push({ x: p.x, y: p.y, z: p.z, name: b.name, open: b.getProperties?.().open === true, d: +d.toFixed(1) })
  }
  doors.sort((a, b) => a.d - b.d)
  const enclosedBy = (() => { // walled on 4 sides within 3 blocks (door counts as wall) and a ceiling
    const x = Math.floor(me.x), y = Math.floor(me.y), z = Math.floor(me.z)
    const solidish = (dx, dy, dz) => { const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz)); return !!b && b.boundingBox === 'block' }
    let ceil = false
    for (let dy = 2; dy <= 4 && !ceil; dy++) ceil = solidish(0, dy, 0)
    let walls = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { for (let k = 1; k <= 3; k++) if (solidish(dx * k, 0, dz * k) || solidish(dx * k, 1, dz * k)) { walls++; break } }
    return ceil && walls === 4
  })()
  const who = builder ? `a structure built by ${builder}` : 'a player-built structure'
  const near = doors[0]
  const text = enclosedBy && near ? `You are inside ${who}; there is a${near.open ? 'n open' : ' closed'} ${near.name.replace(/_/g, ' ')} at ${near.x} ${near.y} ${near.z} (${near.d} m). Open it instead of breaking walls.` : ''
  return { enclosed: enclosedBy, doors, text }
}
