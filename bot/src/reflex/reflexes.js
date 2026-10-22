// The reflexes. Each: { name, priority, critical, cooldownMs, failCooldownMs, maxMs, check(env) -> info|null, run(ctx, info) -> {ok,reason} }
//   env = { bot, danger, cfg, now, state, rng }   ctx = env + { signal, sleep(ms)->bool, log(type,f), engine }
// check() must be cheap and side-effect free. run() must honour ctx.signal and return within maxMs (the engine enforces it
// and always clears control states and releases the body afterwards).
import { Vec3 } from 'vec3'
import { foodForbidden, EMERGENCY_OK } from '../foodguard.js'
import { HARD, DIRS, isPassable, isSolid, isWater, isLava } from './danger.js'
import { search, walkPath, cellOf, inLiquidAt } from './nav.js'
import { assess, bestWeapon, hostilesAround, FIST } from './threats.js'
import { emergencyCover, coverMeans, hitNearby, onTower } from '../skills/shelter.js'
import { sealedWithLeak, plugLeaks } from '../skills/leak.js'
import { rangedCover } from './ranged-cover.js'
import { findFarShore, swimToward, openWaterAround } from '../water-policy.js'

const ok = (reason = 'done', extra = {}) => ({ ok: true, reason, ...extra })
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra })
const eyePos = (bot) => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
const hasItem = (bot, name) => (bot.inventory?.items?.() ?? []).find((i) => i.name === name)
const landOk = (danger, c) => isSolid(danger.blockAt(c.x, c.y - 1, c.z)) && !isWater(danger.blockAt(c.x, c.y, c.z)) && !isWater(danger.blockAt(c.x, c.y + 1, c.z))
const HARD_BLOCKS = new Set(['fire', 'soul_fire', 'cactus', 'campfire', 'soul_campfire', 'magma_block'])

function headBlock(bot, danger) { const p = bot.entity.position; return danger.blockAt(Math.floor(p.x), Math.floor(p.y + (bot.entity.eyeHeight ?? 1.62)), Math.floor(p.z)) }
function isBurning(bot) { const m = bot.entity?.metadata?.[0]; return typeof m === 'number' && (m & 1) === 1 }
// L1: the entity flag is not always reliable (live: the flag read false while hp fell 1/s for 6 s after leaving lava). Within FIRE_MEMORY_MS of a
// lava/fire exposure, hp falling with no hostile close counts as burning too.
const FIRE_MEMORY_MS = 20000
function burningNow(bot, state, now) {
  if (isBurning(bot)) return true
  if (!(now() - (state.fireAt ?? -Infinity) < FIRE_MEMORY_MS)) return false
  if (!(now() - (state.lastDamageAt ?? -Infinity) < 1500)) return false
  if (bot.entity?.isInWater) return false
  return hostilesAround(bot, 6).length === 0
}

async function useBucketDown(ctx, name) {
  const { bot } = ctx
  const it = hasItem(bot, name)
  if (!it) return false
  try {
    await bot.equip(it, 'hand')
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.activateItem()
    await ctx.sleep(300)
    bot.deactivateItem?.()
    return true
  } catch { return false }
}

// ---------------------------------------------------------------- lava / fire / magma / cactus
export const lavaFire = {
  name: 'lava_fire', priority: 100, critical: true, cooldownMs: 300, failCooldownMs: 800, maxMs: 15000,
  check({ bot, danger, state, now }) {
    const c = cellOf(bot.entity.position)
    const w = inLiquidAt(danger, c)
    if (w.lava || bot.entity.isInLava) return { kind: 'lava', cell: c }
    const feet = danger.blockAt(c.x, c.y, c.z), head = danger.blockAt(c.x, c.y + 1, c.z), below = danger.blockAt(c.x, c.y - 1, c.z)
    for (const b of [feet, head, below]) if (b && HARD_BLOCKS.has(b.name) && (b !== below || b.name === 'magma_block' || b.name.includes('campfire'))) {
      if (b === below && (bot.controlState?.sneak)) continue
      return { kind: `block:${b.name}`, cell: c }
    }
    if (burningNow(bot, state, now) && !bot.entity.isInWater && !(state.burnQuietUntil > now())) return { kind: 'burning', cell: c }
    return null
  },
  async run(ctx, info) {
    const { bot, danger } = ctx
    const start = cellOf(bot.entity.position)
    const inLava = info.kind === 'lava'
    let bucket = false
    let res = null
    ctx.state.fireAt = ctx.now()
    if (info.kind === 'burning') { // already out of the fire: put the flames out (water within ~8 blocks, bucket) and keep the body until they are gone
      ctx.log('lava_fire_plan', { kind: 'burning', bucket: !!hasItem(bot, 'water_bucket'), steps: null })
      const r = await extinguish(ctx)
      return r.out ? ok('extinguished', { ms: r.ms, water: r.water }) : fail('still_burning')
    }
    res ??= search(danger, start, (c, i) => landOk(danger, c) && i.cost < 5, { lavaOk: inLava, maxNodes: 1200, maxCost: inLava ? 90 : 40 })
    res ??= search(danger, start, (c, i) => landOk(danger, c) && i.cost < HARD, { lavaOk: inLava, maxNodes: 1200, maxCost: inLava ? 90 : 40 })
    // In lava every 100 ms costs ~1 heart: walk out when the exit is 1-2 cells away; the bucket (~1 s) only pays off for longer ways.
    const shortWay = inLava && res && res.path.length <= 2
    if ((inLava || info.kind === 'burning') && hasItem(bot, 'water_bucket') && !shortWay && !(res && info.kind === 'burning' && res.path.length === 0)) bucket = await useBucketDown(ctx, 'water_bucket')
    if (ctx.signal.aborted) return fail('aborted')
    ctx.log('lava_fire_plan', { kind: info.kind, bucket, steps: res?.path.length ?? null })
    if (bucket) { // water at the feet: lava source -> obsidian, flames out; then take the water back
      for (let i = 0; i < 8 && !ctx.signal.aborted; i++) { await ctx.sleep(100); if (!bot.entity.isInLava && !isBurning(bot)) break }
      if (!bot.entity.isInLava && !isBurning(bot)) { await ctx.sleep(150); await pickupWater(ctx, start); return ok('bucket', { kind: info.kind }) }
    }
    if (!res) {
      if (inLava) { // nothing reachable: at least keep rising so we do not sink, then report
        bot.setControlState('jump', true)
        await ctx.sleep(1500)
      }
      return fail('no_safe_cell')
    }
    const w = await walkPath(ctx, res.path, { stepMs: inLava ? 3000 : 2200 })
    if (!w.ok) return fail(`walk_${w.reason}`)
    // L1: still burning on dry land. The reflex stays in charge (no skill, no eat) until the fire is out: water within 8 blocks, bucket, else wait.
    ctx.state.fireAt = ctx.now()
    if (burningNow(bot, ctx.state, ctx.now)) await extinguish(ctx)
    if (bucket) await pickupWater(ctx, start)
    const c = cellOf(bot.entity.position)
    return inLiquidAt(danger, c).lava ? fail('still_in_lava') : ok('escaped', { to: [res.goal.x, res.goal.y, res.goal.z] })
  },
}

