// ROAM1: `collect_seeds` skill: break tall grass / ferns in daylight until some seeds drop (about 1 in 8 breaks gives wheat seeds). A means: S2 / the roam playbook
// choose when; the farm_plot skill uses the same idea. Success = seed count delta in the inventory, never a claim.
import { freeSlots } from './lib.js'
import { SEED_RE, seedCount, grassNear, grassSeedRun } from './seeds.js'   // RS3: the loop moved to seeds.js (shared with grass_seeds)
export { SEED_RE, seedCount, grassNear }

export function makeRoamSkills() {
  return [{
    name: 'collect_seeds', max_s: 90, stall_s: 30,
    precondition: ({ bot }) => {
      if (!(!!bot?.entity && bot.health > 0)) return false
      if (freeSlots(bot) < 1) return { ok: false, reason: 'inventory_full' }
      if (!grassNear(bot, 16, 1).length) return { ok: false, reason: 'no_grass', detail: 'no tall grass or fern within 16 m' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.broken ?? 0}:${ctx.state.gained ?? 0}`,
    async run(ctx) {
      const want = ctx.args.count ?? 4
      const res = await grassSeedRun(ctx, { want, radius: 16, maxMs: 80000, maxBreaks: 60, re: SEED_RE })
      return res.gained > 0 ? { ok: true, gained: res.gained, broken: res.broken } : { ok: false, reason: 'no_seeds_dropped', detail: `broke ${res.broken} grass, no seeds dropped (about 1 in 8 gives one)` }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }]
}
