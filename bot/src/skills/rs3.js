// RS3 skills: make_charcoal (logs -> charcoal, no coal needed), collect_eggs / throw_eggs (chicken loop), bonemeal_ripen (S2 only), take_hay (village).
// All results are counted from the pack or the world, never claimed. Numbers that RS2 marked [G] (to measure on the 1.21.1 server) are logged, not assumed.
import { goals, V, dist3, items, countItem, countMatch, collectDrops, freeSlots, isNight, isThunder } from './lib.js'
import { acquireFurnace } from './cook.js'
import { craftItem } from './craft.js'
import { isBaby } from './farm1.js'
import { cropRipe, cropAge, ringStands } from './activities.js'

const logsOf = (bot) => { const o = {}; for (const i of items(bot)) if (/_log$/.test(i.name)) o[i.name] = (o[i.name] ?? 0) + i.count; return o }

/**
 * How many charcoal can this pack make? One log smelts into 1 charcoal (10 s); a log or plank burns 1.5 items (RS2 entry 32). Input = the log type she holds most of,
 * fuel = the other logs first, then planks, then the rest of the input type. Pure. -> { k, input, fuel:[{name,count}], need }
 * k = charcoal that can be made now (<= want); need = logs she would have to hold for `want` (for the playbook's wood step).
 */
export function charcoalPlan(inv, want = 4) {
  const logs = inv.logs ?? {}, planks = inv.planks ?? 0
  const types = Object.entries(logs).sort((a, b) => b[1] - a[1])
  const total = types.reduce((s, [, n]) => s + n, 0)
  const need = Math.ceil(want / 0.6)   // k <= 0.6 * logs when the fuel is logs too
  if (!types.length) return { k: 0, input: null, fuel: [], need }
  const [inName, inN] = types[0]
  const other = total - inN
  let k = 0
  for (let c = Math.min(want, inN); c >= 1; c--) if (1.5 * (planks + other + (inN - c)) + 1e-9 >= c) { k = c; break }
  if (!k) return { k: 0, input: inName, fuel: [], need }
  let units = Math.ceil(k / 1.5), fuel = []
  const take = (name, have) => { const n = Math.min(have, units); if (n > 0) { fuel.push({ name, count: n }); units -= n } }
  for (const [name, n] of types.slice(1)) take(name, n)
  if (units > 0) take('planks', planks)
  if (units > 0) take(inName, inN - k)
  return { k, input: inName, fuel, need }
}
export const invForCharcoal = (bot) => ({ logs: logsOf(bot), planks: countMatch(bot, /_planks$/) })

const dayOk = (bot) => !(isNight(bot) || isThunder(bot))
const SMELT_MS = 10000