/** Stay in charge until no longer burning. Water (any, within ~8 blocks) > bucket > wait. Bounded (12 s). */
async function extinguish(ctx, { maxMs = 12000 } = {}) {
  const { bot, danger } = ctx
  const t0 = ctx.now()
  let walks = 0, water = false, bucketTried = false
  while (!ctx.signal.aborted && ctx.now() - t0 < maxMs) {
    const here = cellOf(bot.entity.position)
    const wet = inLiquidAt(danger, here).water || bot.entity.isInWater
    if (wet) water = true
    if (!burningNow(bot, ctx.state, ctx.now) && !(wet && isBurning(bot))) break
    if (wet) { await ctx.sleep(150); continue } // the water puts it out within a tick or two
    if (!bucketTried && hasItem(bot, 'water_bucket')) { bucketTried = true; if (await useBucketDown(ctx, 'water_bucket')) { water = true; await ctx.sleep(200); if (!burningNow(bot, ctx.state, ctx.now)) { await pickupWater(ctx, here); break } continue } }
    if (walks < 3) {
      const res = search(danger, here, (c) => isWater(danger.blockAt(c.x, c.y, c.z)) && danger.costAt(c) < HARD, { maxNodes: 700, maxCost: 16 })
      if (res && res.path.length) { walks++; ctx.log('burn_to_water', { steps: res.path.length }); const w = await walkPath(ctx, res.path, { sprint: true, stepMs: 2500 }); if (w.ok) { water = true; await ctx.sleep(100) }; continue }
    }
    await ctx.sleep(200) // nothing to extinguish with: stand on safe ground (burning ends by itself) and keep every other skill off the body
  }
  const out = !burningNow(bot, ctx.state, ctx.now)
  if (!out) ctx.state.burnQuietUntil = ctx.now() + 1000 // re-enter at once, but not on the same tick
  return { out, ms: ctx.now() - t0, water }
}

async function pickupWater(ctx, near) {
  const { bot, danger } = ctx
  try {
    const empty = hasItem(bot, 'bucket')
    if (!empty) return
    for (let dy = -1; dy <= 1; dy++) for (const [dx, dz] of [[0, 0], ...DIRS]) {
      const b = danger.blockAt(near.x + dx, near.y + dy, near.z + dz)
      if (b?.name === 'water' && b.metadata === 0 && bot.entity.position.distanceTo(b.position) < 4.5) {
        await bot.equip(empty, 'hand')
        await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true)
        bot.activateItem(); await ctx.sleep(250); bot.deactivateItem?.()
        return
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------- suffocation
export const suffocation = {
  name: 'suffocation', priority: 95, critical: true, cooldownMs: 400, failCooldownMs: 1500, maxMs: 12000,
  check({ bot, danger }) {
    const h = headBlock(bot, danger)
    if (h && h.boundingBox === 'block' && !h.transparent && !isLiquid(h)) return { block: h.name }
    return null
  },
  async run(ctx) {
    ctx.bot.__suffocating = true // B1: only this reflex may dig through built blocks (never doors) to stay alive
    try { return await suffocationRun(ctx) } finally { ctx.bot.__suffocating = false }
  },
}
async function suffocationRun(ctx) {
    const { bot, danger } = ctx
    let dug = 0
    for (let i = 0; i < 6 && !ctx.signal.aborted; i++) {
      const h = headBlock(bot, danger)
      if (!(h && h.boundingBox === 'block' && !h.transparent)) break
      // do not open a roof into lava/water
      const above = danger.blockAt(h.position.x, h.position.y + 1, h.position.z)
      if (isLava(above) || (isWater(above) && i === 0 && false)) {
        // try a side block instead
        const side = DIRS.map(([dx, dz]) => danger.blockAt(h.position.x + dx, h.position.y, h.position.z + dz)).find((b) => b && b.boundingBox === 'block' && !isLava(danger.blockAt(b.position.x, b.position.y + 1, b.position.z)))
        if (!side) return fail('only_lava_above')
        await digSafe(ctx, side); dug++; continue
      }
      if (!(await digSafe(ctx, h))) return fail('dig_failed', { block: h.name })
      dug++
      await ctx.sleep(120)
    }
    const feet = danger.blockAt(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z))
    if (feet && feet.boundingBox === 'block' && !feet.transparent) { if (await digSafe(ctx, feet)) dug++ }
    const h2 = headBlock(bot, danger)
    return h2 && h2.boundingBox === 'block' && !h2.transparent ? fail('still_inside') : ok('freed', { dug })
}
function isLiquid(b) { return isWater(b) || isLava(b) }
async function digSafe(ctx, block) {
  const { bot } = ctx
  try {
    if (bot.canDigBlock && !bot.canDigBlock(block)) return false
    const tool = bot.pathfinder?.bestHarvestTool?.(block)
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    await bot.dig(block, true)
    return true
  } catch { return false }
}

// ---------------------------------------------------------------- falling block overhead
export const fallingBlock = {
  name: 'falling_block', priority: 92, critical: true, cooldownMs: 600, failCooldownMs: 1000, maxMs: 4000,
  check({ bot }) {
    const me = bot.entity.position
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e || e.name !== 'falling_block' || !e.position) continue
      const dy = e.position.y - me.y
      if (Math.hypot(e.position.x - me.x, e.position.z - me.z) < 1.2 && dy > 0.5 && dy < 12) return { x: e.position.x, z: e.position.z }
    }
    return null
  },
  async run(ctx, info) {
    const { bot, danger } = ctx
    const start = cellOf(bot.entity.position)
    const res = search(danger, start, (c, i) => landOk(danger, c) && i.cost < HARD && Math.hypot(c.x + 0.5 - info.x, c.z + 0.5 - info.z) >= 2, { maxNodes: 120, maxCost: 6 })
    if (!res) return fail('no_cell')
    const w = await walkPath(ctx, res.path, { stepMs: 1200 })
    return w.ok ? ok('stepped_aside') : fail(`walk_${w.reason}`)
  },
}

