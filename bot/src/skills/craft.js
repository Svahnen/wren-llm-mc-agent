// craft(item): small closed recipe set; intermediates (planks, sticks, table) are made on demand.
// Success = inventory delta of the product (never the model's claim).
import { goals, dist3, countItem, countMatch, items, placeNearby, V } from './lib.js'

const WOOD = '_planks$'
// needs: planks (any type) / stick / cobble / coal / wool / table (3x3 recipe)
export const RECIPES = {
  planks: { out: 4, from: 'log' },
  stick: { out: 4, planks: 2 },
  crafting_table: { planks: 4 },
  chest: { planks: 8, table: true },
  wooden_pickaxe: { planks: 3, stick: 2, table: true }, wooden_axe: { planks: 3, stick: 2, table: true },
  wooden_sword: { planks: 2, stick: 1, table: true }, wooden_shovel: { planks: 1, stick: 2, table: true },
  stone_pickaxe: { cobble: 3, stick: 2, table: true }, stone_axe: { cobble: 3, stick: 2, table: true },
  stone_sword: { cobble: 2, stick: 1, table: true }, stone_shovel: { cobble: 1, stick: 2, table: true },
  torch: { out: 4, coal: 1, stick: 1 },
  furnace: { cobble: 8, table: true },
  bed: { wool: 3, planks: 3, table: true },
  fishing_rod: { stick: 3, string: 2, table: true },   // PB4
  wooden_hoe: { planks: 2, stick: 2, table: true },     // PB4
  bread: { wheat: 3, table: true },                     // FARM1 (3 wheat in a row)
  stone_hoe: { cobble: 2, stick: 2, table: true },      // RS3 (bootstrap_kit farm_kit)
  wheat: { out: 9, hay: 1 },                            // RS3: 1 hay bale -> 9 wheat (village_forage), shapeless, no table
}
export const CRAFTABLE = Object.keys(RECIPES)
const COBBLE = ['cobblestone', 'cobbled_deepslate', 'blackstone']

export const planksCount = (bot) => countMatch(bot, /_planks$/)
export const logsCount = (bot) => countMatch(bot, /_log$/)

function tableNear(bot, r = 24) {
  const id = bot.registry.blocksByName.crafting_table.id
  return bot.findBlock({ matching: id, maxDistance: r })
}

async function craftOnce(ctx, name, table) {
  const bot = ctx.bot
  const it = bot.registry.itemsByName[name]
  if (!it) return false
  const recipes = bot.recipesFor(it.id, null, 1, table ?? null)
  if (!recipes.length) return false
  const before = countItem(bot, name)
  try { await bot.craft(recipes[0], 1, table ?? undefined) } catch (e) { ctx.log('craft_error', { name, message: String(e.message).slice(0, 120) }); return false }
  await ctx.sleep(150)
  return countItem(bot, name) > before
}

/** Make planks from any log until at least n planks are held. */
async function ensurePlanks(ctx, n) {
  const bot = ctx.bot
  let guard = 0
  while (planksCount(bot) < n && guard++ < 12 && !ctx.aborted) {
    const log = items(bot).find((i) => i.name.endsWith('_log') || i.name.endsWith('_stem') || i.name.endsWith('_wood'))
    if (!log) return false
    const plank = log.name.replace(/_(log|stem|wood)$/, log.name.endsWith('_stem') ? '_planks' : '_planks')
    const ok = await craftOnce(ctx, plank, null) || await craftOnce(ctx, log.name.replace('_log', '_planks'), null)
    if (!ok) return false
  }
  return planksCount(bot) >= n
}
async function ensureSticks(ctx, n) {
  const bot = ctx.bot
  let guard = 0
  while (countItem(bot, 'stick') < n && guard++ < 6 && !ctx.aborted) {
    if (planksCount(bot) < 2 && !(await ensurePlanks(ctx, 2))) return false
    if (!(await craftOnce(ctx, 'stick', null))) return false
  }
  return countItem(bot, 'stick') >= n
}

