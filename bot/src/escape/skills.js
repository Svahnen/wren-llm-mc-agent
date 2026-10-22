// Escape-ladder skills: each is a normal T1 skill (progress_fn, max_s, abort, precondition).
// All of them require args.unstuck === true: they are only meant to be run by the escalation ladder (or a
// deliberate caller), never as habits. Digging is only done by dig_up / staircase / cut_web (unstuck mode).
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { settleWithin } from '../util.js'
import { swimToDry } from '../water-policy.js'
import {
  UP, DIRS, feetCell, diagnose, exitDirs, isSolid, isPassable, isLiquid, isLava, isWeb, isGravity, hdist,
  placeableItem, placeableCount, pickaxeItem, cutterItem, safeToDig, findDoors, hazardNear,
  groundBelow, pillarCells, ownPillarHeight,
} from './world.js'

const { goals } = pf
const yawOf = (d) => Math.atan2(-d.x, -d.z)
const unstuck = ({ args }) => args?.unstuck === true
const pre = (...fns) => (c) => fns.every((f) => f(c))
const hasBlocks = ({ bot }) => placeableCount(bot) > 0
const hasPick = ({ bot }) => !!pickaxeItem(bot)
const posKey = (bot) => { const p = bot.entity.position; return `${Math.round(p.x * 2)},${Math.round(p.y * 2)},${Math.round(p.z * 2)}` }
const clearKeys = (bot) => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) bot.setControlState(k, false) }

/** Dirs where moving is not an obvious fall/lava (floor or wall there). */
export function safeDirs(bot) {
  const c = feetCell(bot)
  return DIRS.filter((d) => {
    const a = c.plus(d)
    const near = [bot.blockAt(a), bot.blockAt(a.offset(0, 1, 0))]
    if (near.some((b) => isLiquid(b))) return false
    const below = bot.blockAt(a.offset(0, -1, 0))
    return isSolid(below) || isSolid(bot.blockAt(a))
  })
}

async function walk(ctx, d, ms, { jump = false, sneak = false } = {}) {
  const bot = ctx.bot
  await bot.look(yawOf(d), 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('jump', jump)
  bot.setControlState('sneak', sneak)
  await ctx.sleep(ms)
  clearKeys(bot)
}

async function equip(bot, item) { try { if (bot.heldItem?.type !== item.type) await bot.equip(item, 'hand') } catch { /* ignore */ } }

async function digBlock(ctx, b, tool, ms = 9000) {
  const bot = ctx.bot
  if (tool) await equip(bot, tool)
  await landed(ctx, 1500) // VAL2: digging while airborne takes 5x longer (the 6th stair block of a live pit timed out at 20 s): stand first
  const r = await settleWithin(bot.dig(b, true), ms)
  if (r.timedOut) { try { bot.stopDigging() } catch { /* ignore */ } return false }
  return !r.error
}

/** ARB1: best-effort wooden pickaxe from what she holds (logs/planks): planks -> table (placed in the stairwell wall cell) -> sticks -> pickaxe. Never throws. */
async function tryCraftPickaxe(ctx) {
  const bot = ctx.bot
  const dbg = (step, extra = {}) => { try { ctx.log?.('craft_pickaxe', { step, ...extra }); if (process.env.S2_DEBUG) console.log('craft_pickaxe', step, JSON.stringify(extra)) } catch { /* ignore */ } }
  try {
    const cnt = (re) => bot.inventory.items().filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0)
    const craft = async (name, n, table = null) => {
      const id = bot.registry.itemsByName[name]?.id; if (id == null) return false
      const rec = bot.recipesFor(id, null, 1, table)[0]; if (!rec) { dbg('no_recipe', { name, table: !!table }); return false }
      await bot.craft(rec, n, table ?? undefined); await ctx.sleep(150); dbg('crafted', { name }); return true
    }
    const have = () => cnt(/_planks$/)
    // logs -> planks (4 per log). The inventory counts lag a moment behind a craft: wait for the rise before deciding again.
    for (let i = 0; i < 4 && have() < 9 && bot.inventory.items().some((x) => /_log$/.test(x.name)); i++) {
      const log = bot.inventory.items().find((x) => /_log$/.test(x.name)), before = have()
      if (!await craft(log.name.replace('_log', '_planks'), 1)) break
      for (let k = 0; k < 10 && have() <= before; k++) await ctx.sleep(100)
    }
    const hasTable = !!bot.findBlock?.({ matching: (b) => b.name === 'crafting_table', maxDistance: 4 })
    const stickPlanks = cnt(/^stick$/) >= 2 ? 0 : 2
    if (have() < (hasTable ? 3 : 4) + stickPlanks + (hasTable ? 0 : 0)) { dbg('not_enough_planks', { planks: have() }); return false }
    if (cnt(/^stick$/) < 2) { const sb = cnt(/^stick$/); await craft('stick', 1); for (let k = 0; k < 10 && cnt(/^stick$/) <= sb; k++) await ctx.sleep(100) }
    let table = bot.findBlock?.({ matching: (b) => b.name === 'crafting_table', maxDistance: 4 })
    if (!table) {
      if (!await craft('crafting_table', 1)) return false
      const item = bot.inventory.items().find((i) => i.name === 'crafting_table'); if (!item) { dbg('no_table_item'); return false }
      // VAL2: the old code tried to put the table into her OWN cell (always refused in a 1x1 pit). Use a free neighbour cell with a floor; in a
      // closed shaft first dig one wall block at feet level (by hand, the softest), then put the table there.
      const c = feetCell(bot)
      const spot = () => DIRS.find((d) => !isSolid(bot.blockAt(c.plus(d))) && !isLiquid(bot.blockAt(c.plus(d))) && isSolid(bot.blockAt(c.plus(d).offset(0, -1, 0))))
      let d = spot()
      if (!d) {
        const wall = DIRS.filter((x) => isSolid(bot.blockAt(c.plus(x))) && safeToDig(bot, bot.blockAt(c.plus(x)))).sort((a, b) => (bot.blockAt(c.plus(a)).hardness ?? 9) - (bot.blockAt(c.plus(b)).hardness ?? 9))[0]
        if (!wall) { dbg('no_wall_to_dig'); return false }
        if (!await digBlock(ctx, bot.blockAt(c.plus(wall)), null, 20000)) { dbg('wall_dig_failed'); return false }
        d = spot(); if (!d) { dbg('no_spot_after_dig'); return false }
      }
      await bot.equip(item, 'hand')
      await settleWithin(bot.placeBlock(bot.blockAt(c.plus(d).offset(0, -1, 0)), new Vec3(0, 1, 0)).catch(() => {}), 1500)
      table = bot.findBlock?.({ matching: (b) => b.name === 'crafting_table', maxDistance: 4 })
      if (!table) { dbg('table_not_found'); return false }
    }
    const plank = bot.inventory.items().find((i) => /_planks$/.test(i.name))?.name.replace('_planks', '') ?? 'oak'
    await craft('wooden_pickaxe', 1, table)
    dbg('done', { pickaxe: !!pickaxeItem(bot) })
    return !!pickaxeItem(bot)
  } catch (e) { dbg('exception', { msg: String(e?.message).slice(0, 120) }); return false }
}