// ---------------------------------------------------------------- D1: water bucket landing (MLG, simple and safe)
// Only with a water_bucket in the inventory and when the fall is long (> MLG_MIN_FALL blocks so far): look down, place the water when the
// ground is within reach, pick it up again after landing. Never on lava below (water would not help), never without the bucket.
export const MLG_MIN_FALL = 8
export const mlg = {
  name: 'mlg', priority: 96, critical: true, cooldownMs: 1500, failCooldownMs: 1500, maxMs: 8000,
  check({ bot, state }) {
    const e = bot.entity, st = (state.mlg ??= { top: null })
    if (!e || e.onGround || e.isInWater || e.isInLava) { st.top = null; return null }
    const y = e.position.y
    if (st.top === null || y > st.top) st.top = y
    if (!(e.velocity?.y < -0.5)) return null
    const fallen = st.top - y
    if (fallen < MLG_MIN_FALL) return null
    if (!bot.inventory?.items?.().some((i) => i.name === 'water_bucket')) return null
    return { fallen: +fallen.toFixed(1) }
  },
  async run(ctx, info) {
    const { bot } = ctx
    const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket')
    if (!bucket) return fail('no_bucket')
    try { await bot.equip(bucket, 'hand') } catch { return fail('equip_failed') }
    let placed = false
    for (let i = 0; i < 100 && !ctx.signal.aborted; i++) {
      const e = bot.entity
      if (e.onGround || e.isInWater) break
      try { await bot.look(e.yaw, -Math.PI / 2, true) } catch { /* ignore */ }
      const tgt = bot.blockAtCursor?.(4.2)
      if (tgt && tgt.name !== 'water' && tgt.name !== 'lava') { try { bot.activateItem(); placed = true } catch { /* ignore */ } break }
      if (!(await ctx.sleep(30))) break
    }
    await ctx.sleep(600)
    // pick the water up again (the bucket is empty now)
    const empty = bot.inventory.items().find((i) => i.name === 'bucket')
    if (placed && empty) {
      try { await bot.equip(empty, 'hand'); await bot.look(bot.entity.yaw, -Math.PI / 2, true); await ctx.sleep(150); const w = bot.blockAtCursor?.(4.2); if (w && w.name === 'water') bot.activateItem() } catch { /* ignore */ }
    }
    return placed ? ok('mlg', { fallen: info.fallen }) : fail('no_ground_in_reach')
  },
}

// ---------------------------------------------------------------- drowning
export const drowning = {
  name: 'drowning', priority: 90, critical: true, cooldownMs: 300, failCooldownMs: 1500, maxMs: 25000,
  check({ bot, danger, cfg }) {
    if (!isWater(headBlock(bot, danger))) return null
    const o = bot.oxygenLevel ?? 20
    return o < cfg.drownAir ? { oxygen: o } : null
  },
  async run(ctx) {
    const { bot, danger } = ctx
    // STUCK3: walled in except for a water source in the wall (dug a pit at a pond edge): swimming is pointless, cut the leak off and let the cell drain
    try {
      if (sealedWithLeak(bot)) {
        const r = await plugLeaks(bot, { sleep: (ms) => ctx.sleep(ms) })
        ctx.log('leak_plugged', r)
        if (r.plugged && r.dry) return ok('leak_plugged', r)
      }
    } catch (e) { ctx.log('leak_plug_error', { message: String(e?.message).slice(0, 100) }) }
    const start = cellOf(bot.entity.position)
    const res = search(danger, start, (c, i) => landOk(danger, c) && i.cost < HARD, { maxNodes: 1500, maxCost: 60 })
    if (res) {
      ctx.log('drowning_plan', { steps: res.path.length, goal: [res.goal.x, res.goal.y, res.goal.z] })
      const w = await walkPath(ctx, res.path, { sprint: false, stepMs: 4000 })
      if (w.ok) return ok('out_of_water')
      ctx.log('drowning_walk_failed', w)
    }
    // no exit (or walking failed): own swim-up. Hold jump until the head is in air, then tread water.
    const t0 = Date.now()
    while (!ctx.signal.aborted && Date.now() - t0 < 12000) {
      bot.setControlState('jump', true)
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      if (!(await ctx.sleep(100))) break
      if (!isWater(headBlock(bot, danger)) && (bot.oxygenLevel ?? 20) >= 8) {
        const again = search(danger, cellOf(bot.entity.position), (c, i) => landOk(danger, c) && i.cost < HARD, { maxNodes: 1500, maxCost: 60 })
        if (again) { const w = await walkPath(ctx, again.path, { sprint: false, stepMs: 4000 }); if (w.ok) return ok('out_of_water') }
        // NIGHT2: open water, no shore within the local search (example: 11 min at 100,61,100, 20x20 blocks of water): swim straight to the nearest loaded far shore instead of treading
        if (!again) {
          const far = openWaterAround(bot) ? findFarShore(bot) : null
          if (far) {
            ctx.log('drowning_far_shore', { x: far.x, y: far.y, z: far.z, r: far.r })
            const sw = await swimToward(ctx, far, { maxMs: 7000 })
            if (sw.ok) return ok('out_of_water', { far: true })
            if (sw.reason === 'aborted') return fail('aborted')
            if (sw.reason !== 'stalled') return fail('swimming_to_far_shore', { left: Math.round(sw.left ?? 0) })
          }
        }
        // surfaced but boxed in: WATER1: the head is in air, so the body goes back to its owner at once (observed: 3 s holds x52 in 10 min starved forage/hunt/move_to).
        // Tread only while the head would dip again (a deep column); standing in shallow water with the head out is not a drowning case.
        const t1 = Date.now()
        bot.setControlState('jump', false)
        while (!ctx.signal.aborted && Date.now() - t1 < 1200) { if (isWater(headBlock(bot, danger))) { bot.setControlState('jump', true) } else bot.setControlState('jump', false); if (!(await ctx.sleep(150))) break }
        bot.setControlState('jump', false)
        return fail('surfaced_no_exit')
      }
    }
    return fail('could_not_surface')
  },
}

