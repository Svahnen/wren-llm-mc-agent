// shelter + take_cover (H1). Night routine and ranged-threat avoidance, deterministic, no LLM.
//  shelter     build a sealed 1x1x2 pillbox from placeable blocks (outside protected boxes), wait inside until dawn, reclaim the blocks
//  take_cover  break the line of sight to skeletons (walk behind a block), or charge a lone shooter when healthy and armed
import { MOBS, hostilesAround } from '../reflex/threats.js'
import { waterRisk, nearWater, wetCell } from '../water-policy.js'
import { doorKeepout, goals, V, dist3, items, countItem, bestTool, equipBest, isStandable, standableY, collectDrops } from './lib.js'
import { isWalkthroughDoor, builtReason } from './movements-protect.js'
import { phase, isDark, openCells, pillboxCells, placeableCount, PLACEABLE, blockRank, SHELTER_BLOCKS, rangedThreats, hiddenFrom, chooseResponse } from '../habits/safety.js'

const alive = ({ bot }) => !!bot?.entity && bot.health > 0
const solid = (b) => !!b && b.boundingBox === 'block'
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

// SURV2: blocks a new block can simply replace; anything else non-solid in a target cell (torch, ladder, rail, button, sign ...) is cleared first
const REPLACEABLE_RE = /^(air|cave_air|void_air|water|lava|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|light|fire|soul_fire)$/
const DOORISH = /(_door|_fence_gate|_trapdoor)$/

/** Place one block at `cell` against any solid neighbour. 'exists' | true | false. The reason of a false is left in bot.__placeFail (SURV2 diagnostics). */
export async function placeAt(bot, cell) {
  const target = V(cell.x, cell.y, cell.z)
  const cur = bot.blockAt(target)
  if (solid(cur)) return 'exists'
  if (cur && cur.name === 'lava') { bot.__placeFail = 'lava'; return false }
  // SURV2: a torch (she lights caves all the time) or another small non-replaceable block in the cell makes the server refuse the placement: take it away first
  if (cur && !REPLACEABLE_RE.test(cur.name)) {
    if (DOORISH.test(cur.name)) { bot.__placeFail = `occupied:${cur.name}`; return false }
    try { await Promise.race([bot.dig(cur), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 2000))]) } catch (e) { try { bot.stopDigging() } catch { /* ignore */ } bot.__placeFail = `occupied:${cur.name}:${String(e?.message).slice(0, 30)}`; return false }
    await new Promise((r) => setTimeout(r, 80))
  }
  // SURV3: sand/gravel placed over open air falls (onto her head when it is the cap): only on a supported cell
  const supported = solid(bot.blockAt(target.offset(0, -1, 0)))
  const stack = items(bot).filter((i) => PLACEABLE.test(i.name) && (supported || !FALLING_RE.test(i.name))).sort((a, b) => blockRank(a.name) - blockRank(b.name) || b.count - a.count)[0]   // PB1: preferred material first, any solid block works
  if (!stack) { bot.__placeFail = supported ? 'no_blocks' : 'only_falling_blocks'; return false }
  let sawRef = false, lastErr = null
  for (const [dx, dy, dz] of FACES) {
    const nb = bot.blockAt(target.offset(dx, dy, dz))
    if (!solid(nb)) continue
    sawRef = true
    try {
      await bot.equip(stack, 'hand')
      await bot.placeBlock(nb, V(-dx, -dy, -dz))
      await new Promise((r) => setTimeout(r, 60))
      if (solid(bot.blockAt(target))) return true
      lastErr = 'not_solid_after'
    } catch (e) { lastErr = String(e.message).slice(0, 140); if (process.env.H1_DEBUG) console.log('placeAt fail', cell, [dx, dy, dz], lastErr) }
  }
  bot.__placeFail = sawRef ? `place_error:${lastErr}` : 'no_reference'
  if (process.env.H1_DEBUG) console.log('placeAt no ref', cell)
  return false
}

function siteOk(bot, S, env) {
  if (!isStandable(bot, S.x, S.y, S.z)) return false
  // HOME2: never beside a door or gate (the door would be a wall of the pillbox; blocks end up on its walk axis and cannot be removed again)
  if (doorKeepout(bot, S.x, S.y, S.z)) return false
  for (const c of pillboxCells(S)) if (!solid(bot.blockAt(V(c.x, c.y, c.z))) && doorKeepout(bot, c.x, c.y, c.z)) return false
  for (const c of [S, ...pillboxCells(S)]) {
    if (env.digForbidden?.(c)) return false
    const b = bot.blockAt(V(c.x, c.y, c.z))
    if (b && /lava|water|bubble/.test(b.name)) return false
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const f = bot.blockAt(V(S.x + dx, S.y - 1, S.z + dz)); if (f && /lava/.test(f.name)) return false
    // every wall cell must be placeable: it is solid already or has a solid neighbour other than our own cell (floor beside us, an older wall)
    const cell = V(S.x + dx, S.y, S.z + dz)
    if (!solid(bot.blockAt(cell)) && ![[0, -1, 0], [dx, 0, dz], [dz ? 1 : 0, 0, dx ? 1 : 0], [dz ? -1 : 0, 0, dx ? -1 : 0]].some(([a, b, c]) => solid(bot.blockAt(cell.offset(a, b, c))))) return false
  }
  return true
}

