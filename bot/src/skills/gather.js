// Resource skills: gather_wood, gather_stone, collect(resource), hunt, fish. Success = inventory delta.
// Collecting skills require free inventory slots.
import { whenGrounded, yieldTick } from '../airborne-guard.js'
import { structureReason } from './enclosure.js' // DOOR3: never take structure blocks
import { goals, dist3, distXZ, V, items, countItem, countAny, countMatch, freeSlots, equipBest, bestTool, collectDrops, standableY, openSky, isNight } from './lib.js'
import { craftItem } from './craft.js'
import { digRisk, ledgeRisk, tooDark } from './dig-safe.js'
import { lightAt } from './survival.js'
import { makeFish } from './fishing.js'
import { makeForagePlants } from './forageplants.js'
import { noteDepleted, depletedAt } from './depleted.js'
import { waterRisk, wetCell } from '../water-policy.js'

const MIN_FREE = 2
const alive = ({ bot }) => !!bot?.entity && bot.health > 0
const notFull = ({ bot }) => !!bot?.entity && bot.health > 0 && freeSlots(bot) >= MIN_FREE ? true : { ok: false, reason: 'inventory_full' }

export const RESOURCES = {
  wood: { blocks: (n) => n.endsWith('_log'), items: (n) => n.endsWith('_log'), tool: 'axe', need: null },
  stone: { blocks: (n) => ['stone', 'cobblestone', 'andesite', 'diorite', 'granite'].includes(n), items: (n) => ['cobblestone', 'andesite', 'diorite', 'granite'].includes(n), tool: 'pickaxe', need: 'pickaxe' },
  coal: { blocks: (n) => n === 'coal_ore' || n === 'deepslate_coal_ore', items: (n) => n === 'coal', tool: 'pickaxe', need: 'pickaxe' },
  iron: { blocks: (n) => n === 'iron_ore' || n === 'deepslate_iron_ore', items: (n) => n === 'raw_iron', tool: 'pickaxe', need: 'stone_pickaxe' },
  sand: { blocks: (n) => n === 'sand' || n === 'red_sand', items: (n) => n === 'sand' || n === 'red_sand', tool: 'shovel', need: null },
  dirt: { blocks: (n) => n === 'dirt' || n === 'grass_block' || n === 'coarse_dirt', items: (n) => n === 'dirt' || n === 'coarse_dirt', tool: 'shovel', need: null },
  plants: { blocks: (n) => ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium', 'red_tulip', 'orange_tulip', 'pink_tulip', 'white_tulip', 'lily_of_the_valley'].includes(n), items: (n) => /^(dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|allium|.*_tulip|lily_of_the_valley)$/.test(n), tool: null, need: null },
}

const exposed = (bot, p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => { const b = bot.blockAt(p.offset(x, y, z)); return b && b.boundingBox === 'empty' && b.name !== 'lava' })


const SEARCH_RADII = [16, 40, 64]
const LABEL = { wood: 'log', stone: 'stone', coal: 'coal ore', iron: 'iron ore', sand: 'sand', dirt: 'dirt', plants: 'flower' }
/** GATH1: why a search found nothing, as one sentence the brain can read ('no log within 64 m'; 'nearby dirt is part of your house'). */
export function explainNoTarget(bot, env, res, ids, bad = new Set(), radius = SEARCH_RADII.at(-1)) {
  const R = radius, name = LABEL[res] ?? res, until = Date.now() + 400
  let all = []
  try { all = bot.findBlocks({ matching: ids, maxDistance: R, count: 150 }) } catch { /* chunk edge */ }
  if (!all.length) return `no ${name} within ${R} m (none in the loaded world around you)`
  let structure = 0, buried = 0, forbidden = 0, tried = 0, skipped = 0
  for (const p of all) {
    if (Date.now() > until) { skipped++; continue } // GATH2: bounded; the structure check floods
    if (bad.has(p.toString())) { tried++; continue }
    if (!exposed(bot, p)) { buried++; continue } // cheap test first
    if (structureReason(bot, bot.blockAt(p))) { structure++; continue }
    if (env.digForbidden?.(p)) { forbidden++; continue }
  }
  const parts = []
  if (structure) parts.push(`${structure} are part of your house or buildings (not taken)`)
  if (forbidden) parts.push(`${forbidden} are in protected areas`)
  if (buried) parts.push(`${buried} are buried with no open face`)
  if (tried) parts.push(`${tried} already failed`)
  if (skipped) parts.push(`${skipped} not checked (time)`)
  return `${all.length} ${name} blocks within ${R} m but none usable: ${parts.join(', ') || 'unreachable'}`
}

// ---- GATH2 -----------------------------------------------------------------------------------------------------------------
/** GATH2: trees beside her home/bed are part of the yard: prefer others (soft, not a ban). */
function nearHomePenalty(env, p) {
  let pen = 0
  for (const l of env.landmarks?.list?.() ?? []) if (/^(home|bed|shelter)/.test(l.kind) || l.id === 'home') if (Math.hypot(l.x - p.x, l.z - p.z) < 14) pen = 25
  return pen
}
const SEARCH_BUDGET_MS = 1500 // the whole candidate search of one loop turn (live: an empty stone search took 8.5 s)
const EMPTY_TTL_MS = 30000
const STAIR_DEPTH = 4
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SOFT = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|clay|stone|cobblestone|andesite|diorite|granite|tuff|deepslate|short_grass|tall_grass|fern|snow|snow_block)$/
const STONEY = /^(stone|cobblestone|andesite|diorite|granite)$/
const gAir = (b) => !b || b.boundingBox === 'empty'
const wet = (b) => !!b && /^(water|lava|bubble_column|magma_block)$/.test(b.name)