// ---------------------------------------------------------------- fleeing / shelter
async function fleeFrom(ctx, { maxMs = 9000, safeDist = 14, only = null } = {}) {
  const { bot, danger } = ctx
  const t0 = Date.now()
  let moved = 0
  while (!ctx.signal.aborted && Date.now() - t0 < maxMs) {
    let th = hostilesAround(bot, 24).filter((t) => !t.prof.neutral)
    if (only) th = th.filter(only)
    if (!th.length || th[0].d >= safeDist) return ok('clear', { moved })
    const start = cellOf(bot.entity.position)
    const res = search(danger, start, null, {
      maxNodes: 500, maxCost: 16,
      pick: (c, g) => {
        if (!landOk(danger, c)) return null
        let md = Infinity
        for (const t of th) md = Math.min(md, Math.hypot(c.x + 0.5 - t.e.position.x, c.z + 0.5 - t.e.position.z))
        return md - 0.2 * g
      },
    })
    if (!res || !res.path.length) return fail('cornered')
    const w = await walkPath(ctx, res.path.slice(0, 5), { stepMs: 1500 })
    moved += res.path.slice(0, 5).length
    if (!w.ok && w.reason === 'aborted') return fail('aborted')
    if (!w.ok) await ctx.sleep(80)
  }
  return fail('timeout')
}

