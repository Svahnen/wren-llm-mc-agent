// G2: cook(): smelt raw food in a furnace. Finds a furnace (or places one: from a furnace item, or crafts one from 8 cobblestone), puts fuel (coal > charcoal >
// planks > logs) and the raw meat in, waits for the smelting, collects the product. Success = cooked items gained (ground truth from the inventory).
import { goals, dist3, countItem, countMatch, items, placeNearby } from './lib.js'
import { craftItem } from './craft.js'
import { placeInWall, sealedWithLeak, plugLeaks, nicheCandidates } from './leak.js'
import { boxedIn } from './shelter.js'

export const RAW_RE = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|kelp)$/
export const COOKED_OF = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp' }
const COOKED_RE = /^(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|baked_potato|dried_kelp)$/
// items one fuel item smelts (vanilla): coal/charcoal 8, planks/log 1.5, stick 0.5
const FUEL = [['coal', 8], ['charcoal', 8], [/_planks$/, 1.5], [/_log$/, 1.5]]
const SMELT_MS = 10000

export const rawFoodCount = (bot) => countMatch(bot, RAW_RE)
/** fuel stacks to use for n items. -> [{item, count}] or null when the inventory cannot fuel it */
export function planFuel(bot, n) {
  let need = n
  const out = []
  for (const [sel, per] of FUEL) {
    if (need <= 0) break
    const have = items(bot).filter((i) => (sel instanceof RegExp ? sel.test(i.name) : i.name === sel))
    for (const it of have) {
      const use = Math.min(it.count, Math.ceil(need / per))
      if (use > 0) { out.push({ item: it, count: use }); need -= use * per }
      if (need <= 0) break
    }
  }
  return need <= 0 ? out : null
}
const furnaceNear = (bot, r = 24) => { const id = bot.registry.blocksByName.furnace?.id; return id === undefined ? null : bot.findBlock({ matching: id, maxDistance: r }) }

/** RS3: a furnace within reach: one standing within 24 m, or one placed from the pack / crafted from 8 cobblestone and placed (also in a wall niche when sealed in).
 *  -> { fb } | { fail: { ok:false, reason } }. Shared by cook and make_charcoal. */
export async function acquireFurnace(ctx, env = {}) {
  const bot = ctx.bot
  let fb = furnaceNear(bot)
  if (!fb) {
    if (countItem(bot, 'furnace') === 0) {
      if (countMatch(bot, /^(cobblestone|cobbled_deepslate|blackstone)$/) < 8) return { fail: { ok: false, reason: 'no_furnace_materials' } }
      // fuel must survive crafting: the table eats planks, so re-plan the fuel afterwards
      const r = await craftItem(ctx, 'furnace', 1)
      if (!r.ok) return { fail: { ok: false, reason: r.reason ?? 'craft_failed' } }
    }
    let at = await placeNearby(bot, 'furnace', { radius: 4 })   // FOOD2: wider search (shore/water edge left no spot within 2)
    // STUCK3: sealed in a 1x1 cell there is no floor tile: dig one wall block and put the furnace in its place (the cell stays sealed)
    // REC2b: also when the cell is not fully boxed (water leak / open corner): a solid wall block of her pit is dug and refilled with the furnace; a leak is plugged first
    if (!at && sealedWithLeak(bot)) { try { await plugLeaks(bot, { settleMs: 4000 }); at = await placeNearby(bot, 'furnace', { radius: 4 }) } catch { /* ignore */ } }
    if (!at && (boxedIn(bot) || nicheCandidates(bot, env).length)) { at = await placeInWall(ctx, 'furnace', env); if (at) ctx.log('furnace_in_wall', { at: [at.x, at.y, at.z] }) }
    if (!at) return { fail: { ok: false, reason: 'no_spot' } }
    ctx.log('furnace_placed', { at: [at.x, at.y, at.z] })
    await ctx.sleep(300)
    fb = bot.blockAt(at)
  }
  if (!fb) return { fail: { ok: false, reason: 'no_furnace' } }
  return { fb }
}