/** GATH2: plan a 1-wide stair that descends 1 per column (3 cells per column so the body fits) from a standing cell through soft ground into stone. */
export function planStair(bot, env, from, budgetEnd = Date.now() + 700) {
  const fx = Math.floor(from.x), fz = Math.floor(from.z), F = Math.floor(from.y)
  const starts = [[0, 0]]
  for (let r = 2; r <= 24; r += 2) for (let k = 0; k < 8; k++) { const a = (k / 8) * 2 * Math.PI; starts.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]) }
  for (const [sx, sz] of starts) {
    if (Date.now() > budgetEnd) return null
    const x0 = fx + sx, z0 = fz + sz
    const y0 = sx === 0 && sz === 0 ? F : standableY(bot, x0, z0, F, 4, 6)
    if (y0 === null) continue
    const here = V(x0 + 0.5, y0, z0 + 0.5)
    if (!openSky(bot, here)) continue // never under a roof / a tree canopy-less shelter: only outdoors
    if (bot.blockAt(V(x0, y0 - 1, z0)) && structureReason(bot, bot.blockAt(V(x0, y0 - 1, z0)))) continue
    for (const [dx, dz] of DIRS4) {
      const cells = []; let stone = 0, ok = true
      // cells per column i: feet y0-i, head y0-i+1, clearance y0-i+2 (the body walks off the previous step through it)
      for (let i = 1; i <= STAIR_DEPTH && ok; i++) for (const y of [y0 - i + 2, y0 - i + 1, y0 - i]) cells.push({ x: x0 + dx * i, y, z: z0 + dz * i, i })
      for (const c of cells) {
        const b = bot.blockAt(V(c.x, c.y, c.z))
        if (!b) { ok = false; break }
        if (wet(b) || [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([ax, ay, az]) => wet(bot.blockAt(V(c.x + ax, c.y + ay, c.z + az))))) { ok = false; break }
        if (gAir(b)) continue
        if (!SOFT.test(b.name) || wet(b) || env.digForbidden?.(b.position) || structureReason(bot, b)) { ok = false; break }
        if (STONEY.test(b.name)) stone++
      }
      if (!ok || stone < 2) continue
      const xb = x0 + dx * STAIR_DEPTH, zb = z0 + dz * STAIR_DEPTH, yb = y0 - STAIR_DEPTH
      const floor = bot.blockAt(V(xb, yb - 1, zb))
      if (!floor || gAir(floor) || wet(floor)) continue
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (wet(bot.blockAt(V(xb + ax, yb, zb + az))) || wet(bot.blockAt(V(xb + ax, yb - 1, zb + az)))) { ok = false }
      if (!ok) continue
      return { top: { x: x0, y: y0, z: z0 }, dir: [dx, dz], cells, stone }
    }
  }
  return null
}

/** Dig and walk down a planned stair. Returns the number of steps completed. */
async function digStair(ctx, env, plan, enough) {
  const bot = ctx.bot
  const T = plan.top
  const g = await ctx.goto(new goals.GoalBlock(T.x, T.y, T.z), { timeoutMs: 25000 })
  if (!g.ok && distXZ(bot.entity.position, V(T.x + 0.5, 0, T.z + 0.5)) > 2.5) return 0
  let done = 0
  for (let i = 1; i <= STAIR_DEPTH && !ctx.aborted; i++) {
    if (enough()) break
    ctx.state.stage = `stair${i}`
    for (const c of plan.cells.filter((q) => q.i === i)) {
      const b = bot.blockAt(V(c.x, c.y, c.z))
      if (gAir(b)) continue
      if (env.digForbidden?.(b.position) || structureReason(bot, b)) { ctx.log('stair_blocked', { at: [c.x, c.y, c.z] }); return done }
      const risk = digRisk(bot, b.position)
      if (risk) { ctx.log('dig_refused', { why: risk, at: [c.x, c.y, c.z] }); return done }
      await equipBest(bot, STONEY.test(b.name) ? 'pickaxe' : 'shovel').catch(() => {})
      try { await Promise.race([bot.dig(b), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 12000))]) } catch (e) { ctx.log('dig_error', { message: String(e.message).slice(0, 100) }); try { bot.stopDigging() } catch { /* ignore */ } return done }
      await ctx.sleep(120)
    }
    await collectDrops(ctx, V(plan.top.x + 0.5 + plan.dir[0] * i, plan.top.y - i + 0.5, plan.top.z + 0.5 + plan.dir[1] * i), { r: 3 })
    const gi = await ctx.goto(new goals.GoalBlock(T.x + plan.dir[0] * i, T.y - i, T.z + plan.dir[1] * i), { timeoutMs: 8000 })
    if (!gi.ok) return done
    done = i
  }
  return done
}

