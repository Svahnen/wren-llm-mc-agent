// wander / explore: ONE leg toward a STANDABLE, reachable, novelty-biased target (T1 found 61 % NoPath with blind targets).
// Candidate sampling: polar around the bot, find a standable cell in the loaded column, score by visited heatmap
// (+ env.costAt penalty from mind/), then verify the best few with a bounded A* (pathfinder.getPathTo) before walking.
import { explainNoPath } from './shelter.js'
import { goals, standableY, distXZ, dist3, V, openSky } from './lib.js'

const ZONE_REJECT = 12 // env.costAt (lesson zone cost, peak 60) at or above this: not a target
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/** H1: extra cost for targets in/next to caves, lava or deep water (exploring stays novelty-biased, but safer). Pure on bot.blockAt. */
export function hazardPenalty(bot, x, y, z) {
  let pen = 0
  if (y < 58 && !openSky(bot, { x, y, z })) pen += 3        // cave / underground
  let lava = 0, water = 0
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [-1, 0]) {
    const b = bot.blockAt(V(x + dx, y + dy, z + dz))
    if (!b) continue
    if (b.name === 'lava') lava++
    else if (b.name === 'water') water++
  }
  if (lava) pen += 8
  if (water >= 6) pen += 2                                  // lake / deep water edge
  return pen
}

// L1: hard rejects (the live Wren walked an explore leg into lava twice, once in an unlit cave).
const HAZARD_NAMES = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus'])
/** Any lava / fire / magma / cactus within r blocks (horizontal) and dy -3..+2 of the point. */
export function hazardNear(bot, x, y, z, r = 6, step = 1) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
  for (let dx = -r; dx <= r; dx += step) for (let dz = -r; dz <= r; dz += step) for (let dy = -3; dy <= 2; dy++) {
    const b = bot.blockAt(V(x + dx, y + dy, z + dz))
    if (b && HAZARD_NAMES.has(b.name)) return true
  }
  return false
}
/** Is the planned path (A* nodes) close to a hazard? Every 2nd node, radius 3. */
export function pathNearHazard(bot, path, r = 3) {
  for (let i = 0; i < path.length; i += 2) { const n = path[i]; if (n && hazardNear(bot, n.x, n.y, n.z, r, 1)) return true }
  return false
}
/** Underground = below the surface band with no open sky above. Only a deliberate "go down" may target it. */
export function isUndergroundTarget(bot, x, y, z) { return y < 60 && !openSky(bot, { x, y, z }) }

export function sampleTargets(bot, env, { radius = 28, minDist = 6, samples = 32, direction = 'any', stats = null, wide = true } = {}) {
  const o = bot.entity.position
  const rng = env.rng
  const out = []
  const dir = DIRS[direction]
  for (let i = 0; i < samples; i++) {
    let ang = rng() * Math.PI * 2
    if (dir) ang = Math.atan2(dir[1], dir[0]) + (rng() - 0.5) * (Math.PI * 0.9)
    const d = minDist + rng() * (radius - minDist)
    const x = Math.floor(o.x + Math.cos(ang) * d), z = Math.floor(o.z + Math.sin(ang) * d)
    // IMP1: hills and lakes: a ground cell 30-70 m away is often more than 10 below / 6 above her feet, so widen the vertical search before giving up
    let y = standableY(bot, x, z, o.y)
    if (y === null && wide) y = standableY(bot, x, z, o.y, 24, 40)
    if (y === null) { if (stats) stats.nostand = (stats.nostand ?? 0) + 1; continue }
    let score = env.heatmap.count(x, z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) score += 0.25 * env.heatmap.count(x + dx * env.heatmap.cell, z + dz * env.heatmap.cell)
    score += hazardPenalty(bot, x, y, z) + (env.costAt?.({ x, y, z }) ?? 0) + rng() * 0.2 + (Math.abs(y - o.y) > 4 ? 0.5 : 0)
    if (!Number.isFinite(score)) { if (stats) stats.zone = (stats.zone ?? 0) + 1; continue } // Infinity from costAt = forbidden lesson zone
    out.push({ x: x + 0.5, y, z: z + 0.5, score, zone: env.costAt?.({ x, y, z }) ?? 0 })
  }
  return out.sort((a, b) => a.score - b.score)
}