/** A reachable standable site near (or far from) the bot where a pillbox is allowed. Deterministic ring search. */
export function findSite(bot, env, pathOk = () => true) {
  const o = bot.entity.position.floored()
  const hy = standableY(bot, o.x, o.z, o.y, 1, 3)   // the bot may be mid-jump: use the real floor
  const here = V(o.x, hy ?? o.y, o.z)
  if (hy !== null && siteOk(bot, here, env)) return here
  for (const r of [3, 6, 10, 16, 24, 36, 52, 72]) {
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2 + r * 0.37
      const x = Math.floor(o.x + Math.cos(ang) * r), z = Math.floor(o.z + Math.sin(ang) * r)
      const y = standableY(bot, x, z, o.y, 4, 6)
      if (y === null) continue
      const S = V(x, y, z)
      if (siteOk(bot, S, env) && pathOk(S)) return S
    }
  }
  return null
}

const toolFor = (name) => (/planks|log/.test(name) ? 'axe' : /dirt|grass|sand|gravel/.test(name) ? 'shovel' : 'pickaxe')
export async function breakCell(ctx, cell) {
  const bot = ctx.bot
  const b = bot.blockAt(V(cell.x, cell.y, cell.z))
  if (!solid(b)) return true
  await equipBest(bot, toolFor(b.name)).catch(() => {})
  try { await Promise.race([bot.dig(b), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 9000))]) } catch { try { bot.stopDigging() } catch { /* ignore */ } return false }
  return true
}

/** True when feet and head level are walled on all 4 sides and the cell above the head is solid (our pillbox, or any closed 1x1x2 hole). */
export function boxedIn(bot) {
  const p = bot.entity?.position
  if (!p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  const s = (dx, yy, dz) => solid(bot.blockAt(V(x + dx, yy, z + dz))) && !isWalkthroughDoor(bot.blockAt(V(x + dx, yy, z + dz))) // B1: a wooden door is an exit, not a wall
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => s(dx, y, dz) && s(dx, y + 1, dz)) && s(0, y + 2, 0)
}

/** Q1: pathfinding out of a sealed pillbox is NoPath in milliseconds (real Wren: go_to/move_to failed in 5 ms right after an S2 intent
 *  replaced the night shelter, so S2 was told "path_failed" and wrote "pathing issues" into her self-summary). Open a one-block door:
 *  the wall column (feet + head level) on the side with the most open space beyond it. Only blocks of the kind we place are dug, never
 *  protected cells. Resolves true when the pillbox is no longer closed. */
export async function openDoor(bot, env = {}, { timeoutMs = 9000 } = {}) {
  if (!boxedIn(bot)) return false
  const p = bot.entity.position.floored()
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const score = ([dx, dz]) => {
    const f = bot.blockAt(V(p.x + 2 * dx, p.y - 1, p.z + 2 * dz)), a = bot.blockAt(V(p.x + 2 * dx, p.y, p.z + 2 * dz)), h = bot.blockAt(V(p.x + 2 * dx, p.y + 1, p.z + 2 * dz))
    return (solid(f) ? 2 : 0) + (solid(a) ? 0 : 2) + (solid(h) ? 0 : 1) - (f && /lava|water/.test(f.name) ? 9 : 0)
  }
  // B1: only blocks she placed herself (or loose natural pillbox material with no player structure around) are opened, never a player's hut
  const mine = (x, y, z) => { const b = bot.blockAt(V(x, y, z)); return !!b && !builtReason(bot, b) }
  const side = dirs.filter(([dx, dz]) => PLACEABLE.test(bot.blockAt(V(p.x + dx, p.y, p.z + dz))?.name ?? '') && !env.digForbidden?.({ x: p.x + dx, y: p.y, z: p.z + dz }) && mine(p.x + dx, p.y, p.z + dz) && mine(p.x + dx, p.y + 1, p.z + dz)).sort((a, b) => score(b) - score(a))[0]
  if (!side) return false
  const t0 = Date.now()
  for (const yy of [p.y + 1, p.y]) { // head first, so the feet block never drops on us
    const b = bot.blockAt(V(p.x + side[0], yy, p.z + side[1]))
    if (!solid(b)) continue
    if (!PLACEABLE.test(b.name) || env.digForbidden?.({ x: b.position.x, y: b.position.y, z: b.position.z })) return false
    await equipBest(bot, toolFor(b.name)).catch(() => {})
    try { await Promise.race([bot.dig(b), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), Math.max(500, timeoutMs - (Date.now() - t0))))]) } catch { try { bot.stopDigging() } catch { /* ignore */ } return false }
  }
  return !boxedIn(bot)
}

/** NAV1: simple_hut records itself here (build.js) so she can find the way out of her OWN hut: observed she sealed a 5x5 hut around herself (no door item: the door gap is
 *  closed with two placed blocks) and every goto/explore/gather from inside was NoPath in 44 ms, because openDoor only knows the 1x1 pillbox. The door cells are placed blocks: hers to open. */