const SHELTER_BAD = new Set(['sand', 'red_sand', 'gravel', 'tnt', 'chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'crafting_table', 'torch', 'lava_bucket', 'water_bucket', 'bedrock'])
export function placeableBlock(bot) {
  const prefer = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks', 'birch_planks']
  const items = bot.inventory?.items?.() ?? []
  const count = (n) => items.filter((i) => i.name === n).reduce((s, i) => s + i.count, 0)
  for (const n of prefer) if (count(n) >= 8) return items.find((i) => i.name === n)
  const reg = bot.registry?.blocksByName
  if (!reg) return null
  return items.find((i) => reg[i.name]?.boundingBox === 'block' && !SHELTER_BAD.has(i.name) && !i.name.endsWith('_ore') && count(i.name) >= 8) ?? null
}

async function placeAt(ctx, refBlock, face) {
  try { await ctx.bot.placeBlock(refBlock, face); return true } catch { return false }
}

async function buildShelter(ctx) {
  const { bot, danger } = ctx
  const item = placeableBlock(bot)
  if (!item) return fail('no_blocks')
  await bot.equip(item, 'hand')
  const c = cellOf(bot.entity.position)
  // centre on the cell
  await walkPath(ctx, [c], { sprint: false, stepMs: 800 })
  let placed = 0
  for (const [dx, dz] of DIRS) {
    if (ctx.signal.aborted) return fail('aborted')
    const feetCell = { x: c.x + dx, y: c.y, z: c.z + dz }
    if (!isPassable(danger.blockAt(feetCell.x, feetCell.y, feetCell.z))) { placed += 2; continue }
    const floor = danger.blockAt(feetCell.x, feetCell.y - 1, feetCell.z)
    if (!isSolid(floor)) return fail('no_floor_reference')
    if (!(await placeAt(ctx, floor, new Vec3(0, 1, 0)))) return fail('place_failed')
    placed++
    const wall = danger.blockAt(feetCell.x, feetCell.y, feetCell.z)
    if (isSolid(wall)) {
      if (isPassable(danger.blockAt(feetCell.x, feetCell.y + 1, feetCell.z)) && await placeAt(ctx, wall, new Vec3(0, 1, 0))) placed++
    }
  }
  return ok('built', { placed })
}

export async function shelterAndHeal(ctx, why) {
  const { bot, cfg, state } = ctx
  const wasSealed = isSealed(bot, ctx.danger) // an already sealed shelter (habit pillbox) is not ours to open
  const b = await buildShelter(ctx)
  ctx.log('shelter', { why, ...b })
  if (!b.ok) return b
  state.sheltered = true
  const until = Date.now() + cfg.shelterMaxMs * (0.8 + 0.4 * ctx.rng())
  let breached = false
  try {
    let lastHp = bot.health ?? 20
    while (!ctx.signal.aborted && Date.now() < until && (bot.health ?? 20) < cfg.shelterHealTo) {
      // SURV3 (observed: a zombie at the corner of the 4-wall shelter kept hitting her; she waited. Hit back at what is in reach.
      const hurt = (bot.health ?? 20) < lastHp; lastHp = bot.health ?? 20
      const near = hostilesAround(bot, 4).filter((t) => !t.prof.neutral && !t.prof.creeper)
      if (near.length && (hurt || near[0].d <= 3)) { breached = true; if (await hitNearby(ctx, () => ctx.signal.aborted)) continue }
      await eatIfNeeded(ctx, ctx.cfg.eatBelow)
      if (!(await ctx.sleep(500))) break
    }
    // leave through the first wall block (collected again). SURV3: NEVER when aborted (a higher reflex took over: digging the wall open for several seconds with a zombie outside is fatal),
    // nor with a hostile near or while still hurt.
    const c = cellOf(bot.entity.position)
    const unsafeOut = ctx.signal.aborted || breached || (bot.health ?? 20) < 10 || hostilesAround(bot, 16).some((t) => !t.prof.neutral)
    for (const [dx, dz] of wasSealed || unsafeOut ? [] : DIRS) {
      const w = ctx.danger.blockAt(c.x + dx, c.y, c.z)
      if (isSolid(w) && w.name !== 'bedrock') { await digSafe(ctx, w); const h = ctx.danger.blockAt(c.x + dx, c.y + 1, c.z); if (isSolid(h)) await digSafe(ctx, h); break }
    }
  } finally { state.sheltered = false }
  return ok('sheltered', { hp: bot.health })
}

export const lowHealthFlee = {
  name: 'low_health_flee', priority: 80, critical: false, cooldownMs: 1200, failCooldownMs: 1500, maxMs: 70000,
  check({ bot, cfg, state, now, danger }) {
    if (state.lastStand && now() - state.lastStand < 30000) return null // budget spent: fight to the end
    const a = assess(bot, cfg)
    if (a.decision !== 'flee') return null
    if ((bot.health ?? 20) <= (cfg.coverHealth ?? 6) && coverMeans(bot).ok && !isSealed(bot, danger) && !a.fleeClass.length) return null   // SURV2: low_hp_cover seals her in instead of running
    // Q1: sealed in a pillbox, nothing but a creeper blast can reach us. Fleeing from a sealed cell is 'cornered' at once, then
    // shelterAndHeal dug the wall open and the shelter habit re-sealed it: 6 preemptions in 12 s on the real Wren, skeleton outside.
    if (isSealed(bot, danger) && !a.creepers.some((t) => t.d <= 5)) return null
    if (onTower(bot, (x, y, z) => danger.blockAt(x, y, z)) && !a.creepers.some((t) => t.d <= 5) && !hostilesAround(bot, 24).some((t) => t.prof.ranged)) return null   // SURV4: on her own pillar melee mobs cannot reach her; running down into them is worse
    return { reason: a.reason, nearest: a.all[0]?.name }
  },
  async run(ctx, info) {
    const { cfg, state, now } = ctx
    const log = (state.fleeLog ??= [])
    while (log.length && now() - log[0] > cfg.fleeBudget.windowMs) log.shift()
    if (log.length >= cfg.fleeBudget.max) {
      ctx.log('disengage_budget_exhausted', { count: log.length })
      if (placeableBlock(ctx.bot)) { const r = await shelterAndHeal(ctx, 'budget'); if (r.ok) return r }
      state.lastStand = now() // let mob_defense fight to the end
      return fail('budget_exhausted_last_stand')
    }
    log.push(now())
    const r = await fleeFrom(ctx, { maxMs: 9000 })
    if (!r.ok && r.reason === 'cornered' && placeableBlock(ctx.bot)) return shelterAndHeal(ctx, 'cornered')
    if (r.ok && (ctx.bot.health ?? 20) <= cfg.fleeHealth && placeableBlock(ctx.bot)) return shelterAndHeal(ctx, 'recover')
    return r
  },
}

// ---------------------------------------------------------------- SURV2: nearly dead + something hostile in range = seal in, fast
// VAL2 live: hp 4 and a skeleton at 15 m was dead in ~8 s (2 of 2): running in the open is shot in the back, the 10-block pillbox is too slow. This reflex goes first:
// one block column toward the shooter, then dig two down and cap (pit) or the pillbox, then eat inside until the hearts are back. Needs blocks (>= 6) or a pick/shovel.
export const lowHpCover = {
  name: 'low_hp_cover', priority: 85, critical: false, cooldownMs: 5000, failCooldownMs: 6000, maxMs: 75000,
  check({ bot, cfg, state, now, danger, engine }) {
    if ((bot.health ?? 20) > (cfg.coverHealth ?? 6) || bot.health <= 0 || bot.isSleeping) return null
    if (isSealed(bot, danger)) return null
    if (onTower(bot, (x, y, z) => danger.blockAt(x, y, z)) && !hostilesAround(bot, 24).some((t) => t.prof.ranged)) return null   // SURV4: already on her pillar
    if (state.lastStand && now() - state.lastStand < 30000) return null
    const th = hostilesAround(bot, 24).filter((t) => !t.prof.neutral && !t.prof.creeper && (t.prof.ranged ? t.d <= 24 : t.d <= 12))
    if (!th.length) return null
    if (!coverMeans(bot).ok) return null
    if (engine?.arbiter?.holder?.label === 'dig_in' && (th[0].prof.ranged || th[0].d > 9)) return null   // habit dig_in is already doing it (ranged: no hurry); a melee mob close by: take over, the reflex also fights off whatever stands in the cap cell
    return { nearest: th[0].name, d: +th[0].d.toFixed(1), ranged: !!th[0].prof.ranged, n: th.length }
  },
  async run(ctx, info) {
    const { bot, cfg } = ctx
    const r = await emergencyCover(ctx, {}, { maxMs: 14000 })
    ctx.log('low_hp_cover', { ...info, ...r })
    if (!r.ok) return fail(r.reason, { mode: r.mode })
    // sealed: eat (also risky food when hurt) and wait for the hearts, but never longer than shelterMaxMs
    const until = Date.now() + (cfg.shelterMaxMs ?? 60000) * (0.8 + 0.4 * ctx.rng())
    let quiet = 0
    while (!ctx.signal.aborted && Date.now() < until && (bot.health ?? 20) < (cfg.shelterHealTo ?? 16)) {
      // SURV3: a mob that drops into an open-top pit or hits over a corner is hit back (live: sealed 3-deep sand pit, zombie fell in, she ate and died)
      const adj = hostilesAround(bot, 4).filter((t) => !t.prof.neutral && !t.prof.creeper && t.d <= 3.4)
      if (adj.length && await hitNearby(ctx, () => ctx.signal.aborted)) continue
      if ((bot.food ?? 20) < 18) await eatIfNeeded(ctx, 17)
      if (!(await ctx.sleep(500))) break
      quiet = hostilesAround(bot, 24).some((t) => !t.prof.neutral) ? 0 : quiet + 0.5
      if (quiet >= 8 && (bot.health ?? 20) >= 10) break
    }
    return ok('covered', { hp: bot.health, mode: r.mode })
  },
}

// ---------------------------------------------------------------- SURV5: trident drowned = keep away from the water edge
// observed death 52: hp 12 -> 2 and 'impaled by Drowned' at ~9 m; the drowned was classed melee, so nothing kept her off the shore. A trident
// drowned (ranged 8 dmg, stays in the water) is left behind: walk until the nearest water is >= 16 m away and the thrower >= 26 m (or out of sight).
export const WATER_EDGE_M = 16
export const waterWithin = (bot, r) => { try { const ids = ['water'].map((n) => bot.registry?.blocksByName?.[n]?.id).filter((x) => x !== undefined); return ids.length ? !!bot.findBlock?.({ matching: ids, maxDistance: r }) : false } catch { return false } }
export const tridentShooters = (bot) => hostilesAround(bot, 28).filter((t) => t.prof.trident)
export const waterShooter = {
  name: 'water_shooter', priority: 82, critical: false, cooldownMs: 1500, failCooldownMs: 3000, maxMs: 25000,
  check({ bot, danger }) {
    if (bot.health <= 0 || bot.isSleeping) return null
    const th = tridentShooters(bot)
    if (!th.length) return null
    if (isSealed(bot, danger)) return null
    return { nearest: th[0].name, d: +th[0].d.toFixed(1), n: th.length, hp: bot.health }
  },
  async run(ctx, info) {
    const { bot } = ctx
    const r = await fleeFrom(ctx, { maxMs: 20000, safeDist: 26, only: (t) => t.prof.trident })
    const nearWater = waterWithin(bot, WATER_EDGE_M)
    ctx.log('water_shooter', { ...info, ...r, nearWater })
    return r
  },
}

// ---------------------------------------------------------------- creeper keep-distance
export const creeperDistance = {
  name: 'creeper_distance', priority: 78, critical: false, cooldownMs: 1500, failCooldownMs: 2500, maxMs: 9000,
  check({ bot, cfg }) {
    const c = hostilesAround(bot, cfg.creeperRadius).filter((t) => t.prof.creeper)
    return c.length ? { creeper: c[0].d } : null
  },
  async run(ctx) {
    const r = await fleeFrom(ctx, { maxMs: 8000, safeDist: ctx.cfg.creeperSafe, only: (t) => t.prof.creeper })
    if (r.ok || r.reason !== 'cornered') return r
    // cornered by a creeper: hit it first, it is the better odds
    const w = bestWeapon(ctx.bot)
    const near = hostilesAround(ctx.bot, 3.5).find((t) => t.prof.creeper)
    if (near && w !== FIST) { try { await ctx.bot.equip(w.item, 'hand'); await ctx.bot.lookAt(near.e.position.offset(0, 1, 0), true); ctx.bot.attack(near.e) } catch { /* ignore */ } }
    return r
  },
}

// ---------------------------------------------------------------- melee self-defence
export const mobDefense = {
  name: 'mob_defense', priority: 60, critical: false, cooldownMs: 400, failCooldownMs: 1200, maxMs: 30000,
  check({ bot, cfg, state, now }) {
    const a = assess(bot, cfg)
    const last = state.lastStand && now() - state.lastStand < 30000 && a.fighters.length
    if (a.decision === 'fight') return { reason: a.reason, target: a.fighters[0].name }
    if (last) return { reason: 'last_stand', target: a.fighters[0].name }
    return null
  },
  async run(ctx) {
    const { bot, cfg, danger } = ctx
    const w = bestWeapon(bot)
    if (w.item) { try { await bot.equip(w.item, 'hand') } catch { /* fight with what we hold */ } }
    let lastHit = 0, kills = 0, hits = 0
    const t0 = Date.now()
    while (!ctx.signal.aborted && Date.now() - t0 < 28000) {
      const a = assess(bot, cfg)
      const pool = a.fighters.length ? a.fighters : []
      if (!pool.length) return ok('no_target', { hits, kills })
      if (a.decision === 'flee' && !(ctx.state.lastStand && Date.now() - ctx.state.lastStand < 30000)) return fail(`disengage:${a.reason}`, { hits })
      const t = pool[0]
      const target = t.e
      const eyeD = eyePos(bot).distanceTo(target.position.offset(0, (target.height ?? 1.8) * 0.5, 0))
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.85, 0), true)
      const hereC = cellOf(bot.entity.position)
      // never advance into a hazard or off a ledge: wait for the mob instead
      const ahead = { x: Math.floor(bot.entity.position.x - Math.sin(bot.entity.yaw) * 1.2), y: hereC.y, z: Math.floor(bot.entity.position.z - Math.cos(bot.entity.yaw) * 1.2) }
      const aheadOk = landOk(danger, ahead) && danger.costAt(ahead) < HARD || isSolid(danger.blockAt(ahead.x, ahead.y, ahead.z)) || !isPassable(danger.blockAt(ahead.x, ahead.y, ahead.z))
      const approach = eyeD > 2.8 && aheadOk
      bot.setControlState('forward', approach)
      bot.setControlState('sprint', approach && eyeD > 4)
      bot.setControlState('jump', approach && bot.entity.isCollidedHorizontally && bot.entity.onGround)
      if (eyeD <= 3.3 && Date.now() - lastHit >= w.interval) { try { bot.attack(target); hits++; lastHit = Date.now() } catch { /* ignore */ } }
      if (target.isValid === false || target.health === 0) kills++
      if (!(await ctx.sleep(50))) break
    }
    return ctx.signal.aborted ? fail('aborted', { hits }) : fail('timeout', { hits })
  },
}

