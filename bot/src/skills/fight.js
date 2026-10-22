// G2: fight(): melee a hostile mob with the BEST weapon held (sword, else axe). she once ran from a zombie while holding a sword.
// Equips the best weapon first, closes in, attacks on the weapon cooldown, stops when the target is dead / nothing hostile is left near / health is low.
// Creepers (explosion), endermen, wardens, ghasts and blazes are never picked automatically (flee or cover is the answer there); an explicit target is honoured.
import { goals, dist3, items, bestTool } from './lib.js'

export const FIGHTABLE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'spider', 'cave_spider', 'slime', 'silverfish', 'witch', 'pillager', 'vindicator'])
export const LOW_HP = 6
export const weaponOf = (bot) => bestTool(bot, 'sword') ?? bestTool(bot, 'axe') ?? null
const COOLDOWN_MS = { sword: 640, axe: 1000 }

export function pickHostile(bot, wanted = null, maxD = 16) {
  const me = bot.entity.position
  const wantedName = wanted ? String(wanted).replace(/_\d+$/, '') : null
  const wantedId = wanted ? String(wanted).match(/_(\d+)$/)?.[1] : null
  return Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && e.isValid !== false && dist3(e.position, me) <= maxD
    && (wantedName ? (e.name === wantedName || String(e.id) === wantedId) : FIGHTABLE.has(e.name)))
    .sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0] ?? null
}

export function makeFight() {
  return {
    name: 'fight', max_s: 40, stall_s: 15,
    // VAL1: the mob_defense reflex fights with the best weapon (same weaponOf logic); when it holds the body the runner waits for it and reports this skill as satisfied
    coveredBy: ['mob_defense'], coverWaitMs: 32000,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (bot.health <= LOW_HP) return { ok: false, reason: 'low_health' }
      return pickHostile(bot, args.target) ? true : { ok: false, reason: 'no_target_found' }
    },
    progress_fn: (ctx) => `${ctx.state.hits ?? 0}:${ctx.state.kills ?? 0}:${ctx.state.best ?? 'x'}`,
    async run(ctx) {
      const bot = ctx.bot
      const weapon = weaponOf(bot)
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      ctx.state.weapon = weapon?.name ?? 'fists'
      const cd = weapon?.name.endsWith('_axe') ? COOLDOWN_MS.axe : COOLDOWN_MS.sword
      let target = pickHostile(bot, ctx.args.target)
      if (!target) return { ok: false, reason: 'no_target_found' }
      ctx.state.hits = 0; ctx.state.kills = 0
      let lastAttack = 0
      while (!ctx.aborted) {
        if (bot.health <= LOW_HP) { bot.pathfinder?.setGoal(null); return { ok: false, reason: 'low_health' } }
        if (!target || target.isValid === false || (target.health !== undefined && target.health <= 0)) {
          if (target) ctx.state.kills++
          target = pickHostile(bot, ctx.args.target, 10)   // another one close by: finish the fight
          if (!target) break
        }
        const d = dist3(target.position, bot.entity.position)
        ctx.state.best = Math.round(d)
        if (d > 3.2) { bot.pathfinder?.setGoal(new goals.GoalFollow(target, 2), true); await ctx.sleep(250); if (d > 24) return { ok: false, reason: 'target_gone' }; continue }
        bot.pathfinder?.setGoal(null)
        if (Date.now() - lastAttack >= cd) {
          try { await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.85, 0)); bot.attack(target); ctx.state.hits++; lastAttack = Date.now() } catch { /* ignore */ }
        }
        await ctx.sleep(120)
      }
      bot.pathfinder?.setGoal(null)
      if (ctx.aborted) return { ok: false, reason: 'aborted' }
      return { ok: true }
    },
    abort: (_r, ctx) => { try { ctx.bot.pathfinder.setGoal(null) } catch { /* ignore */ } },
  }
}
