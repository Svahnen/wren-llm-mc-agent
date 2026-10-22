// NIGHT2: ranged threats (pillager crossbow, skeleton / stray / bogged arrows, trident drowned) are answered by BREAKING THE LINE OF SIGHT, not by open-ground flight.
// observed: "shot by Pillager": hp 15 -> 4 in 20 s from arrows in the open at 7-14 m; running in the open is shot in the back.
// Order of choice (each only if reachable in time):
//   1. INDOORS: a bounded room (flood fill, doors are walls) with a usable door within ~28 m whose inner cells are hidden from every shooter; walk in through the door
//      (DoorMovements opens it), close it behind her, and stay inside while a shooter is near (pillager patrol at home: stay in, doors closed).
//   2. COVER: the nearest standable cell (local Dijkstra) that no shooter can see: behind a hill / wall / tree line.
//   3. BLOCKS: emergencyCover (shield column / pit / pillbox) when she has blocks or a tool.
//   4. else flee class: walk away (the old behaviour).
// Takes over below low_hp_cover (85, hp <= 6 seals in at once) and above water_shooter (82).
import { Vec3 } from 'vec3'
import { isSolid } from './danger.js'
import { search, walkPath, cellOf } from './nav.js'
import { hostilesAround, profOf } from './threats.js'
import { hiddenFrom } from '../habits/safety.js'
import { floodRoom, doorUsable } from '../skills/enclosure.js'
import { isWalkthroughDoor } from '../skills/movements-protect.js'
import { closeDoorEx, isOpen, lowerHalf } from '../skills/movements-doors.js'
import { emergencyCover, coverMeans, hitNearby } from '../skills/shelter.js'

const ok = (reason = 'done', extra = {}) => ({ ok: true, reason, ...extra })
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra })
export const SHOOTER_RADIUS = 28
export const HOLD_RADIUS = 42       // while a shooter stays this near (even without line of sight) she stays under cover
const FACING = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const key = (x, y, z) => `${x},${y},${z}`

/** every ranged hostile within `r`, with or without line of sight (used to decide when it is safe to come out). */
export function shootersNear(bot, r = HOLD_RADIUS) {
  const me = bot.entity?.position
  if (!me) return []
  const out = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !e.position || e.isValid === false || e.health === 0) continue
    const p = profOf(e)
    if (!p?.ranged || p.neutral) continue
    const d = me.distanceTo(e.position)
    if (d <= r) out.push({ e, d, prof: p, name: e.name })
  }
  return out.sort((a, b) => a.d - b.d)
}

/** is she (feet cell) hidden from all of these? */
export const hiddenNow = (bot, shooters) => hiddenFrom(bot, bot.entity.position.floored(), shooters)