/** Walk back up the stair (it is open, no digging). */
async function climbOut(ctx, stair) {
  const bot = ctx.bot
  if (!stair || !bot?.entity || bot.health <= 0) return true
  const T = stair.top
  if (bot.entity.position.y >= T.y - 0.6) return true
  for (let k = 0; k < 2; k++) {
    await ctx.goto(new goals.GoalBlock(T.x, T.y, T.z), { timeoutMs: 20000 })
    if (bot.entity.position.y >= T.y - 0.6) return true
  }
  // walk the steps one by one, last resort
  for (let i = STAIR_DEPTH; i >= 0; i--) await ctx.goto(new goals.GoalBlock(T.x + stair.dir[0] * i, T.y - i, T.z + stair.dir[1] * i), { timeoutMs: 6000 })
  ctx.log('stair_climb', { ok: bot.entity.position.y >= T.y - 0.6 })
  return bot.entity.position.y >= T.y - 0.6
}

/** Remember where logs grow (max 3 records), so a barren home area can send her to a known forest. */
function rememberForest(env, p) {
  const lm = env.landmarks; if (!lm?.set || !lm.list) return
  const near = lm.list().find((l) => l.kind === 'forest' && Math.hypot(l.x - p.x, l.z - p.z) < 35)
  if (near) { const rec = lm.set(near.id, p, 'forest'); if (near.note) rec.note = near.note; if (near.res) rec.res = near.res; return }   // EXP1: keep her note and resource tags
  const forests = lm.list().filter((l) => l.kind === 'forest').sort((a, b) => a.t - b.t)
  while (forests.length >= 3) lm.forget(forests.shift().id)
  lm.set(`forest_${Date.now().toString(36)}`, p, 'forest')
}

/** GATH2: no log in the loaded area: go to a remembered forest, else probe outward in a new direction each call. Returns {moved, note}. */
async function seekForest(ctx, env, ids, hop) {
  const bot = ctx.bot, me = bot.entity.position
  if (isNight(bot) && !env.__forceDay) return { moved: false, note: 'not wandering far at night' }
  env.forestDead ??= new Map()
  const lm = env.landmarks
  const known = (lm?.list?.() ?? []).filter((l) => l.kind === 'forest' && !((env.forestDead.get(l.id) ?? 0) > Date.now()) && distXZ(l, me) > 30).sort((a, b) => distXZ(a, me) - distXZ(b, me))[0]
  let goal, label
  if (known) { goal = new goals.GoalNearXZ(known.x, known.z, 6); label = known.id; env.forestDead.set(known.id, Date.now() + 600000) } // marked dead until proven by a hit (rememberForest refreshes it)
  else {
    env.woodProbe = ((env.woodProbe ?? Math.floor(Math.random() * 8)) + 1 + (hop % 3)) % 8
    const a = (env.woodProbe / 8) * 2 * Math.PI, home = lm?.home
    let tx = me.x + Math.cos(a) * 60, tz = me.z + Math.sin(a) * 60
    if (home && Math.hypot(tx - home.x, tz - home.z) > 260) { tx = me.x + (home.x - me.x) * 0.5; tz = me.z + (home.z - me.z) * 0.5 } // never drift away for ever
    goal = new goals.GoalNearXZ(tx, tz, 6); label = `probe_${env.woodProbe}`
  }
  ctx.state.stage = `seek${hop}`
  const before = me.clone()
  const r = await ctx.goto(goal, { timeoutMs: 22000 })
  ctx.log('seek_forest', { to: label, ok: r.ok, moved: +distXZ(before, bot.entity.position).toFixed(0) })
  return { moved: distXZ(before, bot.entity.position) > 8, note: label }
}

/** The generic dig-and-pick-up engine (GATH2: wrapper that climbs a stair back out whatever the result). */
export async function gatherResource(ctx, env, res, want) {
  const st = { stair: null }
  try { return await gatherCore(ctx, env, res, want, st) } finally { if (st.stair) { try { ctx.state.stage = 'climb'; st.climbed = await climbOut(ctx, st.stair) } catch { st.climbed = false } } }
}

