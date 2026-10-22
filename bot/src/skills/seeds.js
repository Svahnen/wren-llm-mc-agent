// RS3: seeds from grass. `grass_seeds` breaks short grass / tall grass / ferns (12.5 % chance of a wheat seed per break, RS2 entry 1) until the seed count is met
// or the grass is used up; `bonemeal_grass` (S2 only, needs bone meal) sprouts new grass on a grass block so it can be broken for seeds (RS2 entry 2).
// Facts are measured, never claimed: the result is the seed delta in the pack and the number of breaks; the bone meal yield is counted from the world and logged
// (1.21.1 expectation, NOT verified on this server: short grass and flowers only, tall grass only from bone meal on short grass; see RS3 report).
import { goals, V, dist3, items, countMatch, collectDrops, freeSlots, isNight, isThunder } from './lib.js'

export const SEED_RE = /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/
export const WHEAT_SEED_RE = /^wheat_seeds$/
export const seedCount = (bot) => countMatch(bot, SEED_RE)
export const wheatSeeds = (bot) => countMatch(bot, WHEAT_SEED_RE)
export const GRASS = ['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern']
export const SEED_CHANCE = 0.125   // RS2 0.1.3: per broken grass plant
export const GRASSED_OUT_MS = 20 * 60000
const idsOf = (bot, names) => names.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)

/** grass plants within r (nearest first). Pure on bot.findBlocks. */
export function grassNear(bot, r = 16, count = 24) {
  const ids = idsOf(bot, GRASS)
  if (!ids.length) return []
  const me = bot.entity.position
  return (bot.findBlocks?.({ matching: ids, maxDistance: r, count }) ?? []).map((p) => ({ p, d: dist3(p, me) })).sort((a, b) => a.d - b.d)
}

/** where she cleared the grass (area marker, kept in env): { x, z, t } list, newest last, max 6 */
export function markGrassedOut(env, bot, now = Date.now()) {
  if (!env) return
  const p = bot.entity.position
  const list = (env.grassedOut ??= [])
  list.push({ x: Math.round(p.x), z: Math.round(p.z), t: now }); while (list.length > 6) list.shift()
}
export function grassedOutHere(env, bot, now = Date.now(), r = 24) {
  const p = bot.entity?.position; if (!p) return null
  return (env?.grassedOut ?? []).find((g) => now - g.t < GRASSED_OUT_MS && Math.hypot(g.x - p.x, g.z - p.z) <= r) ?? null
}

/**
 * The shared loop: walk to the nearest grass plant, break it, pick the drop up, until `want` more wheat seeds are held. Used by the `grass_seeds` skill and by
 * `collect_seeds` (the roam forage). Stops when the grass within `radius` is gone, after `maxMs`, or after `maxBreaks`. Never throws.
 * -> { gained, broken, exhausted, reason? }   (gained = seed delta in the inventory)
 */
export async function grassSeedRun(ctx, { want = 9, radius = 32, maxMs = 80000, maxBreaks = 140, re = WHEAT_SEED_RE } = {}) {
  const bot = ctx.bot, t0 = Date.now(), before = countMatch(bot, re)
  const bad = new Map()   // cell key -> failures
  let broken = 0, exhausted = false
  ctx.state.broken = 0; ctx.state.gained = 0
  for (let k = 0; k < maxBreaks && !ctx.aborted && countMatch(bot, re) - before < want && Date.now() - t0 < maxMs; k++) {
    if (freeSlots(bot) < 1) break
    const g = grassNear(bot, radius, 16).find((c) => (bad.get(`${c.p.x},${c.p.y},${c.p.z}`) ?? 0) < 2)
    if (!g) { exhausted = true; break }
    const key = `${g.p.x},${g.p.y},${g.p.z}`
    const r = await ctx.goto(new goals.GoalNear(g.p.x, g.p.y, g.p.z, 2), { timeoutMs: 10000 })
    if (r && r.ok === false) { bad.set(key, (bad.get(key) ?? 0) + 1); await ctx.sleep(100); continue }
    const b = bot.blockAt(V(g.p.x, g.p.y, g.p.z))
    if (!b || !GRASS.includes(b.name)) { bad.set(key, 2); continue }
    try { await bot.lookAt(V(g.p.x + 0.5, g.p.y + 0.5, g.p.z + 0.5)); await bot.dig(b) } catch { bad.set(key, (bad.get(key) ?? 0) + 1); continue }
    broken++; ctx.state.broken = broken
    await ctx.sleep(150)
    await collectDrops(ctx, g.p, { r: 5, max: 2 })
    ctx.state.gained = countMatch(bot, re) - before
  }
  const gained = countMatch(bot, re) - before
  ctx.state.gained = gained
  return { gained, broken, exhausted }
}

const dayOk = (bot) => !(isNight(bot) || isThunder(bot))