/** Rooms with a usable door near her. Returns [{door:{x,y,z}, cells:[{x,y,z}] inner standing cells, outside:{x,y,z}, d}] sorted by distance to the door. */
export function indoorCandidates(bot, shooters, { radius = 28, maxRooms = 6 } = {}) {
  const me = bot.entity.position
  const ids = bot.registry?.blocksArray?.filter((b) => /_door$/.test(b.name) && !b.name.startsWith('iron_')).map((b) => b.id) ?? []
  let spots = []
  try { spots = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 }) : [] } catch { spots = [] }
  const seen = new Set(), out = []
  for (const p of spots) {
    const b0 = bot.blockAt(p)
    if (!b0 || !isWalkthroughDoor(b0)) continue
    const lower = lowerHalf(bot, b0)
    const k = key(lower.position.x, lower.position.y, lower.position.z)
    if (seen.has(k)) continue
    seen.add(k)
    if (!doorUsable(bot, lower)) continue
    let props = {}; try { props = lower.getProperties?.() ?? {} } catch { /* ignore */ }
    const f = FACING[props.facing]
    if (!f) continue
    for (const s of [1, -1]) {
      const sx = lower.position.x + f[0] * s, sz = lower.position.z + f[1] * s
      for (const dy of [0, -1, 1]) {
        const y = lower.position.y + dy
        const a = bot.blockAt(new Vec3(sx, y, sz)), h = bot.blockAt(new Vec3(sx, y + 1, sz)), fl = bot.blockAt(new Vec3(sx, y - 1, sz))
        if (!a || !h || !fl || isSolid(a) || isSolid(h) || !isSolid(fl) || /door/.test(a.name) || /door/.test(h.name)) continue
        const room = floodRoom(bot, [sx, y, sz])
        if (!room.bounded) break
        const cells = [...room.cells].map((c) => { const [x, yy, z] = c.split(',').map(Number); return { x, y: yy, z } })
          .filter((c) => Math.hypot(c.x - lower.position.x, c.z - lower.position.z) >= 1.9)   // not the cell right behind the door
        const hidden = cells.filter((c) => hiddenFrom(bot, c, shooters))
        if (!hidden.length) break
        // the best inner cell: hidden and the farthest from the door (up to 6 blocks), so an open door leaf cannot expose her
        hidden.sort((c1, c2) => Math.min(6, Math.hypot(c2.x - lower.position.x, c2.z - lower.position.z)) - Math.min(6, Math.hypot(c1.x - lower.position.x, c1.z - lower.position.z)))
        const outside = { x: lower.position.x - f[0] * s, y: lower.position.y, z: lower.position.z - f[1] * s }
        out.push({ door: { x: lower.position.x, y: lower.position.y, z: lower.position.z }, cell: hidden[0], outside, d: Math.hypot(lower.position.x + 0.5 - me.x, lower.position.z + 0.5 - me.z), room: room.cells.size })
        break
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).slice(0, maxRooms)
}

/** nearest cell (local Dijkstra, no pathfinder) that no shooter can see; null when none within cost 16. */
export function coverCell(ctx, shooters, { maxCost = 16 } = {}) {
  const { bot, danger } = ctx
  const start = cellOf(bot.entity.position)
  const res = search(danger, start, (c) => hiddenFrom(bot, c, shooters), { maxNodes: 700, maxCost })
  return res && res.path.length ? res : null
}

/** pathfinder goto that never throws, bounded; the DoorMovements opens doors on the way. */
async function gotoCell(ctx, c, { timeoutMs = 18000 } = {}) {
  const { bot } = ctx
  const pf = bot.pathfinder
  if (!pf) return false
  let timer
  try {
    const goals = (await import('mineflayer-pathfinder')).default.goals
    const g = new goals.GoalBlock(c.x, c.y, c.z)
    await Promise.race([
      pf.goto(g),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs) }),
      new Promise((_, rej) => { ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }) }),
    ])
    return true
  } catch { return false } finally { clearTimeout(timer); try { pf.setGoal(null) } catch { /* ignore */ } }
}

/** close the open doors within 4.4 m (the one she came through). */
async function closeNearDoors(ctx) {
  const { bot } = ctx
  const me = bot.entity.position
  const ids = bot.registry?.blocksArray?.filter((b) => /_door$|_fence_gate$/.test(b.name) && !b.name.startsWith('iron_')).map((b) => b.id) ?? []
  let spots = []
  try { spots = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 5, count: 12 }) : [] } catch { spots = [] }
  let n = 0
  for (const p of spots) {
    const b = bot.blockAt(p)
    if (!b || !isOpen(b) || (b.getProperties?.().half === 'upper')) continue
    if (Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) > 4.4) continue
    const r = await closeDoorEx(bot, b, { retries: 2 }); if (r.ok) n++
  }
  return n
}

