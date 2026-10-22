// PB4: `fish` skill (replaces the bot.fish() wrapper): find water within 16 m, stand on the BANK facing the water, cast (activateItem), wait for the bite
// (bobber velocity dip, entityVelocity, or the splash sound), reel, pick up the catch. 60 s per catch; success = inventory delta, never the model's claim.
import { goals, V, dist3, items, countItem, countMatch, standableY } from './lib.js'

const CATCH = /^(cod|salmon|tropical_fish|pufferfish)$/
const JUNK = /^(bowl|stick|string|bone|leather|ink_sac|lily_pad|saddle|name_tag|nautilus_shell|enchanted_book|fishing_rod|leather_boots|rotten_flesh|tripwire_hook|bamboo|water_bottle|potion)$/
const alive = ({ bot }) => !!bot?.entity && bot.health > 0
const at = (bot, x, y, z) => bot.blockAt(V(x, y, z))
const isBobber = (e) => !!e && /fishing_bobber/.test(e.name ?? e.displayName ?? '') || e?.displayName === 'Fishing Bobber'

/** [{water, bank:{x,y,z}}] candidate pairs: surface water cell and a standable dry cell 1..3 blocks away on the same level, nearest first. */
export function bankSpots(bot, r = 16) {
  const wid = bot.registry.blocksByName.water.id, me = bot.entity.position
  const cells = bot.findBlocks({ matching: wid, maxDistance: r, count: 400 }) ?? []
  const out = []
  for (const w of cells) {
    const up = at(bot, w.x, w.y + 1, w.z); if (!up || up.boundingBox !== 'empty' || up.name === 'water') continue
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => at(bot, w.x + dx, w.y, w.z + dz)?.name === 'water').length
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const k of [1, 2]) {
      const bx = w.x - dx * k, bz = w.z - dz * k, floor = at(bot, bx, w.y, bz), feet = at(bot, bx, w.y + 1, bz), head = at(bot, bx, w.y + 2, bz)
      if (!floor || floor.boundingBox !== 'block' || /water|lava|leaves|cactus|magma/.test(floor.name) || !feet || feet.boundingBox !== 'empty' || feet.name === 'water' || !head || head.boundingBox !== 'empty') continue
      if (k === 2) { const mid = at(bot, w.x - dx, w.y, w.z - dz); if (mid?.name !== 'water' && mid?.boundingBox !== 'empty') continue }
      out.push({ water: w, bank: { x: bx, y: w.y + 1, z: bz }, score: Math.hypot(bx - me.x, bz - me.z) - nb * 1.5 + (k - 1) })
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

export function makeFish() {
  return {
    name: 'fish', max_s: 200, stall_s: 45,
    precondition: ({ bot }) => alive({ bot }) && (countItem(bot, 'fishing_rod') > 0 ? true : { ok: false, reason: 'no_rod' }),
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.ticks ?? 0}:${ctx.state.caught ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, want = ctx.args.catches ?? 1
      const spots = bankSpots(bot, 16); if (!spots.length) return { ok: false, reason: 'no_water' }
      ctx.state.stage = 'walk'
      let spot = null
      for (const s of spots.slice(0, 4)) {
        const d = Math.hypot(s.bank.x + 0.5 - bot.entity.position.x, s.bank.z + 0.5 - bot.entity.position.z)
        if (d < 0.9 && Math.abs(s.bank.y - bot.entity.position.y) < 1) { spot = s; break }
        const r = await ctx.goto(new goals.GoalBlock(s.bank.x, s.bank.y, s.bank.z), { timeoutMs: 25000 }); if (r.ok) { spot = s; break }
      }
      if (!spot) return { ok: false, reason: 'cannot_reach_bank' }
      const rod = items(bot).find((i) => i.name === 'fishing_rod'); await bot.equip(rod, 'hand')
      const inv = () => countMatch(bot, CATCH) + countMatch(bot, JUNK)
      const before = inv(), foodBefore = countMatch(bot, CATCH)
      let bites = 0, caught = 0, casts = 0
      const target = V(spot.water.x + 0.5, spot.water.y + 0.9, spot.water.z + 0.5)
      let splash = 0
      const onSound = (name) => { if (/fishing_bobber\.splash/.test(String(name ?? ''))) splash++ }
      bot.on('soundEffectHeard', onSound); bot.on('hardcodedSoundEffectHeard', onSound)
      try {
        for (let n = 0; n < want && !ctx.aborted; n++) {
          ctx.state.stage = 'cast'
          try { await bot.lookAt(target) } catch { /* ignore */ }
          bot.activateItem(); casts++
          await ctx.sleep(2200)   // the cast itself splashes when the bobber lands: only splashes after this count as bites
          const s0 = splash
          let bob = Object.values(bot.entities).find((e) => isBobber(e) && dist3(e.position, bot.entity.position) < 20)
          if (!bob) { bot.activateItem(); await ctx.sleep(500); continue }   // no bobber: this click reeled something in; recast
          ctx.state.stage = 'wait'
          const t0 = Date.now(); let bite = false
          while (Date.now() - t0 < 60000 && !ctx.aborted) {
            await ctx.sleep(120)
            if (Math.floor((Date.now() - t0) / 5000) !== ctx.state.ticks) ctx.state.ticks = Math.floor((Date.now() - t0) / 5000)
            if (!bob.isValid && bob.isValid !== undefined) { bob = Object.values(bot.entities).find((e) => isBobber(e) && dist3(e.position, bot.entity.position) < 20); if (!bob) break }
            if (splash > s0 || (bob.velocity && bob.velocity.y < -0.15 && Date.now() - t0 > 1500)) { bite = true; break }
          }
          if (!bite) { bot.activateItem(); await ctx.sleep(600); ctx.state.stage = 'timeout'; continue }   // reel in the empty line
          bites++
          ctx.state.stage = 'reel'
          bot.activateItem()
          await ctx.sleep(1200)
          // pick the item up: it flies to us, but step toward stragglers
          for (const e of Object.values(bot.entities)) if (e.name === 'item' && e.position && dist3(e.position, bot.entity.position) < 6) { try { await ctx.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.7), { timeoutMs: 3000 }) } catch { /* ignore */ } }
          await ctx.sleep(500)
          caught = inv() - before; ctx.state.caught = caught
          try { await goBack(ctx, spot) } catch { /* ignore */ }
        }
      } finally { bot.removeListener('soundEffectHeard', onSound); bot.removeListener('hardcodedSoundEffectHeard', onSound); try { if (Object.values(bot.entities).some(isBobber)) bot.activateItem() } catch { /* ignore */ } }
      const food = countMatch(bot, CATCH) - foodBefore
      ctx.state.stage = 'done'
      return caught > 0 ? { ok: true, reason: food > 0 ? 'caught_fish' : 'caught_something', caught, fish: food, bites, casts } : { ok: false, reason: bites ? 'no_inventory_delta' : ctx.aborted ? 'aborted' : 'no_bite', bites, casts }
    },
    abort: (_r, ctx) => { try { ctx.bot.activateItem() } catch { /* reel in */ } },
  }
}
async function goBack(ctx, spot) { const p = ctx.bot.entity.position; if (Math.hypot(p.x - spot.bank.x - 0.5, p.z - spot.bank.z - 0.5) > 1.5) await ctx.goto(new goals.GoalBlock(spot.bank.x, spot.bank.y, spot.bank.z), { timeoutMs: 5000 }) }