async function gatherCore(ctx, env, res, want, st) {
  const bot = ctx.bot
  const R = RESOURCES[res]
  const ids = Object.values(bot.registry.blocksByName).filter((b) => R.blocks(b.name)).map((b) => b.id)
  const have = () => items(bot).filter((i) => R.items(i.name)).reduce((s, i) => s + i.count, 0)
  const start = have()
  ctx.state.have = start
  const bad = new Set()
  const badCol = new Set()   // SURV4: columns (x,z) of a tree rejected as ledge/dark: every log of that trunk is rejected with it
  let fails = 0, rejected = 0
  // NAV1: bulk blocks (dirt/stone/sand) are never dug more than 1 below where she started working: observed gather_stone dug a 5-deep shaft under her own hut and could not climb out (NoPath in 44 ms, canDig off)
  const bulk = res === 'stone' || res === 'dirt' || res === 'sand'
  let anchor = null, stairs = 0, hops = 0, walked = 0, nightStop = false
  const radii = res === 'wood' ? [...SEARCH_RADII, 112] : SEARCH_RADII // GATH2: logs are sparse, so a wide pass is cheap
  const t00 = Date.now()
  const causes = {}, why = (k, d) => { const c = (causes[k] ??= { n: 0, d }); c.n++; c.d = d ?? c.d }
  const causeText = () => Object.entries(causes).map(([k, c]) => `${c.n}x ${k}${c.d ? ` (${c.d})` : ''}`).join(', ')
  // GATH2: a recent empty search at (nearly) the same spot answers at once, with the same honest reason
  const emptyKey = () => `${res}:${Math.floor(bot.entity.position.x / 16)}:${Math.floor(bot.entity.position.z / 16)}:${Math.floor(bot.entity.position.y / 8)}`
  const cache = (env.gatherEmpty ??= new Map())
  const dep = depletedAt(env, res, bot.entity.position)   // BAT1: 5 min cooldown for a (resource, place) that just came up empty, for every caller
  if (dep) { ctx.log('no_target', { resource: res, detail: dep.text, cached: true, cooldown: true }); return { ok: false, reason: 'no_target_found', detail: dep.text } }
  const hit = cache.get(emptyKey())
  if (hit && Date.now() - hit.t < EMPTY_TTL_MS) { ctx.log('no_target', { resource: res, detail: hit.detail, cached: true }); return { ok: false, reason: 'no_target_found', detail: hit.detail } }
  while (have() - start < want && !ctx.aborted && fails < 6) {
    if (freeSlots(bot) < 1) return { ok: have() > start, reason: 'inventory_full' }
    await whenGrounded(bot) // SURV3: never start a 1 s synchronous search mid-jump (live kick: 'floating too long' after 4 rejected targets in a row); also lets the physics timer run between iterations
    const me = bot.entity.position
    if (!anchor || distXZ(anchor, me) > 5 || me.y > anchor.y) anchor = { x: me.x, z: me.z, y: me.y }
    // NAV1 depth rule; GATH2: inside her own stair the floor is the stair bottom (max STAIR_DEPTH + 1 under the top), and never the column under her feet
    const minY = st.stair ? st.stair.top.y - STAIR_DEPTH - 1 : Math.floor(anchor.y) - 1
    const underMe = (p) => res === 'stone' && p.x === Math.floor(me.x) && p.z === Math.floor(me.z) && p.y < Math.floor(me.y)
    const tSearch = Date.now(), deadline = tSearch + SEARCH_BUDGET_MS
    // L1: widening search radius (a d40 log search blocked the event loop for ~175 ms; most targets are within 16). GATH1: up to 64 m, natural blocks only
    let cand = [], overBudget = false, restart = false
    // SURV3: observed 'N coal ore / 266 dirt found but none has a spot to stand': only the 25 nearest were tested, all in cave walls / under floors. Test them all (+-3 columns), widen the radius when none qualifies.
    const unstand = []
    const canStand = (p) => { for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (standableY(bot, p.x + dx, p.z + dz, p.y + 1, 0, 6) !== null) return true; return false }
    const runRadius = (maxDistance) => bot.findBlocks({ matching: ids, maxDistance, count: env.digForbidden ? 300 : 40, useExtraInfo: (b) => !!b.position && (!bulk || b.position.y >= minY) && Date.now() < deadline && !env.digForbidden?.(b.position) && exposed(bot, b.position) }) // R1: forbidden blocks are excluded INSIDE the search; GATH2: depth and a deadline in the callback (a buried-stone sphere made it run 8.5 s)
      // H1: with protected boxes the 40 nearest can all be forbidden (Wren stood in the village: stock_blocks found nothing)
      .filter((p) => !bad.has(p.toString()) && !badCol.has(`${p.x},${p.z}`) && !(bulk && p.y < minY) && !underMe(p) && exposed(bot, p) && !env.digForbidden?.(p) && !structureReason(bot, bot.blockAt(p))) // I1: protected regions are never dug
      .map((p) => ({ p, cost: distXZ(p, me) + 1.5 * Math.max(0, p.y - me.y) + 0.5 * Math.max(0, me.y - p.y) + (env.costAt?.(p) ?? 0) + (res === 'wood' ? nearHomePenalty(env, p) : 0) }))
      .filter((c) => Number.isFinite(c.cost)) // I1: Infinity from costAt = forbidden target
      .sort((a, b) => a.cost - b.cost)
      .filter((c, i, all) => { const ok = canStand(c.p); if (!ok && unstand.length < 3) unstand.push(c); return ok })
    for (const maxDistance of radii) {
      if (res === 'stone' && maxDistance > 40 && !env.noStair && !st.stair && stairs < 2 && cand.length === 0) {
        // GATH2: no exposed stone within 40 m (hillside/cave): dig a safe stair through the soil instead of walking 64 m
        const plan = planStair(bot, env, me)
        if (plan) {
          stairs++
          ctx.log('stair_plan', { top: plan.top, dir: plan.dir, stone: plan.stone })
          st.stair = plan
          const n = await digStair(ctx, env, plan, () => have() - start >= want)
          ctx.log('stair_done', { steps: n, have: have() - start })
          ctx.state.have = have(); ctx.state.stage = 'gather'
          if (n === 0) st.stair = null
          restart = true
          break
        }
      }
      if (Date.now() > deadline) { overBudget = true; break }
      await yieldTick(0)   // SURV3: one pass (up to ~1 s of synchronous findBlocks) at a time: a reflex that wants the body (live: hp 4 + zombie) gets it between passes, physics packets flow
      if (ctx.aborted) break
      cand = runRadius(maxDistance)
      if (cand.length) break
    }
    if (!cand.length && unstand.length && !restart) cand = unstand.slice(0, 3) // nothing with a visible standing spot anywhere: let the pathfinder try the nearest ones
    if (restart) continue // new position / depth floor: search again from the stair
    if (res === 'wood' && cand.length) rememberForest(env, cand[0].p)
    if (res === 'wood' && !cand.length && !overBudget && hops < 3) {
      const r = await seekForest(ctx, env, ids, hops); hops++
      if (r.moved) walked++
      if (r.moved || r.note !== 'not wandering far at night') { ctx.state.stage = 'gather'; continue }
      nightStop = true
    }
    ctx.state.search_ms = Date.now() - tSearch
    const t = cand[0] // SURV3: runRadius already keeps only targets with a standing spot (or, failing that, the 3 nearest for the pathfinder to try)
    if (!t) {
      if (have() > start) return { ok: true, reason: 'partial' }
      let detail = cand.length ? `${cand.length} ${LABEL[res] ?? res} blocks found within ${radii.at(-1)} m but none has a spot to stand and reach it` : explainNoTarget(bot, env, res, ids, bad, radii.at(-1))
      if (res === 'wood' && nightStop) detail += '; not wandering further at night'
      else if (res === 'wood' && hops) detail += `; looked further away (${walked} walk${walked === 1 ? '' : 's'}), no forest found`
      if (res === 'stone' && !cand.length) detail += stairs ? '; a stair through the soil found no usable stone' : '; no safe place for a stair through the soil within 24 m'
      if (overBudget) detail += ' (search time budget used)'
      cache.set(emptyKey(), { t: Date.now(), detail })
      noteDepleted(env, res, bot.entity.position, detail)
      ctx.log('no_target', { resource: res, detail, ms: Date.now() - t00 })
      return { ok: false, reason: 'no_target_found', detail }
    }
    const block = bot.blockAt(t.p)
    if (!block || !R.blocks(block.name)) { bad.add(t.p.toString()); continue }
    // D1: never work beside an open drop, never in the dark (except tunnelling resources), never dig a block that leaves a drop > 3
    const tunnel = res === 'stone' || res === 'coal' || res === 'iron'
    const lr = ledgeRisk(bot, t.p) ?? (!tunnel && !openSky(bot, me) && tooDark(Math.max(lightAt(bot, t.p.offset(0, 1, 0)), lightAt(bot, me.floored()))) ? 'dark' : null) // roofed AND unlit = cave; open sky at night is fine (light data of fresh chunks is unreliable)
    if (lr) {
      // SURV4: observed gather_wood 'nothing_gained' after 11.9 s: the 6 failures were 6 logs of ONE trunk on a cliff edge ('ledge' each, ~1 s search apiece). Reject the trunk (+-1 column) at once and do not count it as a failed dig.
      ctx.log('target_rejected', { why: lr, at: [t.p.x, t.p.y, t.p.z] }); bad.add(t.p.toString())
      if (res === 'wood') { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) badCol.add(`${t.p.x + dx},${t.p.z + dz}`) } else fails++
      if (++rejected >= 10) fails = 6
      continue
    }
    ctx.log('target', { block: block.name, at: [t.p.x, t.p.y, t.p.z] })
    if (dist3(me.offset(0, 1.62, 0), t.p.offset(0.5, 0.5, 0.5)) > 4.2) {
      const r = await ctx.goto(new goals.GoalLookAtBlock(t.p, bot.world, { reach: 4 }), { timeoutMs: 25000 })
      if (!r.ok) { bad.add(t.p.toString()); fails++; why('unreachable', r.reason); ctx.log('target_unreachable', { block: block.name, at: [t.p.x, t.p.y, t.p.z], reason: r.reason ?? null }); continue }
    }
    if (R.tool) await equipBest(bot, R.tool).catch(() => {})
    const before = have()
    try {
      const b2 = bot.blockAt(t.p)
      if (!b2 || !R.blocks(b2.name)) continue
      const risk = digRisk(bot, b2.position)
      if (risk) { ctx.log('dig_refused', { why: risk, at: [t.p.x, t.p.y, t.p.z] }); bad.add(t.p.toString()); fails++; why('dig_refused', risk); continue }
      await Promise.race([bot.dig(b2), new Promise((_, rej) => setTimeout(() => rej(new Error('dig timeout')), 12000))])
    } catch (e) { ctx.log('dig_error', { message: String(e.message).slice(0, 100) }); try { bot.stopDigging() } catch { /* ignore */ } bad.add(t.p.toString()); fails++; why('dig_error', String(e.message).slice(0, 40)); continue }
    await ctx.sleep(450)
    await collectDrops(ctx, t.p.offset(0.5, 0.5, 0.5))
    if (have() > before) { ctx.state.have = have(); fails = 0 } else {
      // SURV5: honest cause: block still there (dig had no effect) vs broken but the drop was not picked up (item entity left / fell out of reach / no drop for this tool)
      const nowB = bot.blockAt(t.p), broke = !nowB || nowB.name !== block.name
      const drop = broke && Object.values(bot.entities ?? {}).some((en) => en?.name === 'item' && en.position && en.position.distanceTo(t.p.offset(0.5, 0.5, 0.5)) < 4)
      why(!broke ? 'block_not_broken' : drop ? 'drop_not_picked_up' : 'broken_no_drop', `${block.name}@${t.p.y} held=${bot.heldItem?.name ?? 'nothing'}`)
      ctx.log('gain_none', { block: block.name, at: [t.p.x, t.p.y, t.p.z], broke, drop, held: bot.heldItem?.name ?? null })
      bad.add(t.p.toString()); fails++
    }
  }
  const gained = have() - start
  // SURV4: say WHY (a bare nothing_gained hid six ledge rejections)
  return gained > 0 ? { ok: true } : { ok: false, reason: ctx.aborted ? 'aborted' : 'nothing_gained', detail: rejected >= 10 || badCol.size ? `${rejected} targets rejected as unsafe to work at (ledge / dark), ${fails} dig failures${causeText() ? ': ' + causeText() : ''}` : `${fails} dig failures: ${causeText() || 'nothing picked up'}` }
}

