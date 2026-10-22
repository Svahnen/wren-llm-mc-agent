// DOOR1: simple world interactions as callable skills (and plain functions). Not registered by registerSkills (skills.json/schema.js are
// shared). Usage:
//   import { makeInteractSkills } from './interact.js';  for (const s of makeInteractSkills()) runner.register(s)
// Skills: open_door {x,y,z | which:'nearest'}, close_doors_nearby {radius}, press_button {x,y,z | which:'nearest', state:'toggle'|'on'|'off'},
//         chest {action:'list'|'take'|'put', item, count, x,y,z | nearest}.
// Doors are never broken: every function here only right-clicks. Trace: door_opened / door_closed / door_failed (same shape as the auto opener).
import { goals, V, dist3 } from './lib.js'
import { isWalkthroughDoor, isIronDoor, isTrapdoor, isTrigger } from './movements-protect.js'
import { openDoorEx, closeDoorEx, openDoorsNear, lowerHalf, activate, isOpen } from './movements-doors.js'

const arr = (p) => [p.x, p.y, p.z]
const isAnyDoor = (b) => !!b && (isWalkthroughDoor(b) || isIronDoor(b) || isTrapdoor(b))
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v))
const posArg = (a) => { const x = num(a?.x), y = num(a?.y), z = num(a?.z); return [x, y, z].every(Number.isFinite) ? V(Math.floor(x), Math.floor(y), Math.floor(z)) : null }

function nearestBlock(bot, pred, r = 16) {
  const ids = bot.registry.blocksArray.filter((b) => pred({ name: b.name })).map((b) => b.id)
  if (!ids.length) return null
  const ps = bot.findBlocks({ matching: ids, maxDistance: r, count: 32 })
  const me = bot.entity.position
  return ps.map((p) => bot.blockAt(p)).filter((b) => b && !(/_door$/.test(b.name) && b.getProperties?.().half === 'upper')).sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0] ?? null
}

async function approach(ctx, block, range = 3) {
  const bot = ctx.bot
  if (dist3(bot.entity.position.offset(0, 1, 0), block.position.offset(0.5, 0.5, 0.5)) <= 4) return { ok: true }
  const r = await ctx.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, range), { timeoutMs: 15000 })
  return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'unreachable' }
}

