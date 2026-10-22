// drop_junk / store_in_chest. Success = free-slot delta.
import { goals, dist3, items, freeSlots, countItem, placeNearby, V } from './lib.js'

// keep caps: items above the cap are surplus; JUNK is never worth a slot.
export const JUNK = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'deepslate', 'dripstone_block', 'pointed_dripstone', 'flint', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'mangrove_leaves', 'azalea_leaves', 'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'acacia_sapling', 'dark_oak_sapling', 'jungle_sapling', 'cherry_sapling', 'bone', 'string', 'gunpowder', 'sand', 'red_sand', 'clay_ball', 'snowball', 'netherrack', 'seagrass', 'kelp', 'sweet_berries'])
export const CAPS = { cobblestone: 64, dirt: 32, coarse_dirt: 0, grass_block: 0 }
const LOGCAP = 32
const isLog = (n) => /_(log|planks)$/.test(n)

/** [{item, count}] to get rid of. `all` adds capped surplus; default only junk + surplus. */
export function surplus(bot) {
  const tally = new Map()
  for (const i of items(bot)) tally.set(i.name, (tally.get(i.name) ?? 0) + i.count)
  const out = []
  for (const [name, n] of tally) {
    if (JUNK.has(name)) out.push({ name, count: n })
    else if (name in CAPS && n > CAPS[name]) out.push({ name, count: n - CAPS[name] })
    else if (isLog(name) && n > LOGCAP) out.push({ name, count: n - LOGCAP })
  }
  return out
}

export function makeDropJunk() {
  return {
    name: 'drop_junk', max_s: 40, stall_s: 20,
    precondition: ({ bot }) => (!bot?.entity || bot.health <= 0 ? false : surplus(bot).length ? true : { ok: false, reason: 'nothing_to_drop' }),
    progress_fn: (ctx) => `${freeSlots(ctx.bot)}:${ctx.state.dropped ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const free0 = freeSlots(bot)
      const origin = bot.entity.position.clone()
      for (const s of surplus(bot)) {
        if (ctx.aborted) break
        const it = bot.registry.itemsByName[s.name]
        try { await bot.toss(it.id, null, s.count); ctx.state.dropped = (ctx.state.dropped ?? 0) + s.count } catch (e) { ctx.log('toss_error', { message: String(e.message).slice(0, 100) }) }
        await ctx.sleep(120)
      }
      // walk off so we do not pick the stacks straight up again
      const a = Math.random() * 6.28
      await ctx.goto(new goals.GoalNear(origin.x + Math.cos(a) * 6, origin.y, origin.z + Math.sin(a) * 6, 3), { timeoutMs: 8000 })
      return freeSlots(bot) > free0 ? { ok: true } : { ok: false, reason: 'no_slot_freed' }
    },
  }
}

export function makeStoreInChest(env) {
  const { landmarks } = env
  const chestBlock = (bot, r = 32) => bot.findBlock({ matching: [bot.registry.blocksByName.chest.id, bot.registry.blocksByName.barrel?.id].filter(Boolean), maxDistance: r })
  return {
    name: 'store_in_chest', max_s: 60, stall_s: 25,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!chestBlock(bot) && countItem(bot, 'chest') === 0) return { ok: false, reason: 'no_chest' }
      return true
    },
    progress_fn: (ctx) => `${freeSlots(ctx.bot)}:${ctx.state.stage ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      let cb = chestBlock(bot)
      if (!cb) {
        const at = await placeNearby(bot, 'chest')
        if (!at) return { ok: false, reason: 'cannot_place_chest' }
        cb = bot.blockAt(at)
        landmarks?.set('chest_1', at, 'chest')
        await ctx.sleep(300)
      }
      ctx.state.stage = 'walk'
      if (dist3(bot.entity.position, cb.position) > 3.5) {
        const r = await ctx.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2), { timeoutMs: 25000 })
        if (!r.ok) return { ok: false, reason: r.reason }
      }
      const free0 = freeSlots(bot)
      ctx.state.stage = 'open'
      let w
      try {
        w = await bot.openContainer(cb)
        // deposit junk, surplus and the bulk materials; keep tools, food, torches, beds, crafting basics
        const keep = /(_pickaxe|_axe|_sword|_shovel|_hoe|fishing_rod|torch|_bed|^bread|^cooked_|^apple|^carrot|^baked_potato|^beef|^porkchop|^mutton|^chicken|^stick$|^crafting_table$|^chest$|^coal$)/
        const todo = [...surplus(bot).map((s) => s), ...items(bot).filter((i) => !keep.test(i.name) && !/_(log|planks)$/.test(i.name) && !JUNK.has(i.name) && !(i.name in CAPS)).map((i) => ({ name: i.name, count: i.count }))]
        ctx.state.stage = 'deposit'
        for (const s of todo) {
          if (ctx.aborted) break
          const it = bot.registry.itemsByName[s.name]
          try { await w.deposit(it.id, null, s.count) } catch (e) { ctx.log('deposit_error', { name: s.name, message: String(e.message).slice(0, 80) }); if (/full|space/i.test(String(e.message))) break }
        }
      } catch (e) { return { ok: false, reason: 'open_failed' } } finally { try { w?.close() } catch { /* ignore */ } }
      return freeSlots(bot) > free0 ? { ok: true } : { ok: false, reason: 'no_slot_freed' }
    },
  }
}
