// PB4: missing activities as skills (material-agnostic, world-verified results, never trust a claim). Playbooks (library/*.json) chain them.
//   hole_and_cap   dig 2 down through plain ground and cap the hole above you (blocks come from the hole itself)       -> exit_hole later
//   exit_hole      leave a hole made by hole_and_cap: break the cap, pillar up with the blocks you hold (fills the hole)
//   roof_over_me   3x3 roof 3 blocks above your feet (one support column at your side) against arrows from above / phantoms / rain
//   torch_perimeter torches on a ring (~6 m apart) around where you stand (shelter / home)
//   stair_down     staircase down to target_y, never into the unknown: stops at lava, water, air gaps, falling blocks
//   farm_plot / farm_harvest  till a 3x3 plot (hoe), plant seeds, mark it as place "farm"; later harvest ripe crops and replant
//   animal_pen     5x5 fence (fences or any blocks) with a gate cell, optionally lure animals in with wheat/seeds
import { doorKeepout, goals, V, dist3, items, countItem, countMatch, standableY, equipBest } from './lib.js'
import { placeAt, boxedIn, emergencyCover, coverMeans } from './shelter.js'
import { builtReason } from './movements-protect.js'
import { pillarUp } from './build.js'
import { placeableCount, PLACEABLE } from '../habits/safety.js'
import { waterRisk, nearWater } from '../water-policy.js'

const solid = (b) => !!b && b.boundingBox === 'block'
const nm = (b) => b?.name ?? 'unknown'
const LIQ = /^(lava|water|bubble_column|magma_block)$/
const isLiquid = (b) => !!b && LIQ.test(b.name)
const FALLING = /^(sand|red_sand|gravel|[a-z_]+_concrete_powder)$/
const alive = ({ bot }) => !!bot?.entity && bot.health > 0
const at = (bot, x, y, z) => bot.blockAt(V(x, y, z))
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

async function settle(ctx) { const bot = ctx.bot; try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ } bot.clearControlStates?.(); for (let i = 0; i < 8 && !bot.entity.onGround; i++) await ctx.sleep(150) }
const feetCell = (bot) => { const p = bot.entity.position.floored(); return V(p.x, standableY(bot, p.x, p.z, p.y, 1, 3) ?? p.y, p.z) }

async function digCell(ctx, c, ms = 9000) {
  const bot = ctx.bot, b = at(bot, c.x, c.y, c.z)
  if (!solid(b)) return true
  await equipBest(bot, /log|planks|wood/.test(b.name) ? 'axe' : /dirt|grass|sand|gravel|clay/.test(b.name) ? 'shovel' : 'pickaxe').catch(() => {})
  try { await Promise.race([bot.dig(b), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), ms))]) } catch { try { bot.stopDigging() } catch { /* ignore */ } return false }
  return !solid(at(bot, c.x, c.y, c.z))
}

/** place any `re`-named item from the floor/neighbour at cell c (generic: fences, gates, torches...). true | false */
export async function placeItemAt(bot, c, re, faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
  const cur = at(bot, c.x, c.y, c.z)
  if (cur && cur.name !== 'air' && cur.boundingBox !== 'empty' && !/grass|fern|snow/.test(cur.name)) return solid(cur)
  const it = items(bot).find((i) => re.test(i.name)); if (!it) return false
  for (const [dx, dy, dz] of faces) {
    const nb = at(bot, c.x + dx, c.y + dy, c.z + dz)
    if (!solid(nb) || isLiquid(nb)) continue
    try { await bot.equip(it, 'hand'); await bot.placeBlock(nb, V(-dx, -dy, -dz)); await new Promise((r) => setTimeout(r, 120)); if (re.test(nm(at(bot, c.x, c.y, c.z)))) return true } catch { /* next face */ }
  }
  return false
}

// ------------------------------------------------------------------ hole_and_cap / exit_hole
export function holeSiteRisk(bot, S) {
  if (waterRisk(bot) && nearWater(bot, S)) return 'near_water'   // WATER1: seepage - a pit within 3 blocks of water floods (STUCK3); hurt or at night pick dry ground
  for (const dy of [-1, -2]) {
    const b = at(bot, S.x, S.y + dy, S.z)
    if (!solid(b) || /bedrock|chest|furnace|table|bed$|door|spawner/.test(b.name) || isLiquid(b)) return `bad_ground_${nm(b)}`
    for (const [dx, dz] of SIDES) { const s = at(bot, S.x + dx, S.y + dy, S.z + dz); if (isLiquid(s)) return `liquid_beside_${nm(s)}` }
  }
  const floor3 = at(bot, S.x, S.y - 3, S.z)
  if (!solid(floor3) || isLiquid(floor3)) return `no_floor_below_${nm(floor3)}`
  // SURV3: digging through sand/gravel is fine (the walls stay), but the cap must not be a falling block: needs 2 safe blocks in the bag (cap + one side)
  if (FALLING.test(nm(at(bot, S.x, S.y - 1, S.z)))) {
    const safe = items(bot).filter((i) => PLACEABLE.test(i.name) && !FALLING.test(i.name)).reduce((n, i) => n + i.count, 0)
    if (safe < 2) return 'falling_block_ground'
  }
  return null
}

/** SURV4: would the dig guard refuse one of the two cells hole_and_cap digs (structure protection: near a bed/door/torch/chest, shell of a room, known place, player-built)? */
export function holeProtectedReason(bot, S, env = {}) {
  for (const dy of [-1, -2]) {
    const b = at(bot, S.x, S.y + dy, S.z)
    const why = builtReason(bot, b) ?? (env.digForbidden?.({ x: S.x, y: S.y + dy, z: S.z }) ? 'protected_area' : null)
    if (why) return `protected_ground_${why}`
  }
  return null
}

