// B1 + DOOR1: doors for the pathfinder and the automatic door behaviour. mineflayer-pathfinder 2.4.5 (issue #373) cannot path through doors:
// canOpenDoors only handles fence gates (and is off), a closed wooden door is a solid block, so with canDig it DIGS the door / the wall. Here:
//  - DoorMovements: closed or open wooden doors, non-iron fence gates, iron doors that have a button/lever in reach, and trapdoor hatches
//    above a ladder are walkable cells (cost +1) in the planner; blocks built by players are never planned as breakable;
//  - installDoorOpener(bot): while the pathfinder moves (or a skill walks forward) a closed door/gate right ahead is opened (iron doors:
//    their button/lever is pressed; trapdoor above a ladder she climbs: opened); after she passed (crossed the door plane) it is closed again
//    (only what she opened herself); in an enclosed shelter at night or with a hostile near, any open wooden door/gate next to her is closed.
// Trace events: door_opened {at,name,kind,via}, door_closed {at,name,why}, door_failed {at,name,action,reason}.
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { builtReason, isWalkthroughDoor, isIronDoor, isTrapdoor, isTrigger, structureInfo } from './movements-protect.js'

const { Movements } = pf
const FACING = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const REACH = 4.4
const HOSTILE_RE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|creeper|spider|cave_spider|witch|pillager|vindicator|evoker|ravager|phantom|slime|enderman|silverfish|blaze|ghast|hoglin|piglin_brute|warden|bogged|breeze)$/
const props = (b) => { try { return b?.getProperties?.() ?? {} } catch { return {} } }
const keyOf = (p) => `${p.x},${p.y},${p.z}`
const arr = (p) => [p.x, p.y, p.z]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const isOpen = (b) => props(b).open === true
export const isClosed = (b) => (isWalkthroughDoor(b) || isIronDoor(b) || isTrapdoor(b)) && props(b).open !== true
/** the lower half of a two block door (doors and their upper half share state; we always key on the lower cell). */
export function lowerHalf(bot, b) { return b && props(b).half === 'upper' && /_door$/.test(b.name) ? (bot.blockAt(b.position.offset(0, -1, 0)) ?? b) : b }
export const nearestTo = (bot, p) => Math.hypot(p.x + 0.5 - bot.entity.position.x, (p.y + 0.5 - bot.entity.position.y) * 0.6, p.z + 0.5 - bot.entity.position.z)

// ------------------------------------------------------------------------------------------------ iron door triggers
const trigCache = new Map()
const plateCache = new Map()
/** buttons / levers within `r` of a door cell (cached 4 s: the planner asks thousands of times). */
export function triggersNear(bot, pos, r = 4) {
  const k = keyOf(pos), c = trigCache.get(k)
  if (c && Date.now() - c.t < 4000) return c.list
  const ids = bot.registry?.blocksArray?.filter((b) => isTrigger(b)).map((b) => b.id) ?? []
  let list = []
  try {
    if (ids.length && typeof bot.findBlocks === 'function') list = bot.findBlocks({ point: pos, matching: ids, maxDistance: r, count: 12 }).filter((p) => Math.abs(p.y - pos.y) <= 2)
  } catch { list = [] }
  if (trigCache.size > 400) trigCache.clear()
  trigCache.set(k, { t: Date.now(), list })
  return list
}

export const clearTriggerCache = () => { trigCache.clear(); plateCache.clear() }

// ------------------------------------------------------------------------------------------------ DOOR2: pressure plates
export const isPlate = (b) => !!b && /_pressure_plate$/.test(b.name)
const plateIds = (bot) => bot.registry?.blocksArray?.filter((b) => isPlate(b)).map((b) => b.id) ?? []
/** pressure plates within `r` blocks (horizontal) of a door cell at about the same level (cached 4 s). */