export const rangedCover = {
  name: 'ranged_cover', priority: 84, critical: false, cooldownMs: 3000, failCooldownMs: 4000, maxMs: 90000,
  check({ bot, cfg, danger }) {
    if ((bot.health ?? 20) <= 0 || bot.isSleeping || !bot.entity) return null
    const sh = hostilesAround(bot, SHOOTER_RADIUS).filter((t) => t.prof.ranged && !t.prof.neutral)
    if (!sh.length) return null
    if ((bot.health ?? 20) <= (cfg.coverHealth ?? 6) && coverMeans(bot).ok) return null   // low_hp_cover (85) seals her in at once
    const p = bot.entity.position
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    const s = (dx, yy, dz) => isSolid(danger.blockAt(x + dx, yy, z + dz))
    const sealed = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => s(dx, y, dz) && s(dx, y + 1, dz)) && s(0, y + 2, 0)
    if (sealed) return null
    const strong = sh.some((t) => t.name === 'pillager' || t.prof.trident)
    if (!(strong || (bot.health ?? 20) <= 14 || sh.length >= 2)) return null   // one skeleton at good health: mob_defense fights it
    if (hiddenNow(bot, sh)) return null
    return { nearest: sh[0].name, d: +sh[0].d.toFixed(1), n: sh.length, hp: bot.health }
  },
  async run(ctx, info) {
    const { bot } = ctx
    const t0 = Date.now()
    const over = () => ctx.signal.aborted || Date.now() - t0 > 85000
    const log = (mode, extra = {}) => ctx.log('ranged_cover', { ...info, mode, ...extra, hp: bot.health })
    let mode = null
    for (let round = 0; round < 3 && !over(); round++) {
      const sh = shootersNear(bot, SHOOTER_RADIUS)
      if (!sh.length || hiddenNow(bot, sh)) { mode = mode ?? 'hidden'; break }
      // 1. indoors
      let done = false
      const rooms = indoorCandidates(bot, sh)
      ctx.log('ranged_cover_rooms', { n: rooms.length, rooms: rooms.map((r) => ({ door: [r.door.x, r.door.y, r.door.z], d: +r.d.toFixed(1), cell: [r.cell.x, r.cell.y, r.cell.z], room: r.room })) })
      for (const r of rooms) {
        if (over()) break
        // a door farther from her than from the nearest shooter, in the shooter's direction, is no refuge: skip when the door is much nearer to the shooter
        const e0 = sh[0].e.position
        if (Math.hypot(r.door.x + 0.5 - e0.x, r.door.z + 0.5 - e0.z) + 4 < r.d && r.d > 10) continue
        const reached = await gotoCell(ctx, r.cell, { timeoutMs: Math.min(20000, 4000 + r.d * 650) })
        const here = bot.entity.position
        if (reached || Math.hypot(here.x - (r.cell.x + 0.5), here.z - (r.cell.z + 0.5)) < 2.2) {
          await closeNearDoors(ctx)
          mode = 'indoors'; log(mode, { door: [r.door.x, r.door.y, r.door.z], d: +r.d.toFixed(1), room: r.room }); done = true; break
        }
      }
      if (done) break
      if (over()) break
      // 2. natural cover
      const cov = coverCell(ctx, sh)
      if (cov) {
        const w = await walkPath(ctx, cov.path, { stepMs: 1500 })
        if (w.ok || w.reason === 'step_timeout') { mode = 'cover'; log(mode, { steps: cov.path.length, walk: w.reason ?? 'ok' }); if (hiddenNow(bot, shootersNear(bot, SHOOTER_RADIUS))) break; continue }
        if (w.reason === 'aborted') return fail('aborted')
      }
      // 3. build / dig in
      if (coverMeans(bot).ok) {
        const r = await emergencyCover(ctx, {}, { maxMs: 12000 })
        mode = 'blocks'; log(mode, { ...r }); if (r.ok) break
      }
      log('no_cover'); return fail('no_cover')
    }
    if (!mode) return fail('no_progress')
    // hold: stay under cover while any shooter is near (a pillager patrol at the door), hit what comes into reach, eat, come out when quiet
    let quiet = 0
    while (!over()) {
      if (!(await ctx.sleep(400))) break
      const near = shootersNear(bot, HOLD_RADIUS)
      quiet = near.length ? 0 : quiet + 0.4
      if (quiet >= 8) break
      const adj = hostilesAround(bot, 4).filter((t) => !t.prof.neutral && !t.prof.creeper && t.d <= 3.4)
      if (adj.length && await hitNearby(ctx, () => ctx.signal.aborted)) continue
      const exposed = hostilesAround(bot, SHOOTER_RADIUS).filter((t) => t.prof.ranged)
      if (exposed.length && !hiddenNow(bot, exposed)) {
        // line of sight again (door opened by a mob, wall break): one more cover round
        const sh = shootersNear(bot, SHOOTER_RADIUS)
        const cov = coverCell(ctx, sh)
        if (cov) { await walkPath(ctx, cov.path, { stepMs: 1500 }); continue }
        if (coverMeans(bot).ok) { await emergencyCover(ctx, {}, { maxMs: 10000 }); continue }
        return fail('exposed_no_cover')
      }
    }
    return ok('covered', { mode, held_s: Math.round((Date.now() - t0) / 1000), hp: bot.health })
  },
}
