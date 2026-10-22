// eat, sleep, place_torch. Ground truth: food level/item delta, bot.isSleeping, torch block exists.
import { foodForbidden, EMERGENCY_OK } from '../foodguard.js'
import { goals, dist3, V, items, countItem, countMatch, isNight, isThunder, timeOfDay, placeNearby, DANGER_FLOOR } from './lib.js'

const BAD_FOOD = new Set(['pufferfish', 'spider_eye', 'poisonous_potato', 'chorus_fruit', 'rotten_flesh', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot'])

/** SURV1: risky food (rotten flesh...) is eaten when the body needs it: starving (food <= 6) or hurt with regeneration blocked (food < 18). */
export const REGEN_FOOD = 18
export function needsBadFood(bot) { return (bot.food ?? 20) <= 6 || ((bot.health ?? 20) <= 6 && (bot.food ?? 20) < REGEN_FOOD) }
/** RS3 eat_emergency (RS2 entry 26): of the "bad" foods only these may be eaten in an emergency (rotten flesh: 4 hunger, 80 % Hunger for 30 s; golden food is just good food).
 *  Spider eye, poisonous potato, pufferfish, chorus fruit and suspicious stew are never eaten out of hunger: on Easy starving stops at 5 hearts and cannot kill her,
 *  and a poisoned body is worse than a hungry one. She may still NAME such an item herself (her choice, her lesson), except pufferfish (foodguard). */
export { EMERGENCY_OK }
export function edibles(bot, { allowBad = false, also = null } = {}) {
  const foods = bot.registry.foodsByName ?? {}
  const rank = (i) => foods[i.name].foodPoints + foods[i.name].saturation * 0.2
  return items(bot).filter((i) => foods[i.name] && !foodForbidden(i.name, bot.health) && (!BAD_FOOD.has(i.name) || i.name === also || (allowBad && EMERGENCY_OK.has(i.name))))
    .sort((a, b) => (BAD_FOOD.has(a.name) ? 1 : 0) - (BAD_FOOD.has(b.name) ? 1 : 0) || rank(b) - rank(a))   // everything better first, bad food last
}
/** RS3: what an emergency meal would do, for tests and the menu. Pure. -> { emergency, aim, pool:[names] } */
export function emergencyPlan(bot) {
  const emergency = needsBadFood(bot)
  return { emergency, aim: emergency ? REGEN_FOOD : 20, pool: edibles(bot, { allowBad: emergency }).map((i) => i.name) }
}

export function makeEat() {
  return {
    name: 'eat', max_s: 30, stall_s: 15,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (bot.food >= 20) return { ok: false, reason: 'not_hungry' }
      if (args.item && foodForbidden(args.item, bot.health)) return { ok: false, reason: 'poison_food' }   // DUSK1: pufferfish (and spider eye / potato when hurt) are refused even when named
      const e = edibles(bot, { allowBad: needsBadFood(bot), also: args.item })   // she may name a risky item herself: her choice, her lesson
      if (!e.length) return { ok: false, reason: 'no_food' }
      if (args.item && !e.some((i) => i.name === args.item)) return { ok: false, reason: 'no_such_food' }
      return true
    },
    progress_fn: (ctx) => `${ctx.bot.food}:${ctx.state.step ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      let guard = 0
      const startFood = bot.food
      // RS3 eat_emergency: the emergency is decided ONCE at the start (food <= 6, or hurt with regeneration blocked) and kept for the whole meal: eat good food first, then rotten flesh,
      // until food >= 18 (the level where natural regeneration starts), so one meal is enough to heal. Bad food is never eaten past 18; good food continues to 20.
      const emerg = needsBadFood(bot)
      // eat-to-regen: hurt bodies only heal while food >= 18, so keep eating past the first bite (a drive, not a script: stops when food items run out or the gap is tiny)
      while (bot.food < 20 && guard++ < 14 && !ctx.aborted) {
        const pool = edibles(bot, { allowBad: emerg, also: ctx.args.item })
        const it = (ctx.args.item && pool.find((i) => i.name === ctx.args.item)) || pool[0]
        if (!it) break
        const bad = BAD_FOOD.has(it.name) && !/^golden_/.test(it.name)
        if (bad && bot.food >= REGEN_FOOD) break
        // do not waste a big food on a tiny gap: cooked meat gives 6-8
        const pts = bot.registry.foodsByName[it.name].foodPoints
        if (20 - bot.food < Math.min(pts, 2) ) break
        const before = it.count, food0 = bot.food
        ctx.state.step = (ctx.state.step ?? 0) + 1
        // SURV2: a reflex taking the body must not wait 2 s for a bite to finish
        try { await bot.equip(it, 'hand'); await Promise.race([bot.consume(), new Promise((res) => { const iv = setInterval(() => { if (ctx.aborted) { clearInterval(iv); res() } }, 40); setTimeout(() => clearInterval(iv), 6000) })]) } catch (e) { ctx.log('eat_error', { message: String(e.message).slice(0, 100) }); if (ctx.aborted) break; await ctx.sleep(300); continue }
        await ctx.sleep(200)
        if (bot.food <= food0 && countItem(bot, it.name) >= before) break
      }
      if (bot.food > startFood) return { ok: true, reason: emerg ? (bot.food >= REGEN_FOOD ? 'emergency_fed' : 'emergency_partly_fed') : undefined, detail: emerg ? `food ${startFood} -> ${bot.food}${bot.food >= REGEN_FOOD ? ': natural regeneration is on' : ': below 18, no natural regeneration yet'}` : undefined }
      return { ok: false, reason: ctx.aborted ? 'aborted' : 'food_not_increased' }
    },
    abort: (_r, ctx) => { try { ctx.bot.deactivateItem() } catch { /* ignore */ } },
  }
}

/** PB2: free standable cells next to a bed (both halves, incl. diagonals), nearest to `from` first. Walking to GoalNear(bed, 2) could pick a cell on the far side of a
 *  shelter wall (or inside a wall) and "keep getting stuck"; the goal is now ANY of the cells a body can actually stand in beside the bed. */
export function bedApproachCells(bot, bed, from = bot.entity?.position) {
  const isBed = (b) => !!b && (bot.isABed?.(b) ?? /_bed$/.test(b.name))
  const halves = [bed.position]
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = bot.blockAt(bed.position.offset(dx, 0, dz)); if (isBed(n)) halves.push(n.position) }
  const solid = (b) => !!b && b.boundingBox === 'block'
  const bad = (b) => !b || /lava|water|fire|cactus|magma|campfire|sweet_berry/.test(b.name)
  const seen = new Set(), out = []
  for (const h of halves) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue
    const c = h.offset(dx, 0, dz), key = `${c.x},${c.y},${c.z}`
    if (seen.has(key) || halves.some((q) => q.x === c.x && q.y === c.y && q.z === c.z)) continue
    seen.add(key)
    const feet = bot.blockAt(c), head = bot.blockAt(c.offset(0, 1, 0)), floor = bot.blockAt(c.offset(0, -1, 0))
    if (!feet || solid(feet) || bad(feet) || isBed(feet) || solid(head) || bad(head) || !solid(floor) || DANGER_FLOOR.has(floor.name) || /leaves/.test(floor.name)) continue
    out.push(c)
  }
  if (from) out.sort((a, b) => dist3(a, from) - dist3(b, from))
  return out
}

/** SURV3: the SERVER refused a bed ("You can sleep only at night") while the client clock/weather said night (5x not_night in daylight).
 *  Remember it so the next try ends in 1 ms with the dusk time instead of walking to the bed again. Expires with the client's dusk estimate (>= 60 s, <= 10 min); client says night: 90 s. */
const DAY_TICKS_PER_MS = 24000 / (20 * 60 * 1000)
export function duskInMs(bot) { const t = timeOfDay(bot); return t < 12542 ? Math.ceil((12542 - t) / DAY_TICKS_PER_MS) : 0 }
export function noteSleepRefused(bot) { bot.__sleepRefusedDay = { at: Date.now(), ttl: Math.min(10 * 60000, Math.max(duskInMs(bot), 0) || 90000, Math.max(60000, duskInMs(bot) || 90000)) } }
export function sleepRefusedNow(bot, now = Date.now()) {
  const r = bot?.__sleepRefusedDay
  if (!r) return null
  if (now - r.at > r.ttl) { bot.__sleepRefusedDay = null; return null }
  const minLeft = Math.max(1, Math.ceil((r.ttl - (now - r.at)) / 60000))
  return { dusk_min: Math.max(1, Math.ceil(duskInMs(bot) / 60000) || minLeft) }
}

export function makeSleep(env) {
  const { landmarks } = env
  const findBed = (bot, r = 48) => bot.findBlock({ matching: (b) => bot.isABed(b) && b.name.endsWith('_bed') && b.getProperties?.().part !== 'foot', maxDistance: r })
    ?? bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: r })
  return {
    name: 'sleep', max_s: 200, stall_s: 40,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!(isNight(bot) || isThunder(bot))) return { ok: false, reason: 'not_night', detail: `not night yet (dusk in ${Math.max(1, Math.ceil(duskInMs(bot) / 60000))} min)` }
      const ref = sleepRefusedNow(bot)
      if (ref) return { ok: false, reason: 'not_night', detail: `the server says it is day (dusk in about ${ref.dusk_min} min); not asking again before then` }
      if (!findBed(bot) && !landmarks?.get?.('bed') && !items(bot).some((i) => i.name.endsWith('_bed'))) return { ok: false, reason: 'no_bed' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.best ?? ''}:${ctx.state.sleepTicks ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      let bed = findBed(bot)
      // PB2: the bed she remembers may be farther than the 48 blocks findBlock sees (live: "sleep rejected no_bed" with the bed 66 m away): walk toward it, then look again
      for (let hop = 0; !bed && hop < 3 && !ctx.aborted; hop++) {
        const lm = landmarks?.get?.('bed'); if (!lm) break
        ctx.state.stage = 'walk_far'
        const r = await ctx.goto(new goals.GoalNear(lm.x, lm.y, lm.z, 6), { timeoutMs: 45000 })
        bed = findBed(bot)
        if (!r.ok && !bed) break
      }
      if (!bed) {
        ctx.state.stage = 'place'
        const bedItem = items(bot).find((i) => i.name.endsWith('_bed'))
        const at = bedItem && await placeNearby(bot, bedItem.name)
        if (!at) return { ok: false, reason: 'cannot_place_bed' }
        bed = bot.blockAt(at)
        if (!bed || !bot.isABed(bed)) return { ok: false, reason: 'cannot_place_bed' }
        landmarks?.set('bed', bed.position, 'bed')
      }
      landmarks?.set('bed', bed.position, 'bed')
      let lastReason = 'unknown'
      for (let attempt = 0; attempt < 3 && !ctx.aborted; attempt++) {
        ctx.state.stage = 'walk'
        const track = setInterval(() => { try { ctx.state.best = Math.round(dist3(bot.entity.position, bed.position)) } catch { /* ignore */ } }, 300)
        const cells = bedApproachCells(bot, bed)
        const goal = cells.length ? new goals.GoalCompositeAny(cells.map((c) => new goals.GoalBlock(c.x, c.y, c.z))) : new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)
        ctx.state.approach = cells.length
        let r = await ctx.goto(goal, { timeoutMs: 40000 })
        if (!r.ok && cells.length) r = await ctx.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { timeoutMs: 15000 })
        clearInterval(track)
        if (!r.ok) { lastReason = r.reason; continue }
        try {
          await bot.sleep(bed)
          break
        } catch (e) {
          const m = String(e.message)
          lastReason = /occupied/i.test(m) ? 'bed_occupied' : /too far/i.test(m) ? 'too_far' : /monster/i.test(m) ? 'monsters_nearby' : /night|day/i.test(m) ? 'not_night' : /obstructed|not a bed/i.test(m) ? 'bed_blocked' : 'sleep_failed'
          if (lastReason === 'not_night') noteSleepRefused(bot)
          if (lastReason === 'bed_occupied' || lastReason === 'monsters_nearby' || lastReason === 'not_night') return { ok: false, reason: lastReason }
          await ctx.sleep(500)
        }
      }
      if (!bot.isSleeping) return { ok: false, reason: ctx.aborted ? 'aborted' : lastReason }
      ctx.state.stage = 'asleep'
      const stay = (ctx.args.max_stay_s ?? 120) * 1000
      const t0 = Date.now()
      while (bot.isSleeping && !ctx.aborted && Date.now() - t0 < stay) { ctx.state.sleepTicks = (ctx.state.sleepTicks ?? 0) + 1; await ctx.sleep(1000) } // declared wait budget
      const slept = Date.now() - t0
      if (bot.isSleeping) { try { await bot.wake() } catch { /* ignore */ } }
      return slept >= 3000 ? { ok: true, reason: 'slept' } : { ok: false, reason: 'woke_early' }
    },
    abort: async (_r, ctx) => { try { if (ctx.bot.isSleeping) await ctx.bot.wake() } catch { /* ignore */ } },
  }
}

export const TORCH_LIGHT = 4
/** Effective light: block light, or sky light reduced by the night (sky 15 at night counts as ~4). */
export function lightAt(bot, p) {
  const b = bot.blockAt(p)
  if (!b) return 15
  const sky = (b.skyLight ?? 0) - (isNight(bot) ? 11 : 0) - (isThunder(bot) ? 3 : 0)
  return Math.max(b.light ?? 0, sky, 0)
}

export function makePlaceTorch() {
  return {
    name: 'place_torch', max_s: 20, stall_s: 15,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (countItem(bot, 'torch') === 0) return { ok: false, reason: 'no_torch' }
      const lvl = args.level ?? TORCH_LIGHT
      if (lightAt(bot, bot.entity.position.floored()) > lvl && !args.force) return { ok: false, reason: 'light_ok' }
      // a torch within 5 blocks already lights this spot (client light data can lag after a placement): place elsewhere
      if (!args.force) { try { if (bot.findBlock({ matching: (b) => /(^|_)torch$/.test(b?.name ?? ''), maxDistance: 5 })) return { ok: false, reason: 'torch_nearby' } } catch { /* no world */ } }
      return true
    },
    progress_fn: (ctx) => ctx.state.step ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const before = countItem(bot, 'torch')
      ctx.state.step = 1
      const at = await placeNearby(bot, 'torch')
      ctx.state.step = 2
      await ctx.sleep(400)
      if (!at) return { ok: false, reason: 'no_spot' }
      const b = bot.blockAt(at)
      if (!b || !/torch/.test(b.name) || countItem(bot, 'torch') >= before) return { ok: false, reason: 'not_placed' }
      ctx.state.at = [at.x, at.y, at.z]
      return { ok: true }
    },
  }
}