/** Make sure a pickaxe exists, crafting a wooden one from logs/planks if not. */
async function ensurePickaxe(ctx, min = 'pickaxe') {
  const bot = ctx.bot
  if (bestTool(bot, 'pickaxe')) return true
  const r = await craftItem(ctx, 'wooden_pickaxe', 1)
  return r.ok
}

const gatherSkill = (env, name, res, defWant, max_s, pre) => ({
  name, max_s, stall_s: 35,
  precondition: (c) => { const n = notFull(c); return n === true ? (pre ? pre(c) : true) : n },
  progress_fn: (ctx) => `${ctx.state.have ?? 'start'}:${ctx.state.stage ?? 0}`,
  async run(ctx) {
    const want = ctx.args.count ?? defWant
    if (RESOURCES[res].need === 'pickaxe') {
      ctx.state.stage = 'tool'
      if (!(await ensurePickaxe(ctx))) return { ok: false, reason: 'no_tool' }
    }
    if (res === 'iron' && !['stone', 'iron', 'diamond', 'netherite'].some((t) => bestTool(ctx.bot, 'pickaxe')?.name.startsWith(t))) return { ok: false, reason: 'no_tool' }
    ctx.state.stage = 'gather'
    return gatherResource(ctx, env, res, want)
  },
  abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
})