export function recordHut(bot, S, size, doorCells, sealed) {
  const r = Math.floor(size / 2)
  bot.__huts = [...(bot.__huts ?? []).filter((h) => !(h.S.x === S.x && h.S.y === S.y && h.S.z === S.z)), { S: { x: S.x, y: S.y, z: S.z }, r, door: doorCells.map((c) => ({ x: c.x, y: c.y, z: c.z })), sealed, t: Date.now() }].slice(-6)
}
function hutAround(bot) {
  const p = bot.entity?.position; if (!p) return null
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  return (bot.__huts ?? []).find((h) => Math.abs(x - h.S.x) <= h.r - 1 && Math.abs(z - h.S.z) <= h.r - 1 && y >= h.S.y && y <= h.S.y + 1 && h.door.some((c) => solid(bot.blockAt(V(c.x, c.y, c.z))))) ?? null
}
/** Open the (sealed) door of the hut she stands in: dig its 2 door cells, head first. True when no door cell is solid any more. */
export async function leaveHut(bot, env = {}, { timeoutMs = 32000 } = {}) {
  const h = hutAround(bot); if (!h) { bot.__leaveHutWhy = 'no_hut_here'; return false }
  const t0 = Date.now()
  for (const c of [...h.door].sort((a, b) => b.y - a.y)) {
    const b = bot.blockAt(V(c.x, c.y, c.z))
    if (!solid(b) || isWalkthroughDoor(b)) continue
    { const why = env.digForbidden?.(c) ? 'forbidden' : builtReason(bot, b); if (why) { bot.__leaveHutWhy = why; return false } }   // a block she did not place stays protected
    await equipBest(bot, toolFor(b.name)).catch(() => {})
    try { await Promise.race([bot.dig(b), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), Math.max(500, Math.min(16000, timeoutMs - (Date.now() - t0)))))]) } catch (e) { bot.__leaveHutWhy = 'dig:' + String(e?.message ?? e); try { bot.stopDigging() } catch { /* ignore */ } return false }
  }
  return !h.door.some((c) => solid(bot.blockAt(V(c.x, c.y, c.z))))
}
/** flood fill over cells free at feet+head level within 5 blocks; true when it never reaches the edge and a roof covers it (a sealed room, whoever built it) */
function closedRoom(bot, R = 5) {
  const p = bot.entity.position, x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z)
  const free = (x, z) => !solid(bot.blockAt(V(x, y0, z))) && !solid(bot.blockAt(V(x, y0 + 1, z)))
  const seen = new Set([`${x0},${z0}`]), q = [[x0, z0]]
  while (q.length) {
    const [x, z] = q.pop()
    if (Math.abs(x - x0) >= R || Math.abs(z - z0) >= R) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = `${x + dx},${z + dz}`; if (!seen.has(k) && free(x + dx, z + dz)) { seen.add(k); q.push([x + dx, z + dz]) } }
  }
  for (const k of seen) { const [x, z] = k.split(',').map(Number); let roof = false; for (let dy = 2; dy <= 4 && !roof; dy++) roof = solid(bot.blockAt(V(x, y0 + dy, z))); if (!roof) return false }
  return seen.size > 1
}
/** NAV1: why a path from where she stands is impossible, in words S2 can act on (null when nothing obvious). */
export function explainNoPath(bot) {
  try {
    if (!bot.entity) return null
    if (hutAround(bot)) return 'sealed_in_own_hut (door sealed with placed blocks; leave_hut / open the door first)'
    if (boxedIn(bot)) return 'boxed_in (walls and ceiling on every side)'
    const p = bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (closedRoom(bot)) return 'enclosed_room (every opening around you is walled; no door, so nothing to walk through)'
    const walled = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => solid(bot.blockAt(V(x + dx, y + 1, z + dz))) && solid(bot.blockAt(V(x + dx, y + 2, z + dz)))).length
    if (walled >= 3) return 'in_pit (walls two blocks high around you; walking cannot climb out, digging is off)'
  } catch { /* ignore */ }
  return null
}

/** NAV1: NoPath from inside a pit (walls 2 high, e.g. dug by gather): allow the pathfinder to dig for the one retry (30 s), then restore. The dig guard still refuses protected/built blocks. */
export function allowPitDig(bot, ms = 30000) {
  const mv = bot.pathfinder?.movements
  if (!mv || mv.canDig || !String(explainNoPath(bot) ?? '').startsWith('in_pit')) return false
  mv.canDig = true
  const t = setTimeout(() => { mv.canDig = false }, ms); t.unref?.()
  return true
}

/** SHEL1: build_failed history per place. observed: 9x the same site, 'only_falling_blocks' (sand bag, centre cap has no support). Max 2 tries per place per 30 min, then fail in ms. */
const SHELTER_FAILS = []
const SHELTER_RETRY_MS = 30 * 60 * 1000
export function noteShelterFail(S, now = Date.now()) { SHELTER_FAILS.push({ x: S.x, y: S.y, z: S.z, t: now }); while (SHELTER_FAILS.length > 40) SHELTER_FAILS.shift() }
export function shelterFailsNear(p, now = Date.now(), r = 8) { return SHELTER_FAILS.filter((f) => now - f.t < SHELTER_RETRY_MS && Math.abs(f.x - p.x) <= r && Math.abs(f.z - p.z) <= r && Math.abs(f.y - p.y) <= 6).length }
export function resetShelterFails() { SHELTER_FAILS.length = 0 }

