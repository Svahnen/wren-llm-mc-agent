// Movement skills: move_to, go_to, follow, approach, flee, return_home, return_to_surface, set_home.
import { goals, dist3, distXZ, pos3, openSky, standableY, V } from './lib.js'
import { MOBS } from '../reflex/threats.js'

const alive = ({ bot }) => !!bot?.entity && bot.health > 0

/** Goto with best-distance progress bookkeeping. Returns {ok, reason}. */
async function walkTo(ctx, p, radius = 2, timeoutMs = 60000) {
  const bot = ctx.bot
  const dist = () => Math.round(dist3(bot.entity.position, p))
  ctx.state.best = Math.min(ctx.state.best ?? 1e9, dist())
  const track = setInterval(() => { try { const d = dist(); if (d < ctx.state.best) ctx.state.best = d } catch { /* gone */ } }, 250)
  try {
    let r = await ctx.goto(new goals.GoalNear(p.x, p.y, p.z, radius), { timeoutMs })
    let left = dist3(bot.entity.position, p)
    // NAV1: a goto that resolves at once without getting anywhere (stale empty path, e.g. right after she opened her hut door) gets one more try
    if (r.ok && left > radius + 1.5 && !ctx.aborted) { await ctx.sleep(700); r = await ctx.goto(new goals.GoalNear(p.x, p.y, p.z, radius), { timeoutMs }); left = dist3(bot.entity.position, p) }
    if (!r.ok) return { ok: false, reason: r.reason, left, ...(r.why ? { why: r.why } : {}) }
    if (left > radius + 1.5) return { ok: false, reason: 'not_reached', left } // goto resolves on empty paths: verify
    return { ok: true, left }
  } finally { clearInterval(track) }
}

export function resolvePlayer(bot, name) {
  const p = bot.players?.[name]
  return p?.entity ?? null
}
export function resolveEntity(bot, ref) {
  if (typeof ref !== 'string') return null
  const pl = resolvePlayer(bot, ref)
  if (pl) return pl
  const id = /(\d+)$/.exec(ref)
  const all = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position)
  const byName = all.filter((e) => e.name === ref.replace(/_\d+$/, '') || e.username === ref)
  const pool = byName.length ? byName : all.filter((e) => String(e.id) === (id?.[1] ?? ''))
  return pool.sort((a, b) => dist3(a.position, bot.entity.position) - dist3(b.position, bot.entity.position))[0] ?? null
}

