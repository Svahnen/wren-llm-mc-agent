// PVP1: defend(): hit back at a PLAYER who is hurting her, bounded. S2 chooses it (never a reflex).
//   - only someone the hurt tracker saw hit her in the last 10 s (never attacks first, never someone who did not hurt her);
//   - best weapon (same weaponOf as fight), attacks only inside reach and never moves toward them (it never pathfinds, so it cannot chase);
//   - ends when they stop hitting her for QUIET_MS, after max_s (20), when health is low (body safety takes over), or when they leave reach.
import { dist3 } from './lib.js'
import { weaponOf, LOW_HP } from './fight.js'

export const DEFEND_MAX_S = 20, QUIET_MS = 5000, RECENT_MS = 10000, REACH = 3.2, LEAVE_D = 7
const COOLDOWN_MS = { sword: 640, axe: 1000, fist: 500 }
export function makeDefend() {
  const tracker = (bot) => bot.__hurtBy
  return {
    name: 'defend', max_s: DEFEND_MAX_S, stall_s: 10,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (bot.health <= LOW_HP) return { ok: false, reason: 'low_health' }
      if (!tracker(bot)?.lastFrom(args.target, RECENT_MS)) return { ok: false, reason: 'not_attacking_you' }
      return bot.players?.[args.target]?.entity ? true : { ok: false, reason: 'target_gone' }
    },
    progress_fn: (ctx) => `${ctx.state.hits ?? 0}:${ctx.state.secs ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, name = ctx.args.target, t0 = Date.now()
      const weapon = weaponOf(bot)
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      ctx.state.weapon = weapon?.name ?? 'fists'
      const cd = weapon?.name.endsWith('_axe') ? COOLDOWN_MS.axe : weapon ? COOLDOWN_MS.sword : COOLDOWN_MS.fist
      ctx.state.hits = 0; ctx.state.secs = 0
      let lastAttack = 0
      while (!ctx.aborted) {
        ctx.state.secs = Math.round((Date.now() - t0) / 1000)
        if (bot.health <= LOW_HP) return { ok: false, reason: 'low_health' }
        if (Date.now() - t0 > DEFEND_MAX_S * 1000) return { ok: true, note: 'time_up' }
        if (!tracker(bot)?.lastFrom(name, QUIET_MS)) return { ok: true, note: 'attacker_stopped' }
        const e = bot.players?.[name]?.entity
        if (!e) return { ok: true, note: 'attacker_left' }
        const d = dist3(e.position, bot.entity.position)
        if (d > LEAVE_D) return { ok: true, note: 'attacker_left_reach' }
        if (d <= REACH && Date.now() - lastAttack >= cd) {
          try { await bot.lookAt(e.position.offset(0, (e.height ?? 1.8) * 0.85, 0)); bot.attack(e); ctx.state.hits++; lastAttack = Date.now() } catch { /* ignore */ }
        }
        await ctx.sleep(100)
      }
      return { ok: false, reason: 'aborted' }
    },
    abort: () => {},
  }
}