export function makeGatherSkills(env) {
  const wood = gatherSkill(env, 'gather_wood', 'wood', 4, 100)
  const stone = gatherSkill(env, 'gather_stone', 'stone', 8, 120)
  const collect = {
    name: 'collect', max_s: 140, stall_s: 35,
    precondition: (c) => (c.args.resource in RESOURCES ? notFull(c) : { ok: false, reason: 'invalid_args' }),
    progress_fn: (ctx) => `${ctx.state.have ?? 'start'}:${ctx.state.stage ?? 0}`,
    async run(ctx) {
      const res = ctx.args.resource
      if (RESOURCES[res].need === 'pickaxe' || (res === 'iron')) {
        ctx.state.stage = 'tool'
        if (!(await ensurePickaxe(ctx))) return { ok: false, reason: 'no_tool' }
        if (res === 'iron' && !bestTool(ctx.bot, 'pickaxe')?.name.match(/^(stone|iron|diamond|netherite)/)) return { ok: false, reason: 'no_tool' }
      }
      ctx.state.stage = 'gather'
      return gatherResource(ctx, env, res, ctx.args.count ?? 4)
    },
    abort: (_r, ctx) => { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
  }
  return [wood, stone, collect, makeHunt(env), makeFish(env), makeForagePlants()]
}

const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
export const FISH = new Set(['cod', 'salmon'])
const FISH_DROP = /^(cod|salmon)$/

/**
 * VAL1: hunt a cod/salmon from the BANK. Pathfinder cannot walk to a swimming fish (the old hunt failed `unreachable_animal` on salmon); instead pick the
 * nearest fish near the surface, stand on a dry/shallow cell within sword reach of it, hit it when it is within 3.3 m, then pick the drop up
 * (shallow water is walked, deep water is not entered: the drowning reflex stays the safety net).
 */
export async function huntFish(ctx, env, wanted = null) {
  const bot = ctx.bot
  const before = countMatch(bot, FISH_DROP)
  const sword = bestTool(bot, 'sword') ?? bestTool(bot, 'axe'); if (sword) await bot.equip(sword, 'hand').catch(() => {})
  const bad = (env.huntBad ??= new Map())
  const pickFish = () => Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.isValid !== false && FISH.has(e.name) && (!wanted || wanted === 'fish' || e.name === wanted) && !((bad.get(e.id) ?? 0) > Date.now()) && dist3(e.position, bot.entity.position) < 40)
    .sort((a, b) => dist3(a.position, bot.entity.position) - dist3(b.position, bot.entity.position))
  const surfaceDepth = (e) => { for (let k = 0; k < 6; k++) { const b = bot.blockAt(e.position.offset(0, k, 0).floored()); if (b && b.name !== 'water') return k } return 6 }
  /** a standing cell within reach of the fish: standable (dry or shallow), close in x/z */
  const bank = (e) => {
    const f = e.position, out = []
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const x = Math.floor(f.x) + dx, z = Math.floor(f.z) + dz
      const y = standableY(bot, x, z, f.y + 1, 3, 3)
      if (y === null) continue
      if (waterRisk(bot) && wetCell(bot, x, y, z)) continue   // WATER1: hurt / night: fish from the bank with dry feet only
      const d = Math.hypot(x + 0.5 - f.x, y + 1.6 - (f.y + 0.3), z + 0.5 - f.z)
      if (d <= 3.0) out.push({ x, y, z, d, walk: dist3(V(x, y, z), bot.entity.position) })
    }
    return out.sort((a, b) => a.walk - b.walk || a.d - b.d)[0] ?? null
  }
  let target = null, hits = 0
  ctx.state.hits = 0
  const t0 = Date.now()
  while (!ctx.aborted && Date.now() - t0 < 80000) {
    if (!target || target.isValid === false) {
      if (target && target.isValid === false) break // killed or gone
      const near = pickFish().filter((e) => surfaceDepth(e) <= 3)[0] ?? null
      if (!near) { ctx.log('hunt_fish_none', { fish: pickFish().slice(0, 4).map((e) => ({ y: +e.position.y.toFixed(1), depth: surfaceDepth(e), d: +dist3(e.position, bot.entity.position).toFixed(1) })) }); return { ok: false, reason: pickFish().length ? 'fish_too_deep' : 'no_animal_nearby' } }
      target = near
    }
    const d = dist3(target.position, bot.entity.position.offset(0, 1.6, 0))
    ctx.state.best = Math.round(d)
    if (d <= 3.3) {
      bot.pathfinder.setGoal(null)
      try { await bot.lookAt(target.position.offset(0, 0.2, 0)); bot.attack(target); hits++; ctx.state.hits = hits } catch { /* ignore */ }
      await ctx.sleep(450); continue
    }
    const spot = bank(target)
    if (!spot) { bad.set(target.id, Date.now() + 120000); target = null; if (Date.now() - t0 > 60000) break; continue }
    const r = await ctx.goto(new goals.GoalNear(spot.x + 0.5, spot.y, spot.z + 0.5, 0.8), { timeoutMs: 8000 })
    if (!r.ok && r.reason === 'aborted') return { ok: false, reason: 'aborted' }
    if (!r.ok) { bad.set(target.id, Date.now() + 120000); target = null }
    else await ctx.sleep(300)
  }
  const pos = target?.position?.clone() ?? bot.entity.position.clone()
  bot.pathfinder.setGoal(null)
  await ctx.sleep(600)
  await collectDrops(ctx, pos, { r: 7 })
  ctx.state.got = countMatch(bot, FISH_DROP) - before
  return ctx.state.got > 0 ? { ok: true } : { ok: false, reason: ctx.aborted ? 'aborted' : hits ? 'no_drop' : 'fish_unreachable' }
}
export function makeHunt(env) {
  return {
    name: 'hunt', max_s: 90, stall_s: 20, precondition: notFull,
    progress_fn: (ctx) => `${ctx.state.best ?? 'start'}:${ctx.state.hits ?? 0}:${ctx.state.got ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot
      const meat = () => countMatch(bot, /^(beef|porkchop|mutton|chicken|rabbit)$/) + countMatch(bot, /_wool$/) * 0
      const before = meat()
      const sword = bestTool(bot, 'sword'); if (sword) await bot.equip(sword, 'hand').catch(() => {})
      const wanted = ctx.args.target ? String(ctx.args.target).replace(/_\d+$/, '') : null
      if (wanted && (wanted === 'fish' || FISH.has(wanted))) return huntFish(ctx, env, wanted)
      // H1: reach 80 (was 40; the soak found no animal within 32 around the village and never hunted); big animals are worth a detour, chickens are not
      const worth = (e) => dist3(e.position, bot.entity.position) - (/^(cow|pig|sheep)$/.test(e.name) ? 8 : 0)
      const pick = () => Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.isValid !== false && !((env.huntBad?.get(e.id) ?? 0) > Date.now()) && ANIMALS.has(e.name) && !(waterRisk(bot) && wetCell(bot, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z))) && (!wanted || e.name === wanted || String(e.id) === String(ctx.args.target).match(/(\d+)$/)?.[1]) && dist3(e.position, bot.entity.position) < 80)
        .sort((a, b) => worth(a) - worth(b))[0]
      // F1: pre-check reachability (A* with a short budget): 'noPath' animals (islands, behind water, fenced) are skipped at once instead of after a 15-20 s chase
      const reachable = async (e) => {
        try {
          const pf = bot.pathfinder; if (!pf?.getPathTo || !pf.movements) return true
          const r = await pf.getPathTo(pf.movements, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 400)
          return r?.status !== 'noPath'
        } catch { return true }
      }
      let target = null
      for (let k = 0; k < 3 && !ctx.aborted; k++) {
        const cand = pick(); if (!cand) break
        if (await reachable(cand)) { target = cand; break }
        ;(env.huntBad ??= new Map()).set(cand.id, Date.now() + 180000)
        ctx.log('hunt_unreachable_skip', { id: cand.id, name: cand.name })
      }
      if (!target) {
        // VAL1: no land animal reachable but a fish swims near: hunt it from the bank
        if (Object.values(bot.entities).some((e) => FISH.has(e.name) && e.position && dist3(e.position, bot.entity.position) < 30)) return huntFish(ctx, env, null)
        return { ok: false, reason: pick() ? 'unreachable_animal' : 'no_animal_nearby' }
      }
      ctx.state.hits = 0
      let lastGain = Date.now()
      const shears = target.name === 'sheep' && items(bot).find((i) => i.name === 'shears')
      if (shears) { // H1: shear instead of kill: wool for a bed, the sheep stays
        const wool0 = countMatch(bot, /_wool$/)
        await bot.equip(shears, 'hand').catch(() => {})
        for (let i = 0; i < 80 && !ctx.aborted && target.isValid; i++) {
          if (dist3(target.position, bot.entity.position) > 3) { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); await ctx.sleep(300); ctx.state.best = Math.round(dist3(target.position, bot.entity.position)); continue }
          bot.pathfinder.setGoal(null)
          try { await bot.lookAt(target.position.offset(0, target.height * 0.8, 0)); await bot.activateEntity(target); ctx.state.hits++ } catch { /* ignore */ }
          await ctx.sleep(500)
          if (countMatch(bot, /_wool$/) > wool0) break
        }
        await collectDrops(ctx, target.position.clone(), { r: 6 })
        ctx.state.got = countMatch(bot, /_wool$/) - wool0
        if (ctx.state.got > 0) return { ok: true }
      }
      while (!ctx.aborted) {
        if (!target.isValid) break
        const d = dist3(target.position, bot.entity.position)
        // H1: monotone best distance (an animal wandering closer/farther must not look like progress); give up on an unreachable one and remember it
        const rd = Math.round(d)
        if (rd < (ctx.state.best ?? 1e9)) { ctx.state.best = rd; lastGain = Date.now() }
        if (d > 3 && Date.now() - lastGain > 15000) { (env.huntBad ??= new Map()).set(target.id, Date.now() + 180000); bot.pathfinder.setGoal(null); return { ok: false, reason: 'unreachable_animal' } }
        if (d > 3) { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); await ctx.sleep(300); continue }
        bot.pathfinder.setGoal(null)
        try { await bot.lookAt(target.position.offset(0, target.height * 0.8, 0)); bot.attack(target); ctx.state.hits++ } catch { /* ignore */ }
        await ctx.sleep(650)
      }
      const pos = target.position.clone()
      bot.pathfinder.setGoal(null)
      await ctx.sleep(500)
      await collectDrops(ctx, pos, { r: 6 })
      ctx.state.got = meat() - before
      return meat() > before ? { ok: true } : { ok: false, reason: ctx.aborted ? 'aborted' : 'no_drop' }
    },
    abort: (_r, ctx) => { try { ctx.bot.pathfinder.setGoal(null) } catch { /* ignore */ } },
  }
}

// PB4: the rod fishing skill lives in fishing.js (bank search, cast, bite detection)
export { makeFish }
