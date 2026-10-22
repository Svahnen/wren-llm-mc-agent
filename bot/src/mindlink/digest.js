// Real bot state -> (a) the brain's S2 digest (brain/contract.js normalizeDigest shape) and (b) the mind's raw digest + tick input.
// Ids are what the body's skills can resolve: entities as `<name>_<n>` (n = rank by distance; resolveEntity() matches by name and picks the nearest),
// players by username, places by landmark name. Hazards are scanned from the world (lava, fire, ...).
import { isIgnoredPlayer } from '../ignore-players.js'
import { Vec3 } from 'vec3'
import { MOBS, relevantThreat } from '../reflex/threats.js'
import { facingFromYawDeg, clockFromTicks, gearNotes, compass8 } from '../../../brain/goaltypes.js'
const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'husk', 'drowned', 'pillager', 'phantom', 'slime', 'zombie_villager', 'cave_spider', 'stray', 'vindicator', 'blaze', 'ghast', 'magma_cube', 'silverfish', 'evoker', 'ravager', 'vex', 'wither_skeleton', 'piglin_brute', 'warden', 'guardian'])
// only animals the hunt skill can actually kill and eat are `animal` (hunting a horse would just fail; cod and salmon count since hunt hits them from the bank (VAL1)); everything else non-hostile is `neutral`
const ANIMAL = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'cod', 'salmon'])
const SKIP = new Set(['item', 'experience_orb', 'arrow', 'area_effect_cloud', 'falling_block', 'text_display', 'item_display', 'block_display', 'interaction', 'marker', 'lightning_bolt', 'painting', 'item_frame', 'glow_item_frame', 'armor_stand', 'boat', 'minecart'])
import { diagnose, groundBelow } from '../escape/world.js'
import { confinedShared } from '../detect/confined.js'
import { inOwnShelter, fullyEnclosed } from '../detect/stuck.js'

export const HAZARD_BLOCKS = ['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow', 'sweet_berry_bush', 'cobweb']
const NOTABLE_BLOCKS = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'gold_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'ancient_debris', 'chest', 'spawner', 'bookshelf', 'crafting_table', 'furnace', 'bed', 'water', 'lava', 'obsidian', 'sand', 'clay', 'pumpkin', 'melon']

const r1 = (v) => Math.round(v)
/** SURV1: health as the digest shows it: whole numbers, but one decimal below 6 and never 0 while alive (0.27 used to read as '0, basically dead') */
export function hpShown(h) { if (!(h > 0)) return 0; return h < 6 ? Math.max(0.1, Math.round(h * 10) / 10) : Math.round(h) }
export const posArr = (p) => (p ? [r1(p.x), r1(p.y), r1(p.z)] : null)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export function timePhase(bot) {
  const t = (((bot.time?.timeOfDay ?? 1000) % 24000) + 24000) % 24000
  const night = t >= 12542 && t <= 23459
  const phase = night ? 'night' : t >= 12000 ? 'dusk' : t >= 23460 ? 'dawn' : 'day'
  return { phase, ticks: t, day: Math.floor((bot.time?.age ?? 0) / 24000) + 1, night, thunder: (bot.thunderState ?? 0) > 0.5 }
}

export function entityKind(e) {
  const n = e.name ?? e.username ?? e.displayName
  if (!n || SKIP.has(n)) return null
  if (e.type === 'player') return null
  const cat = HOSTILE.has(n) || e.type === 'hostile' ? 'hostile' : ANIMAL.has(n) ? 'animal' : 'neutral'
  return { name: n, cat }
}

/** Scan hazard blocks near the bot. Returns [{id,kind,dist,pos}] (nearest per kind first, max 8). */
export function scanHazards(bot, maxDistance = 12, count = 4) {
  const me = bot.entity?.position
  if (!me || !bot.registry) return []
  // L1: ONE findBlocks pass over all hazard ids (was one pass per kind: 8 x 70 ms = 0.5-0.7 s of blocked event loop per call, measured live)
  const ids = HAZARD_BLOCKS.map((k) => bot.registry.blocksByName[k]?.id).filter((x) => x !== undefined)
  let ps = []
  try { ps = bot.findBlocks({ matching: ids, maxDistance, count: count * 8 }) } catch { /* chunk edge */ }
  const byKind = {}
  for (const p of ps) { const n = bot.blockAt(p)?.name; if (n) (byKind[n] ??= []).push(p) }
  const out = []
  for (const [kind, list] of Object.entries(byKind)) {
    list.sort((a, c) => dist(a, me) - dist(c, me))
    list.slice(0, count).forEach((p, i) => out.push({ id: `${kind}_${i + 1}`, kind: kind === 'soul_fire' ? 'fire' : kind, dist: +dist(p, me).toFixed(1), pos: [p.x, p.y, p.z] }))
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 8)
}

