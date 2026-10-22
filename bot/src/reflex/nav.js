// Tiny local navigation for reflexes: Dijkstra over walk/jump/drop/swim moves that NEVER enters lava unless
// the bot is already in lava (then lava cells are allowed at a high cost so it can get out), plus a control-state
// walker. The mineflayer pathfinder is deliberately not used here: it is slow to plan, cannot swim out (issue 391)
// and a reflex must not depend on its state.
import { Vec3 } from 'vec3'
import { HARD, DIRS, isPassable, isSolid, isWater, isLava } from './danger.js'

const cellKey = (c) => `${c.x},${c.y},${c.z}`
export const cellOf = (pos) => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 0.0001), z: Math.floor(pos.z) })

export function inLiquidAt(danger, c) {
  const f = danger.blockAt(c.x, c.y, c.z), h = danger.blockAt(c.x, c.y + 1, c.z)
  return { water: isWater(f) || isWater(h), lava: isLava(f) || isLava(h) }
}

/**
 * Dijkstra from `start`. goal(cell, info) -> true | number(score bonus, lower is better, not used) | false.
 * opts: lavaOk (allow lava cells at cost 30), maxNodes, maxCost, score(cell)->number (pick best scored node instead of first goal)
 * returns {path:[cell], goal, cost} or null. path excludes the start cell.
 */
export function search(danger, start, goal, { lavaOk = false, maxNodes = 900, maxCost = 40, pick = null } = {}) {
  const open = [{ c: start, g: 0 }]
  const best = new Map([[cellKey(start), { g: 0, prev: null, c: start }]])
  const closed = new Set()
  let nodes = 0
  let bestPick = null
  const bodyFree = (x, y, z) => {
    const f = danger.blockAt(x, y, z), h = danger.blockAt(x, y + 1, z)
    if (!isPassable(f) || !isPassable(h)) return null
    const lava = isLava(f) || isLava(h)
    if (lava) return lavaOk ? { lava: true, cost: 30 } : null
    const cost = danger.costAt({ x, y, z })
    if (cost >= HARD) return null
    return { lava: false, cost }
  }
  const floorOk = (x, y, z, info) => info.lava || isSolid(danger.blockAt(x, y - 1, z)) || isWater(danger.blockAt(x, y, z)) || isWater(danger.blockAt(x, y + 1, z))
  const relax = (from, c, step, info) => {
    const g = from.g + step + Math.min(info.cost, 60) / 10
    const k = cellKey(c)
    const old = best.get(k)
    if (old && old.g <= g) return
    const rec = { g, prev: from.rec, c }
    best.set(k, rec)
    open.push({ c, g, rec })
  }
  while (open.length && nodes < maxNodes) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].g < open[bi].g) bi = i
    const cur = open.splice(bi, 1)[0]
    const ck = cellKey(cur.c)
    if (closed.has(ck)) continue
    closed.add(ck)
    cur.rec = best.get(ck)
    nodes++
    if (cur.g > maxCost) break
    const c = cur.c
    if (goal && nodes > 1 && goal(c, { cost: danger.costAt(c), g: cur.g }) === true) return finish(cur.rec, cur.g)
    if (pick && nodes > 1) {
      const s = pick(c, cur.g)
      if (s !== null && s !== undefined && (!bestPick || s > bestPick.s)) bestPick = { s, rec: cur.rec, g: cur.g }
    }
    const here = inLiquidAt(danger, c)
    // vertical swimming
    if (here.water || here.lava) {
      for (const dy of [1, -1]) {
        const n = { x: c.x, y: c.y + dy, z: c.z }
        const info = bodyFree(n.x, n.y, n.z)
        if (!info) continue
        const w = inLiquidAt(danger, n)
        if (!(w.water || w.lava) && dy < 0 && !floorOk(n.x, n.y, n.z, info)) continue
        relax(cur, n, 1.2, info)
      }
    }
    for (const [dx, dz] of DIRS) {
      const nx = c.x + dx, nz = c.z + dz
      for (const dy of [0, 1, -1, -2, -3]) {
        const ny = c.y + dy
        if (dy === 1 && !isPassable(danger.blockAt(c.x, c.y + 2, c.z))) continue
        if (dy === 1 && isLava(danger.blockAt(c.x, c.y + 2, c.z)) && !lavaOk) continue
        if (dy < 0) {
          let clear = true
          for (let yy = ny + 1; yy <= c.y + 1; yy++) { const b = danger.blockAt(nx, yy, nz); if (!isPassable(b) || (isLava(b) && !lavaOk)) { clear = false; break } }
          if (!clear) continue
        }
        const info = bodyFree(nx, ny, nz)
        if (!info) continue
        if (!floorOk(nx, ny, nz, info)) continue
        relax(cur, { x: nx, y: ny, z: nz }, 1 + (dy < 0 ? 0.4 * -dy : 0) + (dy > 0 ? 0.6 : 0) + (info.lava ? 1 : 0), info)
        break // first feasible vertical option for this direction (prefers staying level)
      }
    }
  }
  if (pick && bestPick) return finish(bestPick.rec, bestPick.g)
  return null

  function finish(rec, g) {
    const path = []
    for (let r = rec; r && r.prev; r = r.prev) path.push(r.c)
    path.reverse()
    return { path, goal: path[path.length - 1] ?? start, cost: g }
  }
}

/** Walk a path with control states. ctx: {bot, signal, sleep(ms)->bool}. Never leaves keys pressed. */
export async function walkPath(ctx, path, { sprint = true, stepMs = 2200, now = Date.now } = {}) {
  const { bot } = ctx
  try {
    for (const cell of path) {
      const tx = cell.x + 0.5, tz = cell.z + 0.5
      const t0 = now()
      let lastD = Infinity, lastGain = t0
      for (;;) {
        if (ctx.signal.aborted) return { ok: false, reason: 'aborted' }
        const p = bot.entity.position
        const dx = tx - p.x, dz = tz - p.z
        const d = Math.hypot(dx, dz)
        const wet = bot.entity.isInWater || bot.entity.isInLava
        const dyTo = cell.y - p.y
        const wantUp = dyTo > 0.6 || (wet && dyTo > -0.2)
        const reachedH = d < (wet ? 0.45 : 0.3)
        const reachedV = dyTo < (wet ? 1.0 : 0.6) && dyTo > -1.3
        if (reachedH && reachedV) break
        if (reachedH && !reachedV && dyTo > 0.6 && !wet && bot.entity.onGround) { /* needs a jump: fall through to controls */ }
        if (now() - t0 > stepMs) return { ok: false, reason: 'step_timeout', cell }
        if (d < lastD - 0.05) { lastD = d; lastGain = now() } else if (now() - lastGain > 900) {
          bot.setControlState('jump', true) // wedged: hop
          if (now() - lastGain > 1500) return { ok: false, reason: 'stalled', cell }
        }
        if (d > 0.15) await bot.look(Math.atan2(-dx, -dz), 0, true)
        bot.setControlState('forward', d > 0.2)
        bot.setControlState('sprint', sprint && d > 1.6 && !wet)
        bot.setControlState('jump', wantUp || wet && dyTo > -0.5 || (bot.entity.isCollidedHorizontally && bot.entity.onGround))
        if (!(await ctx.sleep(50))) return { ok: false, reason: 'aborted' }
      }
    }
    return { ok: true }
  } finally {
    for (const k of ['forward', 'sprint', 'jump', 'back', 'left', 'right']) { try { bot.setControlState(k, false) } catch { /* ignore */ } }
  }
}

export function lookAtPoint(bot, v) { return bot.lookAt(new Vec3(v.x, v.y, v.z), true) }