/** SURV4: a nearby standable cell where holeSiteRisk and the dig guard both allow the hole (ring search, nearest first). null when none. */
export function findHoleSite(bot, env = {}, maxR = 18) {
  const o = bot.entity.position.floored()
  for (const r of [3, 5, 8, 11, 14, 18]) {
    if (r > maxR) break
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2 + r * 0.41
      const x = Math.floor(o.x + Math.cos(ang) * r), z = Math.floor(o.z + Math.sin(ang) * r)
      const y = standableY(bot, x, z, o.y, 4, 6)
      if (y === null) continue
      const S = V(x, y, z)
      if (holeSiteRisk(bot, S) === null && holeProtectedReason(bot, S, env) === null) return S
    }
  }
  return null
}

export function makeHoleAndCap(env) {
  return {
    name: 'hole_and_cap', max_s: 40, stall_s: 15, stationary: true,
    precondition: ({ bot }) => {
      if (!alive({ bot })) return false
      if (boxedIn(bot)) return { ok: false, reason: 'already_sealed' }
      return true   // SURV4: a bad or protected site is no longer a rejection: run() walks to plain ground or covers herself another way
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.dug ?? 0}:${ctx.state.placed ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, t0 = Date.now()
      await settle(ctx)
      let S0 = feetCell(bot); let S = S0
      // SURV4: observed hole_and_cap failed cannot_dig twice in 134 ms: the dig guard refuses ground within 2 blocks of her bed/door/torches (near_structure). Move to plain ground, else cover another way.
      let risk = holeSiteRisk(bot, S0) ?? holeProtectedReason(bot, S0, env)
      if (risk) {
        ctx.state.stage = 'relocate'; ctx.state.site_risk = risk
        const site = findHoleSite(bot, env)
        if (site) {
          ctx.log?.('hole_relocate', { from: [S0.x, S0.y, S0.z], to: [site.x, site.y, site.z], why: risk })
          const g = await ctx.goto(new goals.GoalBlock(site.x, site.y, site.z), { timeoutMs: 16000 })
          if (ctx.aborted) return { ok: false, reason: 'aborted' }
          await settle(ctx); S0 = feetCell(bot); S = S0
          risk = holeSiteRisk(bot, S0) ?? holeProtectedReason(bot, S0, env)
          if (risk && !g.ok) ctx.state.walk = g.reason
        }
      }
      if (risk) return coverInstead(ctx, env, risk)
      ctx.state.stage = 'dig'
      for (let k = 0; k < 2 && !ctx.aborted && Date.now() - t0 < 25000; k++) {
        const below = at(bot, S.x, S.y - 1, S.z), f2 = at(bot, S.x, S.y - 2, S.z)
        if (!solid(below) || !solid(f2) || isLiquid(f2) || env.digForbidden?.({ x: S.x, y: S.y - 1, z: S.z })) break
        if (!(await digCell(ctx, { x: S.x, y: S.y - 1, z: S.z }))) break
        ctx.state.dug = (ctx.state.dug ?? 0) + 1
        for (let i = 0; i < 14 && bot.entity.position.y > S.y - 0.9 && !ctx.aborted; i++) await ctx.sleep(100)
        S = feetCell(bot)
      }
      if (!ctx.state.dug) return coverInstead(ctx, env, ctx.state.site_risk ?? 'dig_refused')
      ctx.state.stage = 'cap'
      // a side block at cap level first (rests on the ground), then the cap itself against it (same trick as the pillbox)
      for (let pass = 0; pass < 2 && !ctx.aborted; pass++) {
        const side = SIDES.map(([dx, dz]) => ({ x: S.x + dx, y: S.y + 2, z: S.z + dz })).find((c) => solid(at(bot, c.x, c.y - 1, c.z)) || solid(at(bot, c.x, c.y, c.z)))
        for (const c of [side, { x: S.x, y: S.y + 2, z: S.z }].filter(Boolean)) if (await placeAt(bot, c) === true) ctx.state.placed = (ctx.state.placed ?? 0) + 1
        // open walls in the shaft (cave openings) get plugged too
        for (const dy of [0, 1]) for (const [dx, dz] of SIDES) { const c = { x: S.x + dx, y: S.y + dy, z: S.z + dz }; if (!solid(at(bot, c.x, c.y, c.z))) await placeAt(bot, c) }
        if (boxedIn(bot)) break
      }
      const sealed = boxedIn(bot)
      env.holeCap = sealed ? { x: S.x, y: S.y, z: S.z, top: S0.y, t: Date.now() } : env.holeCap
      ctx.state.stage = 'done'
      return sealed ? { ok: true, reason: 'sealed_in_hole', depth: S0.y - S.y, note: 'sealed 2 below ground; leave with exit_hole in the morning' } : { ok: false, reason: ctx.aborted ? 'aborted' : 'not_sealed', depth: S0.y - S.y }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

/** SURV4: the ground cannot be dug here: wall in (or tower up on falling blocks) with whatever she holds; honest reason when she holds nothing usable. */
async function coverInstead(ctx, env, risk) {
  ctx.state.stage = 'cover_instead'
  const m = coverMeans(ctx.bot)
  if (!m.ok) return { ok: false, reason: 'cannot_dig', detail: `${risk}: this ground may not be dug here and no plain ground within 18 m; ${m.blocks} placeable blocks (6 needed for walls)` }
  const r = await emergencyCover(ctx, env, { maxMs: 14000, shield: false })
  ctx.state.placed = r.placed; ctx.state.dug = r.dug
  if (r.ok) return { ok: true, reason: 'sealed_in_cover', mode: r.mode, note: `${risk}: sealed with ${r.mode} instead of a hole` }
  return { ok: false, reason: r.reason === 'aborted' ? 'aborted' : 'not_sealed', detail: `${risk}; walls/cover attempt ${r.mode ?? 'none'} placed ${r.placed}`, placed: r.placed }
}

export function makeExitHole(env) {
  return {
    name: 'exit_hole', max_s: 40, stall_s: 15, stationary: true,
    precondition: ({ bot }) => alive({ bot }) && (placeableCount(items(bot)) >= 1 || boxedIn(bot) ? true : { ok: false, reason: 'no_blocks' }),
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.dug ?? 0}:${Math.round(ctx.bot?.entity?.position?.y ?? 0)}`,
    async run(ctx) {
      const bot = ctx.bot, y0 = bot.entity.position.y
      await settle(ctx)
      const S = feetCell(bot)
      ctx.state.stage = 'open'
      // surface depth: how many solid cells up until open sky/air column
      let up = 0; while (up < 5 && (solid(at(bot, S.x, S.y + 2 + up, S.z)))) up++
      const cap = { x: S.x, y: S.y + 2, z: S.z }
      if (solid(at(bot, cap.x, cap.y, cap.z))) { if (!(await digCell(ctx, cap))) return { ok: false, reason: 'cannot_open_cap' }; ctx.state.dug = 1 }
      const h = env.holeCap, top = h && Math.abs(h.x - S.x) + Math.abs(h.z - S.z) === 0 ? h.top : null
      const need = top !== null ? top - S.y : 2
      if (top !== null) for (const [dx, dz] of SIDES) { const c = { x: S.x + dx, y: top, z: S.z + dz }; const b = at(bot, c.x, c.y, c.z); if (solid(b) && !solid(at(bot, c.x, c.y + 1, c.z)) && PLACEABLE.test(nm(b)) && dist3(bot.entity.position, c) < 4.5) await digCell(ctx, c, 4000) }
      ctx.state.stage = 'climb'
      // short of blocks: mine them from the shaft wall (solid ground only, never next to liquid), they are the blocks that fill the hole when we climb
      for (const dy of [1, 0, 2]) for (const [dx, dz] of SIDES) {
        if (placeableCount(items(bot)) >= need || ctx.aborted) break
        const c = { x: S.x + dx, y: S.y + dy, z: S.z + dz }, b = at(bot, c.x, c.y, c.z)
        if (!solid(b) || !PLACEABLE.test(nm(b)) || [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].some(([a, b2, d]) => isLiquid(at(bot, c.x + a, c.y + b2, c.z + d)))) continue
        if (await digCell(ctx, c, 6000)) await ctx.sleep(500)
      }
      if (placeableCount(items(bot)) < need) return { ok: false, reason: 'not_enough_blocks_to_climb', need, have: placeableCount(items(bot)) }
      const r = await pillarUp(ctx, S, need)
      await ctx.sleep(300)
      const gained = bot.entity.position.y - y0
      if (r.ok || gained >= need - 0.3) { env.holeCap = null; return { ok: true, reason: 'left_hole', gained: +gained.toFixed(1) } }
      return { ok: false, reason: r.reason ?? 'cannot_climb', gained: +gained.toFixed(1) }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ roof_over_me
export const ROOF_BLOCKS = 12   // 3 support column + 9 roof (the column top is one of the 9)
export function makeRoofOverMe(env) {
  return {
    name: 'roof_over_me', max_s: 60, stall_s: 20, stationary: true,
    precondition: ({ bot }) => {
      if (!alive({ bot })) return false
      const have = placeableCount(items(bot)); return have >= ROOF_BLOCKS ? true : { ok: false, reason: 'not_enough_blocks', need: ROOF_BLOCKS, have }
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.placed ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      await settle(ctx)
      const S = feetCell(bot), H = 3
      const roof = []; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) roof.push({ x: S.x + dx, y: S.y + H, z: S.z + dz })
      const clear = roof.filter((c) => solid(at(bot, c.x, c.y, c.z))).length
      if (clear === 9) return { ok: true, reason: 'roof_already_there', placed: 0 }
      // support column on the side with a solid floor and free air for 3 cells
      const col = SIDES.map(([dx, dz]) => ({ x: S.x + dx, z: S.z + dz })).find((c) => solid(at(bot, c.x, S.y - 1, c.z)) && !isLiquid(at(bot, c.x, S.y - 1, c.z)) && [0, 1, 2].every((k) => !solid(at(bot, c.x, S.y + k, c.z))))
        ?? SIDES.map(([dx, dz]) => ({ x: S.x + dx, z: S.z + dz })).find((c) => [0, 1, 2].every((k) => solid(at(bot, c.x, S.y + k, c.z))))   // an existing wall column does as well
      if (!col) return { ok: false, reason: 'no_support_column_site' }
      ctx.state.stage = 'column'
      for (let k = 0; k < H; k++) if (await placeAt(bot, { x: col.x, y: S.y + k, z: col.z }) === true) ctx.state.placed = (ctx.state.placed ?? 0) + 1
      ctx.state.stage = 'roof'
      // roof cells rest on a placed neighbour: sweep until nothing more can be placed
      for (let pass = 0; pass < 6 && !ctx.aborted; pass++) {
        let any = false
        for (const c of roof) {
          if (solid(at(bot, c.x, c.y, c.z))) continue
          if (placeableCount(items(bot)) < 1) return { ok: false, reason: 'ran_out_of_blocks', placed: ctx.state.placed ?? 0 }
          if (await placeAt(bot, c) === true) { any = true; ctx.state.placed = (ctx.state.placed ?? 0) + 1 }
        }
        if (roof.every((c) => solid(at(bot, c.x, c.y, c.z)))) break
        if (!any) break
      }
      const done = roof.filter((c) => solid(at(bot, c.x, c.y, c.z))).length
      ctx.state.stage = 'done'
      return done >= 9 ? { ok: true, reason: 'roofed', placed: ctx.state.placed ?? 0, note: 'roof 3 m above your feet, open at the sides' } : { ok: false, reason: 'roof_incomplete', roof_cells: done, placed: ctx.state.placed ?? 0 }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ torch_perimeter
export function ringPoints(center, radius, spacing) {
  const n = Math.min(12, Math.max(3, Math.round((2 * Math.PI * radius) / spacing)))
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return { x: Math.round(center.x + Math.cos(a) * radius), z: Math.round(center.z + Math.sin(a) * radius) } })
}
export function makeTorchPerimeter(env) {
  return {
    name: 'torch_perimeter', max_s: 120, stall_s: 30,
    precondition: ({ bot, args }) => {
      if (!alive({ bot })) return false
      const have = countItem(bot, 'torch'); return have >= Math.min(3, args.count ?? 6) ? true : { ok: false, reason: 'no_torch', have }
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.placed ?? 0}:${ctx.state.i ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, a = ctx.args
      const lm = a.place ? env.landmarks?.get?.(a.place) : null
      const center = lm && Number.isFinite(lm.x) ? lm : bot.entity.position
      const pts = ringPoints(center, a.radius ?? 6, a.spacing ?? 6).slice(0, a.count ?? 12)
      const before = countItem(bot, 'torch'); let placed = 0, skipped = 0
      ctx.state.stage = 'ring'
      for (let i = 0; i < pts.length && !ctx.aborted; i++) {
        ctx.state.i = i
        if (countItem(bot, 'torch') < 1) break
        const y = standableY(bot, pts[i].x, pts[i].z, Math.round(bot.entity.position.y), 4, 6)
        if (y === null) { skipped++; continue }
        const floor = at(bot, pts[i].x, y - 1, pts[i].z), cell = at(bot, pts[i].x, y, pts[i].z)
        if (!solid(floor) || isLiquid(floor) || !cell || (cell.boundingBox !== 'empty')) { skipped++; continue }
        if (doorKeepout(bot, pts[i].x, y, pts[i].z)) { skipped++; continue }   // HOME2: no torch on a door's walk axis
        const r = await ctx.goto(new goals.GoalNear(pts[i].x, y, pts[i].z, 2), { timeoutMs: 15000 })
        if (!r.ok) { skipped++; continue }
        if (await placeItemAt(bot, { x: pts[i].x, y, z: pts[i].z }, /^torch$/, [[0, -1, 0]])) { placed++; ctx.state.placed = placed } else skipped++
      }
      const used = before - countItem(bot, 'torch')
      ctx.state.stage = 'done'
      return placed >= Math.min(3, pts.length) ? { ok: true, reason: 'torches_placed', placed, skipped, ring: pts.length } : { ok: false, reason: placed ? 'few_torches_placed' : 'no_torch_placed', placed, skipped, used }
    },
  }
}

// ------------------------------------------------------------------ stair_down
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
export function stairStepRisk(bot, x, y, z, dx, dz) {
  // the three cells to clear for a step from feet cell (x,y) to (x+dx, y-1): head (y+1), feet (y), new floor level (y-1); then the cell below must be solid
  const nx = x + dx, nz = z + dz
  for (const yy of [y + 2, y + 1, y, y - 1, y - 2]) {
    const b = at(bot, nx, yy, nz)
    if (!b) return 'unloaded'
    if (isLiquid(b)) return `stopped_${nm(b) === 'lava' ? 'lava' : 'water'}`
    for (const [sx, sz] of SIDES) { if (yy < y - 1 || yy > y + 1) continue; const s = at(bot, nx + sx, yy, nz + sz); if (isLiquid(s)) return `stopped_${nm(s) === 'lava' ? 'lava' : 'water'}_beside` }
  }
  if (FALLING.test(nm(at(bot, nx, y + 2, nz)))) return 'stopped_falling_block_above'
  const under = at(bot, nx, y - 2, nz)
  if (!solid(under)) return 'stopped_air_gap_below'
  if (/bedrock|chest|furnace|table|spawner|door|bed$|obsidian/.test(nm(at(bot, nx, y - 1, nz)))) return `stopped_${nm(at(bot, nx, y - 1, nz))}`
  const ahead = at(bot, nx + dx, y - 1, nz + dz); if (isLiquid(ahead)) return 'stopped_liquid_ahead'
  return null
}
export function makeStairDown(env) {
  return {
    name: 'stair_down', max_s: 240, stall_s: 40, stationary: true,
    precondition: ({ bot, args }) => alive({ bot }) && (bot.entity.position.y > (args.target_y ?? 0) + 0.5 ? true : { ok: false, reason: 'already_there' }),
    progress_fn: (ctx) => `${ctx.state.step ?? 0}:${Math.round(ctx.bot?.entity?.position?.y ?? 0)}`,
    async run(ctx) {
      const bot = ctx.bot, a = ctx.args
      await settle(ctx)
      let dir = DIRS[a.direction] ?? null
      if (!dir) { const yaw = bot.entity.yaw; dir = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? [-Math.sign(Math.sin(yaw)), 0] : [0, -Math.sign(Math.cos(yaw))] }
      const [dx, dz] = dir
      const y0 = bot.entity.position.y, t0 = Date.now()
      const lim = a.max_steps ?? 40
      for (let step = 0; step < lim && !ctx.aborted && Date.now() - t0 < 220000; step++) {
        ctx.state.step = step
        const S = feetCell(bot)
        if (S.y <= a.target_y) return { ok: true, reason: 'reached_target', y: S.y, descended: Math.round(y0 - S.y) }
        const risk = stairStepRisk(bot, S.x, S.y, S.z, dx, dz)
        if (risk) return { ok: Math.round(y0 - S.y) > 0, reason: risk, y: S.y, descended: Math.round(y0 - S.y), note: 'stopped on purpose, did not dig into the unknown' }
        const nx = S.x + dx, nz = S.z + dz
        for (const yy of [S.y + 1, S.y, S.y - 1]) {   // head, feet, new floor level
          if (env.digForbidden?.({ x: nx, y: yy, z: nz })) return { ok: false, reason: 'protected_block', y: S.y }
          if (!(await digCell(ctx, { x: nx, y: yy, z: nz }))) return { ok: false, reason: 'cannot_dig', y: S.y, descended: Math.round(y0 - S.y) }
        }
        const r = await ctx.goto(new goals.GoalBlock(nx, S.y - 1, nz), { timeoutMs: 12000 })
        if (!r.ok) { try { await bot.lookAt(V(nx + 0.5, S.y - 1 + 0.5, nz + 0.5)) } catch { /* ignore */ } bot.setControlState('forward', true); await ctx.sleep(900); bot.setControlState('forward', false) }
        await ctx.sleep(200)
        if (feetCell(bot).y > S.y - 1) return { ok: false, reason: 'cannot_step_down', y: feetCell(bot).y }
      }
      const y = feetCell(bot).y
      return y <= a.target_y ? { ok: true, reason: 'reached_target', y, descended: Math.round(y0 - y) } : { ok: Math.round(y0 - y) > 0, reason: ctx.aborted ? 'aborted' : 'step_limit', y, descended: Math.round(y0 - y) }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging(); ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ farming
const TILLABLE = /^(grass_block|dirt|dirt_path)$/
const SEEDS = /^(wheat_seeds|beetroot_seeds|carrot|potato)$/
const CROP_FOR = { wheat_seeds: 'wheat', beetroot_seeds: 'beetroots', carrot: 'carrots', potato: 'potatoes' }
const MAX_AGE = { wheat: 7, beetroots: 3, carrots: 7, potatoes: 7 }
const seedItem = (bot) => items(bot).find((i) => SEEDS.test(i.name))
export const cropAge = (b) => { try { return b.getProperties?.().age ?? b.metadata ?? 0 } catch { return b.metadata ?? 0 } }
export const cropRipe = (b) => !!b && b.name in MAX_AGE && Number(cropAge(b)) >= MAX_AGE[b.name]

/** best 3x3 plot centre near `from`: all nine tiles tillable with free air above; prefers water within 4 (hydration). */
export function findPlotSite(bot, from, r = 14) {
  const waters = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: 20, count: 400 }) ?? []
  let best = null
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const cx = Math.floor(from.x) + dx, cz = Math.floor(from.z) + dz
    const y = standableY(bot, cx, cz, Math.floor(from.y), 3, 4); if (y === null) continue
    const fy = y - 1; let ok = true, wet = 0
    for (let i = -1; i <= 1 && ok; i++) for (let k = -1; k <= 1 && ok; k++) {
      const f = at(bot, cx + i, fy, cz + k), up = at(bot, cx + i, fy + 1, cz + k)
      if (!f || !TILLABLE.test(f.name) && f.name !== 'farmland') ok = false
      else if (up && !(up.boundingBox === 'empty' && !isLiquid(up))) ok = false
      else if (waters.some((w) => w.y >= fy && w.y <= fy + 1 && Math.abs(w.x - (cx + i)) <= 4 && Math.abs(w.z - (cz + k)) <= 4)) wet++
    }
    if (!ok) continue
    const score = wet * 10 - Math.hypot(dx, dz)
    if (!best || score > best.score) best = { x: cx, y: fy, z: cz, wet, score }
  }
  return best
}

/** RS3: standable cells on the ring (Chebyshev distance 2) around a 3x3 plot whose centre FLOOR block is `c`; never farmland. She works the plot from here (reach 4.5 covers all nine tiles). */
export function ringStands(bot, c) {
  const out = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue
    const x = c.x + dx, z = c.z + dz
    const y = standableY(bot, x, z, c.y + 1, 2, 2); if (y === null) continue
    const floor = at(bot, x, y - 1, z); if (!floor || floor.name === 'farmland') continue
    out.push({ x, y, z })
  }
  return out
}

/** RS3: crops need light 9 at the plant block. Lowest block light (torches) and sky light over the nine plant cells of a plot (site = centre FLOOR block). */
export const CROP_LIGHT = 9
export function plotLight(bot, site) {
  let minBlock = 15, minSky = 15, n = 0
  for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) {
    const b = at(bot, site.x + i, site.y + 1, site.z + k); if (!b) continue
    n++; minBlock = Math.min(minBlock, b.light ?? 0); minSky = Math.min(minSky, b.skyLight ?? 0)
  }
  return n ? { n, minBlock, minSky } : null
}
/** torches beside the plot (the middle of the north / south side lights all nine tiles to >= 10: Manhattan distance <= 4 from a torch 2 off the centre). -> number placed */
export async function torchPlot(bot, site, max = 2) {
  let placed = 0
  for (const dz of [2, -2]) {
    if (placed >= max || !items(bot).some((i) => i.name === 'torch')) break
    const cell = { x: site.x, y: site.y + 1, z: site.z + dz }
    const floor = at(bot, cell.x, cell.y - 1, cell.z); if (!solid(floor) || floor.name === 'farmland') continue
    try { if (await placeItemAt(bot, cell, /^torch$/, [[0, -1, 0]])) placed++ } catch { /* next */ }
  }
  return placed
}
/** honest one-line facts about a finished plot, for the result note */
export function plotNote({ wet, light, torches }) {
  const parts = []
  parts.push(wet >= 9 ? 'all 9 tiles within 4 blocks of water (hydrated)' : wet > 0 ? `only ${wet}/9 tiles within 4 blocks of water: the dry ones grow slowly` : 'no water within 4 blocks: crops grow slowly')
  if (light) parts.push(light.minBlock >= CROP_LIGHT ? `lit by torches (light ${light.minBlock})` : light.minSky >= CROP_LIGHT ? `daylight ${light.minSky} (grows by day${torches ? '' : ', not at night without torches'})` : `dark spot (light ${Math.max(light.minBlock, light.minSky)} < ${CROP_LIGHT}): crops will not grow well`)
  if (torches) parts.push(`${torches} torch${torches === 1 ? '' : 'es'} placed`)
  return parts.join('; ')
}

async function collectSeeds(ctx, need = 1) {
  const bot = ctx.bot, t0 = Date.now()
  const ids = ['short_grass', 'tall_grass', 'grass', 'fern'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
  let tries = 0
  while (!ctx.aborted && countMatch(bot, SEEDS) < need && tries++ < 40 && Date.now() - t0 < 45000) {
    const g = bot.findBlock({ matching: ids, maxDistance: 16 }); if (!g) return false
    const r = await ctx.goto(new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), { timeoutMs: 10000 }); if (!r.ok) continue
    try { await bot.dig(g) } catch { /* next */ }
    await ctx.sleep(250)
    for (const e of Object.values(bot.entities)) if (e.name === 'item' && e.position && dist3(e.position, bot.entity.position) < 6) { try { await ctx.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.8), { timeoutMs: 3000 }) } catch { /* ignore */ } }
  }
  return countMatch(bot, SEEDS) >= need
}

export function makeFarmPlot(env) {
  return {
    name: 'farm_plot', max_s: 180, stall_s: 40,
    precondition: ({ bot }) => alive({ bot }) && (items(bot).some((i) => /_hoe$/.test(i.name)) ? true : { ok: false, reason: 'no_hoe' }),
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.tilled ?? 0}:${ctx.state.planted ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      ctx.state.stage = 'site'
      // FOOD4: the plot belongs near home: from far away walk to the home area first (<= 150 m), then look for a site
      { const home = env.landmarks?.get?.('home'), me0 = bot.entity.position
        if (home && Math.hypot(me0.x - home.x, me0.z - home.z) > 24 && Math.hypot(me0.x - home.x, me0.z - home.z) <= 150) { ctx.state.stage = 'to_home'; await ctx.goto(new goals.GoalNear(home.x, home.y, home.z, 14), { timeoutMs: 60000 }); ctx.state.stage = 'site' } }
      const site = findPlotSite(bot, bot.entity.position)
      if (!site) return { ok: false, reason: 'no_plot_site', note: 'no flat 3x3 of grass or dirt with free air above within 14 m of here' }
      ctx.state.stage = 'seeds'
      if (countMatch(bot, SEEDS) < 1) await collectSeeds(ctx, 9)
      if (countMatch(bot, SEEDS) < 1) return { ok: false, reason: 'no_seeds_found', note: 'no tall grass or fern within 16 m gave seeds (seeds drop from breaking grass about 1 time in 8); nothing was tilled, try a grassy meadow' }
      const stand = { x: site.x + 2, z: site.z }
      const sy = standableY(bot, stand.x, stand.z, site.y + 1, 3, 4)
      const r = await ctx.goto(sy !== null ? new goals.GoalBlock(stand.x, sy, stand.z) : new goals.GoalNear(site.x, site.y + 1, site.z, 3), { timeoutMs: 40000 })
      if (!r.ok) return { ok: false, reason: 'cannot_reach_plot', detail: r.reason }
      ctx.state.stage = 'till'
      const tiles = []; for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) tiles.push({ x: site.x + i, y: site.y, z: site.z + k })
      const hoe = items(bot).find((i) => /_hoe$/.test(i.name)); await bot.equip(hoe, 'hand')
      let tilled = 0
      for (const t of tiles) {
        if (ctx.aborted) break
        let b = at(bot, t.x, t.y, t.z); if (b?.name === 'farmland') { tilled++; continue }
        try { await bot.lookAt(V(t.x + 0.5, t.y + 1, t.z + 0.5)); await bot.activateBlock(b) } catch { /* verify below */ }
        await ctx.sleep(150)
        b = at(bot, t.x, t.y, t.z); if (b?.name === 'farmland') tilled++
      }
      ctx.state.tilled = tilled
      if (tilled < 5) return { ok: false, reason: 'tilling_failed', tilled }
      ctx.state.stage = 'plant'
      let planted = 0
      for (const t of tiles) {
        if (ctx.aborted) break
        const f = at(bot, t.x, t.y, t.z), up = at(bot, t.x, t.y + 1, t.z)
        if (f?.name !== 'farmland') continue
        if (up && up.name in MAX_AGE) { planted++; continue }
        const sd = seedItem(bot); if (!sd) break
        try { await bot.equip(sd, 'hand'); await bot.lookAt(V(t.x + 0.5, t.y + 1, t.z + 0.5)); await bot.activateBlock(f) } catch { /* verify */ }
        await ctx.sleep(150)
        if (at(bot, t.x, t.y + 1, t.z)?.name in MAX_AGE) planted++
      }
      ctx.state.planted = planted
      env.landmarks?.set?.('farm', { x: site.x, y: site.y + 1, z: site.z }, 'place')
      // RS3: light check (crops need 9 at the plant block) and torches beside the plot when the block light is low and she holds some
      ctx.state.stage = 'light'
      let light = plotLight(bot, site), torches = 0
      if (planted >= 1 && light && light.minBlock < CROP_LIGHT) { torches = await torchPlot(bot, site, 2); if (torches) light = plotLight(bot, site) ?? light }
      const note = plotNote({ wet: site.wet, light, torches })
      ctx.log('farm_plot_facts', { wet: site.wet, light, torches, tilled, planted })
      ctx.state.stage = 'done'
      return planted >= 1 ? { ok: true, reason: planted === 9 ? 'plot_planted' : 'plot_partly_planted', tilled, planted, watered: site.wet, hydrated: site.wet, light, torches, note, detail: note } : { ok: false, reason: 'no_seeds', tilled, note: 'plot is tilled; plant it when you have seeds (break tall grass)' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

export function makeFarmHarvest(env) {
  return {
    name: 'farm_harvest', max_s: 120, stall_s: 40,
    precondition: ({ bot }) => alive({ bot }) && (env.landmarks?.get?.('farm') ? true : { ok: false, reason: 'no_farm_known' }),
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.harvested ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, lm = env.landmarks.get('farm')
      ctx.state.stage = 'walk'
      const stands = ringStands(bot, { x: lm.x, y: lm.y - 1, z: lm.z })   // RS3: work the plot from its border; a jump onto farmland tramples it
      if (Math.hypot(bot.entity.position.x - lm.x, bot.entity.position.z - lm.z) > 4) {
        const near = stands.sort((a, b) => dist3(a, bot.entity.position) - dist3(b, bot.entity.position))[0]
        const r = await ctx.goto(near ? new goals.GoalBlock(near.x, near.y, near.z) : new goals.GoalNear(lm.x, lm.y, lm.z, 3), { timeoutMs: 60000 })
        if (!r.ok) return { ok: false, reason: 'cannot_reach_farm', detail: r.reason }
      }
      const ids = Object.keys(MAX_AGE).map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
      const crops = bot.findBlocks({ matching: ids, maxDistance: 8, count: 30 }).map((p) => at(bot, p.x, p.y, p.z)).filter((b) => b && Math.hypot(b.position.x - lm.x, b.position.z - lm.z) <= 4)
      if (!crops.length) return { ok: false, reason: 'no_crops_found' }
      const ripe = crops.filter(cropRipe)
      if (!ripe.length) return { ok: false, reason: 'not_grown', crops: crops.length, note: 'crops are still growing; come back later' }
      ctx.state.stage = 'harvest'
      const before = countMatch(bot, /^(wheat|beetroot|carrot|potato)$/); let harvested = 0, replanted = 0
      for (const c of ripe) {
        if (ctx.aborted) break
        const name = c.name, floor = at(bot, c.position.x, c.position.y - 1, c.position.z)
        if (dist3(bot.entity.position, c.position) > 4.2) {   // RS3: step along the border, never into the plot
          const st = stands.slice().sort((a, b) => dist3(a, c.position) - dist3(b, c.position))[0]
          const r = await ctx.goto(st ? new goals.GoalBlock(st.x, st.y, st.z) : new goals.GoalNear(c.position.x, c.position.y, c.position.z, 3), { timeoutMs: 8000 }); if (!r.ok) continue
        }
        try { await bot.lookAt(V(c.position.x + 0.5, c.position.y + 0.5, c.position.z + 0.5)); await bot.dig(c); harvested++ } catch { continue }
        await ctx.sleep(300)
        for (const e of Object.values(bot.entities)) if (e.name === 'item' && e.position && dist3(e.position, c.position) < 3) { try { await ctx.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.8), { timeoutMs: 3000 }) } catch { /* ignore */ } }
        const sd = items(bot).find((i) => CROP_FOR[i.name] === name)
        if (sd && floor?.name === 'farmland') { try { await bot.equip(sd, 'hand'); await bot.activateBlock(floor); await ctx.sleep(150); if (at(bot, c.position.x, c.position.y, c.position.z)?.name === name) replanted++ } catch { /* ignore */ } }
        ctx.state.harvested = harvested
      }
      const gained = countMatch(bot, /^(wheat|beetroot|carrot|potato)$/) - before
      ctx.state.stage = 'done'
      return harvested ? { ok: true, reason: 'harvested', harvested, replanted, gained } : { ok: false, reason: 'harvest_failed' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ animal_pen
const FENCE = /_fence$/, GATE = /_fence_gate$/
const ANIMAL_FOOD = { cow: /^wheat$/, sheep: /^wheat$/, pig: /^(carrot|potato|beetroot)$/, chicken: /_seeds$/ }
export function penCells(C, size = 5) {
  const r = Math.floor(size / 2), out = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push({ x: C.x + dx, y: C.y, z: C.z + dz, gate: dx === 0 && dz === r })
  return out
}
export function penBlocksNeeded(fences, size = 5) { const n = penCells({ x: 0, y: 0, z: 0 }, size).length - 1; return fences ? n : n * 2 }
export function makeAnimalPen(env) {
  return {
    name: 'animal_pen', max_s: 200, stall_s: 40,
    precondition: ({ bot }) => {
      if (!alive({ bot })) return false
      const f = countMatch(bot, FENCE), b = placeableCount(items(bot)), need = penBlocksNeeded(f >= 15)
      return f >= 15 || b >= need ? true : { ok: false, reason: 'not_enough_fence_or_blocks', fences: f, blocks: b, need }
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.placed ?? 0}:${ctx.state.lured ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      await settle(ctx)
      const C = feetCell(bot), cells = penCells(C)
      // flat site: floor under all 25 tiles, nothing in the way at fence height
      let bad = 0; for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const f = at(bot, C.x + dx, C.y - 1, C.z + dz); if (!solid(f) || isLiquid(f)) bad++ }
      if (bad > 2) return { ok: false, reason: 'site_not_flat', bad }
      const fences = countMatch(bot, FENCE) >= 15, tall = fences ? 1 : 2
      ctx.state.stage = 'fence'
      const mat = fences ? FENCE : PLACEABLE
      for (let pass = 0; pass < 3; pass++) {   // animals standing in a cell block the placement: sweep again
      for (let layer = 0; layer < tall; layer++) for (const c of cells) {
        if (ctx.aborted) break
        if (c.gate) continue
        const cell = { x: c.x, y: c.y + layer, z: c.z }
        if (solid(at(bot, cell.x, cell.y, cell.z))) continue
        if (fences ? await placeItemAt(bot, cell, mat) : await placeAt(bot, cell) === true) ctx.state.placed = (ctx.state.placed ?? 0) + 1
      }
      if (cells.filter((c) => !c.gate).every((c) => solid(at(bot, c.x, c.y, c.z)))) break
      await ctx.sleep(1500)
      }
      const open = cells.filter((c) => !c.gate).some((c) => !solid(at(bot, c.x, c.y, c.z)))
      if (open) return { ok: false, reason: 'fence_incomplete', placed: ctx.state.placed ?? 0 }
      const gate = cells.find((c) => c.gate)
      env.landmarks?.set?.('pen', { x: C.x, y: C.y, z: C.z }, 'place')
      // lure: animals follow a held food item within ~8 m
      ctx.state.stage = 'lure'
      let lured = 0
      const wanted = Object.entries(ANIMAL_FOOD).filter(([, re]) => countMatch(bot, re) > 0).map(([n]) => n)
      if (wanted.length) {
        const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && wanted.includes(e.name) && dist3(e.position, bot.entity.position) < 24).slice(0, 4)
        for (const an of near) {
          if (ctx.aborted) break
          const food = items(bot).find((i) => ANIMAL_FOOD[an.name].test(i.name)); if (!food) continue
          await bot.equip(food, 'hand')
          const t0 = Date.now()
          while (Date.now() - t0 < 40000 && !ctx.aborted) {
            const d = dist3(an.position, bot.entity.position)
            const inside = Math.abs(an.position.x - (C.x + 0.5)) < 2.2 && Math.abs(an.position.z - (C.z + 0.5)) < 2.2
            if (inside) { lured++; break }
            // go toward the animal until it notices (< 6 m), then walk to the pen centre (through the gate gap) so it follows
            const target = d > 6 ? an.position : V(C.x + 0.5, C.y, C.z + 0.5)
            await ctx.goto(new goals.GoalNear(target.x, target.y, target.z, d > 6 ? 4 : 1), { timeoutMs: 6000 })
            try { await bot.lookAt(an.position.offset(0, an.height ?? 1, 0)) } catch { /* ignore */ }
          }
        }
      }
      ctx.state.lured = lured
      // leave through the gate cell and close it
      ctx.state.stage = 'close'
      const out = { x: gate.x, y: gate.y, z: gate.z + 2 }
      await ctx.goto(new goals.GoalNear(out.x, out.y, out.z, 1), { timeoutMs: 15000 })
      let closed = false
      if (items(bot).some((i) => GATE.test(i.name))) closed = await placeItemAt(bot, { x: gate.x, y: gate.y, z: gate.z }, GATE)
      if (!closed) for (let layer = 0; layer < tall; layer++) closed = (fences ? await placeItemAt(bot, { x: gate.x, y: gate.y + layer, z: gate.z }, FENCE) : await placeAt(bot, { x: gate.x, y: gate.y + layer, z: gate.z }) === true) || closed
      ctx.state.stage = 'done'
      return closed ? { ok: true, reason: lured ? 'pen_closed_with_animals' : 'pen_closed_empty', placed: ctx.state.placed ?? 0, lured, note: lured ? undefined : 'no animals lured (hold wheat/seeds/carrots near cows, sheep, chickens, pigs)' } : { ok: false, reason: 'gate_not_closed', placed: ctx.state.placed ?? 0, lured }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

export function makeActivitySkills(env) {
  return [makeHoleAndCap(env), makeExitHole(env), makeRoofOverMe(env), makeTorchPerimeter(env), makeStairDown(env), makeFarmPlot(env), makeFarmHarvest(env), makeAnimalPen(env)]
}