/** L2: ground-truth note when she is stuck on a column / ledge (no walkable neighbour, ground > 3 blocks below). The detector's repeat_cap
 *  refusals used to leave S2 blind to WHY every goal failed. Returns { y, drop, text } or null. */
export function confinedNote(bot) {
  try {
    if (!bot?.entity) return null
    // GATH1: sealed in her own shelter is resting, not trapped: no 'confined' words (the digest says 'sheltered' instead) unless a rescue was asked for
    if (inOwnShelter(bot) && !confinedShared.rescue) return null
    // STUCK3: hurt and walled in on purpose (dug pit / cover): that is cover, not 'confined and cannot move' (the repeated complaint made S2 write 16x 'stuck')
    if ((bot.health ?? 20) <= 10 && fullyEnclosed(bot) && !confinedShared.rescue) return null
    // W1: the global no-displacement watchdog declared her confined (any shape of trap, not only a column)
    if (confinedShared.confined) {
      const dir = confinedShared.dir?.dir ?? 'up'
      return { y: Math.round(bot.entity.position.y), drop: 0, global: true, rescue: !!confinedShared.rescue, text: `you are confined and cannot move; try dig out in direction ${dir}. Do not start explore/collect/hunt/approach: the body is running the escape ladder (dig out, staircase, bridge, pillar)` }
    }
    const d = diagnose(bot)
    if (!d.elevated) return null
    const y = Math.round(bot.entity.position.y)
    const drop = groundBelow(bot, d.cell).drop
    return { y, drop, text: `you are confined on a column at y=${y}, ${drop} blocks above the ground with no walkable neighbour; the body will descend by mining down (escape_descend), do not start collect/explore until you are down` }
  } catch { return null }
}

/** FOOD1: how long (s) hp has been <= 6; 0 when not low. Per bot. */
const lowHpSince = new WeakMap()
export function lowHpSeconds(bot, now = Date.now()) {
  if (!((bot.health ?? 20) <= 6) || !(bot.health > 0)) { lowHpSince.delete(bot); return 0 }
  if (!lowHpSince.has(bot)) lowHpSince.set(bot, now)
  return Math.round((now - lowHpSince.get(bot)) / 1000)
}

