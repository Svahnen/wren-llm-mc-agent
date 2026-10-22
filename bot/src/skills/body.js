// look_at, gesture, idle_activity: cheap non-LLM body animation.
import { isIgnoredPlayer } from '../ignore-players.js'
import { dist3, V } from './lib.js'
import { resolveEntity } from './move.js'

const alive = ({ bot }) => !!bot?.entity && bot.health > 0

export function makeBodySkills(env) {
  const lookAt = {
    name: 'look_at', max_s: 10, precondition: alive,
    progress_fn: (ctx) => ctx.state.step ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const a = ctx.args
      let p = null
      if (a.target) { const e = resolveEntity(bot, a.target); if (e) p = e.position.offset(0, e.height ?? 1.6, 0) }
      else if (a.x !== undefined) p = V(a.x + 0.5, a.y + 0.5, a.z + 0.5)
      else { // nearest player
        const e = Object.values(bot.players ?? {}).filter((x) => !isIgnoredPlayer(x.username)).map((x) => x.entity).filter((e) => e && e !== bot.entity).sort((x, y) => dist3(x.position, bot.entity.position) - dist3(y.position, bot.entity.position))[0]
        if (e) p = e.position.offset(0, e.height ?? 1.6, 0)
      }
      if (!p) return { ok: false, reason: 'target_gone' }
      ctx.state.step = 1
      await bot.lookAt(p, false)
      ctx.state.step = 2
      await ctx.sleep(a.hold_ms ?? 800)
      return { ok: true }
    },
  }
  const gesture = {
    name: 'gesture', max_s: 10, precondition: alive,
    progress_fn: (ctx) => ctx.state.step ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const step = async (fn, ms) => { if (ctx.aborted) return; ctx.state.step = (ctx.state.step ?? 0) + 1; await fn(); await ctx.sleep(ms) }
      const { yaw, pitch } = bot.entity
      switch (ctx.args.kind) {
        case 'nod': for (let i = 0; i < 2; i++) { await step(() => bot.look(yaw, pitch + 0.45, true), 220); await step(() => bot.look(yaw, pitch - 0.1, true), 220) } await step(() => bot.look(yaw, pitch, true), 100); break
        case 'shake_head': for (let i = 0; i < 2; i++) { await step(() => bot.look(yaw + 0.6, pitch, true), 220); await step(() => bot.look(yaw - 0.6, pitch, true), 220) } await step(() => bot.look(yaw, pitch, true), 100); break
        case 'wave': for (let i = 0; i < 3; i++) await step(() => bot.swingArm('right'), 300); break
        case 'jump': await step(() => bot.setControlState('jump', true), 250); await step(() => bot.setControlState('jump', false), 400); break
        case 'crouch': await step(() => bot.setControlState('sneak', true), 1200); await step(() => bot.setControlState('sneak', false), 100); break
        default: return { ok: false, reason: 'invalid_args' }
      }
      return ctx.aborted ? { ok: false, reason: 'aborted' } : { ok: true }
    },
    abort: (_r, ctx) => { try { ctx.bot.setControlState('sneak', false); ctx.bot.setControlState('jump', false) } catch { /* ignore */ } },
  }
  const idle = {
    name: 'idle_activity', max_s: 60, precondition: alive,
    progress_fn: (ctx) => ctx.state.step ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const rng = env.rng
      const kind = ctx.args.kind ?? 'look_around'
      const tick = async (ms) => { ctx.state.step = (ctx.state.step ?? 0) + 1; return ctx.sleep(ms) }
      if (kind === 'look_around') {
        for (let i = 0; i < 4 && !ctx.aborted; i++) { await bot.look(bot.entity.yaw + (rng() - 0.5) * 2.4, (rng() - 0.5) * 0.5, false); await tick(700 + rng() * 800) }
      } else if (kind === 'watch_sky') {
        await bot.look(bot.entity.yaw, -0.9, false); for (let i = 0; i < 4 && !ctx.aborted; i++) await tick(1200)
      } else { // sit | rest: stand still, declared wait ticks
        const n = Number.isInteger(ctx.args.seconds) ? Math.min(60, Math.max(1, ctx.args.seconds)) : kind === 'rest' ? 20 : 5 // IMP1: explicit duration from a wait intent; Q1: 8 s of rest was worth 1% energy (S2 rested again and again, energy stayed 1/20 for 30 min)
        for (let i = 0; i < n && !ctx.aborted; i++) await tick(1000)
      }
      return ctx.aborted ? { ok: false, reason: 'aborted' } : { ok: true }
    },
  }
  return [lookAt, gesture, idle]
}
