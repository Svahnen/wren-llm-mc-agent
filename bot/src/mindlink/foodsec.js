// FARM1: world facts for the digest's food-security block: the farm plot (growth stage), the animal pen (animals inside), the fishing rod (durability),
// remembered berry bushes. Perception only (no advice): brain/menu-farm1.js turns it into a status line and options. Cached, never throws.
import { Vec3 } from 'vec3'
import { penAnimals, isBaby } from '../skills/farm1.js'

const CROPS = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }
const ageOf = (b) => { try { const p = b.getProperties?.(); if (p && p.age !== undefined) return Number(p.age) } catch { /* ignore */ } return Number(b.metadata ?? 0) }
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/** crop stage at the farm: { crops, ripe, avg_age, stage: 'empty'|'growing'|'ripe', kind } or null when the chunk is not loaded */
export function farmStatus(bot, lm) {
  if (!lm) return null
  const ids = Object.keys(CROPS).map((n) => bot.registry?.blocksByName?.[n]?.id).filter((x) => x !== undefined)
  let ps = []
  try { ps = bot.findBlocks({ matching: ids, point: new Vec3(Math.round(lm.x), Math.round(lm.y), Math.round(lm.z)), maxDistance: 5, count: 30 }) ?? [] } catch { return null }
  const probe = bot.blockAt(new Vec3(Math.round(lm.x), Math.round(lm.y) - 1, Math.round(lm.z)))
  if (!probe) return null   // unloaded
  const crops = ps.map((p) => bot.blockAt(p)).filter((b) => b && b.name in CROPS && Math.hypot(b.position.x - lm.x, b.position.z - lm.z) <= 3)
  if (!crops.length) return { crops: 0, ripe: 0, avg_age: 0, stage: 'empty' }
  const ripe = crops.filter((b) => ageOf(b) >= CROPS[b.name]).length
  const avg = crops.reduce((s, b) => s + ageOf(b) / CROPS[b.name], 0) / crops.length
  return { crops: crops.length, ripe, avg_age: Math.round(avg * 100) / 100, stage: ripe > 0 ? 'ripe' : 'growing', kind: crops[0].name }
}

const lastPen = new WeakMap()
export function penStatus(bot, lm) {
  if (!lm) return null
  const C = { x: Math.floor(lm.x), y: Math.floor(lm.y), z: Math.floor(lm.z) }
  const me = bot.entity?.position
  if (!me || d2(me, C) > 60) return lastPen.get(bot) ? { ...lastPen.get(bot), stale: true } : { total: null, babies: 0, kinds: {}, stale: true }
  const an = penAnimals(bot, C), kinds = {}
  for (const a of an) kinds[a.name] = (kinds[a.name] ?? 0) + 1
  const out = { total: an.length, babies: an.filter((a) => a.baby).length, kinds }
  lastPen.set(bot, out)
  return out
}

export function rodStatus(bot) {
  const it = (bot.inventory?.items?.() ?? []).find((i) => i.name === 'fishing_rod')
  if (!it) return null
  const max = bot.registry?.itemsByName?.fishing_rod?.maxDurability ?? 384
  const used = Number(it.durabilityUsed ?? 0)
  return { durability_left: Math.max(0, max - used), durability_max: max }
}

let cache = { t: 0, v: null }
/** -> { farm, pen, rod, berries } (any may be null). `landmarks` is the Landmarks store. 15 s cache. */
export function foodSecurityFacts(bot, landmarks, now = Date.now()) {
  if (cache.v && now - cache.t < 15000) return cache.v
  const out = { farm: null, pen: null, rod: null, berries: null }
  try {
    const me = bot.entity?.position
    const farm = landmarks?.get?.('farm'), pen = landmarks?.get?.('pen')
    if (farm && me) { const st = d2(me, farm) <= 90 ? farmStatus(bot, farm) : null; out.farm = { pos: [Math.round(farm.x), Math.round(farm.y), Math.round(farm.z)], dist: Math.round(d2(me, farm)), ...(st ?? { stage: 'unknown' }) } }
    if (pen && me) out.pen = { pos: [Math.round(pen.x), Math.round(pen.y), Math.round(pen.z)], dist: Math.round(d2(me, pen)), ...penStatus(bot, pen) }
    out.rod = rodStatus(bot)
    // remembered berry bushes: a place she can come back to
    const id = bot.registry?.blocksByName?.sweet_berry_bush?.id
    if (me && id !== undefined) {
      const p = (bot.findBlocks({ matching: id, maxDistance: 32, count: 1 }) ?? [])[0]
      if (p && !landmarks?.get?.('berries')) landmarks?.set?.('berries', p, 'food_area')
    }
    const bl = landmarks?.get?.('berries')
    if (bl && me) out.berries = { pos: [Math.round(bl.x), Math.round(bl.y), Math.round(bl.z)], dist: Math.round(d2(me, bl)) }
  } catch { /* perception must never throw */ }
  cache = { t: now, v: out }
  return out
}
export const _resetFoodSecCache = () => { cache = { t: 0, v: null } }
export { isBaby }

// HOME2: distance (m) to the nearest water within 24 m, null when there is none. The fish skill needs a bank within 16 m, so the menu offers fishing only then. Cached 10 s.
const waterCache = new WeakMap()
export function nearestWaterM(bot, now = Date.now()) {
  const c = waterCache.get(bot); if (c && now - c.t < 10000) return c.v
  let v = null
  try {
    const me = bot.entity?.position, id = bot.registry?.blocksByName?.water?.id
    if (me && id !== undefined) {
      const ps = bot.findBlocks({ matching: id, maxDistance: 24, count: 1 }) ?? []
      if (ps.length) v = Math.round(Math.hypot(ps[0].x + 0.5 - me.x, ps[0].y - me.y, ps[0].z + 0.5 - me.z))
    }
  } catch { v = undefined }
  waterCache.set(bot, { t: now, v })
  return v
}