/** Does a path exist (bounded A*)? Unknown API (test doubles) => assume yes. */
export function pathExists(bot, t, ms = 250, { safe = false, minSteps = 8 } = {}) {
  try {
    if (!bot.pathfinder?.getPathTo || !bot.pathfinder.movements) return true
    const r = bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(t.x, t.y, t.z, 1), ms)
    // a long target (explore, >= 30 blocks) rarely finishes in 250 ms: a partial/timeout path that already leads >= 8 steps is good enough
    const ok = r.status === 'success' || ((r.status === 'timeout' || r.status === 'partial') && (r.path?.length ?? 0) >= minSteps)
    return ok && !(safe && pathNearHazard(bot, r.path ?? []))
  } catch { return true }
}

function makeLegSkill(name, env, defaults) {
  return {
    name,
    max_s: defaults.max_s,
    stall_s: 14,
    precondition: ({ bot }) => !!bot?.entity && bot.health > 0,
    progress_fn: (ctx) => ctx.state.best ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const radius = ctx.args.radius ?? defaults.radius
      const direction = ctx.args.direction ?? 'any'
      const diag = { nostand: 0, zone: 0, underground: 0, hazard: 0, nopath: 0, goto_failed: 0 }
      // IMP1: stage 0 = the normal leg; stages 1-2 = shorter legs toward the nearest not-yet-walked ground (no direction, more samples, partial paths accepted)
      const stages = [{ radius, minDist: defaults.minDist, direction, samples: 32 }, { radius: Math.min(radius, 36), minDist: 10, direction: 'any', samples: 64, frontier: true }, { radius: 20, minDist: 5, direction: 'any', samples: 64, frontier: true }]
      for (let attempt = 0; attempt < 5; attempt++) {
        if (ctx.aborted) return { ok: false, reason: 'aborted' }
        const st = stages[attempt < 3 ? 0 : attempt - 2]
        const cands = sampleTargets(bot, env, { radius: st.radius, minDist: st.minDist, direction: st.direction, samples: st.samples, stats: diag })
        let t = null
        const down = ctx.args.allow_underground === true || direction === 'down'
        let examined = 0
        for (const c of cands) {
          if (examined >= 10) break
          if (c.zone >= ZONE_REJECT) { env.heatmap.visit(c.x, c.z); continue }                                   // lesson zone
          if (!down && isUndergroundTarget(bot, c.x, c.y, c.z)) { diag.underground++; env.heatmap.visit(c.x, c.z); continue }        // caves / unlit underground
          if (hazardNear(bot, c.x, c.y, c.z, 6)) { diag.hazard++; env.heatmap.visit(c.x, c.z); ctx.log('target_rejected', { why: 'hazard', x: Math.round(c.x), y: c.y, z: Math.round(c.z) }); continue }
          examined++
          if (pathExists(bot, c, st.frontier ? 400 : 300, { safe: true, minSteps: st.frontier ? 4 : 8 })) { t = c; break } else { diag.nopath++; env.heatmap.visit(c.x, c.z) }
        }
        if (!t) { ctx.state.best = (ctx.state.best ?? 0); await ctx.sleep(300); continue }
        ctx.state.target = t
        ctx.log('target', { x: Math.round(t.x), y: t.y, z: Math.round(t.z), score: +t.score.toFixed(2), attempt })
        const dist = () => Math.round(dist3(bot.entity.position, t))
        ctx.state.best = Math.min(ctx.state.best ?? 1e9, dist())
        const track = setInterval(() => { try { const d = dist(); if (d < ctx.state.best) ctx.state.best = d } catch { /* gone */ } }, 250)
        let r
        try { r = await ctx.goto(new goals.GoalNear(t.x, t.y, t.z, 2), { timeoutMs: st.frontier ? 25000 : defaults.legMs }) } finally { clearInterval(track) }
        if (r.ok && dist() <= 4) return { ok: true }
        env.heatmap.visit(t.x, t.z); env.heatmap.visit(t.x, t.z)
        diag.goto_failed++
        if (r.reason === 'aborted') return { ok: false, reason: 'aborted' }
      }
      ctx.log('explore_diag', { ...diag, pos: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)] })   // why no target: terrain not loaded / hills / zones / hazards / no path / walk failed
      { let why = null; try { why = explainNoPath(ctx.bot) } catch { /* ignore */ } return { ok: false, reason: 'no_reachable_target', ...(why ? { detail: why } : {}) } }   // NAV1
    },
  }
}

export function makeWander(env) {
  // env may be {heatmap, radius} from T1's main.js: normalise.
  const e = { rng: Math.random, costAt: null, ...env }
  return makeLegSkill('wander', e, { max_s: 45, radius: env.radius ?? 28, minDist: 6, legMs: 40000 })
}
export function makeExplore(env) {
  return makeLegSkill('explore', env, { max_s: 90, radius: 70, minDist: 30, legMs: 80000 })
}