/** Brain digest. ctx: {drives:{urgencies}, landmarks, chat:[{from,text}], events:[str], recent_intents, activity, hazards?} */
export function brainDigest(bot, ctx = {}) {
  const me = bot.entity?.position
  const tp = timePhase(bot)
  const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && me)
  const counts = {}
  const nearby = ents.map((e) => ({ e, k: entityKind(e), d: dist(e.position, me) })).filter((x) => x.k && x.d <= 40)
    .sort((a, b) => (a.k.cat === 'hostile' ? -1 : 0) - (b.k.cat === 'hostile' ? -1 : 0) || a.d - b.d)
    .slice(0, 10)
    .map(({ e, k, d }) => { counts[k.name] = (counts[k.name] ?? 0) + 1; return { id: `${k.name}_${counts[k.name]}`, kind: k.name, cat: k.cat, dist: +d.toFixed(1), pos: posArr(e.position), tags: k.cat === 'animal' ? ['animal'] : [] } })
  const players = Object.values(bot.players ?? {}).filter((p) => p.username && p.username !== bot.username && !isIgnoredPlayer(p.username))
    .map((p) => ({ name: p.username, dist: p.entity ? +dist(p.entity.position, me).toFixed(1) : undefined, pos: p.entity ? posArr(p.entity.position) : undefined }))
  const inventory = {}
  for (const it of bot.inventory?.items?.() ?? []) inventory[it.name] = (inventory[it.name] ?? 0) + it.count
  const places = (ctx.landmarks?.list?.() ?? []).map((l) => ({ id: l.id, kind: l.kind, pos: [r1(l.x), r1(l.y), r1(l.z)], dist: me ? +dist(l, me).toFixed(0) : undefined, ...(l.note ? { note: String(l.note).slice(0, 80) } : {}) }))
    .sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0)).slice(0, 20)
  const f3 = worldFacts(bot)
  const u = ctx.drives?.urgencies ?? {}
  return {
    at: Date.now(), time: { day: tp.day, phase: tp.phase, ticks: tp.ticks }, thunder: tp.thunder, pos: posArr(me), ...(inOwnShelter(bot) ? { sheltered: true } : {}), ...f3, gear: gearNotes(inventory), food_sources: foodSources(ctx.foodSeen, me), failures: ctx.failures ?? [], ...(ctx.explored ? { explored: ctx.explored } : {}),
    difficulty: typeof bot.game?.difficulty === 'string' ? bot.game.difficulty : undefined,   // PB1: real difficulty drives the body-facts block
    health: hpShown(bot.health ?? 20), low_hp_s: lowHpSeconds(bot), food: Math.round(bot.food ?? 20),
    energy: Math.round(20 * (1 - (u.energy !== undefined ? Math.sqrt(u.energy) : 0))),
    needs: Object.fromEntries(['hunger', 'energy', 'safety', 'curiosity', 'social'].map((k) => [k, +(u[k] ?? 0).toFixed(2)])),
    inventory, free_slots: safe(() => bot.inventory.emptySlotCount(), 30),
    nearby, hazards: ctx.hazards ?? scanHazards(bot), players, places,
    events: [...(ctx.events ?? []).slice(-6), ...(ctx.confined ? [ctx.confined.text] : [])], chat: ctx.chat ?? [], recent_intents: ctx.recent_intents ?? [], activity: ctx.activity ?? null,
  }
}
/** animals seen recently (S1's perception memory) with distance and compass direction */
export function foodSources(seen, me, now = Date.now()) {
  if (!seen || !me) return []
  return [...seen.values()].filter((f) => now - f.t < 360000).map((f) => ({ name: f.name, dist: Math.round(Math.hypot(f.x - me.x, f.z - me.z)), dir: compass8(f.x - me.x, f.z - me.z) ?? 'here', ago_s: Math.round((now - f.t) / 1000) }))
    .sort((a, b) => a.dist - b.dist).slice(0, 5)
}
/** S1G: the F3-screen facts a player has: facing + compass, biome, dimension, light level, clock. Perception only. */
export function worldFacts(bot) {
  const out = {}
  const me = bot.entity?.position
  const yaw = bot.entity?.yaw
  if (Number.isFinite(yaw)) out.facing = facingFromYawDeg(180 - (yaw * 180) / Math.PI)
  let blk = null; try { blk = me ? bot.blockAt(me) : null } catch { /* unloaded */ }
  const biome = blk?.biome?.name ?? (Number.isFinite(blk?.biome) ? bot.registry?.biomes?.[blk.biome]?.name : null)
  if (biome) out.biome = String(biome).replace(/^minecraft:/, '')
  const dim = bot.game?.dimension; if (typeof dim === 'string') out.dimension = dim.replace(/^minecraft:/, '')
  const night = bot.time?.isDay === false // raw skyLight ignores time of day: at night the sky contributes ~4 instead of 15
  const light = blk ? Math.max(blk.light ?? 0, Math.max(0, (blk.skyLight ?? 0) - (night ? 11 : 0))) : null; if (Number.isFinite(light) && blk) out.light = light // block light alone read 0 in daylight ('light 0 at 15:21')
  const clock = clockFromTicks(bot.time?.timeOfDay); if (clock) out.clock = clock
  return out
}
const safe = (f, d) => { try { return f() } catch { return d } }