export function makeShelter(env) {
  return {
    name: 'shelter', max_s: 900, stall_s: 45, stationary: true,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      const p = bot.entity.position.floored()
      const S = V(p.x, standableY(bot, p.x, p.z, p.y, 1, 3) ?? p.y, p.z)
      const open = openCells(bot, S)
      if (open > 0 && placeableCount(items(bot)) < Math.min(open, SHELTER_BLOCKS)) return { ok: false, reason: 'no_blocks' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.placed ?? 0}:${ctx.state.ticks ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const t0 = Date.now()
      const waitMax = (ctx.args.max_wait_s ?? 700) * 1000
      const floorOf = () => { const p = bot.entity.position.floored(); const y = standableY(bot, p.x, p.z, p.y, 1, 3); return V(p.x, y ?? p.y, p.z) }
      let S = floorOf()
      if (openCells(bot, S) > 0 && shelterFailsNear(S) >= 2) { ctx.log?.('build_failed_detail', { at: [S.x, S.y, S.z], why: 'repeat_suppressed', blocks: placeableCount(items(bot)) }); return { ok: false, reason: 'build_failed_repeat' } }
      // 1. site
      if (openCells(bot, S) > 0) {
        ctx.state.stage = 'site'
        const pathOk = (T) => { try { return !bot.pathfinder?.getPathTo || bot.pathfinder.getPathTo(bot.pathfinder.movements, new goals.GoalNear(T.x, T.y, T.z, 1), 200).status !== 'noPath' } catch { return true } }
        const site = findSite(bot, env, pathOk)
        if (!site) return { ok: false, reason: 'no_site' }
        if (dist3(site, bot.entity.position) > 1.2) {
          const r = await ctx.goto(new goals.GoalBlock(site.x, site.y, site.z), { timeoutMs: 45000 })
          if (!r.ok) return { ok: false, reason: r.reason }
        }
        for (let i = 0; i < 10 && !bot.entity.onGround; i++) await ctx.sleep(150)
        S = floorOf()
        if (!siteOk(bot, S, env)) return { ok: false, reason: 'no_site' }
        // 2. build
        ctx.state.stage = 'build'
        try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
        bot.clearControlStates?.()
        for (let pass = 0; pass < 2 && openCells(bot, S) > 0 && !ctx.aborted; pass++) {
          for (const c of pillboxCells(S)) {
            if (ctx.aborted) break
            const r = await placeAt(bot, c)
            if (r === true) ctx.state.placed = (ctx.state.placed ?? 0) + 1
          }
        }
        if (openCells(bot, S) > 0) {
          // SHEL1: only falling blocks (sand/gravel) and just the unsupported centre cap open, walls 2 high all round: that is a shelter against melee (same rule as SURV3 cover)
          const wallsAt = (yy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(bot.blockAt(V(S.x + dx, yy, S.z + dz))))
          const openNow = pillboxCells(S).filter((c) => !solid(bot.blockAt(V(c.x, c.y, c.z))))
          if (bot.__placeFail === 'only_falling_blocks' && wallsAt(S.y) && wallsAt(S.y + 1) && openNow.every((c) => c.x === S.x && c.z === S.z && c.y === S.y + 2)) {
            ctx.log?.('shelter_open_top', { at: [S.x, S.y, S.z], why: 'only_falling_blocks' })
            ctx.state.openTop = true
          } else {
            // SURV2: say WHY (observed: build_failed 5x with no trace of the cause): per open cell the block in it and the placement failure
            const open = openNow.map((c) => ({ at: [c.x, c.y, c.z], block: bot.blockAt(V(c.x, c.y, c.z))?.name ?? null, forbidden: !!env.digForbidden?.(c) }))
            ctx.log?.('build_failed_detail', { at: [S.x, S.y, S.z], open, why: bot.__placeFail ?? null, blocks: placeableCount(items(bot)) })
            // SHEL1: fall back to what her inventory can do (pit with pick/shovel, tower, shield) instead of leaving her in the open
            let cov = null
            if (!ctx.aborted) { try { cov = await emergencyCover(ctx, env, { maxMs: 12000 }) } catch { cov = null } }
            if (cov?.ok) { S = floorOf(); ctx.log?.('shelter_fallback', { mode: cov.mode, at: [S.x, S.y, S.z] }) }
            else { noteShelterFail(S); return { ok: false, reason: ctx.aborted ? 'aborted' : 'build_failed', fallback: cov?.reason ?? null } }
          }
        }
      }
      // 3. wait out the night
      ctx.state.stage = 'wait'
      while (!ctx.aborted && Date.now() - t0 < waitMax && isDark(bot)) {
        ctx.state.ticks = (ctx.state.ticks ?? 0) + 1 // declared wait budget
        await ctx.sleep(1000)
        if (!ctx.state.openTop && openCells(bot, S) > 0 && placeableCount(items(bot)) > 0) { for (const c of pillboxCells(S)) await placeAt(bot, c) }
      }
      if (ctx.aborted) return { ok: false, reason: 'aborted' }
      // SURV2: never open the pillbox while she is hurt or something hostile is close (live test: shelter dug itself out 8 s after dig_in with a skeleton at 8 m and hp 4 -> dead)
      const hostileClose = () => Object.values(bot.entities ?? {}).some((e) => e && e !== bot.entity && e.position && MOBS[e.name] && !MOBS[e.name].neutral && e.isValid !== false && dist3(e.position, bot.entity.position) <= 28)
      for (let i = 0; i < 120 && !ctx.aborted && (bot.health < 12 || hostileClose()) && Date.now() - t0 < waitMax + 120000; i++) { ctx.state.ticks = (ctx.state.ticks ?? 0) + 1; ctx.state.stage = 'wait_safe'; await ctx.sleep(1000) }
      // 4. leave and reclaim the blocks
      ctx.state.stage = 'leave'
      const order = [...pillboxCells(S).slice(4, 8), ...pillboxCells(S).slice(0, 4), ...pillboxCells(S).slice(8)] // head level first, so we can step out
      const tl = Date.now()
      let door = false
      for (const c of order) {
        if (ctx.aborted || Date.now() - tl > 20000) break
        if (env.digForbidden?.(c)) continue
        if (dist3(bot.entity.position.offset(0, 1.6, 0), V(c.x + 0.5, c.y + 0.5, c.z + 0.5)) > 4.5) continue
        await breakCell(ctx, c)
        ctx.state.ticks = (ctx.state.ticks ?? 0) + 1
        if (!door && openCells(bot, S) >= 2) door = true
      }
      await collectDrops(ctx, bot.entity.position, { r: 6, max: 6 })
      const out = bot.entity.position
      await ctx.goto(new goals.GoalNear(out.x + 3, out.y, out.z + 3, 3), { timeoutMs: 8000 })
      return { ok: true, reason: isDark(bot) ? 'timeout' : 'dawn' }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}

export function makeTakeCover(env) {
  const cover = (bot, threats) => {
    const o = bot.entity.position.floored()
    const near = threats[0].e.position
    let best = null
    for (let r = 2; r <= 10; r += 2) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2 + r
        const x = Math.floor(o.x + Math.cos(ang) * r), z = Math.floor(o.z + Math.sin(ang) * r)
        const y = standableY(bot, x, z, o.y, 2, 3)
        if (y === null) continue
        const cell = { x, y, z }
        if (env.costAt && !(env.costAt(cell) < 100)) continue
        if (!hiddenFrom(bot, cell, threats)) continue
        const cost = dist3(cell, o) + 0.3 * Math.max(0, dist3(o, near) - dist3(cell, near))
        if (!best || cost < best.cost) best = { cell, cost }
      }
      if (best) break
    }
    return best?.cell ?? null
  }
  return {
    name: 'take_cover', max_s: 40, stall_s: 15, precondition: alive,
    progress_fn: (ctx) => `${ctx.state.round ?? 0}:${ctx.state.best ?? 'x'}:${ctx.state.hits ?? 0}:${ctx.state.stage ?? ''}`,
    async run(ctx) {
      const bot = ctx.bot
      for (let round = 0; round < 4 && !ctx.aborted; round++) {
        ctx.state.round = round
        const threats = rangedThreats(bot, 32)
        if (!threats.length) return { ok: true, reason: 'clear' }
        const me = bot.entity.position
        if (hiddenFrom(bot, me.floored(), threats)) {
          ctx.state.stage = 'hidden'
          for (let i = 0; i < 6 && !ctx.aborted; i++) { await ctx.sleep(1000); ctx.state.best = i }
          return { ok: true, reason: 'covered' }
        }
        const sword = bestTool(bot, 'sword')
        const mode = chooseResponse({ hp: bot.health, nThreats: threats.length, nearest: threats[0].d, hasWeapon: !!sword })
        if (mode === 'charge') {
          ctx.state.stage = 'charge'
          await equipBest(bot, 'sword').catch(() => {})
          const tgt = threats[0].e
          const tc = Date.now()
          while (!ctx.aborted && tgt.isValid !== false && Date.now() - tc < 14000 && bot.health >= 8) {
            const d = dist3(tgt.position, bot.entity.position)
            ctx.state.best = Math.round(d)
            if (d > 3) { bot.pathfinder?.setGoal(new goals.GoalFollow(tgt, 1.5), true); await ctx.sleep(250); continue }
            try { bot.pathfinder?.setGoal(null); await bot.lookAt(tgt.position.offset(0, (tgt.height ?? 1.8) * 0.85, 0)); bot.attack(tgt); ctx.state.hits = (ctx.state.hits ?? 0) + 1 } catch { /* ignore */ }
            await ctx.sleep(600)
          }
          try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
          if (tgt.isValid === false) return { ok: true, reason: 'killed' }
          continue
        }
        ctx.state.stage = 'cover'
        const cell = cover(bot, threats)
        if (!cell) {
          // nothing to hide behind: run directly away from the nearest shooter
          const t = threats[0].e.position
          const dx = me.x - t.x, dz = me.z - t.z, n = Math.hypot(dx, dz) || 1
          const x = Math.floor(me.x + (dx / n) * 22), z = Math.floor(me.z + (dz / n) * 22)
          const y = standableY(bot, x, z, me.y, 6, 8)
          if (y === null) return { ok: false, reason: 'no_escape_route' }
          const r = await ctx.goto(new goals.GoalNear(x, y, z, 3), { timeoutMs: 12000 })
          if (!r.ok && r.reason === 'aborted') return r
          continue
        }
        ctx.state.best = Math.round(dist3(cell, me))
        const r = await ctx.goto(new goals.GoalBlock(cell.x, cell.y, cell.z), { timeoutMs: 8000 })
        if (!r.ok && r.reason === 'aborted') return r
      }
      const left = rangedThreats(bot, 32)
      return left.length && !hiddenFrom(bot, bot.entity.position.floored(), left) ? { ok: false, reason: 'still_exposed' } : { ok: true, reason: 'covered' }
    },
    abort: (_r, ctx) => { try { ctx.bot.pathfinder?.setGoal(null) } catch { /* ignore */ } },
  }
}