export function platesNear(bot, pos, r = 3) {
  const k = keyOf(pos), c = plateCache.get(k)
  if (c && Date.now() - c.t < 4000) return c.list
  let list = []
  try {
    const ids = plateIds(bot)
    if (ids.length && typeof bot.findBlocks === 'function') list = bot.findBlocks({ point: pos, matching: ids, maxDistance: r + 1, count: 12 }).filter((p) => Math.abs(p.y - pos.y) <= 1 && Math.hypot(p.x - pos.x, p.z - pos.z) <= r + 0.01)
  } catch { list = [] }
  if (plateCache.size > 400) plateCache.clear()
  plateCache.set(k, { t: Date.now(), list })
  return list
}
/** a plate that powers `door` on the side where the bot is, not yet under it, will open the door when she walks on it: do not toggle by hand. */
export function plateWillOpen(bot, door) {
  const me = bot.entity.position
  if (Math.hypot(me.x - (door.position.x + 0.5), me.z - (door.position.z + 0.5)) < 1.25) return false // at the door and still closed: use it
  const f = FACING[props(door).facing] ?? [0, 0]
  const side = ((me.x - (door.position.x + 0.5)) * f[0] + (me.z - (door.position.z + 0.5)) * f[1]) >= 0 ? 1 : -1
  return platesNear(bot, door.position).some((p) => {
    const ps = ((p.x - door.position.x) * f[0] + (p.z - door.position.z) * f[1]) * side
    return ps > 0 || (f[0] === 0 && f[1] === 0) // plate lies on her side of the door plane
  })
}
/** standing on a plate right now (door opens within a tick or two). */
export function onPlate(bot) {
  const p = bot.entity?.position
  if (!p) return false
  const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)))
  return isPlate(b)
}
export const isPowered = (b) => props(b).powered === true
/** other leaves of the same doorway: wooden door cells next to this one in the wall plane (double door) and their state. */
export function siblingLeaves(bot, b) {
  const f = FACING[props(b).facing]
  if (!f) return []
  const out = []
  for (const [ax, az] of [[f[1], f[0]], [-f[1], -f[0]]]) { // along the wall
    const o = bot.blockAt(b.position.offset(ax, 0, az))
    if (o && isWalkthroughDoor(o) && props(o).half !== 'upper') out.push(o)
  }
  return out
}