/** Mind 'tick' digest input. */
export function mindTickDigest(bot, { hazards = [], resting = false } = {}) {
  const me = bot.entity?.position
  const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && me)
  const threats = ents.filter((e) => entityKind(e)?.cat === 'hostile' && dist(e.position, me) < 16 && (!MOBS[e.name] || relevantThreat(bot, e))).length
  const humansNearby = ents.filter((e) => e.type === 'player' && dist(e.position, me) < 32).length
  return {
    food: bot.food, hp: bot.health, tps: safe(() => bot.getTps?.(), 20) ?? 20, threats, danger: hazards.some((h) => (h.kind === 'lava' || h.kind === 'fire' || h.kind === 'magma_block') && h.dist <= 2.5),
    humansNearby, sleeping: !!bot.isSleeping, resting, pos: me ? { x: me.x, y: me.y, z: me.z } : undefined,
  }
}

/** Raw digest for mind 'digest' op (self_summary, lessons, episodes come back from memory). */
export function mindRawDigest(bot, { hazards = [], confined = null } = {}) {
  const me = bot.entity?.position
  const tp = timePhase(bot)
  return {
    pos: me ? { x: me.x, y: me.y, z: me.z } : { x: 0, y: 0, z: 0 }, hp: bot.health, food: bot.food, dayTime: tp.ticks,
    inventory: (bot.inventory?.items?.() ?? []).map((i) => ({ name: i.name, count: i.count })), freeSlots: safe(() => bot.inventory.emptySlotCount(), 30),
    entities: Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && me && entityKind(e)).map((e) => ({ type: entityKind(e).name, hostile: entityKind(e).cat === 'hostile', dist: dist(e.position, me) })).sort((a, b) => a.dist - b.dist).slice(0, 6),
    blocks: hazards.slice(0, 3).map((h) => ({ name: h.kind, dist: h.dist })),
    humans: Object.values(bot.players ?? {}).filter((p) => p.username !== bot.username && !isIgnoredPlayer(p.username) && p.entity && me).map((p) => ({ name: p.username, dist: dist(p.entity.position, me) })),
    confined: confined?.text ?? null,
  }
}

/** Notable things in view for the curiosity/discovery system: [{kind:'mob'|'block', name, x,y,z}] (first of each name only). */
const sightingTurn = new WeakMap()
/** L1: one NOTABLE block kind per call (rotating), radius 20. All 22 kinds in one call blocked the event loop for 1.6 s every 8 s (measured live);
 *  mobs are cheap and scanned every call. Call it every ~2 s: the full block cycle takes ~45 s. */
export function scanSightings(bot, { blocksPerCall = 1 } = {}) {
  const me = bot.entity?.position
  if (!me) return []
  const out = []
  const seenMob = new Set()
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !e.position) continue
    const k = entityKind(e); if (!k || seenMob.has(k.name) || dist(e.position, me) > 40) continue
    seenMob.add(k.name); out.push({ kind: 'mob', name: k.name, x: e.position.x, y: e.position.y, z: e.position.z })
  }
  let turn = sightingTurn.get(bot) ?? 0
  for (let k = 0; k < blocksPerCall; k++, turn++) {
    const n = NOTABLE_BLOCKS[turn % NOTABLE_BLOCKS.length]
    const b = bot.registry?.blocksByName[n]; if (!b) continue
    let ps = []; try { ps = bot.findBlocks({ matching: b.id, maxDistance: 20, count: 1 }) } catch { /* ignore */ }
    if (ps[0]) out.push({ kind: 'block', name: n, x: ps[0].x, y: ps[0].y, z: ps[0].z })
  }
  sightingTurn.set(bot, turn)
  return out
}

/** Hazard extent for a death lesson: farthest hazard block of `kind` within r of p. */
export function hazardExtent(bot, p, kind, r = 10) {
  const b = bot.registry?.blocksByName[kind]; if (!b) return 0
  // Q1: mineflayer calls point.floored(): a plain {x,y,z} threw, was swallowed, and EVERY death lesson got extent 0 (live: lava death, extent 0)
  let ps = []; try { ps = bot.findBlocks({ matching: b.id, maxDistance: r, count: 64, point: new Vec3(p.x, p.y, p.z) }) } catch { return 0 }
  return ps.length ? Math.ceil(Math.max(...ps.map((q) => Math.hypot(q.x - p.x, q.z - p.z)))) : 0
}