/** Positions of tables we placed or walked to (SURV5), so a table out of the 24 m scan can still be found again. */
const knownTables = (bot) => (bot._knownTables ??= [])
const rememberTable = (bot, p) => { const k = knownTables(bot); if (!k.some((q) => q.x === p.x && q.y === p.y && q.z === p.z)) k.push({ x: p.x, y: p.y, z: p.z }); if (k.length > 8) k.shift() }

/**
 * A crafting table within reach (<4 blocks): the nearest scanned one, else a remembered one (walk <= 64 m), else craft one (4 planks, made
 * from logs if needed) and place it on open ground outside protected zones. Returns { table } or { reason: 'no_table', detail } with the honest cause.
 */
async function ensureTable(ctx) {
  const bot = ctx.bot
  const protectedAt = (p) => { try { return !!ctx.env?.digForbidden?.(p) || !!ctx.env?.isProtected?.(p.x, p.y, p.z) } catch { return false } }
  let tb = tableNear(bot)
  if (!tb) {
    const id = bot.registry.blocksByName.crafting_table.id
    const me = bot.entity.position
    for (const k of [...knownTables(bot)].sort((a, b) => dist3(a, me) - dist3(b, me))) {
      if (dist3(k, me) > 64) continue
      const blk = bot.blockAt(new (me.constructor)(k.x, k.y, k.z))
      if (blk && blk.type !== id) { knownTables(bot).splice(knownTables(bot).indexOf(k), 1); continue }   // gone
      const r = await ctx.goto(new goals.GoalNear(k.x, k.y, k.z, 2), { timeoutMs: 25000 })
      tb = bot.findBlock({ matching: id, maxDistance: 6 })
      if (r.ok && tb) break
      tb = null
    }
  }
  if (!tb) {
    if (countItem(bot, 'crafting_table') === 0) {
      const planks = planksCount(bot), logs = logsCount(bot)
      if (planks < 4 && planks + logs * 4 < 4) return { reason: 'no_table', detail: `no crafting table within reach and no wood to make one (need 4 planks, have ${planks} planks, ${logs} logs)` }
      if (!(await ensurePlanks(ctx, 4))) return { reason: 'no_table', detail: `no crafting table within reach; could not make 4 planks (have ${planksCount(bot)} planks, ${logsCount(bot)} logs)` }
      if (!(await craftOnce(ctx, 'crafting_table', null))) return { reason: 'no_table', detail: 'no crafting table within reach; the table recipe failed' }
    }
    const at = await placeNearby(bot, 'crafting_table', { avoid: [] })
    if (!at) return { reason: 'no_table', detail: 'no crafting table within reach; no free flat spot within 2 blocks to place one' }
    if (protectedAt(at)) {   // placed inside a protected zone: take it back and say so
      try { await bot.dig(bot.blockAt(at)) } catch { /* ignore */ }
      return { reason: 'no_table', detail: 'no crafting table within reach; the only free spot is inside a protected zone' }
    }
    ctx.log('table_placed', { at: [at.x, at.y, at.z] })
    await ctx.sleep(300)
    tb = bot.blockAt(at)
  }
  if (!tb) return { reason: 'no_table', detail: 'table placed but not found afterwards' }
  rememberTable(bot, tb.position)
  if (dist3(bot.entity.position, tb.position) > 3.5) {
    const r = await ctx.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2), { timeoutMs: 20000 })
    if (!r.ok) return { reason: 'no_table', detail: `crafting table at ${tb.position.x},${tb.position.y},${tb.position.z} is unreachable (${r.reason ?? 'no path'})` }
  }
  return { table: tb }
}