export function makeMoveSkills(env) {
  const { landmarks, trail } = env
  const moveTo = {
    name: 'move_to', max_s: 120, stall_s: 20, precondition: alive,
    progress_fn: (ctx) => ctx.state.best ?? 'start',
    async run(ctx) {
      const { x, z, radius = 2 } = ctx.args
      // the given y may be inside a block / in the air: snap to a standable cell in that column when the chunk is loaded
      const y = standableY(ctx.bot, x, z, ctx.args.y, 8, 12) ?? ctx.args.y
      const r = await walkTo(ctx, { x: x + 0.5, y, z: z + 0.5 }, radius, 110000)
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.why ? { detail: r.why } : {}) }
    },
  }
  const goTo = {
    name: 'go_to', max_s: 120, stall_s: 20, precondition: ({ bot, args }) => !!bot?.entity && !!landmarks.get(args.place),
    progress_fn: (ctx) => ctx.state.best ?? 'start',
    async run(ctx) {
      const pl = landmarks.get(ctx.args.place)
      if (!pl) return { ok: false, reason: 'unknown_place' }
      const r = await walkTo(ctx, pl, 2, 110000)
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.why ? { detail: r.why } : {}) }
    },
  }
  const follow = {
    name: 'follow', max_s: 320, stall_s: 25,
    precondition: ({ bot, args }) => !!bot?.entity && !!resolvePlayer(bot, args.target),
    progress_fn: (ctx) => `${ctx.state.best ?? 'start'}:${ctx.state.nearTicks ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const dur = ctx.args.duration_s ?? 60
      const t0 = Date.now()
      let goneSince = null
      ctx.state.nearTicks = 0
      while (!ctx.aborted && Date.now() - t0 < dur * 1000) {
        const e = resolvePlayer(bot, ctx.args.target)
        if (!e) { goneSince ??= Date.now(); if (Date.now() - goneSince > 6000) return { ok: false, reason: 'target_gone' }; await ctx.sleep(500); continue }
        goneSince = null
        const d = dist3(e.position, bot.entity.position)
        ctx.state.best = Math.min(ctx.state.best ?? 1e9, Math.round(d))
        if (d <= 4) { ctx.state.nearTicks++; try { await bot.lookAt(e.position.offset(0, e.height ?? 1.6, 0)) } catch { /* ignore */ } }
        if (d > 3.5) { try { bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true) } catch { /* ignore */ } } else { try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } }
        await ctx.sleep(500)
      }
      return ctx.aborted ? { ok: false, reason: 'aborted' } : { ok: true }
    },
    abort: (_r, ctx) => { try { ctx.bot.pathfinder.setGoal(null) } catch { /* ignore */ } },
  }
  const approach = {
    name: 'approach', max_s: 60, stall_s: 15,
    precondition: ({ bot, args }) => !!bot?.entity && !!resolveEntity(bot, args.target),
    progress_fn: (ctx) => ctx.state.best ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const e = resolveEntity(bot, ctx.args.target)
      if (!e) return { ok: false, reason: 'target_gone' }
      const r = await walkTo(ctx, e.position, 2.5, 55000)
      const e2 = resolveEntity(bot, ctx.args.target)
      const d = e2 ? dist3(e2.position, bot.entity.position) : Infinity
      if (e2 && d <= 4) { try { await bot.lookAt(e2.position.offset(0, e2.height ?? 1.6, 0)) } catch { /* ignore */ } return { ok: true } }
      return { ok: false, reason: r.ok ? 'target_moved' : r.reason }
    },
  }
  const flee = {
    name: 'flee', max_s: 30, stall_s: 10, precondition: alive,
    progress_fn: (ctx) => ctx.state.best ?? 'start',
    async run(ctx) {
      const bot = ctx.bot
      const e = resolveEntity(bot, ctx.args.from)
      // VAL1: S2 once fled from "salmon_4" (starving, anxious): fleeing from anything that is not a hostile mob is refused with a reason S2 can read
      if (e && e !== bot.entity && e.type !== 'player' && !MOBS[e.name]) return { ok: false, reason: 'not_a_threat', message: `${e.name} is not a threat; it is not hostile` }
      const o = bot.entity.position
      const away = e ? Math.atan2(o.z - e.position.z, o.x - e.position.x) : Math.random() * 6.28
      const start = e ? dist3(o, e.position) : 0
      let shortOf = null
      for (const spread of [0, 0.5, -0.5, 1.0, -1.0]) {
        const a = away + spread
        const x = Math.floor(o.x + Math.cos(a) * 22), z = Math.floor(o.z + Math.sin(a) * 22)
        const y = standableY(bot, x, z, o.y)
        if (y === null) continue
        ctx.state.best = 0
        const track = setInterval(() => { ctx.state.best = Math.max(ctx.state.best, Math.round(dist3(bot.entity.position, o))) }, 250)
        const r = await ctx.goto(new goals.GoalNear(x, y, z, 2), { timeoutMs: 20000 })
        clearInterval(track)
        const gained = e ? dist3(bot.entity.position, e.position) - start : dist3(bot.entity.position, o)
        if (gained >= 8) return { ok: true }
        if (!r.ok && (r.reason === 'aborted' || ctx.aborted)) return { ok: false, reason: 'aborted' }
        // Q1: arriving short (or goto resolving on an empty path) used to end the flee at once with not_far_enough (3 of 5 S2 flees on the
        // real Wren, 8 ms - 329 ms); the other directions were never tried
        shortOf = 'not_far_enough'
      }
      return { ok: false, reason: shortOf ?? 'no_escape_route' }
    },
  }

  /** Retrace the trail backwards, stopping when stopFn(crumb) is true. */
  async function retrace(ctx, stopFn) {
    const bot = ctx.bot
    const crumbs = trail.reversed()
    ctx.state.crumbs = 0
    for (const c of crumbs) {
      if (ctx.aborted) return { ok: false, reason: 'aborted' }
      if (dist3(bot.entity.position, c) < 3) continue
      if (stopFn(c)) { const r = await ctx.goto(new goals.GoalNear(c.x, c.y, c.z, 1.5), { timeoutMs: 25000 }); return r }
      const r = await ctx.goto(new goals.GoalNear(c.x, c.y, c.z, 1.5), { timeoutMs: 25000 })
      if (r.ok) ctx.state.crumbs++
    }
    return { ok: true }
  }

  const returnHome = {
    name: 'return_home', max_s: 240, stall_s: 25,
    precondition: ({ bot }) => !!bot?.entity && !!landmarks.home,
    progress_fn: (ctx) => `${ctx.state.best ?? 'start'}:${ctx.state.crumbs ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const h = landmarks.home
      let r = await walkTo(ctx, h, 3, 90000)
      if (r.ok) return { ok: true }
      if (r.reason === 'aborted') return r
      // fallback: retrace the breadcrumb trail (a route we know was walkable), then try again
      ctx.log('trail_fallback', { crumbs: trail.length, left: Math.round(dist3(bot.entity.position, h)) })
      await retrace(ctx, () => false)
      r = await walkTo(ctx, h, 3, 60000)
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
  }
  const returnToSurface = {
    name: 'return_to_surface', max_s: 240, stall_s: 25, precondition: alive,
    progress_fn: (ctx) => `${ctx.state.crumbs ?? 0}:${ctx.state.best ?? 'start'}`,
    async run(ctx) {
      const bot = ctx.bot
      if (openSky(bot, bot.entity.position)) return { ok: true, reason: 'already_on_surface' }
      const startY = bot.entity.position.y
      ctx.state.best = Math.round(startY)
      await retrace(ctx, (c) => openSky(bot, c))
      if (openSky(bot, bot.entity.position)) return { ok: true }
      if (landmarks.home && openSky(bot, landmarks.home)) { const r = await walkTo(ctx, landmarks.home, 3, 60000); if (r.ok && openSky(bot, bot.entity.position)) return { ok: true } }
      return { ok: false, reason: 'no_route_to_surface' }
    },
  }
  const setHome = {
    name: 'set_home', max_s: 10, precondition: alive,
    progress_fn: (ctx) => ctx.state.done ?? 'start',
    async run(ctx) {
      const p = ctx.bot.entity.position
      if (!ctx.bot.entity.onGround) await ctx.sleep(600)
      landmarks.set('home', p, 'home')
      ctx.state.done = 1
      const h = landmarks.home
      return dist3(h, p) < 1 ? { ok: true } : { ok: false, reason: 'not_stored' }
    },
  }
  return [moveTo, goTo, follow, approach, flee, returnHome, returnToSurface, setHome]
}