export function makeSeedSkills(env = {}) {
  return [{
    name: 'grass_seeds', max_s: 120, stall_s: 30,
    precondition: ({ bot, args }) => {
      if (!(!!bot?.entity && bot.health > 0)) return false
      if (!dayOk(bot)) return { ok: false, reason: 'night', detail: 'seeds are collected in daylight (hostile mobs spawn on the grass at night)' }
      if (freeSlots(bot) < 1) return { ok: false, reason: 'inventory_full' }
      const r = args?.radius ?? 32
      if (!grassNear(bot, r, 1).length) {
        const out = grassedOutHere(env, bot)
        return { ok: false, reason: out ? 'grassed_out' : 'no_grass', detail: out ? `I cleared the grass here ${Math.max(1, Math.round((Date.now() - out.t) / 60000))} min ago; walk to a new meadow` : `no grass, tall grass or fern within ${r} m` }
      }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.broken ?? 0}:${ctx.state.gained ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = ctx.args.count ?? 9, radius = ctx.args.radius ?? 32
      const res = await grassSeedRun(ctx, { want, radius })
      if (res.exhausted) markGrassedOut(env, bot)
      const per = res.broken ? `${res.gained} seed${res.gained === 1 ? '' : 's'} from ${res.broken} grass (about 1 in 8 gives one; ${res.broken ? (res.gained / res.broken * 100).toFixed(0) : 0} % here)` : 'no grass broken'
      ctx.log('grass_seeds', { gained: res.gained, broken: res.broken, exhausted: res.exhausted, want, radius })
      if (res.gained > 0) return { ok: true, reason: res.gained >= want ? 'seeds_reached' : res.exhausted ? 'grass_used_up' : 'partial', detail: per }
      return { ok: false, reason: res.broken ? 'no_seeds_dropped' : res.exhausted ? 'grassed_out' : 'nothing_broken', detail: res.broken ? `broke ${res.broken} grass, no seed dropped (about 1 in 8 gives one)` : 'could not reach any grass' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }, makeBonemealGrass(env)]
}

// ------------------------------------------------------------------ bonemeal_grass
const PLANTS = ['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'lily_of_the_valley']
export const BONEMEAL_THIN = 5   // fewer new plants than this from one bone meal = a thin result
const boneMealItem = (bot) => items(bot).find((i) => i.name === 'bone_meal')

/** grass blocks (open air above) around p within r that carry no plant yet. */
function freeGrassBlocks(bot, p, r) {
  const ids = idsOf(bot, ['grass_block'])
  if (!ids.length) return []
  return (bot.findBlocks?.({ matching: ids, maxDistance: r, count: 200, point: p }) ?? []).filter((q) => { const up = bot.blockAt(V(q.x, q.y + 1, q.z)); return !!up && (up.name === 'air' || up.name === 'cave_air') })
}
export const plantCount = (bot, p, r = 8) => { const ids = idsOf(bot, PLANTS); return ids.length ? (bot.findBlocks?.({ matching: ids, maxDistance: r, count: 400, point: p }) ?? []).length : 0 }

/** the grass block with the most free grass blocks around it (a flat open meadow), within 12 m of her. -> {p, free} | null */
export function bestGrassTarget(bot, r = 12) {
  const me = bot.entity.position, free = freeGrassBlocks(bot, me, r)
  if (!free.length) return null
  const set = new Set(free.map((q) => `${q.x},${q.y},${q.z}`))
  let best = null
  for (const q of free) {
    let n = 0
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (set.has(`${q.x + dx},${q.y},${q.z + dz}`)) n++
    const score = n - dist3(q, me) * 0.3
    if (!best || score > best.score) best = { p: q, free: n, score }
  }
  return best
}

function makeBonemealGrass(env) {
  return {
    name: 'bonemeal_grass', max_s: 90, stall_s: 25,
    precondition: ({ bot }) => {
      if (!(!!bot?.entity && bot.health > 0)) return false
      if (!dayOk(bot)) return { ok: false, reason: 'night' }
      if (!boneMealItem(bot)) return { ok: false, reason: 'no_bone_meal' }
      if (!bestGrassTarget(bot)) return { ok: false, reason: 'no_free_grass', detail: 'no grass block with open air above within 12 m' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.used ?? 0}:${ctx.state.plants ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, uses = ctx.args.uses ?? 1
      let used = 0, plants = 0, poor = 0
      const meas = ((env.measure ??= {}).bonemealGrass ??= [])
      for (let n = 0; n < uses && !ctx.aborted && poor < 2; n++) {
        const bm = boneMealItem(bot); if (!bm) break
        const t = bestGrassTarget(bot); if (!t) break
        const r = await ctx.goto(new goals.GoalNear(t.p.x, t.p.y + 1, t.p.z, 3), { timeoutMs: 12000 })
        if (r && r.ok === false) break
        const blk = bot.blockAt(V(t.p.x, t.p.y, t.p.z)); if (!blk || blk.name !== 'grass_block') continue
        const before = plantCount(bot, V(t.p.x, t.p.y, t.p.z))
        try { await bot.equip(bm, 'hand'); await bot.lookAt(V(t.p.x + 0.5, t.p.y + 1, t.p.z + 0.5)); await bot.activateBlock(blk) } catch (e) { ctx.log('bonemeal_error', { message: String(e?.message).slice(0, 100) }); break }
        used++; ctx.state.used = used
        await ctx.sleep(700)
        const got = plantCount(bot, V(t.p.x, t.p.y, t.p.z)) - before
        meas.push(got); if (meas.length > 20) meas.shift()
        plants += Math.max(0, got); ctx.state.plants = plants
        if (got < BONEMEAL_THIN) poor++
      }
      ctx.log('bonemeal_grass', { used, plants, history: meas.slice(-5) })
      if (!used) return { ok: false, reason: 'no_bone_meal_used', detail: 'could not use bone meal on a grass block (not reachable, or none left)' }
      return plants >= BONEMEAL_THIN ? { ok: true, reason: 'grass_sprouted', detail: `${used} bone meal made ${plants} new plants (measured)` } : { ok: false, reason: 'thin_result', detail: `${used} bone meal made only ${plants} new plants (measured; grass or flowers)` }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}