const DIG_TOOL_RE = /_(pickaxe|shovel)$/
export const FALLING_RE = /^(sand|red_sand|gravel|[a-z_]+_concrete_powder)$/
export const TOWER_H = 3   // SURV4: a tower of this many blocks under her feet; mobs of the zombie class cannot reach it (live-measured)

/**
 * SURV4: pillar up `h` blocks with falling blocks (sand/gravel) from the bag. A pillar block is placed on the cell under her own feet, so it always has a floor under it and
 * never falls (unlike a sand roof over open air, SURV3). Returns the number of blocks placed.
 */
export async function towerUp(ctx, h = TOWER_H, { over = () => !!(ctx.aborted || ctx.signal?.aborted) } = {}) {
  const bot = ctx.bot; let placed = 0
  try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
  bot.clearControlStates?.()
  for (let i = 0; i < h && !over(); i++) {
    const stack = items(bot).filter((it) => PLACEABLE.test(it.name)).sort((a, b) => (FALLING_RE.test(b.name) ? 1 : 0) - (FALLING_RE.test(a.name) ? 1 : 0) || b.count - a.count)[0]
    if (!stack) break
    const before = bot.entity.position.y
    try { await bot.equip(stack, 'hand') } catch { /* ignore */ }
    try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch { /* ignore */ }
    bot.setControlState('jump', true)
    let done = false
    for (let k = 0; k < 16 && !done && !over(); k++) {
      await ctx.sleep(50)
      if (bot.entity.position.y - before >= 0.85) {
        const f = bot.entity.position.floored()
        const ref = bot.blockAt(V(f.x, Math.floor(before) - 1, f.z))
        const under = bot.blockAt(V(f.x, Math.floor(before), f.z))
        try { if (solid(under)) done = true; else if (solid(ref)) { await bot.placeBlock(ref, V(0, 1, 0)); done = true } } catch { /* next tick */ }
      }
    }
    bot.setControlState('jump', false)
    if (!done) break
    placed++
    for (let k = 0; k < 8 && !bot.entity.onGround && !over(); k++) await ctx.sleep(50)
  }
  bot.setControlState('jump', false)
  return placed
}