export class DoorMovements extends Movements {
  getBlock(pos, dx, dy, dz) {
    const b = super.getBlock(pos, dx, dy, dz)
    if (!b) return b
    if (isWalkthroughDoor(b)) { b.physical = false; b.safe = true; b.door = true } // opened on the way by the door opener
    else if (isIronDoor(b) && (triggersNear(this.bot, b.position).length || platesNear(this.bot, b.position).length)) { b.physical = false; b.safe = true; b.door = true; b.ironDoor = true }
    else if (isTrapdoor(b) && !b.physicalOpen) { // a hatch directly above a ladder column is the way up
      const below = this.bot.blockAt(b.position.offset(0, -1, 0))
      if (below && below.name === 'ladder') { b.physical = false; b.safe = true; b.door = true }
    }
    return b
  }
  /**
   * DOOR2: a door leaf is a thin panel; a closed or open door/gate cell can only be entered or left ALONG its facing axis (the panel sits on a side edge when open,
   * so a sideways step into the cell hits it). Planner and opener agree: no sideways or diagonal moves into or out of a door cell.
   */
  getNeighbors(node) {
    const out = super.getNeighbors(node)
    // NIGHT2: the filter used bot.blockAt(vec) with extraInfos (block-entity lookup per call): 3-5x slower A* than plain Movements (0.3 -> 1-2 ms/node, first
    // call 400-550 ms), so the 3 s thinkTimeout ended near structures with "Timeout" (the 6x move_to Timeouts on the way to the bed). Cheap lookup + a short-lived cell cache.
    const now = Date.now()
    if (!this._dcT || now - this._dcT > 1500 || this._dc.size > 60000) { this._dc = new Map(); this._dcT = now }
    const dc = this._dc
    const doorAxis = (x, y, z) => {
      const k = x + ',' + y + ',' + z
      let v = dc.get(k)
      if (v === undefined) {
        const b = this.bot.blockAt(new Vec3(x, y, z), false)
        if (!b || !(isWalkthroughDoor(b) || isIronDoor(b))) v = null
        else { const f = FACING[props(b).facing]; v = f ? { x: Math.abs(f[0]), z: Math.abs(f[1]) } : { x: 0, z: 0, odd: true } }
        dc.set(k, v)
      }
      return v
    }
    const isDoorCell = (x, y, z) => doorAxis(x, y, z) !== null
    return out.filter((n) => {
      const mx = n.x - node.x, mz = n.z - node.z
      if (!mx && !mz) return true
      if (mx && mz) { // DOOR3 root cause: a diagonal step cuts the corner of a door cell next to it (flank cell = door); the body hits the wall corner / leaf and she ends BESIDE the open door
        for (const [fx, fz] of [[node.x + mx, node.z], [node.x, node.z + mz]]) for (const y of [node.y, node.y + 1, n.y, n.y + 1]) {
          if (isDoorCell(fx, y, fz)) return false
        }
      }
      for (const [x, y, z] of [[n.x, n.y, n.z], [node.x, node.y, node.z]]) {
        const a = doorAxis(x, y, z)
        if (a && !a.odd && ((mx !== 0 && !a.x) || (mz !== 0 && !a.z))) return false
      }
      return true
    })
  }
  safeToBreak(block) {
    if (builtReason(this.bot, block)) return false // never plan to dig player-built blocks (and never a door)
    return super.safeToBreak(block)
  }
}

// ------------------------------------------------------------------------------------------------ primitives
/** One activation (right click) with a bounded wait: bot.activateBlock waits for a (non-forced) look that never finishes while the pathfinder steers. */
export async function activate(bot, b, { timeoutMs = 700 } = {}) {
  if (!b) return false
  try {
    try { await Promise.race([bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true), sleep(200)]) } catch { /* ignore */ }
    await Promise.race([bot.activateBlock(b), sleep(timeoutMs).then(() => { throw new Error('activate timeout') })])
    return true
  } catch { return false }
}

/**
 * Open a closed door/gate/trapdoor. Iron doors: press the nearest button / flip the nearest lever in reach.
 * Resolves { ok, reason?, via? }. reason: not_a_door | out_of_reach | iron_no_trigger | activate_error | still_closed.
 */
