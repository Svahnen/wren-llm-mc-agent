// PB1: `build` skill: small structures from WHATEVER solid blocks she carries (material-agnostic, preference order in habits/safety.js blockRank).
//   wall_ring  a wall of `height` (2..3) around the cell she stands on (4 sides, no roof): cheap protection from the ground level
//   pillar_up  stack blocks under her feet, `height` (2..10) high: escape from a pit / from mobs (bridge-free vertical escape)
//   simple_hut a size x size (3..7, default 5) hut, 2-high walls + roof, a 2-high door gap that is closed with a door item if she holds one, else sealed/left open per `seal`
// Plans are DATA (cells()) so new structures are one function. dig_in (SURV1) stays its own skill. Success is read from the world, never trusted.
import { V, items, standableY, dist3 } from './lib.js'
import { placeAt, recordHut } from './shelter.js'
import { placeableCount } from '../habits/safety.js'

const solid = (b) => !!b && b.boundingBox === 'block'
const free = (b) => !b || b.boundingBox === 'empty' || /grass|fern|snow|flower|vine|bush/.test(b.name)

/** cell lists, in placement order (bottom layer first, outside in), relative to the feet cell S. */
export const PLANS = {
  wall_ring: (S, a) => { const h = a.height ?? 2, out = []; for (let y = 0; y < h; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push({ x: S.x + dx, y: S.y + y, z: S.z + dz }); return out },
  simple_hut: (S, a) => {
    const n = a.size ?? 5, r = Math.floor(n / 2), h = 2, out = []
    const door = (c) => c.dz === r && c.dx === 0 && c.y < h        // door gap: middle of the +z side, 2 high
    for (let y = 0; y < h; y++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; const c = { dx, dz, y }; if (!door(c)) out.push({ x: S.x + dx, y: S.y + y, z: S.z + dz }) }
    const roof = []; for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) roof.push({ x: S.x + dx, y: S.y + h, z: S.z + dz, d: Math.max(Math.abs(dx), Math.abs(dz)) })
    roof.sort((p, q) => q.d - p.d)                                   // perimeter first, centre last (each roof block rests on a placed neighbour)
    return [...out, ...roof.map(({ d, ...c }) => c)]
  },
}
export const doorCells = (S, a) => { const r = Math.floor((a.size ?? 5) / 2); return [{ x: S.x, y: S.y, z: S.z + r }, { x: S.x, y: S.y + 1, z: S.z + r }] }
export const blocksNeeded = (plan, a = {}) => { const S = { x: 0, y: 0, z: 0 }; return plan === 'pillar_up' ? (a.height ?? 4) : PLANS[plan] ? PLANS[plan](S, a).length : 0 }

export function makeBuild(env) {
  return {
    name: 'build', max_s: 120, stall_s: 25, stationary: true,
    precondition: ({ bot, args }) => {
      if (!bot?.entity || bot.health <= 0) return false
      const need = blocksNeeded(args.plan, args), have = placeableCount(items(bot))
      return have >= need ? true : { ok: false, reason: 'not_enough_blocks', need, have }
    },
    progress_fn: (ctx) => `${ctx.state.placed ?? 0}:${ctx.state.stage ?? 's'}`,
    async run(ctx) {
      const bot = ctx.bot, a = ctx.args
      try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
      bot.clearControlStates?.()
      for (let i = 0; i < 8 && !bot.entity.onGround; i++) await ctx.sleep(150)
      const p = bot.entity.position.floored()
      const S = V(p.x, standableY(bot, p.x, p.z, p.y, 1, 3) ?? p.y, p.z)
      if (a.plan === 'pillar_up') return pillarUp(ctx, S, a.height ?? 4)
      const cells = PLANS[a.plan]?.(S, a); if (!cells) return { ok: false, reason: 'unknown_plan' }
      if (a.plan === 'simple_hut') {   // site check: floor under the footprint and room for walls/roof (a few obstacles are tolerated and counted)
        const r = Math.floor((a.size ?? 5) / 2); let bad = 0
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { const f = bot.blockAt(V(S.x + dx, S.y - 1, S.z + dz)); if (!solid(f) || /lava|water|leaves/.test(f?.name ?? '')) bad++ }
        if (bad > 3) return { ok: false, reason: 'site_blocked' }
      }
      ctx.state.stage = 'place'
      let missing = 0
      const why = new Map()   // BAT1: cell -> honest cause of the last failed attempt (placeAt sets bot.__placeFail)
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 2) {   // third and last try: only when something temporary (a mob or player in the cell, a late block update) may have blocked the cell
          if (![...why.values()].some((w) => /^(place_error|occupied|entity|reach)/.test(w))) break   // (missing keeps its value from pass 1)
          await ctx.sleep(500)
        }
        missing = 0
        for (const c of cells) {
          if (ctx.aborted) return { ok: false, reason: 'aborted' }
          const key = `${c.x},${c.y},${c.z}`
          if (solid(bot.blockAt(V(c.x, c.y, c.z)))) { why.delete(key); continue }
          if (dist3(bot.entity.position, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }) > 4.6) { missing++; why.set(key, 'reach:out of reach'); continue }
          bot.__placeFail = null
          const r = await placeAt(bot, c)
          if (r === true) { ctx.state.placed = (ctx.state.placed ?? 0) + 1; why.delete(key) }
          else if (r === false) { missing++; why.set(key, String(bot.__placeFail ?? 'unknown')); if (!placeableCount(items(bot))) return { ok: false, reason: 'ran_out_of_blocks', placed: ctx.state.placed ?? 0, detail: `placed ${ctx.state.placed ?? 0} of ${cells.length} blocks, then the placeable blocks ran out; collect more (dirt, cobblestone) and build again` } }
          else why.delete(key)
        }
        if (!missing) break
      }
      let door = 'none'
      if (a.plan === 'simple_hut') {
        const dc = doorCells(S, a), d = items(bot).find((i) => /_door$/.test(i.name))
        if (d) { try { await bot.equip(d, 'hand'); const ref = bot.blockAt(V(dc[0].x, dc[0].y - 1, dc[0].z)); if (solid(ref)) { await bot.placeBlock(ref, V(0, 1, 0)); door = 'door' } } catch { /* fall through */ } }
        if (door === 'none' && (a.seal ?? true)) { let ok = 0; for (const c of dc) if (await placeAt(bot, c) !== false) ok++; door = ok === 2 ? 'sealed' : 'open' } else if (door === 'none') door = 'open'
        try { recordHut(bot, S, a.size ?? 5, dc, door === 'sealed') } catch { /* ignore */ }   // NAV1: so she can open her own sealed door from inside
      }
      ctx.state.stage = 'done'
      return missing === 0 ? { ok: true, reason: door === 'none' ? 'built' : `built_${door}`, placed: ctx.state.placed ?? 0, // ARB1: say what the structure is, so 'done' and 'am I enclosed' agree
        ...(a.plan === 'wall_ring' ? { enclosed: false, note: 'walls only, no roof: still open from above' } : a.plan === 'simple_hut' ? { enclosed: door !== 'open' } : {}) } : { ok: false, reason: 'incomplete', missing, detail: incompleteDetail(why, cells.length, ctx.state.placed ?? 0, placeableCount(items(bot))) }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