/** One jump + place block under feet. Returns true if the block under the old feet cell is now solid. */
async function pillarOnce(ctx) {
  const bot = ctx.bot
  const item = placeableItem(bot)
  if (!item) return false
  await equip(bot, item)
  await landed(ctx)
  const base = feetCell(bot)
  const ref = bot.blockAt(base.offset(0, -1, 0))
  if (!isSolid(ref)) return false
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  bot.setControlState('jump', true)
  const t0 = Date.now()
  let placing = false
  while (!ctx.aborted && Date.now() - t0 < 1400 && !isSolid(bot.blockAt(base))) {
    if (!placing && bot.entity.position.y >= base.y + 1.02) {
      placing = true
      settleWithin(bot.placeBlock(ref, UP), 1200).then(() => { placing = false })
    }
    await ctx.sleep(15)
  }
  bot.setControlState('jump', false)
  const t1 = Date.now()
  while (!ctx.aborted && !bot.entity.onGround && Date.now() - t1 < 800) await ctx.sleep(30)
  await ctx.sleep(80)
  const ok = isSolid(bot.blockAt(base))
  if (ok) { const cells = pillarCells(bot); cells.push({ x: base.x, y: base.y, z: base.z }); if (cells.length > 200) cells.splice(0, cells.length - 200) }
  return ok
}

/** Max height a pillar-up may gain (and the max own pillar under the feet). Taller = a column she cannot leave (observed case). */
export const MAX_PILLAR = 6
/** Pillar-up is for pits / ceilings / hazards: needs solid walls around (>= 2 of 4 neighbours at feet level) or liquid, and room under the cap. */
export function pillarAllowed(bot) {
  const d = diagnose(bot)
  if (d.elevated || ownPillarHeight(bot) >= MAX_PILLAR) return false
  if (d.ceilingSolid && d.ceilingDy <= 2) return false   // HYG1/FOOD2: (also in water: the observed ceiling failures were in water under a roof) a roof right over the head (own cover, cave): pillar_up failed 'ceiling' 4x; dig_up / staircase / wall-out are the rungs there
  if (d.inWater || d.inLava) return true
  const walls = DIRS.filter((dir) => isSolid(bot.blockAt(d.cell.plus(dir))) || isSolid(bot.blockAt(d.cell.plus(dir).offset(0, 1, 0)))).length
  return walls >= 2
}

async function landed(ctx, ms = 1200) {
  const t0 = Date.now()
  while (!ctx.aborted && !ctx.bot.entity.onGround && Date.now() - t0 < ms) await ctx.sleep(30)
}