export async function openDoorEx(bot, b0, { sleepMs = 200, retries = 1 } = {}) {
  let b = lowerHalf(bot, b0)
  if (!b || !(isWalkthroughDoor(b) || isIronDoor(b) || isTrapdoor(b))) return { ok: false, reason: 'not_a_door' }
  if (isOpen(b)) return { ok: true, via: 'already_open' }
  if (nearestTo(bot, b.position) > REACH + 0.6 && !isIronDoor(b)) return { ok: false, reason: 'out_of_reach' }
  if (isIronDoor(b)) {
    const me = bot.entity.position
    const trig = triggersNear(bot, b.position).map((p) => ({ p, d: Math.hypot(p.x + 0.5 - me.x, p.y + 0.5 - me.y, p.z + 0.5 - me.z) })).filter((t) => t.d <= REACH).sort((x, y) => x.d - y.d)[0]
    if (!trig) return { ok: false, reason: triggersNear(bot, b.position).length ? 'out_of_reach' : 'iron_no_trigger' }
    const tb = bot.blockAt(trig.p)
    const leverWas = tb?.name === 'lever' ? props(tb).powered === true : undefined   // DOOR3b: remember the state to flip a lever back after she passed
    if (!(await activate(bot, tb))) return { ok: false, reason: 'activate_error' }
    for (let i = 0; i < 6; i++) { await sleep(120); if (isOpen(bot.blockAt(b.position))) return { ok: true, via: tb.name, trigger: arr(trig.p), leverWas } }
    return { ok: false, reason: 'still_closed', via: tb.name }
  }
  // DOOR2: a powered door (plate/button/lever holds it) is never toggled by hand; a plate on her side opens it when she steps on it
  if (isPowered(b) || onPlate(bot)) { // let the redstone settle, then read again
    for (let i = 0; i < 8; i++) { await sleep(100); if (isOpen(bot.blockAt(b.position))) return { ok: true, via: 'powered' } }
    if (isPowered(bot.blockAt(b.position))) return { ok: false, reason: 'powered_wait' }
  }
  if (plateWillOpen(bot, b)) return { ok: false, reason: 'plate_will_open' }
  for (let a = 0; a <= retries; a++) {
    if (!(await activate(bot, b))) { if (a === retries) return { ok: false, reason: 'activate_error' }; continue }
    // poll for the state change: reading too early and 'retrying' would toggle the door shut again
    for (let i = 0; i < 6; i++) { await sleep(Math.max(40, sleepMs / 3)); const nb = bot.blockAt(b.position); if (isOpen(nb)) return { ok: true, via: 'use' }; if (isPowered(nb)) break }
    if (isOpen(bot.blockAt(b.position))) return { ok: true, via: 'use' }
  }
  return { ok: false, reason: 'still_closed' }
}
/** Legacy boolean API (B1, shelter, escape). */
export async function openDoorBlock(bot, b, opts = {}) { return (await openDoorEx(bot, b, opts)).ok }

/** Close an open wooden door/gate/trapdoor. Resolves { ok, reason? }. */
export async function closeDoorEx(bot, b0, { sleepMs = 200, retries = 1 } = {}) {
  const b = lowerHalf(bot, b0)
  if (!b || !(isWalkthroughDoor(b) || isTrapdoor(b))) return { ok: false, reason: isIronDoor(b) ? 'iron_self_closing' : 'not_a_door' }
  if (!isOpen(b)) return { ok: true, via: 'already_closed' }
  if (nearestTo(bot, b.position) > REACH + 0.6) return { ok: false, reason: 'out_of_reach' }
  if (isPowered(b)) return { ok: false, reason: 'powered' } // held open by a plate/button/lever: it closes itself, never toggle
  for (let a = 0; a <= retries; a++) {
    if (!(await activate(bot, b))) { if (a === retries) return { ok: false, reason: 'activate_error' }; continue }
    for (let i = 0; i < 6; i++) { await sleep(Math.max(40, sleepMs / 3)); const nb = bot.blockAt(b.position); if (!isOpen(nb)) return { ok: true }; if (isPowered(nb)) return { ok: false, reason: 'powered' } }
  }
  return { ok: false, reason: 'still_open' }
}

/** Closed door/gate cells in front of the bot (feet and head level, along its yaw). Lower half returned (doors are 2 high). */
export function doorsAhead(bot, reach = [0.9, 1.6], { iron = true } = {}) {
  const p = bot.entity?.position
  if (!p) return []
  const fx = -Math.sin(bot.entity.yaw), fz = -Math.cos(bot.entity.yaw)
  const out = new Map()
  for (const r of reach) for (const dy of [0.2, 1.2]) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x + fx * r), Math.floor(p.y + dy), Math.floor(p.z + fz * r)))
    if (b && isClosed(b) && !isTrapdoor(b) && (iron || !isIronDoor(b))) { const l = lowerHalf(bot, b); out.set(keyOf(l.position), l) }
  }
  return [...out.values()]
}