/** BAT1: an honest, specific account of a partial build + what to do instead (never just 'incomplete') */
export function incompleteDetail(why, total, placed, held) {
  const tally = {}
  for (const w of why.values()) { const k = w.split(':')[0]; tally[k] = (tally[k] ?? 0) + 1 }
  const names = { no_reference: 'no solid block next to the cell to build on (water, air or a ledge)', place_error: 'the server refused the placement (protected area or something standing in the cell)', occupied: 'another block is in the cell', reach: 'out of reach', lava: 'lava in the cell', no_blocks: 'no placeable block left', only_falling_blocks: 'only sand/gravel left and the cell has no support' }
  const parts = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x ${names[k] ?? k}`)
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0]
  const alt = top === 'no_reference' || top === 'lava' ? 'stand on flat dry ground (not at the water edge or on a ledge) and build again, or pillar_up / dig_in here' : top === 'place_error' || top === 'occupied' ? 'step to another cell (not a protected area) and build again, or try dig_in' : top === 'reach' ? 'build again from the middle of the spot' : 'collect more blocks and build again'
  return `placed ${placed} of ${total} blocks (${why.size} missing, holding ${held} placeable blocks): ${parts.join(', ') || 'unknown cause'}. Instead: ${alt}.`
}

/** stack blocks under her feet: jump, place on the block below at the top of the jump. */
export async function pillarUp(ctx, S, height) {
  const bot = ctx.bot, y0 = bot.entity.position.y
  ctx.state.stage = 'pillar'
  for (let i = 0; i < height && !ctx.aborted; i++) {
    const stack = items(bot).filter((it) => /./.test(it.name)).find((it) => placeableCount([it]) > 0)
    if (!stack) return { ok: false, reason: 'ran_out_of_blocks', gained: Math.round(bot.entity.position.y - y0) }
    const before = bot.entity.position.y
    try { await bot.equip(stack, 'hand') } catch { /* ignore */ }
    try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch { /* ignore */ }
    bot.setControlState('jump', true)
    let placed = false
    for (let k = 0; k < 14 && !placed && !ctx.aborted; k++) {
      await ctx.sleep(60)
      if (bot.entity.position.y - before >= 0.9) {
        const f = bot.entity.position.floored()
        const ref = bot.blockAt(V(f.x, Math.floor(before) - 1 + 0, f.z))
        const under = bot.blockAt(V(f.x, Math.floor(before), f.z))
        try { if (solid(under)) { /* already filled */ placed = true } else if (solid(ref)) { await bot.placeBlock(ref, V(0, 1, 0)); placed = true } } catch { /* retry next tick */ }
      }
    }
    bot.setControlState('jump', false)
    await ctx.sleep(250)
    ctx.state.placed = (ctx.state.placed ?? 0) + (placed ? 1 : 0)
    if (bot.entity.position.y - before < 0.5 && !placed) return { ok: false, reason: 'cannot_pillar', gained: Math.round(bot.entity.position.y - y0) }
  }
  const gained = bot.entity.position.y - y0
  return gained >= Math.min(height, 2) - 0.2 ? { ok: true, reason: 'pillared', gained: +gained.toFixed(1) } : { ok: false, reason: 'cannot_pillar', gained: +gained.toFixed(1) }
}