export function makeCook(env = {}) {
  return {
    name: 'cook', max_s: 150, stall_s: 40,
    precondition: ({ bot }) => {
      if (!bot?.entity) return false
      if (rawFoodCount(bot) === 0) return { ok: false, reason: 'no_raw_food' }
      const n = rawFoodCount(bot)
      if (!planFuel(bot, Math.min(n, 4)) ) return { ok: false, reason: 'no_fuel' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.cooked ?? 0}:${ctx.state.waited ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const raw = items(bot).filter((i) => RAW_RE.test(i.name)).sort((a, b) => (a.name === 'kelp') - (b.name === 'kelp') || b.count - a.count)[0]   // FOOD1: real meat first, kelp (dried_kelp is only +1) last
      if (!raw) return { ok: false, reason: 'no_raw_food' }
      const cookedName = COOKED_OF[raw.name]
      const count = Math.min(raw.count, 8)
      const fuel = planFuel(bot, count)
      if (!fuel) return { ok: false, reason: 'no_fuel' }
      const before = countItem(bot, cookedName)
      // 1. a furnace
      ctx.state.stage = 'furnace'
      const got = await acquireFurnace(ctx, env)
      if (got.fail) return got.fail
      const fb = got.fb
      if (dist3(bot.entity.position, fb.position) > 3.2) {
        const g = await ctx.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), { timeoutMs: 25000 })
        if (!g.ok) return { ok: false, reason: g.reason ?? 'unreachable' }
      }
      // 2. load
      ctx.state.stage = 'load'
      const fuel2 = planFuel(bot, count)   // inventory may have changed (table crafting used planks)
      if (!fuel2) return { ok: false, reason: 'no_fuel' }
      let furnace
      try { furnace = await bot.openFurnace(fb) } catch (e) { ctx.log('cook_open_error', { message: String(e.message).slice(0, 100) }); return { ok: false, reason: 'cannot_open' } }
      ctx.state.furnace = furnace
      try {
        for (const f of fuel2) { try { await furnace.putFuel(f.item.type, null, f.count) } catch (e) { ctx.log('cook_fuel_error', { message: String(e.message).slice(0, 100) }) } }
        if (!furnace.fuelItem?.() && !(furnace.fuel > 0)) { try { await ctx.sleep(300) } catch { /* ignore */ } }
        try { await furnace.putInput(raw.type, null, count) } catch (e) { ctx.log('cook_input_error', { message: String(e.message).slice(0, 100) }); return { ok: false, reason: 'cannot_load' } }
        // 3. wait and collect (the smelting itself is the declared wait budget: progress ticks while it runs)
        ctx.state.stage = 'smelt'
        const t0 = Date.now(), budget = count * SMELT_MS + 8000
        let got = 0
        while (!ctx.aborted && Date.now() - t0 < budget) {
          await ctx.sleep(1500)
          ctx.state.waited = Math.round((Date.now() - t0) / 1000)
          if (furnace.outputItem?.()) { try { await furnace.takeOutput(); } catch { /* ignore */ } }
          got = countItem(bot, cookedName) - before
          ctx.state.cooked = got
          if (got >= count) break
        }
        if (ctx.aborted) {
          // keep what is cooked; the rest stays in the furnace (a later cook picks it up as output)
          if (furnace.outputItem?.()) { try { await furnace.takeOutput() } catch { /* ignore */ } }
        }
      } finally { try { furnace.close() } catch { /* ignore */ } ctx.state.furnace = null }
      const gained = countItem(bot, cookedName) - before
      return gained > 0 ? { ok: true } : { ok: false, reason: ctx.aborted ? 'aborted' : 'nothing_cooked' }
    },
    abort: (_r, ctx) => { try { ctx.state.furnace?.close() } catch { /* ignore */ } },
  }
}
export { COOKED_RE }