// ---------------------------------------------------------------- eating
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'raw_chicken', 'enchanted_golden_apple', 'golden_apple', 'golden_carrot'])
export function chooseFood(bot, { allowBad = false } = {}) {
  const foods = bot.registry?.foodsByName
  if (!foods) return null
  const missing = 20 - (bot.food ?? 20)
  const cands = (bot.inventory?.items?.() ?? []).filter((i) => foods[i.name] && !foodForbidden(i.name, bot.health) && (!BAD_FOOD.has(i.name) || (allowBad && EMERGENCY_OK.has(i.name))))   // RS3: hunger only ever justifies rotten flesh / golden food
  if (!cands.length) return null
  // smallest food that still fills the gap, else the biggest; never waste golden apples
  const sorted = cands.sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)
  const fit = sorted.filter((i) => foods[i.name].foodPoints <= missing + 1)
  return fit[0] ?? sorted[sorted.length - 1]
}

async function eatIfNeeded(ctx, limit = 17) {
  const { bot, cfg } = ctx
  for (let i = 0; i < 4 && !ctx.signal.aborted; i++) {
    if ((bot.food ?? 20) > limit) break
    const item = chooseFood(bot, { allowBad: (bot.food ?? 20) <= cfg.eatStarving })
    if (!item) return fail('no_food')
    const before = bot.food
    try {
      await bot.equip(item, 'hand')
      const p = bot.consume()
      await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('eat_timeout')), 4500))])
    } catch (e) { try { bot.deactivateItem?.() } catch { /* ignore */ } ; if (String(e?.message).includes('full')) break }
    await ctx.sleep(100)
    if ((bot.food ?? 0) <= before && !(i === 0)) return fail('no_effect')
  }
  return ok('ate', { food: bot.food })
}