/** Closed trapdoor hatch above the bot while it stands in a ladder column (or on top of one). */
export function hatchAbove(bot) {
  const p = bot.entity?.position
  if (!p) return null
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  const here = bot.blockAt(new Vec3(x, y, z)), under = bot.blockAt(new Vec3(x, y - 1, z))
  if (!(here?.name === 'ladder' || under?.name === 'ladder')) return null
  for (let dy = 1; dy <= 3; dy++) {
    const b = bot.blockAt(new Vec3(x, y + dy, z))
    if (b && isTrapdoor(b) && !isOpen(b)) return b
    if (b && b.boundingBox === 'block' && !isTrapdoor(b)) return null
  }
  return null
}

/** all open wooden doors/gates within r of the bot (lower halves, sorted by distance). */
export function openDoorsNear(bot, r = 6) {
  const ids = bot.registry?.blocksArray?.filter((b) => isWalkthroughDoor({ name: b.name })).map((b) => b.id) ?? []
  let ps = []
  try { ps = ids.length ? bot.findBlocks({ matching: ids, maxDistance: r, count: 64 }) : [] } catch { ps = [] }
  const out = []
  for (const p of ps) { const b = bot.blockAt(p); if (b && isOpen(b) && props(b).half !== 'upper') out.push(b) }
  return out.sort((a, b) => nearestTo(bot, a.position) - nearestTo(bot, b.position))
}

export const hostilesNear = (bot, r = 16) => Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && HOSTILE_RE.test(e.name ?? '') && e.position && e.position.distanceTo(bot.entity.position) <= r)
export const isNight = (bot) => { const t = bot.time?.timeOfDay; return typeof t === 'number' && t >= 12600 && t <= 23400 }

