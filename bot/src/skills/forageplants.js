// DAY1: `forage_plants` skill: legit vanilla plant food when no animal is near. Ripe sweet berry bushes (right-click, the bush stays), ripe crops
// (wheat excluded: not edible raw), melons, and as a last resort apples from oak/dark oak leaves (breaking leaves, ~1 apple per 200 leaves, capped).
// Success = edible item delta in the inventory, never a claim.
import { goals, dist3, V, items, freeSlots, collectDrops } from './lib.js'
import { waterRisk, nearWater } from '../water-policy.js'

const EDIBLE = /^(sweet_berries|apple|carrot|potato|beetroot|melon_slice|glow_berries)$/
export const FORAGE_ITEMS = EDIBLE
const RIPE = { carrots: 7, potatoes: 7, beetroots: 3, sweet_berry_bush: 2 }
const age = (b) => { try { const p = b.getProperties?.(); if (p && p.age !== undefined) return Number(p.age) } catch { /* ignore */ } return b.metadata ?? 0 }
const count = (bot) => items(bot).filter((i) => EDIBLE.test(i.name)).reduce((s, i) => s + i.count, 0)

/** [{block, kind, d}] ripe plant food within r blocks, nearest first (pure on bot.findBlocks / blockAt) */
export function plantTargets(bot, r = 40) {
  const me = bot.entity.position, out = []
  const names = ['sweet_berry_bush', 'carrots', 'potatoes', 'beetroots', 'melon']
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
  if (!ids.length) return out
  for (const p of bot.findBlocks({ matching: ids, maxDistance: r, count: 40 }) ?? []) {
    const b = bot.blockAt(p); if (!b) continue
    if (b.name in RIPE && age(b) < RIPE[b.name]) continue
    out.push({ block: b, kind: b.name, d: dist3(p, me) })
  }
  return out.sort((a, b) => a.d - b.d)
}
export function leafTargets(bot, r = 24) {
  const ids = ['oak_leaves', 'dark_oak_leaves'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
  if (!ids.length) return []
  const me = bot.entity.position
  return (bot.findBlocks({ matching: ids, maxDistance: r, count: 60 }) ?? []).map((p) => ({ block: bot.blockAt(p), kind: 'leaves', d: dist3(p, me) })).filter((t) => t.block && !(t.block.getProperties?.().persistent === true || t.block.getProperties?.().persistent === 'true')).sort((a, b) => a.d - b.d)
}

// FOOD3: an empty search is remembered (place + time): the same search 30 m from there within 120 s answers at once, so callers move on to hunt / expedition.
const EMPTY_MS = 120000, EMPTY_M = 30
export const emptySearch = { t: 0, x: 0, z: 0 }
export function recentEmpty(bot, now = Date.now()) {
  const p = bot?.entity?.position
  return !!p && emptySearch.t > 0 && now - emptySearch.t < EMPTY_MS && Math.hypot(p.x - emptySearch.x, p.z - emptySearch.z) < EMPTY_M
}
function markEmpty(bot) { const p = bot.entity.position; emptySearch.t = Date.now(); emptySearch.x = p.x; emptySearch.z = p.z }

export function makeForagePlants() {
  return {
    name: 'forage_plants', max_s: 120, stall_s: 25,
    precondition: ({ bot }) => {
      if (!(!!bot?.entity && bot.health > 0 && freeSlots(bot) >= 1)) return { ok: false, reason: 'inventory_full' }
      if (recentEmpty(bot)) return { ok: false, reason: 'no_target_found', detail: 'searched here less than 2 min ago: no plants; hunt, fish or walk to a new area instead' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.n ?? 0}:${ctx.state.got ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, before = count(bot), want = ctx.args.count ?? 4
      ctx.state.n = 0
      let targets = plantTargets(bot), leaves = false
      if (!targets.length) { targets = leafTargets(bot); leaves = true }
      if (!targets.length) { markEmpty(bot); return { ok: false, reason: 'no_target_found', detail: 'no ripe berry bush, crop, melon or oak leaves within 40 m' } }
      if (waterRisk(bot)) targets = targets.filter((t) => !nearWater(bot, t.block.position, 1))   // WATER1: hurt / night: no plant that needs wet feet
      if (!targets.length) return { ok: false, reason: 'no_target_found', detail: 'only plants at the water edge (hurt or night: not entering water)' }
      for (const t of targets.slice(0, leaves ? 40 : 12)) {
        if (ctx.aborted || count(bot) - before >= (leaves ? 1 : want)) break
        const p = t.block.position
        const ok = await ctx.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { timeoutMs: 15000 })
        if (ok && ok.ok === false) continue
        const cur = bot.blockAt(p); if (!cur || cur.name !== t.block.name) continue
        try {
          await bot.lookAt(V(p.x + 0.5, p.y + 0.5, p.z + 0.5))
          if (t.kind === 'sweet_berry_bush') await bot.activateBlock(cur)
          else await bot.dig(cur)
        } catch { continue }
        ctx.state.n++
        await ctx.sleep(300)
        await collectDrops(ctx, p, { r: 5, max: 2 })
        ctx.state.got = count(bot) - before
      }
      ctx.state.got = count(bot) - before
      return ctx.state.got > 0 ? { ok: true } : { ok: false, reason: 'nothing_gained', detail: leaves ? 'no apple dropped from the leaves I broke' : 'the plants I reached gave nothing' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}