export function makeInteractSkills() {
  const trace = (ctx, type, f) => ctx.log(type, f)
  return [
    {
      name: 'open_door', max_s: 25, stall_s: 15,
      precondition: ({ bot }) => (!bot?.entity || bot.health <= 0 ? false : true),
      progress_fn: () => Date.now(),
      async run(ctx) {
        const bot = ctx.bot, p = posArg(ctx.args)
        let b = p ? bot.blockAt(p) : nearestBlock(bot, (x) => isAnyDoor(x) && true)
        b = lowerHalf(bot, b)
        if (!isAnyDoor(b)) return { ok: false, reason: p ? 'not_a_door' : 'no_door_nearby' }
        const a = await approach(ctx, b, 2); if (!a.ok) return { ok: false, reason: a.reason }
        const r = await openDoorEx(bot, b, { retries: 2 })
        if (r.ok) { if (r.via !== 'already_open') bot.__doorStats && bot.__doorStats.opened++; trace(ctx, 'door_opened', { at: arr(b.position), name: b.name, via: r.via }); return { ok: true, at: arr(b.position), via: r.via } }
        trace(ctx, 'door_failed', { at: arr(b.position), name: b.name, action: 'open', reason: r.reason })
        return { ok: false, reason: r.reason }
      },
    },
    {
      name: 'close_doors_nearby', max_s: 40, stall_s: 20,
      progress_fn: () => Date.now(),
      async run(ctx) {
        const bot = ctx.bot, radius = Math.min(24, Math.max(2, num(ctx.args?.radius) ?? 8))
        const closed = [], failed = []
        for (let i = 0; i < 8 && !ctx.aborted; i++) {
          const todo = openDoorsNear(bot, radius).filter((b) => !closed.some((c) => c.join() === arr(b.position).join()) && !failed.some((c) => c.at.join() === arr(b.position).join()))
          const b = todo[0]
          if (!b) break
          const a = await approach(ctx, b, 2)
          let r = a.ok ? await closeDoorEx(bot, b, { retries: 2 }) : { ok: false, reason: a.reason }
          if (r.ok) { closed.push(arr(b.position)); bot.__doorStats && bot.__doorStats.closed++; trace(ctx, 'door_closed', { at: arr(b.position), name: b.name, why: 'close_doors_nearby' }) }
          else { failed.push({ at: arr(b.position), reason: r.reason }); trace(ctx, 'door_failed', { at: arr(b.position), name: b.name, action: 'close', reason: r.reason }) }
        }
        return closed.length || !failed.length ? { ok: true, closed: closed.length, failed: failed.length } : { ok: false, reason: failed[0].reason }
      },
    },
    {
      name: 'press_button', max_s: 20, stall_s: 12,
      progress_fn: () => Date.now(),
      async run(ctx) {
        const bot = ctx.bot, p = posArg(ctx.args)
        const b = p ? bot.blockAt(p) : nearestBlock(bot, isTrigger, 12)
        if (!b || !isTrigger(b)) return { ok: false, reason: p ? 'not_a_button' : 'no_button_nearby' }
        const a = await approach(ctx, b, 2); if (!a.ok) return { ok: false, reason: a.reason }
        const want = ctx.args?.state // lever only: on | off | toggle
        const pr = () => b.getProperties?.() ?? {}
        const cur = bot.blockAt(b.position)?.getProperties?.().powered
        if (b.name === 'lever' && ((want === 'on' && cur === true) || (want === 'off' && cur === false))) return { ok: true, powered: cur, note: 'already' }
        void pr
        if (!(await activate(bot, bot.blockAt(b.position)))) return { ok: false, reason: 'activate_error' }
        await ctx.sleep(250)
        return { ok: true, powered: bot.blockAt(b.position)?.getProperties?.().powered ?? null, at: arr(b.position) }
      },
    },
    {
      name: 'chest', max_s: 40, stall_s: 20,
      progress_fn: () => Date.now(),
      async run(ctx) {
        const bot = ctx.bot, p = posArg(ctx.args), action = ctx.args?.action ?? 'list'
        const b = p ? bot.blockAt(p) : nearestBlock(bot, (x) => /^(chest|trapped_chest|barrel)$/.test(x.name), 16)
        if (!b || !/^(chest|trapped_chest|barrel)$/.test(b.name)) return { ok: false, reason: 'no_chest' }
        const a = await approach(ctx, b, 2); if (!a.ok) return { ok: false, reason: a.reason }
        return chestTransfer(bot, b, { action, item: ctx.args?.item, count: num(ctx.args?.count) })
      },
    },
  ]
}

/** Primitive: open the container block, list / take / put, close. Resolves { ok, ...}. */
export async function chestTransfer(bot, block, { action = 'list', item = null, count = null } = {}) {
  let w
  try { w = await Promise.race([bot.openContainer(block), new Promise((_, rej) => setTimeout(() => rej(new Error('open timeout')), 5000))]) } catch (e) { return { ok: false, reason: 'open_failed', message: String(e.message).slice(0, 80) } }
  try {
    const tally = (list) => { const m = {}; for (const i of list) m[i.name] = (m[i.name] ?? 0) + i.count; return m }
    if (action === 'list') return { ok: true, items: tally(w.containerItems()) }
    if (!item) return { ok: false, reason: 'no_item' }
    const it = bot.registry.itemsByName[item]
    if (!it) return { ok: false, reason: 'unknown_item' }
    if (action === 'take') {
      const have = w.containerItems().filter((i) => i.type === it.id).reduce((s, i) => s + i.count, 0)
      if (!have) return { ok: false, reason: 'not_in_chest' }
      const n = Math.min(count ?? have, have)
      await w.withdraw(it.id, null, n)
      return { ok: true, moved: n }
    }
    if (action === 'put') {
      const have = bot.inventory.items().filter((i) => i.type === it.id).reduce((s, i) => s + i.count, 0)
      if (!have) return { ok: false, reason: 'not_in_inventory' }
      const n = Math.min(count ?? have, have)
      await w.deposit(it.id, null, n)
      return { ok: true, moved: n }
    }
    return { ok: false, reason: 'bad_action' }
  } catch (e) { return { ok: false, reason: 'transfer_failed', message: String(e.message).slice(0, 80) } } finally { try { w.close() } catch { /* ignore */ } }
}
export { isOpen }