/** SURV4: standing on a free-standing pillar (>= 3 solid cells under the feet, nothing solid beside the two cells under the feet): melee mobs below cannot walk up or reach. */
export function onTower(bot, blockAt = (x, y, z) => bot.blockAt(V(x, y, z))) {
  const p = bot.entity?.position; if (!p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  for (const k of [1, 2, 3]) if (!solid(blockAt(x, y - k, z))) return false
  for (const k of [1, 2]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (solid(blockAt(x + dx, y - k, z + dz))) return false
  return true
}

/** SURV2: can the ground under the feet cell S be dug two deep (plain solid, solid floor under that, no liquid, not forbidden)? */
export function canDigPit(bot, S, env = {}, n = 2) {
  const bs = []
  for (let k = 1; k <= n + 1; k++) bs.push(bot.blockAt(V(S.x, S.y - k, S.z)))   // n blocks to dig + a solid floor under them
  if (bs.some((b) => !solid(b))) return false
  if (/lava|water|magma|bedrock|chest|furnace|table|bed|door|spawner|obsidian|ore$/.test(bs.map((b) => b.name).join(' '))) return false
  // SURV3: digging down through sand/gravel is safe (nothing stands above the dug cell); the walls only fall if their own support goes. The cap must then not be a falling block (placeAt).
  for (let k = 1; k <= n; k++) if (env.digForbidden?.({ x: S.x, y: S.y - k, z: S.z })) return false
  // SURV4: the dig guard refuses ground next to her bed / door / torches (near_structure): a pit there is 'cannot_dig' in 0 ms, so the walls plan must be chosen instead
  for (let k = 1; k <= n; k++) { try { if (builtReason(bot, bot.blockAt(V(S.x, S.y - k, S.z)))) return false } catch { /* ignore */ } }
  return true
}
/** SURV2: how deep is the hole she already stands in (0 none, 1, 2)? Counts solid side cells at feet/head level. */
export function holeDepth(bot, S) {
  const side = (yy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => solid(bot.blockAt(V(S.x + dx, yy, S.z + dz)))).length
  return side(S.y + 1) === 4 ? 2 : side(S.y) === 4 ? 1 : 0
}
/** SURV2: does she have a way to seal herself in at all? (>= 6 placeable blocks for a pillbox, or a pick/shovel for a pit) */
export function coverMeans(bot) {
  const blocks = placeableCount(items(bot)), tool = items(bot).some((i) => DIG_TOOL_RE.test(i.name))
  return { blocks, tool, ok: blocks >= 6 || tool }
}

/** SURV2: hit the nearest hostile within reach (it stands in the cell we want to close). true when something was attacked. */
export async function hitNearby(ctx, over) {
  const bot = ctx.bot
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const t = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && MOBS[e.name] && !MOBS[e.name].neutral && e.isValid !== false && dist3(e.position.offset(0, 1, 0), eye) <= 3.4).sort((a, b) => dist3(a.position, eye) - dist3(b.position, eye))[0]
  if (!t) return false
  await equipBest(bot, 'sword').catch(() => {})
  for (let i = 0; i < 5 && !over() && t.isValid !== false && dist3(t.position.offset(0, 1, 0), eye) <= 3.6; i++) {
    try { await bot.lookAt(t.position.offset(0, (t.height ?? 1.8) * 0.8, 0), true); bot.attack(t) } catch { /* ignore */ }
    await ctx.sleep(620)
  }
  return true
}

/**
 * SURV2: seal herself in as FAST as possible and break the line of sight to shooters on the way (live VAL2: hp 4 + skeleton at 15 m = dead in ~8 s, twice, because the
 * 10-block pillbox needs ~6 s). Order: (1) vs a shooter put one block column between us first (2 placements, <1 s), (2) pit = dig 2 down with the pick/shovel then cap
 * (an arrow cannot fly into a hole whose rim is above the eyes, so she is safe from range after ~2 s; the cap only adds melee safety), else pillbox walls nearest the threat
 * first. ctx: {bot, sleep(ms)->bool, aborted|signal, state?}. Returns {ok, reason, mode, placed, dug, ms}.
 */
export async function emergencyCover(ctx, env = {}, { maxMs = 12000, shield = true } = {}) {
  const bot = ctx.bot, t0 = Date.now()
  const aborted = () => !!(ctx.aborted || ctx.signal?.aborted)
  const over = () => aborted() || Date.now() - t0 > maxMs
  let placed = 0, dug = 0, mode = null
  bot.__placeFail = null
  try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
  bot.clearControlStates?.()
  const floorOf = () => { const p = bot.entity.position.floored(); const y = standableY(bot, p.x, p.z, p.y, 1, 3); return V(p.x, y ?? p.y, p.z) }
  for (let i = 0; i < 8 && !bot.entity.onGround && !over(); i++) await ctx.sleep(100)
  let S = floorOf()
  const shooters = rangedThreats(bot, 32).filter((t) => !hiddenFrom(bot, S, [t]))
  const m = coverMeans(bot)
  const have = holeDepth(bot, S)   // a skill that was cut short by this reflex may already have dug one block
  // SURV3: sand/gravel only in the bag -> no cap can be placed (it would fall on her). A 3-deep hole needs no cap: from the rim a zombie's reach (eye distance^2 ~ 2.9 > 2.04) does not get there; 2 deep does (3/3 dead in an open 2-deep sand pit).
  const safeBlocks = items(bot).filter((i) => PLACEABLE.test(i.name) && !FALLING_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
  const capless = m.tool && safeBlocks < 2
  // SURV4: sand/gravel is all she has: a pit stays open (live: 0/5 + 0/5 + 1/2) -> pillar up on it instead (needs no tool, ~1.5 s, no ranged threat: a tower is open to arrows)
  const fallingN = items(bot).filter((i) => FALLING_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (safeBlocks < 2 && fallingN >= TOWER_H && !shooters.length && have === 0 && !over()) {
    const n = await towerUp(ctx, TOWER_H, { over })
    const ok = n >= TOWER_H
    if (!ok) ctx.log?.('cover_failed_detail', { at: [S.x, S.y, S.z], mode: 'tower', placed: n, why: 'pillar_incomplete' })
    return { ok, reason: ok ? 'towered' : aborted() ? 'aborted' : 'cannot_pillar', mode: 'tower', placed: n, dug: 0, ms: Date.now() - t0 }
  }
  const depthWanted = capless ? 3 : 2
  const need = depthWanted - have
  const pit = m.tool && (need === 0 || canDigPit(bot, S, env, need))
  // 1. one block column toward the nearest shooter: arrows from that side stop at once
  if (shield && shooters.length && m.blocks >= 2 && have === 0 && !pit && !over()) {   // pit: digging is faster than a shield; shield only when walls are the plan
    const t = shooters[0].e.position
    const ddx = t.x - (S.x + 0.5), ddz = t.z - (S.z + 0.5)
    const [dx, dz] = Math.abs(ddx) >= Math.abs(ddz) ? [Math.sign(ddx), 0] : [0, Math.sign(ddz)]
    for (const yy of [S.y, S.y + 1]) { if ((await placeAt(bot, { x: S.x + dx, y: yy, z: S.z + dz })) === true) placed++ }
    mode = 'shield'
  }
  if (pit || m.blocks < 6) {
    if (!pit) return { ok: false, reason: placed ? 'shielded_only' : 'cannot_dig', mode, placed, dug, ms: Date.now() - t0 }
    mode = 'pit'
    for (let k = 0; k < need && !over(); k++) {
      const below = { x: S.x, y: S.y - 1, z: S.z }
      if (!(await breakCell(ctx, below))) break
      dug++
      for (let i = 0; i < 12 && bot.entity.position.y > S.y - 0.9 && !over(); i++) await ctx.sleep(80)   // fall one block
      S = floorOf()
    }
    if (!dug && need > 0) return { ok: false, reason: 'cannot_dig', mode, placed, dug, ms: Date.now() - t0 }
    for (let i = 0; i < 10 && !bot.entity.onGround && !over(); i++) await ctx.sleep(80)   // settle before placing over the head (an overlapping body makes the server refuse)
    for (let i = 0; i < 6 && placeableCount(items(bot)) < 2 && !over(); i++) await ctx.sleep(120)   // the dug blocks land in the inventory
  } else mode ??= 'pillbox'
  // 2. close: the cells around/over her (in a pit only the two roof blocks are open); the ones toward a shooter first
  const near = shooters[0]?.e.position
  const order = (cells) => (near ? [...cells].sort((a, b) => dist3(a, near) - dist3(b, near)) : cells)
  for (let pass = 0; pass < 2 && !over(); pass++) {
    const cells = pillboxCells(S)
    const lower = order(cells.filter((c) => c.y <= S.y + 1)), roof = cells.filter((c) => c.y > S.y + 1)
    for (const c of [...lower, ...roof]) {
      if (over()) break
      if (solid(bot.blockAt(V(c.x, c.y, c.z)))) continue
      if ((await placeAt(bot, c)) === true) placed++
      else if (!placeableCount(items(bot))) break
      else if (/^place_error/.test(bot.__placeFail ?? '') && await hitNearby(ctx, over)) { if ((await placeAt(bot, c)) === true) placed++ }   // a mob standing in the cell makes the server refuse: hit it, retry
    }
    if (boxedIn(bot) || openCells(bot, S) === 0) break
  }
  let sealed = boxedIn(bot) || openCells(bot, S) === 0
  // SURV3: only falling blocks (sand/gravel) and no safe cap: walls 2 high around her are enough against melee, so an open top counts; then hit whatever stands at the rim
  const wallsAt = (yy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(bot.blockAt(V(S.x + dx, yy, S.z + dz))))
  const wallsClosed = () => wallsAt(S.y) && wallsAt(S.y + 1)
  if (!sealed && bot.__placeFail === 'only_falling_blocks' && wallsClosed() && wallsAt(S.y + 2)) { /* 3 deep = the rim ring at the cap level is solid too */ sealed = true; mode = (mode ?? 'pit') + '_open_top' }
  if (!sealed && !aborted()) { if (await hitNearby(ctx, over)) mode = (mode ?? '') + '+fought' }
  if (!sealed) ctx.log?.('cover_failed_detail', { at: [S.x, S.y, S.z], mode, placed, dug, why: bot.__placeFail ?? null, open: openCells(bot, S), blocks: placeableCount(items(bot)) })
  return { ok: sealed, reason: sealed ? 'sealed' : aborted() ? 'aborted' : 'not_sealed', mode, placed, dug, ms: Date.now() - t0 }
}

/** SURV1: emergency dig-in (<= ~10 s, no walking): seal the cell she stands in. SURV2: the work is emergencyCover (shield toward shooters, pit first when a pick/shovel is held). The slow
 *  `shelter` skill (site search, wait for dawn, reclaim) stays for calm nights; this is for "hurt, night, something shooting". */
export async function moveToDryIfNeeded(ctx, env = {}) {
  const bot = ctx.bot
  try {
    const p = bot.entity.position.floored(); const S = V(p.x, p.y, p.z)
    if (!waterRisk(bot) || !nearWater(bot, S)) return false
    if (hostilesAround(bot, 12).length) return false   // a threat at the door: cover now, here
    for (const r of [4, 6, 9, 13]) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r)
      const y = standableY(bot, x, z, p.y, 3, 4); if (y === null) continue
      const T = V(x, y, z)
      if (nearWater(bot, T) || wetCell(bot, x, y, z)) continue
      ctx.log?.('dig_in_dry_site', { from: [p.x, p.y, p.z], to: [x, y, z] })
      await ctx.goto(new goals.GoalBlock(x, y, z), { timeoutMs: 9000 })
      return true
    }
  } catch { /* cover here */ }
  return false
}

export function makeDigIn(env) {
  return {
    name: 'dig_in', max_s: 14, stall_s: 8, stationary: true, // ARB1: an intentional enclosure is not 'confined_trapped'
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (boxedIn(bot)) return { ok: false, reason: 'already_sealed' }
      return coverMeans(bot).ok ? true : { ok: false, reason: 'no_blocks' }
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.placed ?? 0}:${ctx.state.dug ?? 0}`,
    async run(ctx) {
      ctx.state.stage = 'cover'
      await moveToDryIfNeeded(ctx, env)   // WATER1: water within 3 blocks = seepage; hurt/night with no hostile close: dry ground first
      const r = await emergencyCover(ctx, env, { maxMs: 12000 })
      ctx.state.placed = r.placed; ctx.state.dug = r.dug; ctx.state.stage = 'done'
      return { ok: r.ok, reason: r.reason, mode: r.mode, placed: r.placed, dug: r.dug }
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
}