const SICK_EAT_GAP_MS = 45000
/** True when the 4 sides at feet and head level and the block above the head are all solid (pillbox / shelter). */
export function isSealed(bot, danger) {
  const p = bot.entity?.position
  if (!p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  const s = (dx, yy, dz) => isSolid(danger.blockAt(x + dx, yy, z + dz))
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => s(dx, y, dz) && s(dx, y + 1, dz)) && s(0, y + 2, 0)
}

export const eat = {
  name: 'eat', priority: 40, critical: false, cooldownMs: 6000, failCooldownMs: 20000, maxMs: 20000,
  check({ bot, cfg, state, now, danger, engine }) {
    const f = bot.food ?? 20
    if (bot.isSleeping) return null // never eat in bed
    if (burningNow(bot, state, now)) return null // L1: fire first; eating ran while she burned to death
    // health-regeneration eat (hp low, food 15..17): rare (SICK_EAT_GAP_MS), only when not sealed in a shelter, and it really eats (limit 17)
    const sick = (bot.health ?? 20) <= 12 && f <= 17 && f > cfg.eatBelow && !!chooseFood(bot) &&
      now() - (state.sickEatAt ?? 0) > SICK_EAT_GAP_MS && !isSealed(bot, danger)
    if (!(f <= cfg.eatBelow || sick)) return null
    if (!chooseFood(bot, { allowBad: f <= cfg.eatStarving })) { // cannot eat: say so once in a while
      if (!state.noFoodAt || now() - state.noFoodAt > 300000) { // F1: inform only; taking the body for 7 ms aborted the running skill for nothing
        state.noFoodAt = now()
        if (engine?.note) { engine.note('reflex_end', { name: 'eat', ok: false, reason: 'no_food', ms: 0, aborted: false, food: f }); return null }
        return { food: f, none: true }
      }
      return null
    }
    // F1: not hungry enough to cut a running skill short: wait for the gap between two skills (arbiter free)
    const holder = engine?.arbiter?.holder
    if (holder && holder.owner !== 'reflex' && f > (cfg.eatUrgent ?? 0)) return null
    if (f > cfg.eatStarving && hostilesAround(bot, 8).some((t) => !t.prof.neutral)) return null
    if (sick && f > cfg.eatBelow) return { food: f, sick: true }
    return { food: f }
  },
  async run(ctx, info) {
    if (info.none) return fail('no_food') // surfaced as an event for S1/S2 (habit: find food)
    if (info.sick) ctx.state.sickEatAt = ctx.now() // stamp first: even a no-op attempt must not repeat for SICK_EAT_GAP_MS
    return eatIfNeeded(ctx, info.sick ? 17 : ctx.cfg.eatBelow)
  },
}