// ------------------------------------------------------------------------------------------------ the opener
export function installDoorOpener(bot, { trace = null, closeAfterMs = 400, shelterClose = true, now = Date.now } = {}) {
  if (!bot || bot.__doorOpener) return bot?.__doorOpener
  const mine = new Map() // key(lower pos) -> { pos, at, name, n:{x,z}, s0, kind, attempts }
  const lastFail = new Map()
  const lastShelter = new Map()
  const stats = (bot.__doorStats = { opened: 0, closed: 0, failed: 0 })
  let busy = false
  const ev = (type, f) => { try { trace?.event(type, f) } catch { /* ignore */ } }
  const fail = (b, action, reason) => {
    const k = `${keyOf(b.position)}:${action}:${reason}`
    if (now() - (lastFail.get(k) ?? 0) < 5000) return
    lastFail.set(k, now()); stats.failed++
    ev('door_failed', { at: arr(b.position), name: b.name, action, reason })
  }
  const normal = (b) => { const f = FACING[props(b).facing]; return f ? { x: f[0], z: f[1] } : { x: 0, z: 0 } }
  const relDot = (pos, n) => { const p = bot.entity.position; return (p.x - (pos.x + 0.5)) * n.x + (p.z - (pos.z + 0.5)) * n.z }
  const track = (b, kind = 'door') => {
    const n = normal(b)
    mine.set(keyOf(b.position), { pos: b.position.clone(), at: now(), name: b.name, n, s0: Math.sign(relDot(b.position, n)) || 1, kind, attempts: 0 })
  }
  const levers = new Map() // DOOR3b: iron door key -> { door, lever, n, s0, at, attempts }: levers she flipped ON herself are flipped back once she is through
  const trackLever = (b, trigger) => {
    const n = normal(b)
    levers.set(keyOf(b.position), { door: b.position.clone(), lever: new Vec3(...trigger), n, s0: Math.sign(relDot(b.position, n)) || 1, at: now(), attempts: 0 })
  }
  const closeOne = async (b, why) => {
    const r = await closeDoorEx(bot, b)
    if (r.ok) { stats.closed++; ev('door_closed', { at: arr(b.position), name: b.name, why }); return true }
    return r
  }

  const tick = async () => {
    if (busy || !bot.entity) return
    busy = true
    try {
      const moving = bot.pathfinder?.isMoving?.() || bot.getControlState?.('forward')
      // 1. open what is in the way
      if (moving) {
        for (const b of doorsAhead(bot)) {
          const r = await openDoorEx(bot, b)
          if (r.ok) { if (r.via !== 'already_open') { stats.opened++; if (!isIronDoor(b)) track(b); else if (r.via === 'lever' && r.leverWas === false && r.trigger) trackLever(b, r.trigger); ev('door_opened', { at: arr(b.position), name: b.name, kind: b.name.endsWith('fence_gate') ? 'gate' : isIronDoor(b) ? 'iron' : 'door', via: r.via }) } break }
          if (r.reason !== 'plate_will_open' && r.reason !== 'powered_wait') fail(b, 'open', r.reason)
          else break
        }
        const h = hatchAbove(bot)
        if (h) {
          const r = await openDoorEx(bot, h)
          if (r.ok) { stats.opened++; track(h, 'hatch'); ev('door_opened', { at: arr(h.position), name: h.name, kind: 'trapdoor', via: r.via }) } else fail(h, 'open', r.reason)
        }
      }
      // 2. close what we opened once she is through
      for (const [k, d] of [...mine]) {
        const b = bot.blockAt(d.pos)
        if (!b || !(isWalkthroughDoor(b) || isTrapdoor(b)) || !isOpen(b)) { mine.delete(k); continue }
        const age = now() - d.at
        if (age > 90000) { mine.delete(k); fail(b, 'close', 'gave_up_timeout'); continue }
        if (age < closeAfterMs) continue
        const me = bot.entity.position
        const dist = Math.hypot(me.x - (d.pos.x + 0.5), me.z - (d.pos.z + 0.5))
        let through
        if (d.kind === 'hatch') through = me.y >= d.pos.y + 0.9 && dist < 3
        else {
          const dot = relDot(d.pos, d.n) * d.s0 // > 0 same side as when opened, < 0 the far side
          through = dot <= -0.85 || (age > 2500 && dist >= 3 && !moving)
          if (!through && age > 4000 && dist >= 3.2) through = true // turned back: tidy up as well
        }
        if (!through) continue
        const inCell = Math.abs(me.x - (d.pos.x + 0.5)) < 0.85 && Math.abs(me.z - (d.pos.z + 0.5)) < 0.85 && Math.abs(me.y - d.pos.y) < 1.5
        if (inCell && age < 6000) continue // never close a door she is standing in / right next to while moving through
        if (isPowered(b)) { if (age < 15000) continue; mine.delete(k); continue } // a plate/button holds it; it closes by itself
        if (dist > REACH + 0.5) { if (age > 20000) { mine.delete(k); fail(b, 'close', 'out_of_reach') } continue }
        const r = await closeOne(b, d.kind === 'hatch' ? 'passed_hatch' : 'passed')
        if (r === true) mine.delete(k)
        else if (r.reason === 'powered') continue
        else if (++d.attempts >= 3) { mine.delete(k); fail(b, 'close', r.reason) }
      }
      // 2b. DOOR3b: flip back a lever she switched on to open an iron door (the door was closed before; a lever left on keeps it open for everyone)
      for (const [k, d] of [...levers]) {
        const lb = bot.blockAt(d.lever)
        if (!lb || lb.name !== 'lever' || props(lb).powered !== true) { levers.delete(k); continue }
        const age = now() - d.at
        if (age > 60000) { levers.delete(k); ev('lever_reset_failed', { at: arr(d.lever), reason: 'gave_up_timeout' }); continue }
        const me = bot.entity.position
        const dist = Math.hypot(me.x - (d.door.x + 0.5), me.z - (d.door.z + 0.5))
        const dot = relDot(d.door, d.n) * d.s0
        const through = dot <= -0.85 || (age > 2500 && dist >= 3 && !moving) || (age > 4000 && dist >= 3.2)
        if (!through || age < closeAfterMs) continue
        if (Math.hypot(me.x - (d.lever.x + 0.5), (me.y - d.lever.y) * 0.6, me.z - (d.lever.z + 0.5)) > REACH) continue   // wait until the lever is in reach again
        if (await activate(bot, lb)) {
          await sleep(150)
          if (props(bot.blockAt(d.lever)).powered !== true) { levers.delete(k); stats.levers_reset = (stats.levers_reset ?? 0) + 1; ev('lever_reset', { at: arr(d.lever), door: arr(d.door) }); continue }
        }
        if (++d.attempts >= 3) { levers.delete(k); ev('lever_reset_failed', { at: arr(d.lever), reason: 'still_on' }) }
      }
      // 3. shelter: inside an enclosed room at night or with a hostile near, close any wooden door next to her
      if (shelterClose && !moving && bot.health > 0) {
        const t = now()
        if (t - (bot.__doorShelterT ?? 0) > 1000) {
          bot.__doorShelterT = t
          const night = isNight(bot), hostile = hostilesNear(bot, 16).length > 0
          if (night || hostile) {
            const near = openDoorsNear(bot, 5).filter((b) => nearestTo(bot, b.position) <= 4.2 && t - (lastShelter.get(keyOf(b.position)) ?? 0) > 30000)
            if (near.length) {
              let inside = false
              try { inside = structureInfo(bot).enclosed } catch { /* ignore */ }
              if (inside || hostile) {
                const d = near[0]
                lastShelter.set(keyOf(d.position), t)
                const r = await closeOne(d, hostile ? 'shelter_hostile' : 'shelter_night')
                if (r !== true) fail(d, 'close', r.reason)
              }
            }
          }
        }
      }
    } catch (e) { ev('door_error', { message: String(e?.message ?? e).slice(0, 120) }) } finally { busy = false }
  }
  let last = 0
  bot.on('physicsTick', () => { const t = Date.now(); if (t - last < 100) return; last = t; tick().catch(() => {}) })
  bot.__doorOpener = { mine, stats, tick }
  return bot.__doorOpener
}