/** Craft `count` of `name`. Returns {ok, reason}. */
export async function craftItem(ctx, name, count = 1, env = ctx.env) {
  ctx = ctx.env === env ? ctx : Object.assign(Object.create(ctx), { env })
  const bot = ctx.bot
  const spec = RECIPES[name]
  if (!spec) return { ok: false, reason: 'unknown_recipe' }
  const startCount = countItem(bot, name)
  const per = spec.out ?? 1
  const batches = Math.max(1, Math.ceil(count / per))
  for (let b = 0; b < batches && !ctx.aborted; b++) {
    if (name === 'planks') {
      const log = items(bot).find((i) => i.name.endsWith('_log'))
      if (!log) return { ok: false, reason: 'missing_log' }
      if (!(await craftOnce(ctx, log.name.replace('_log', '_planks'), null))) return { ok: false, reason: 'craft_failed' }
      continue
    }
    // order matters: table first (it eats 4 planks), then sticks (they eat 2), then the planks the recipe itself needs
    let table = null
    if (spec.table) { const t = await ensureTable(ctx); if (!t.table) return { ok: false, reason: t.reason, detail: t.detail }; table = t.table }
    if (spec.stick && !(await ensureSticks(ctx, spec.stick))) return { ok: false, reason: 'missing_sticks' }
    if (spec.planks && !(await ensurePlanks(ctx, spec.planks))) {   // EXP1: logs are turned into planks first (ensurePlanks); this only fails with no logs left or a failed recipe
      const pl = planksCount(bot), lg = logsCount(bot)
      return { ok: false, reason: 'missing_planks', detail: lg > 0 ? `have ${pl} planks and ${lg} logs but the planks recipe failed` : `have ${pl} planks, need ${spec.planks}, and no logs to make more: the nearby trees are used up (resource_expedition resource=wood goes further out)` }
    }
    if (spec.cobble && countMatch(bot, /^(cobblestone|cobbled_deepslate|blackstone)$/) < spec.cobble) return { ok: false, reason: 'missing_cobblestone' }
    if (spec.coal && countItem(bot, 'coal') + countItem(bot, 'charcoal') < spec.coal) return { ok: false, reason: 'missing_coal' }
    if (spec.wheat && countItem(bot, 'wheat') < spec.wheat) return { ok: false, reason: 'missing_wheat', detail: `bread needs ${spec.wheat} wheat, have ${countItem(bot, 'wheat')}` }
    if (spec.hay && countItem(bot, 'hay_block') < spec.hay) return { ok: false, reason: 'missing_hay' }
    if (spec.string && countItem(bot, 'string') < spec.string) return { ok: false, reason: 'missing_string' }
    if (spec.wool && countMatch(bot, /_wool$/) < spec.wool) return { ok: false, reason: 'missing_wool' }
    // F1: a bed needs 3 wool of ONE colour (mixed colours made recipesFor empty => craft_failed); pick the colour we have most of
    const woolBy = {}
    for (const i of items(bot)) if (i.name.endsWith('_wool')) woolBy[i.name] = (woolBy[i.name] ?? 0) + i.count
    const bestWool = Object.entries(woolBy).sort((a, b) => b[1] - a[1])[0]
    if (spec.wool && (bestWool?.[1] ?? 0) < spec.wool) return { ok: false, reason: 'missing_wool' }
    const target = name === 'bed' ? (bestWool?.[0].replace('_wool', '_bed') ?? 'white_bed') : name
    // planks for wooden tools can be of any wood type: recipesFor picks the satisfiable variant.
    if (!(await craftOnce(ctx, target, table))) { ctx.log('craft_fail_detail', { target, planks: planksCount(bot), sticks: countItem(bot, 'stick'), table: !!table }); return { ok: false, reason: 'craft_failed' } }
  }
  return countItem(bot, name === 'bed' ? 'white_bed' : name) > startCount || (name === 'bed' && countMatch(bot, /_bed$/) > 0)
    ? { ok: true } : { ok: false, reason: 'no_inventory_delta' }
}

export function makeCraft(env = {}) {
  return {
    name: 'craft', max_s: 90, stall_s: 30,
    precondition: ({ bot, args }) => !!bot?.entity && args.item in RECIPES,
    progress_fn: (ctx) => ctx.bot ? `${items(ctx.bot).reduce((s, i) => s + i.count, 0)}:${items(ctx.bot).length}` : 'x',
    async run(ctx) { return craftItem(ctx, ctx.args.item, ctx.args.count ?? 1, env) },
  }
}