// ---------------------------------------------------------------- cliff / void edge
function dropAt(danger, x, y, z, edgeDrop) {
  const f = danger.blockAt(x, y, z), h = danger.blockAt(x, y + 1, z)
  if (!isPassable(f) || !isPassable(h)) return { cliff: false } // wall or unloaded
  let n = 0
  for (let yy = y - 1; yy >= y - 1 - edgeDrop - 3; yy--) {
    const b = danger.blockAt(x, yy, z)
    if (!b) return { cliff: false } // unloaded: unknown, do not panic
    if (isLava(b)) return { cliff: true, lava: true, depth: n }
    if (b.boundingBox === 'block' || isWater(b)) return { cliff: n >= edgeDrop, depth: n }
    n++
  }
  return { cliff: true, depth: n, void: true }
}
export function cliffAhead(bot, danger, edgeDrop, dir) {
  const p = bot.entity.position
  const y = Math.floor(p.y + 0.0001)
  for (const k of [0.8, 1.4]) {
    const cx = Math.floor(p.x + dir.x * k), cz = Math.floor(p.z + dir.z * k)
    const r = dropAt(danger, cx, y, cz, edgeDrop)
    if (r.cliff) {
      // E1: distance along the travel direction until the body enters the cliff column (0 = already over it)
      let dist = k
      for (let t = 0; t <= k; t += 0.05) if (Math.floor(p.x + dir.x * t) === cx && Math.floor(p.z + dir.z * t) === cz) { dist = t; break }
      return { ...r, k, dist, cell: { x: cx, y, z: cz } }
    }
  }
  return null
}
function travelDir(bot) {
  const v = bot.entity.velocity
  if (v && Math.hypot(v.x, v.z) > 0.06) { const m = Math.hypot(v.x, v.z); return { x: v.x / m, z: v.z / m } }
  if (bot.controlState?.forward) return { x: -Math.sin(bot.entity.yaw), z: -Math.cos(bot.entity.yaw) }
  return null
}
// E1: edge_guard only fires when needed. The pathfinder plans drops of at most maxDropDown (4) < edgeDrop (5), so while it owns the movement a
// void cliff ahead is not a threat (lava still is); skills whose job is edges are exempt; after a firing the same edge may re-fire only when the
// body is within EDGE_NEAR of it; the edge that fired is marked as forbidden so re-planning goes around instead of straight back.
export const EDGE_HYST_MS = 4000, EDGE_NEAR = 0.5, EDGE_FORBID_MS = 60000
const EDGE_EXEMPT = new Set(['escape_descend', 'escape_bridge', 'descend', 'bridge'])
function pathfinderOwns(bot) { const pf = bot.pathfinder; return !!(pf && (pf.goal || (typeof pf.isMoving === 'function' && pf.isMoving()))) }
function markEdge(ctx, cell) {
  if (!cell) return
  try { ctx.danger.forbid(cell, EDGE_FORBID_MS) } catch { /* ignore */ }
  const mv = ctx.bot.pathfinder?.movements
  if (mv?.exclusionAreasStep) { // steer the pathfinder around it too (a temporary step-cost area, removed by ttl)
    const until = ctx.now() + EDGE_FORBID_MS
    const fn = (blk) => (ctx.now() < until && blk?.position && blk.position.x === cell.x && blk.position.z === cell.z && blk.position.y >= cell.y - 1 && blk.position.y <= cell.y + 1 ? 100 : 0)
    mv.exclusionAreasStep.push(fn)
    const t = setTimeout(() => { const i = mv.exclusionAreasStep.indexOf(fn); if (i >= 0) mv.exclusionAreasStep.splice(i, 1) }, EDGE_FORBID_MS + 500); t.unref?.()
  }
}
export const edgeGuard = {
  name: 'edge_guard', priority: 70, critical: false, cooldownMs: 700, failCooldownMs: 1500, maxMs: 6000,
  check({ bot, danger, cfg, now, state, engine }) {
    if (!bot.entity.onGround || bot.entity.isInWater) return null
    const d = travelDir(bot)
    if (!d) return null
    const c = cliffAhead(bot, danger, cfg.edgeDrop, d)
    if (!c) return null
    if (!c.lava) {
      const label = engine?.arbiter?.holder?.label
      if (label && EDGE_EXEMPT.has(label)) return null // descend / bridge work at edges on purpose
      if (pathfinderOwns(bot)) return null // pathfinder paths obey maxDropDown: a void cliff beside the path is not on it
      if (now() < (state.edgeUntil ?? 0) && !(c.dist <= EDGE_NEAR)) return null // hysteresis: just stepped back from an edge
    }
    return { depth: c.depth, lava: !!c.lava, void: !!c.void, dir: d, dist: +c.dist.toFixed(2), cell: c.cell }
  },
  async run(ctx, info) {
    const { bot, danger, cfg } = ctx
    bot.clearControlStates()
    ctx.state.edgeUntil = ctx.now() + EDGE_HYST_MS
    const start = cellOf(bot.entity.position)
    const safe = (c) => {
      if (!landOk(danger, c) || danger.costAt(c) >= HARD) return false
      for (const [dx, dz] of DIRS) if (dropAt(danger, c.x + dx, c.y, c.z + dz, cfg.edgeDrop).cliff) return false
      return true
    }
    markEdge(ctx, info.cell)
    if (safe(start)) { await ctx.sleep(150); return ok('already_back') }
    const res = search(danger, start, (c) => safe(c), { maxNodes: 200, maxCost: 8 })
    if (!res) return fail('no_safe_cell')
    const w = await walkPath(ctx, res.path, { sprint: false, stepMs: 1500 })
    return w.ok ? ok('stepped_back', { depth: info.depth }) : fail(`walk_${w.reason}`)
  },
}

export const ALL_REFLEXES = [mlg, lavaFire, suffocation, fallingBlock, drowning, lowHpCover, rangedCover, waterShooter, lowHealthFlee, creeperDistance, edgeGuard, mobDefense, eat]