// ------------------------------------------------------------------------------------------------ DOOR2: "inside" = same walled room as a place
/**
 * Flood fill (4-neighbour, feet+head level free, any door counts as a wall) from the cell at `target` (snapped to a walkable cell) and test whether the bot's cell is in the
 * same component. A component larger than maxCells is open ground: { bounded:false }. Roofless dirt huts count: only the walls matter.
 */
export function sameRoom(bot, target, { maxCells = 400 } = {}) {
  const me = bot.entity?.position
  if (!me || !target) return { bounded: false, inside: false }
  const free = (x, y, z) => {
    const a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z))
    if (!a || !b) return false
    if (/door$|_gate$/.test(a.name) || /door$|_gate$/.test(b.name)) return false
    return a.boundingBox !== 'block' && b.boundingBox !== 'block'
  }
  const ty = Math.floor(target.y + 0.01)
  const seen = new Set(), q = [[Math.floor(target.x), ty, Math.floor(target.z)]]
  const k = (x, z) => `${x},${z}`
  seen.add(k(q[0][0], q[0][2]))
  const mx = Math.floor(me.x), mz = Math.floor(me.z)
  let found = false
  while (q.length) {
    const [x, y, z] = q.shift()
    if (x === mx && z === mz && Math.abs(me.y - y) < 2) found = true
    if (seen.size > maxCells) return { bounded: false, inside: false }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (seen.has(k(nx, nz))) continue
      for (const ny of [y, y - 1, y + 1]) { // step up/down one
        if (free(nx, ny, nz) && bot.blockAt(new Vec3(nx, ny - 1, nz))?.boundingBox === 'block') { seen.add(k(nx, nz)); q.push([nx, ny, nz]); break }
      }
    }
  }
  return { bounded: true, inside: found, cells: seen.size }
}