function makeCharcoal(env) {
  return {
    name: 'make_charcoal', max_s: 220, stall_s: 45,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      const plan = charcoalPlan(invForCharcoal(bot), args?.count ?? 4)
      if (!plan.k) return { ok: false, reason: 'not_enough_logs', detail: `charcoal needs about ${plan.need} logs for ${args?.count ?? 4} (the logs are also the fuel); you hold ${Object.values(logsOf(bot)).reduce((a, b) => a + b, 0)} logs and ${countMatch(bot, /_planks$/)} planks` }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.made ?? 0}:${ctx.state.waited ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = ctx.args.count ?? 4
      ctx.state.stage = 'furnace'
      const got = await acquireFurnace(ctx, env)
      if (got.fail) return got.fail
      const fb = got.fb
      if (dist3(bot.entity.position, fb.position) > 3.2) {
        const g = await ctx.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), { timeoutMs: 25000 })
        if (!g.ok) return { ok: false, reason: g.reason ?? 'unreachable' }
      }
      const plan = charcoalPlan(invForCharcoal(bot), want)   // the table / furnace crafting may have used planks
      if (!plan.k) return { ok: false, reason: 'not_enough_logs', detail: `after making the furnace ${Object.values(logsOf(bot)).reduce((a, b) => a + b, 0)} logs are left` }
      const before = countItem(bot, 'charcoal')
      ctx.state.stage = 'load'
      let furnace
      try { furnace = await bot.openFurnace(fb) } catch (e) { ctx.log('charcoal_open_error', { message: String(e?.message).slice(0, 100) }); return { ok: false, reason: 'cannot_open' } }
      ctx.state.furnace = furnace
      try {
        for (const f of plan.fuel) {
          const it = items(bot).find((i) => (f.name === 'planks' ? /_planks$/.test(i.name) : i.name === f.name)); if (!it) continue
          try { await furnace.putFuel(it.type, null, Math.min(f.count, it.count)) } catch (e) { ctx.log('charcoal_fuel_error', { message: String(e?.message).slice(0, 100) }) }
        }
        const inp = items(bot).find((i) => i.name === plan.input)
        if (!inp) return { ok: false, reason: 'cannot_load' }
        try { await furnace.putInput(inp.type, null, plan.k) } catch (e) { ctx.log('charcoal_input_error', { message: String(e?.message).slice(0, 100) }); return { ok: false, reason: 'cannot_load' } }
        ctx.state.stage = 'smelt'
        const t0 = Date.now(), budget = plan.k * SMELT_MS + 8000
        while (!ctx.aborted && Date.now() - t0 < budget) {
          await ctx.sleep(1500)
          ctx.state.waited = Math.round((Date.now() - t0) / 1000)
          if (furnace.outputItem?.()) { try { await furnace.takeOutput() } catch { /* ignore */ } }
          ctx.state.made = countItem(bot, 'charcoal') - before
          if (ctx.state.made >= plan.k) break
        }
        if (furnace.outputItem?.()) { try { await furnace.takeOutput() } catch { /* ignore */ } }
      } finally { try { furnace.close() } catch { /* ignore */ } ctx.state.furnace = null }
      const made = countItem(bot, 'charcoal') - before
      ctx.state.made = made
      ctx.log('make_charcoal', { planned: plan.k, made, input: plan.input, fuel: plan.fuel })
      if (made > 0) return { ok: true, reason: made >= want ? 'charcoal_made' : 'charcoal_partly', detail: `${made} charcoal from ${plan.k} ${plan.input}` }
      return { ok: false, reason: ctx.aborted ? 'aborted' : 'nothing_smelted', detail: 'the furnace gave no charcoal in time' }
    },
    abort: (_r, ctx) => { try { ctx.state.furnace?.close() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ eggs
export const CHICKEN_CAP = 8   // total chickens (adults + chicks) near the pen before more eggs are not thrown
const chickens = (bot, c, r) => Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && e.name === 'chicken' && e.isValid !== false && dist3(e.position, c) <= r)
export const eggCount = (bot) => countItem(bot, 'egg')

function makeCollectEggs() {
  return {
    name: 'collect_eggs', max_s: 60, stall_s: 20,
    precondition: ({ bot }) => (!bot?.entity || bot.health <= 0 ? false : freeSlots(bot) < 1 ? { ok: false, reason: 'inventory_full' } : true),
    progress_fn: (ctx) => `${ctx.state.seen ?? 0}:${ctx.state.got ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, before = eggCount(bot), r = ctx.args.radius ?? 16
      const eggsOnGround = () => Object.values(bot.entities ?? {}).filter((e) => e && e.name === 'item' && e.position && dist3(e.position, bot.entity.position) <= r && (() => { try { return e.getDroppedItem?.()?.name === 'egg' } catch { return false } })())
      const seen = eggsOnGround(); ctx.state.seen = seen.length
      for (const e of seen.slice(0, 8)) {
        if (ctx.aborted) break
        await ctx.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.7), { timeoutMs: 6000 })
        await ctx.sleep(250)
        ctx.state.got = eggCount(bot) - before
      }
      const got = eggCount(bot) - before; ctx.state.got = got
      return got > 0 ? { ok: true, reason: 'eggs_collected', detail: `${got} egg${got === 1 ? '' : 's'} picked up` } : { ok: false, reason: 'no_eggs_seen', detail: seen.length ? 'saw eggs but could not pick them up' : 'no egg lying on the ground within ' + r + ' m (a hen lays one every 5-10 min)' }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

function makeThrowEggs(env) {
  return {
    name: 'throw_eggs', max_s: 60, stall_s: 20,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!eggCount(bot)) return { ok: false, reason: 'no_eggs' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.thrown ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = Math.min(ctx.args.count ?? 4, eggCount(bot))
      const pen = env.landmarks?.get?.('pen')
      const center = pen && dist3(pen, bot.entity.position) <= 30 ? V(pen.x + 0.5, pen.y, pen.z + 0.5) : null
      const near = chickens(bot, center ?? bot.entity.position, center ? 6 : 14)
      if (!near.length) return { ok: false, reason: 'no_chickens', detail: 'no chicken near the pen / near me to throw eggs at' }
      if (near.length >= CHICKEN_CAP) return { ok: false, reason: 'chickens_enough', detail: `${near.length} chickens already (cap ${CHICKEN_CAP}); keep the eggs for cooking` }
      const aim = center ?? near[0].position
      const babiesBefore = chickens(bot, aim, 8).filter(isBaby).length
      // 4-6 blocks from the target, on the open side
      if (dist3(bot.entity.position, aim) > 6 || dist3(bot.entity.position, aim) < 3) await ctx.goto(new goals.GoalNear(aim.x, aim.y, aim.z, 5), { timeoutMs: 12000 })
      let thrown = 0
      const egg = () => items(bot).find((i) => i.name === 'egg')
      for (let n = 0; n < want && !ctx.aborted; n++) {
        const it = egg(); if (!it) break
        try { await bot.equip(it, 'hand'); await bot.lookAt(aim.offset(0, 0.3, 0)); bot.activateItem(); thrown++; ctx.state.thrown = thrown } catch { break }
        await ctx.sleep(900)
      }
      await ctx.sleep(1200)
      const babiesAfter = chickens(bot, aim, 8).filter(isBaby).length
      const chicks = Math.max(0, babiesAfter - babiesBefore)
      ctx.log('throw_eggs', { thrown, chicks, chickens: near.length })
      return thrown > 0 ? { ok: true, reason: chicks ? 'chicks_hatched' : 'thrown', detail: `threw ${thrown} egg${thrown === 1 ? '' : 's'}, ${chicks} new chick${chicks === 1 ? '' : 's'} seen (about 1 egg in 8 hatches a chick)` } : { ok: false, reason: 'could_not_throw' }
    },
    abort: (_r, ctx) => { try { ctx.bot.deactivateItem?.() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ bone meal on crops
const CROP_NAMES = ['wheat', 'carrots', 'potatoes', 'beetroots']
export const BONEMEAL_MAX_PER_CROP = 5   // RS2 entry 6: wheat takes 2-5 stages per use, so 5 uses always ripen it

function makeBonemealRipen(env) {
  return {
    name: 'bonemeal_ripen', max_s: 120, stall_s: 30,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!countItem(bot, 'bone_meal')) return { ok: false, reason: 'no_bone_meal' }
      if (!env.landmarks?.get?.('farm')) return { ok: false, reason: 'no_farm_known' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.used ?? 0}:${ctx.state.ripe ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, lm = env.landmarks.get('farm')
      const ids = CROP_NAMES.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
      const crops = () => (bot.findBlocks?.({ matching: ids, maxDistance: 12, count: 40, point: V(lm.x, lm.y, lm.z) }) ?? []).map((p) => bot.blockAt(p)).filter((b) => b && Math.hypot(b.position.x - lm.x, b.position.z - lm.z) <= 4)
      let list = crops()
      if (!list.length) return { ok: false, reason: 'no_crops_found', detail: 'nothing is planted on the plot' }
      const ripe0 = list.filter(cropRipe).length
      if (ripe0 === list.length) return { ok: false, reason: 'already_ripe', detail: `all ${list.length} crops are ripe: harvest instead` }
      let used = 0
      for (const c of list) {
        if (ctx.aborted) break
        let cur = bot.blockAt(c.position)
        for (let k = 0; k < BONEMEAL_MAX_PER_CROP && cur && !cropRipe(cur) && !ctx.aborted; k++) {
          const bm = items(bot).find((i) => i.name === 'bone_meal'); if (!bm) break
          const stands = ringStands(bot, { x: lm.x, y: lm.y - 1, z: lm.z })
          if (dist3(bot.entity.position, c.position) > 4.2 && stands.length) {
            const s = stands.sort((a, b) => dist3(a, c.position) - dist3(b, c.position))[0]
            await ctx.goto(new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 10000 })
          }
          try { await bot.equip(bm, 'hand'); await bot.lookAt(V(c.position.x + 0.5, c.position.y + 0.5, c.position.z + 0.5)); await bot.activateBlock(cur) } catch { break }
          used++; ctx.state.used = used
          await ctx.sleep(350)
          cur = bot.blockAt(c.position)
        }
        ctx.state.ripe = crops().filter(cropRipe).length
      }
      list = crops()
      const ripe = list.filter(cropRipe).length
      ctx.state.ripe = ripe
      ctx.log('bonemeal_ripen', { used, ripe0, ripe, crops: list.length, ages: list.map((b) => cropAge(b)) })
      return ripe > ripe0 ? { ok: true, reason: 'crops_ripened', detail: `${used} bone meal: ${ripe0} -> ${ripe} of ${list.length} crops ripe` } : { ok: false, reason: used ? 'not_ripened' : 'no_bone_meal_used', detail: `${used} bone meal used, ripe ${ripe0} -> ${ripe} of ${list.length}` }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ village hay
function makeTakeHay(env) {
  return {
    name: 'take_hay', max_s: 120, stall_s: 30,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!dayOk(bot)) return { ok: false, reason: 'night' }
      if (freeSlots(bot) < 1) return { ok: false, reason: 'inventory_full' }
      const id = bot.registry.blocksByName.hay_block?.id
      if (id === undefined || !(bot.findBlocks?.({ matching: id, maxDistance: 40, count: 1 }) ?? []).length) return { ok: false, reason: 'no_hay_seen', detail: 'no hay bale within 40 m' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.taken ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = ctx.args.count ?? 3, keep = ctx.args.keep ?? 1
      const id = bot.registry.blocksByName.hay_block.id
      const bales = (bot.findBlocks?.({ matching: id, maxDistance: 40, count: 40 }) ?? []).sort((a, b) => dist3(a, bot.entity.position) - dist3(b, bot.entity.position))
      const take = Math.max(0, Math.min(want, bales.length - keep))
      if (take <= 0) return { ok: false, reason: 'last_bale_kept', detail: `${bales.length} bale${bales.length === 1 ? '' : 's'} in view; the village keeps ${keep} (policy), nothing taken` }
      const before = countItem(bot, 'hay_block'), wheat0 = countItem(bot, 'wheat')
      let taken = 0
      for (const p of bales.slice(0, take)) {
        if (ctx.aborted) break
        const r = await ctx.goto(new goals.GoalNear(p.x, p.y, p.z, 3), { timeoutMs: 15000 }); if (r && r.ok === false) continue
        const b = bot.blockAt(p); if (!b || b.name !== 'hay_block') continue
        try { await bot.lookAt(V(p.x + 0.5, p.y + 0.5, p.z + 0.5)); await bot.dig(b) } catch { continue }
        await ctx.sleep(300)
        await collectDrops(ctx, p, { r: 5, max: 2 })
        taken = countItem(bot, 'hay_block') - before; ctx.state.taken = taken
      }
      taken = countItem(bot, 'hay_block') - before
      let crafted = false
      if (taken > 0) { const c = await craftItem(ctx, 'wheat', taken * 9, env); crafted = !!c.ok; if (!c.ok) ctx.log('hay_craft_failed', { reason: c.reason }) }
      const wheat = countItem(bot, 'wheat') - wheat0
      ctx.log('take_hay', { bales: bales.length, taken, wheat })
      if (taken <= 0) return { ok: false, reason: 'nothing_taken', detail: 'could not break or pick up a hay bale' }
      return { ok: true, reason: crafted ? 'hay_to_wheat' : 'hay_taken', detail: `${taken} bale${taken === 1 ? '' : 's'} taken (${bales.length - taken} left in the village), ${wheat} wheat in the pack` }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

// ------------------------------------------------------------------ harvest_ripe (village crops)
const SEED_FOR = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }
const CROP_ITEMS = /^(wheat|carrot|potato|beetroot|wheat_seeds|beetroot_seeds)$/
const cropItems = (bot) => countMatch(bot, CROP_ITEMS)

function makeHarvestRipe() {
  return {
    name: 'harvest_ripe', max_s: 120, stall_s: 30,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!dayOk(bot)) return { ok: false, reason: 'night' }
      if (freeSlots(bot) < 1) return { ok: false, reason: 'inventory_full' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.harvested ?? 0}:${ctx.state.seen ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = ctx.args.count ?? 12, r = ctx.args.radius ?? 20
      const ids = CROP_NAMES.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
      const found = (bot.findBlocks?.({ matching: ids, maxDistance: r, count: 60 }) ?? []).map((p) => bot.blockAt(p)).filter((b) => b && b.name in SEED_FOR)
      ctx.state.seen = found.length
      if (!found.length) return { ok: false, reason: 'no_crops_seen', detail: `no crops within ${r} m` }
      const ripe = found.filter(cropRipe).sort((a, b) => dist3(a.position, bot.entity.position) - dist3(b.position, bot.entity.position))
      if (!ripe.length) return { ok: false, reason: 'none_ripe', detail: `${found.length} crops in view, none ripe (only ripe ones are taken, unripe ones are left to grow)` }
      const before = cropItems(bot); let harvested = 0, replanted = 0
      for (const c of ripe) {
        if (ctx.aborted || harvested >= want) break
        const name = c.name, floor = bot.blockAt(c.position.offset(0, -1, 0))
        const r2 = await ctx.goto(new goals.GoalNear(c.position.x, c.position.y, c.position.z, 3), { timeoutMs: 10000 }); if (r2 && r2.ok === false) continue
        const cur = bot.blockAt(c.position); if (!cur || cur.name !== name || !cropRipe(cur)) continue
        try { await bot.lookAt(V(c.position.x + 0.5, c.position.y + 0.5, c.position.z + 0.5)); await bot.dig(cur); harvested++; ctx.state.harvested = harvested } catch { continue }
        await ctx.sleep(300)
        await collectDrops(ctx, c.position, { r: 4, max: 3 })
        const sd = items(bot).find((i) => i.name === SEED_FOR[name])
        if (sd && floor?.name === 'farmland') { try { await bot.equip(sd, 'hand'); await bot.activateBlock(floor); await ctx.sleep(150); if (bot.blockAt(c.position)?.name === name) replanted++ } catch { /* ignore */ } }
      }
      const gained = cropItems(bot) - before
      ctx.log('harvest_ripe', { seen: found.length, ripe: ripe.length, harvested, replanted, gained })
      return harvested ? { ok: true, reason: 'harvested', detail: `${harvested} ripe crops taken, ${replanted} replanted, ${gained} items gained` } : { ok: false, reason: 'harvest_failed' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

export function makeRs3Skills(env = {}) {
  return [makeCharcoal(env), makeCollectEggs(env), makeThrowEggs(env), makeBonemealRipen(env), makeTakeHay(env), makeHarvestRipe(env)]
}