async function walkOut(ctx, dirs) {
  const bot = ctx.bot
  const start = bot.entity.position.clone()
  for (const d of dirs.slice(0, 2)) {
    await walk(ctx, d, 1100, { jump: true })
    if (hdist(bot.entity.position, start) >= 2) return true
  }
  return hdist(bot.entity.position, start) >= 2
}

const skill = (o) => ({ stall_s: 10, ...o, precondition: pre(unstuck, o.precondition ?? (() => true)) })

export function makeEscapeSkills({ getHome = () => null } = {}) {
  const S = []

  S.push(skill({
    name: 'unstuck_nudge', max_s: 8, stall_s: 6,
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot, start = bot.entity.position.clone()
      const gap = diagnose(bot).gapAround
      // VAL2 (PB3 analysis: 152 of 161 failed): random directions cancelled each other and safeDirs counted WALL cells as moves. Use only
      // really walkable directions, never reverse the previous push, and give up at once when boxed in (the next rung can do something).
      const open = exitDirs(bot).filter((d) => safeDirs(bot).some((s) => s.equals(d)))
      if (!open.length) {
        bot.setControlState('jump', true); await ctx.sleep(300); clearKeys(bot)
        return { ok: false, reason: 'boxed_in' }
      }
      let prev = null
      for (let i = 0; i < 3 && !ctx.aborted; i++) {
        const cand = open.filter((d) => !prev || d.x + prev.x !== 0 || d.z + prev.z !== 0)
        const pool = cand.length ? cand : open
        const d = pool[Math.floor(Math.random() * pool.length)]
        prev = d
        await walk(ctx, d, gap ? 400 : 800, { jump: !gap, sneak: gap })
        if (hdist(bot.entity.position, start) >= 0.8) break
      }
      return hdist(bot.entity.position, start) >= 0.8 ? { ok: true } : { ok: false, reason: 'no_movement' }
    },
  }))

  S.push(skill({
    name: 'unstuck_move_away', max_s: 25, stall_s: 10,
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot, start = bot.entity.position.clone()
      if (!bot.pathfinder) return { ok: false, reason: 'no_pathfinder' }
      const base = Math.random() * Math.PI * 2
      for (let i = 0; i < 4 && !ctx.aborted; i++) {
        const a = base + (i * Math.PI) / 2, r = 5 + Math.random() * 2
        await ctx.goto(new goals.GoalNearXZ(start.x + Math.cos(a) * r, start.z + Math.sin(a) * r, 1), { timeoutMs: 5000 })
        if (hdist(bot.entity.position, start) >= 4) return { ok: true }
      }
      return { ok: false, reason: 'no_path_away' }
    },
  }))

  S.push(skill({
    name: 'escape_jump_spam', max_s: 8, stall_s: 8,
    precondition: ({ bot }) => !diagnose(bot).gapAround && !diagnose(bot).inLava,
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot, start = bot.entity.position.clone()
      const dirs = DIRS
      const t0 = Date.now()
      for (let i = 0; !ctx.aborted && Date.now() - t0 < 4000; i++) {
        await walk(ctx, dirs[i % 4], 650, { jump: true })
        await landed(ctx)
        const p = bot.entity.position
        if (hdist(p, start) >= 2.5 || (p.y - start.y >= 0.9 && bot.entity.onGround)) return { ok: true }
      }
      return { ok: false, reason: 'no_effect' }
    },
  }))

  S.push(skill({
    name: 'escape_place_under', max_s: 10, stall_s: 8, precondition: hasBlocks,
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot
      for (let i = 0; i < 3 && !ctx.aborted; i++) {
        const y0 = bot.entity.position.y
        if (await pillarOnce(ctx)) {
          const ex = exitDirs(bot)
          if (ex.length && await walkOut(ctx, ex)) return { ok: true }
          return bot.entity.position.y - y0 >= 0.8 ? { ok: true, reason: 'gained_height' } : { ok: false, reason: 'no_height' }
        }
      }
      return { ok: false, reason: 'place_failed' }
    },
  }))

  S.push(skill({
    name: 'escape_pillar_up', max_s: 45, stall_s: 9, precondition: pre(hasBlocks, ({ bot }) => pillarAllowed(bot)),
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot, y0 = bot.entity.position.y
      const h0 = ownPillarHeight(bot)
      let fails = 0
      for (let i = 0; i < 14 && !ctx.aborted; i++) {
        if (bot.entity.position.y - y0 >= MAX_PILLAR || ownPillarHeight(bot) >= MAX_PILLAR) return { ok: false, reason: 'height_cap' }
        const ex = exitDirs(bot)
        if (ex.length && !diagnose(bot).inWater) { if (await walkOut(ctx, ex)) return { ok: true } }
        const c = feetCell(bot)
        if (isSolid(bot.blockAt(c.offset(0, 2, 0)))) return { ok: false, reason: 'ceiling' }
        if (await pillarOnce(ctx)) { fails = 0; ctx.progress() } else if (++fails >= 3) return { ok: false, reason: bot.inventory.items().length ? 'place_failed' : 'no_blocks' }
      }
      return bot.entity.position.y - y0 >= 1 ? { ok: true, reason: 'gained_height' } : { ok: false, reason: 'no_height' }
    },
  }))

  S.push(skill({
    name: 'escape_descend', max_s: 180, stall_s: 25,
    precondition: ({ bot }) => { const d = diagnose(bot); return d.exits.length === 0 && !d.inWater && !d.inLava && groundBelow(bot, d.cell).dir !== null && groundBelow(bot, d.cell).drop >= 1 },
    progress_fn: (c) => `${c.state.dug ?? 0}:${posKey(c.bot)}`,
    async run(ctx) {
      const bot = ctx.bot, tool = pickaxeItem(bot), y0 = bot.entity.position.y
      ctx.state.dug = 0
      for (let i = 0; i < 45 && !ctx.aborted; i++) {
        await landed(ctx)
        const d = diagnose(bot)
        if (d.inWater || d.inLava) return bot.entity.position.y < y0 - 0.5 ? { ok: true, reason: 'into_water' } : { ok: false, reason: 'in_liquid' }
        if (d.exits.length > 0 && !d.elevated) return bot.entity.position.y < y0 - 0.5 ? { ok: true } : { ok: false, reason: 'not_on_column' }
        const gb = groundBelow(bot, d.cell)
        if (!gb.dir) return { ok: false, reason: 'no_open_side' }
        // fall of <= 3 blocks onto solid ground / water: just step off (never lava or void)
        if (gb.drop <= 3 && (gb.landing === 'solid' || gb.landing === 'water')) {
          const y1 = bot.entity.position.y
          await bot.look(yawOf(gb.dir), 0, true)
          bot.setControlState('forward', true)
          const t0 = Date.now()
          while (!ctx.aborted && Date.now() - t0 < 2500 && bot.entity.position.y > y1 - 0.3) await ctx.sleep(40) // D1: release 'forward' the moment she is off the edge (holding it while falling carried her past the landing cell)
          clearKeys(bot)
          await landed(ctx, 2500)
          return bot.entity.position.y < y1 - 0.8 ? { ok: true, reason: 'stepped_off' } : { ok: false, reason: 'step_off_failed' }
        }
        // otherwise mine the block under the feet; we drop one block. Never into lava, never if more than 3 would open under us.
        const f = d.cell, under = bot.blockAt(f.offset(0, -1, 0))
        if (!isSolid(under)) { await ctx.sleep(200); continue }
        let fall = 0, hit = null
        for (let k = 2; k <= 6; k++) {
          const b = bot.blockAt(f.offset(0, -k, 0))
          if (isLava(b)) return { ok: false, reason: 'lava_below' }
          if (!b || (b.boundingBox === 'empty' && !isLiquid(b))) { fall++; continue }
          hit = b; break
        }
        if (fall > 3) return { ok: false, reason: 'floating_platform' }
        if (hit && isLava(hit)) return { ok: false, reason: 'lava_below' }
        if (DIRS.some((dir) => isLava(bot.blockAt(f.offset(0, -1, 0).plus(dir))) || isLava(bot.blockAt(f.offset(0, -2, 0).plus(dir))))) return { ok: false, reason: 'lava_adjacent' }
        if (!await digBlock(ctx, under, tool, 20000)) return { ok: false, reason: 'dig_failed' }
        ctx.state.dug++
        ctx.progress()
        const cells = pillarCells(bot), at = cells.findIndex((c) => c.x === under.position.x && c.y === under.position.y && c.z === under.position.z)
        if (at >= 0) cells.splice(at, 1)
        await ctx.sleep(150)
      }
      return { ok: false, reason: 'too_many_steps' }
    },
    abort: (r, ctx) => clearKeys(ctx.bot),
  }))

  S.push(skill({
    name: 'escape_dig_up', max_s: 40, stall_s: 14, precondition: hasPick,
    progress_fn: (c) => `${c.state.dug ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, tool = pickaxeItem(bot)
      ctx.state.dug = 0
      for (let i = 0; i < 8 && !ctx.aborted; i++) {
        const c = feetCell(bot)
        let target = null
        for (let dy = 2; dy <= 4; dy++) { const b = bot.blockAt(c.offset(0, dy, 0)); if (isSolid(b)) { target = b; break } }
        if (!target) return ctx.state.dug ? { ok: true } : { ok: false, reason: 'no_ceiling' }
        if (!safeToDig(bot, target)) return { ok: false, reason: 'unsafe_to_dig' }
        if (!await digBlock(ctx, target, tool)) return { ok: false, reason: 'dig_failed' }
        ctx.state.dug++
      }
      return { ok: true }
    },
  }))

  S.push(skill({
    name: 'escape_staircase', max_s: 240, stall_s: 24, // ARB1: no pickaxe needed any more (hand-dig, slow on stone): the last resort in a pit without blocks/tools
    progress_fn: (c) => `${c.state.dug ?? 0}:${posKey(c.bot)}`,
    run: (ctx) => staircaseUp(ctx),
  }))

  // ARB1: the same staircase as a choosable activity (no unstuck flag): tunnel a stairwell upward when stuck in a hole without blocks to pillar
  S.push({
    name: 'dig_stairs_up', max_s: 240, stall_s: 24,
    precondition: ({ bot }) => { if (!bot?.entity || bot.health <= 0) return false; const d = diagnose(bot); return d.inWater || d.inLava ? { ok: false, reason: 'liquid' } : true },
    progress_fn: (c) => `${c.state.dug ?? 0}:${posKey(c.bot)}`,
    run: (ctx) => staircaseUp(ctx),
  })

  async function staircaseUp(ctx) {
    {
      const bot = ctx.bot
      ctx.state.dug = 0
      if (!pickaxeItem(bot)) await tryCraftPickaxe(ctx)   // best effort: wooden pickaxe from logs/planks; otherwise bare hands
      const tool = pickaxeItem(bot)
      let dir = null
      for (let step = 0; step < 40 && !ctx.aborted; step++) {
        const ex = exitDirs(bot)
        if (ex.length && !diagnose(bot).inWater) return (await walkOut(ctx, ex)) ? { ok: true } : { ok: false, reason: 'walkout_failed' }
        const c = feetCell(bot)
        const volume = (d) => [c.offset(0, 2, 0), c.plus(d).offset(0, 1, 0), c.plus(d).offset(0, 2, 0)]
        const cost = (d) => {
          if (!isSolid(bot.blockAt(c.plus(d)))) return 999 // no floor to step onto
          let n = 0
          for (const v of volume(d)) { const b = bot.blockAt(v); if (isSolid(b)) { n += safeToDig(bot, b) ? 1 : 100 } else if (isLiquid(b) || isWeb(b)) n += 100 }
          return n
        }
        if (!dir || cost(dir) >= 100) dir = [...DIRS].sort((a, b) => cost(a) - cost(b))[0]
        if (cost(dir) >= 100) return { ok: false, reason: 'no_safe_direction' }
        for (const v of volume(dir)) {
          const b = bot.blockAt(v)
          if (isSolid(b)) { if (!await digBlock(ctx, b, tool, tool ? 9000 : 30000)) return { ok: false, reason: 'dig_failed' }; ctx.state.dug++ }
        }
        const target = c.plus(dir).offset(0, 1, 0)
        const t0 = Date.now()
        await bot.look(yawOf(dir), 0, true)
        bot.setControlState('forward', true)
        while (!ctx.aborted && Date.now() - t0 < 1800) {
          bot.setControlState('jump', bot.entity.onGround)
          const f = feetCell(bot)
          if (f.x === target.x && f.z === target.z && f.y >= target.y) break
          await ctx.sleep(40)
        }
        clearKeys(bot)
        await ctx.sleep(120)
      }
      return { ok: false, reason: 'too_many_steps' }
    }
  }

  S.push(skill({
    name: 'escape_swim', max_s: 30, stall_s: 12,
    precondition: ({ bot }) => diagnose(bot).inWater,
    progress_fn: (c) => posKey(c.bot),
    async run(ctx) {
      const bot = ctx.bot
      const t0 = Date.now()
      // WATER1: first action = the shortest swim to the nearest dry standable block (surface route), not a ledge guess one cell around
      for (let k = 0; k < 3 && !ctx.aborted && diagnose(bot).inWater; k++) {
        const s = await swimToDry(ctx)
        ctx.log?.('swim_to_dry', { ok: s.ok, reason: s.reason ?? null, steps: s.steps ?? 0 })
        if (s.ok) break
        if (s.reason === 'no_dry_land' || s.reason === 'aborted') break
      }
      while (!ctx.aborted && Date.now() - t0 < 20000) {
        const dg = diagnose(bot)
        if (!dg.inWater && bot.entity.onGround) { clearKeys(bot); return { ok: true } }
        const c = dg.cell
        // prefer a ledge or shore we can reach from the surface
        let best = null
        for (const d of DIRS) for (let dy = 0; dy <= 1 && !best; dy++) {
          const a = c.plus(d).offset(0, dy, 0)
          if (isSolid(bot.blockAt(a)) && isPassable(bot.blockAt(a.offset(0, 1, 0))) && isPassable(bot.blockAt(a.offset(0, 2, 0)))) best = d
          else if (dy === 0 && isPassable(bot.blockAt(a)) && isSolid(bot.blockAt(a.offset(0, -1, 0)))) best = d
        }
        if (best) await bot.look(yawOf(best), 0, true)
        bot.setControlState('jump', true)
        bot.setControlState('forward', !!best)
        await ctx.sleep(120)
      }
      clearKeys(bot)
      return { ok: false, reason: 'still_in_water' }
    },
    abort: (r, ctx) => clearKeys(ctx.bot),
  }))

  S.push(skill({
    name: 'escape_open_door', max_s: 14, stall_s: 9,
    precondition: ({ bot }) => findDoors(bot, 4.6, { includeOpen: true }).length > 0,
    progress_fn: (c) => `${c.state.opened ?? 0}:${posKey(c.bot)}`,
    // B1: open the nearest door/gate and WALK THROUGH it (never dig the wall); the door opener closes it again behind her.
    async run(ctx) {
      const bot = ctx.bot
      ctx.state.opened = 0
      try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }   // HOME2: no stale path goal steering against the hand-driven walk
      const start = bot.entity.position.clone()
      for (let b of findDoors(bot, 4.6, { includeOpen: true }).slice(0, 3)) {
        if (ctx.aborted) break
        // HOME2: the door sits BESIDE us on the side of its walk axis (a niche / pillbox next to the doorway). Opening it would swing the leaf across that side entrance
        // (observed blocked_beyond_door 4x, repro on the clone 5/5): a CLOSED leaf only fills the edge strip of its cell. Align to the cell centre on the door axis, step in, leave along the axis.
        {
          const f0 = feetCell(bot), ddx = b.position.x - f0.x, ddz = b.position.z - f0.z
          const fc = b.getProperties?.().facing
          const axX = fc === 'east' || fc === 'west'
          if (fc && Math.abs(ddx) + Math.abs(ddz) === 1 && (axX ? ddz !== 0 : ddx !== 0) && b.getProperties?.().open === true && b.getProperties?.().powered !== true) {
            // an OPEN leaf stands across the side entrance: close it again first (the door opener may have swung it open as she turned towards it)
            try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b) } catch { /* ignore */ }
            await ctx.sleep(350)
            b = bot.blockAt(b.position) ?? b
          }
          if (fc && Math.abs(ddx) + Math.abs(ddz) === 1 && (axX ? ddz !== 0 : ddx !== 0) && b.getProperties?.().open !== true) {
            const free = (v) => isPassable(bot.blockAt(v)) && isPassable(bot.blockAt(v.offset(0, 1, 0)))
            const cell = b.position
            const sides = axX ? [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)] : [new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
            const outDir = sides.map((d) => ({ d, n: [1, 2, 3].filter((k) => free(cell.plus(d.scaled(k)))).length })).sort((p, q) => q.n - p.n)[0]
            if (process.env.HOME2_DEBUG) console.log('side-entry', cell.toString(), 'out', outDir.d.toString(), outDir.n, 'pos', bot.entity.position.toString())
            if (outDir.n >= 1) {
              const along = () => (axX ? bot.entity.position.x - (cell.x + 0.5) : bot.entity.position.z - (cell.z + 0.5))
              const alongDir = axX ? new Vec3(-Math.sign(along()) || 1, 0, 0) : new Vec3(0, 0, -Math.sign(along()) || 1)
              const t0 = Date.now()
              bot.setControlState('sneak', true)
              while (!ctx.aborted && Date.now() - t0 < 2500 && Math.abs(along()) > 0.07) {   // 1. centre on the door axis inside our own cell
                await bot.look(yawOf(new Vec3(axX ? -Math.sign(along()) : 0, 0, axX ? 0 : -Math.sign(along()))), 0, true)
                bot.setControlState('forward', true); await ctx.sleep(30); bot.setControlState('forward', false); await ctx.sleep(40)
              }
              clearKeys(bot)
              const into = new Vec3(Math.sign(ddx), 0, Math.sign(ddz))
              await bot.look(yawOf(into), 0, true)   // 2. into the door cell
              bot.setControlState('forward', true)
              const t1 = Date.now()
              while (!ctx.aborted && Date.now() - t1 < 1800 && Math.abs((axX ? bot.entity.position.z - (cell.z + 0.5) : bot.entity.position.x - (cell.x + 0.5))) > 0.3) await ctx.sleep(30)
              clearKeys(bot)
              if (process.env.HOME2_DEBUG) console.log('in door cell?', bot.entity.position.toString())
              await bot.look(yawOf(outDir.d), 0, true)   // 3. out along the axis
              bot.setControlState('forward', true)
              const t2 = Date.now(), p0 = bot.entity.position.clone()
              let dbg = 0
              while (!ctx.aborted && Date.now() - t2 < 3500 && hdist(bot.entity.position, p0) < 2.6) { await ctx.sleep(40); if (process.env.HOME2_DEBUG && dbg++ % 12 === 0) console.log('  step3', bot.entity.position.toString(), bot.entity.onGround, bot.blockAt(cell)?.getProperties?.().open, 'yaw', bot.entity.yaw.toFixed(2), 'ahead', bot.blockAt(cell.plus(outDir.d))?.name, bot.blockAt(cell.plus(outDir.d).offset(0,1,0))?.name) }
              clearKeys(bot)
              if (hdist(bot.entity.position, start) >= 2) return { ok: true }
              ctx.state.opened = Math.max(ctx.state.opened, 1)
              continue
            }
          }
        }
        const wasOpen = b.getProperties?.().open === true
        if (!wasOpen) {
          try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b) } catch { continue }
          await ctx.sleep(300)
          if (bot.blockAt(b.position)?.getProperties?.().open !== true) continue
        }
        ctx.state.opened++
        // walk through: dominant axis from our feet cell to the door cell, then 3 cells beyond it
        const f = feetCell(bot)
        const dx = b.position.x - f.x, dz = b.position.z - f.z
        const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1)
        const steps = Math.max(Math.abs(dx), Math.abs(dz)) + 3
        await bot.look(yawOf(dir), 0, true)
        bot.setControlState('forward', true)
        const t0 = Date.now()
        while (!ctx.aborted && Date.now() - t0 < 700 * steps && hdist(bot.entity.position, start) < steps - 0.2) await ctx.sleep(40)
        clearKeys(bot)
        if (hdist(bot.entity.position, start) >= 2) return { ok: true }
      }
      return ctx.state.opened ? { ok: false, reason: 'blocked_beyond_door' } : { ok: false, reason: 'not_opened' }
    },
    abort: (r, ctx) => clearKeys(ctx.bot),
  }))

  S.push(skill({
    name: 'escape_cut_web', max_s: 60, stall_s: 15,
    precondition: ({ bot }) => diagnose(bot).inWeb,
    progress_fn: (c) => `${c.state.cut ?? 0}:${posKey(c.bot)}`,
    async run(ctx) {
      const bot = ctx.bot, tool = cutterItem(bot)
      ctx.state.cut = 0
      const webOf = (v) => (isWeb(bot.blockAt(v)) ? 1 : 0) + (isWeb(bot.blockAt(v.offset(0, 1, 0))) ? 1 : 0)
      const ok = (v) => { const f = bot.blockAt(v), h = bot.blockAt(v.offset(0, 1, 0)); return (isPassable(f) || isWeb(f)) && (isPassable(h) || isWeb(h)) && isSolid(bot.blockAt(v.offset(0, -1, 0))) }
      const start = feetCell(bot)
      // Dijkstra over cells within radius 8, web cells cost 4 extra
      const key = (v) => `${v.x},${v.y},${v.z}`
      const dist = new Map([[key(start), 0]]), prev = new Map(), open = [start]
      let goal = null
      while (open.length) {
        open.sort((a, b) => dist.get(key(a)) - dist.get(key(b)))
        const u = open.shift()
        if (u !== start && !webOf(u) && DIRS.every((d) => !webOf(u.plus(d)))) { goal = u; break }
        for (const d of DIRS) {
          const v = u.plus(d)
          if (Math.abs(v.x - start.x) > 8 || Math.abs(v.z - start.z) > 8 || !ok(v)) continue
          const nd = dist.get(key(u)) + 1 + 4 * webOf(v)
          if (nd < (dist.get(key(v)) ?? Infinity)) { dist.set(key(v), nd); prev.set(key(v), u); open.push(v) }
        }
      }
      if (!goal) return { ok: false, reason: 'no_web_route' }
      const path = []
      for (let v = goal; v && key(v) !== key(start); v = prev.get(key(v))) path.unshift(v)
      for (const n of path) {
        if (ctx.aborted) break
        for (const v of [feetCell(bot), feetCell(bot).offset(0, 1, 0), n, n.offset(0, 1, 0)]) {
          const b = bot.blockAt(v)
          if (isWeb(b)) { if (!await digBlock(ctx, b, tool)) return { ok: false, reason: 'cut_failed' }; ctx.state.cut++ }
        }
        const t0 = Date.now()
        await bot.look(yawOf(n.minus(feetCell(bot))), 0, true)
        bot.setControlState('forward', true)
        while (!ctx.aborted && Date.now() - t0 < 3000) { const f = feetCell(bot); if (f.x === n.x && f.z === n.z) break; await ctx.sleep(40) }
        clearKeys(bot)
      }
      return { ok: true }
    },
    abort: (r, ctx) => clearKeys(ctx.bot),
  }))

  S.push(skill({
    name: 'escape_bridge', max_s: 45, stall_s: 10, precondition: hasBlocks,
    progress_fn: (c) => `${c.state.placed ?? 0}:${posKey(c.bot)}`,
    async run(ctx) {
      const bot = ctx.bot
      ctx.state.placed = 0
      const c0 = feetCell(bot)
      const gapLen = (d) => { // gap cells (liquid/void) crossed from our own ground to the far shore; 99 = none
        let gap = 0
        for (let k = 1; k <= 12; k++) {
          const f = c0.plus(d.scaled(k)).offset(0, -1, 0)
          if (isSolid(bot.blockAt(f))) {
            if (!gap) continue // still on our own ground
            return isPassable(bot.blockAt(f.offset(0, 1, 0))) && isPassable(bot.blockAt(f.offset(0, 2, 0))) ? gap : 99
          }
          gap++
        }
        return 99
      }
      const dir = [...DIRS].sort((a, b) => gapLen(a) - gapLen(b)).find((d) => { const g = gapLen(d); return g >= 1 && g <= 9 })
      if (!dir) return { ok: false, reason: 'no_far_shore' }
      const item = placeableItem(bot)
      await equip(bot, item)
      const stepTo = async (next) => {
        const t0 = Date.now()
        await bot.look(yawOf(dir), 0, true)
        bot.setControlState('sneak', true); bot.setControlState('forward', true)
        while (!ctx.aborted && Date.now() - t0 < 2500) { const f = feetCell(bot); if (f.x === next.x && f.z === next.z) break; await ctx.sleep(30) }
        clearKeys(bot); await ctx.sleep(80)
        const f = feetCell(bot); return f.x === next.x && f.z === next.z
      }
      let extra = 0
      for (let i = 0; i < 24 && !ctx.aborted; i++) {
        const c = feetCell(bot)
        const nf = c.plus(dir).offset(0, -1, 0)
        if (isSolid(bot.blockAt(nf))) {
          if (!await stepTo(c.plus(dir))) return { ok: false, reason: 'step_failed' }
          if (!hazardNear(bot, 2) || ++extra > 6) return { ok: true }
          continue
        }
        const ref = bot.blockAt(c.offset(0, -1, 0))
        if (!isSolid(ref)) return { ok: false, reason: 'no_support' }
        await settleWithin(bot.placeBlock(ref, dir), 1500)
        if (!isSolid(bot.blockAt(nf))) return { ok: false, reason: 'place_failed' }
        ctx.state.placed++
        ctx.progress()
      }
      return { ok: false, reason: 'bridge_too_long' }
    },
    abort: (r, ctx) => clearKeys(ctx.bot),
  }))

  S.push(skill({
    name: 'unstuck_go_home', max_s: 120, stall_s: 25,
    progress_fn: (c) => c.state.best ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const h = ctx.args.home ?? getHome(bot)
      if (!h) return { ok: false, reason: 'no_home' }
      if (!bot.pathfinder) return { ok: false, reason: 'no_pathfinder' }
      const dist = () => Math.round(Math.hypot(bot.entity.position.x - h.x, bot.entity.position.z - h.z))
      ctx.state.best = dist()
      const track = setInterval(() => { try { const d = dist(); if (d < ctx.state.best) ctx.state.best = d } catch { /* gone */ } }, 500)
      try {
        const r = await ctx.goto(new goals.GoalNearXZ(h.x, h.z, 3), { timeoutMs: 100000 })
        return dist() <= 6 ? { ok: true } : { ok: false, reason: r.ok ? 'not_reached' : r.reason }
      } finally { clearInterval(track) }
    },
  }))

  return S
}

/** Ordered candidate list for the escape rung, from the live situation. */
export function planEscape(bot) {
  const d = diagnose(bot)
  const blocks = placeableCount(bot) > 0, pick = !!pickaxeItem(bot)
  const c = []
  if (d.inWater) c.push('escape_swim') // WATER1: in water the first rung is always the swim to dry land (before doors / bridging / staircases)
  if (d.elevated) c.push('escape_descend') // L2: on a column / ledge high above the ground: come down before anything else
  if (d.doors.length) c.push('escape_open_door')
  if (d.inWeb) c.push('escape_cut_web')
  if (!d.gapAround && !d.inLava) c.push('escape_jump_spam')
  if (d.gapAround && (d.exits.length === 0 || d.enclosed) && blocks) c.push('escape_bridge')
  if (blocks && !d.elevated) c.push('escape_place_under')
  if (d.ceilingSolid && pick) c.push('escape_dig_up')
  if (blocks && pillarAllowed(bot)) c.push('escape_pillar_up')
  c.push('escape_staircase')   // ARB1: also without a pickaxe (hand-dig): the last resort
  if (!d.elevated && d.exits.length === 0 && !d.inWater && !d.inLava && groundBelow(bot, d.cell).drop >= 1) c.push('escape_descend') // low column: step off
  return { cands: c, diag: d }
}

export function registerEscapeSkills(runner, opts) {
  for (const s of makeEscapeSkills(opts)) if (!runner.skills.has(s.name)) runner.register(s)
}
export { Vec3 }
