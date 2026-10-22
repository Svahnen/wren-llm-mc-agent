// PB1: named predicates for playbook conditions (when / done_if / ok / loop.until). Spec string: "[!]name[:arg[:arg]]"; an arg "$x" is replaced by params.x.
// Pure reads of the bot/world/params; no side effects. ctx = { bot, env, params, state, now }.
import { isIgnoredPlayer } from '../ignore-players.js'
import { inventoryFacts } from '../habits/needs.js'
import { countMatch, items } from '../skills/lib.js'
import { boxedIn } from '../skills/shelter.js'
import { sameRoom } from '../skills/movements-doors.js'
import { rangedThreats, exposedTo, phase } from '../habits/safety.js'
import { MOBS, relevantThreat } from '../reflex/threats.js'
import { RECIPES } from '../skills/craft.js'

const RES_RE = { wood: /_log$/, stone: /^(cobblestone|stone)$/, coal: /^(coal|charcoal)$/, iron: /^(raw_iron|iron_ore|iron_ingot)$/, sand: /^sand$/, dirt: /^dirt$/, plants: /(flower|tulip|dandelion|poppy|orchid|allium|cornflower|daisy|fern|seeds|berries)/ }
export const resourceRe = (r) => RES_RE[r] ?? /^$/
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const FISH = new Set(['cod', 'salmon'])

/** place name or "x,y,z" -> {x,y,z} | null */
export function placePos(ctx, ref) {
  if (!ref) return null
  const c = /^\s*(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)(?:[\s,;]+(-?\d+(?:\.\d+)?))?\s*$/.exec(String(ref))
  if (c) return c[3] === undefined ? { x: +c[1], y: ctx.bot.entity?.position?.y ?? 64, z: +c[2] } : { x: +c[1], y: +c[2], z: +c[3] }
  const lm = ctx.env?.landmarks?.get?.(ref) ?? (ref === 'home' ? ctx.env?.landmarks?.home : null)
  return lm && Number.isFinite(lm.x) ? { x: lm.x, y: lm.y, z: lm.z } : null
}
export function personEntity(bot, name) { return isIgnoredPlayer(name) ? null : (bot.players?.[name]?.entity ?? null) }
const nearEntities = (bot, set, r) => { const me = bot.entity?.position; return me ? Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && set.has(e.name) && d3(e.position, me) <= r) : [] }

export const PRED = {
  food_ge: (c, n) => (c.bot.food ?? 20) >= +n,
  food_gt: (c, n) => (c.bot.food ?? 20) > +n,
  food_lt: (c, n) => (c.bot.food ?? 20) < +n,
  food_le: (c, n) => (c.bot.food ?? 20) <= +n,
  hp_lt: (c, n) => (c.bot.health ?? 20) < +n,
  hp_ge: (c, n) => (c.bot.health ?? 20) >= +n,
  has_food: (c) => inventoryFacts(c.bot).food > 0,
  has_cooked: (c) => { const i = inventoryFacts(c.bot); const raw = countMatch(c.bot, /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/); return i.food - raw > 0 },
  has_bad_food: (c) => inventoryFacts(c.bot).badFood > 0,
  has_raw: (c) => inventoryFacts(c.bot).raw > 0,
  has_fuel: (c) => { const i = inventoryFacts(c.bot); return i.fuel >= Math.min(i.raw, 2) && i.fuel > 0 },
  has_rod: (c) => inventoryFacts(c.bot).rod > 0,
  furnace_near: (c) => { try { const id = c.bot.registry.blocksByName.furnace?.id; return id !== undefined && !!c.bot.findBlock({ matching: id, maxDistance: 24 }) } catch { return false } },
  table_near: (c) => { try { const id = c.bot.registry.blocksByName.crafting_table?.id; return id !== undefined && !!c.bot.findBlock({ matching: id, maxDistance: 16 }) } catch { return false } },
  can_make_furnace: (c) => { const i = inventoryFacts(c.bot); return i.furnace > 0 || PRED.furnace_near(c) || (i.cobble >= 8 && (PRED.table_near(c) || i.table > 0 || i.planks >= 4 || i.logs >= 1)) },   // a furnace is a 3x3 recipe: it needs a crafting table
  needs_table_for_furnace: (c) => { const i = inventoryFacts(c.bot); return i.furnace === 0 && i.cobble >= 8 && !PRED.furnace_near(c) && !PRED.table_near(c) && i.table === 0 && i.planks < 4 && i.logs < 1 },
  animals_near: (c) => nearEntities(c.bot, ANIMALS, 28).length > 0,
  fish_near: (c) => nearEntities(c.bot, FISH, 20).length > 0,
  food_source_known: (c) => { const t = c.now(); for (const f of c.env?.foodSeen?.values?.() ?? []) if (t - f.t < 360000 && dxz(f, c.bot.entity.position) > 6) return true; return false },
  water_near: (c) => { try { const id = c.bot.registry.blocksByName.water?.id; return !!c.bot.findBlock({ matching: id, maxDistance: 12 }) } catch { return false } },
  day: (c) => phase(c.bot) === 'day',
  night: (c) => phase(c.bot) === 'night',
  thunder: (c) => (c.bot.thunderState ?? 0) > 0.5,
  bed_known: (c) => !!c.env?.landmarks?.get?.('bed'),
  home_known: (c) => !!c.env?.landmarks?.home || !!c.env?.landmarks?.get?.('home'),
  place_known: (c, p) => !!placePos(c, p),
  at_place: (c, p, r = 6) => { const q = placePos(c, p); return !!q && dxz(q, c.bot.entity.position) <= +r && Math.abs(q.y - c.bot.entity.position.y) <= 12 },
  // DOOR2: arrived INSIDE: when the place sits in a walled room (doors count as walls) she must be in that room; open ground falls back to the distance
  inside_place: (c, p, r = 8) => {
    const q = placePos(c, p); if (!q) return false
    if (dxz(q, c.bot.entity.position) > +r || Math.abs(q.y - c.bot.entity.position.y) > 12) return false
    let room = null
    try { room = sameRoom(c.bot, q) } catch { room = null }
    return room?.bounded ? room.inside : true
  },
  has_item: (c, name, n = 1) => items(c.bot).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0) >= +n,
  has_match: (c, re, n = 1) => countMatch(c.bot, new RegExp(re)) >= +n,
  free_slots_ge: (c, n) => (inventoryFacts(c.bot).free) >= +n,
  blocks_ge: (c, n) => inventoryFacts(c.bot).blocks >= +n,
  gained: (c, res, n) => countMatch(c.bot, resourceRe(res)) - (c.state?.base?.[res] ?? 0) >= +n,
  param_is: (c, k, v) => String(c.params?.[k]) === v,
  craft_needs: (c, item, what) => {
    const sp = RECIPES[item]; if (!sp) return false
    const wood = countMatch(c.bot, /_log$/) * 4 + countMatch(c.bot, /_planks$/), cobble = countMatch(c.bot, /^(cobblestone|cobbled_deepslate|blackstone)$/)
    if (what === 'stone') return !!sp.cobble && cobble < sp.cobble
    if (what === 'wood') { const need = (sp.planks ?? 0) + (sp.stick ? sp.stick / 2 : 0) + (sp.table && !PRED.table_near(c) && !items(c.bot).some((i) => i.name === 'crafting_table') ? 4 : 0) + (sp.out && sp.from === 'log' ? 0 : 0); return (sp.from === 'log' ? countMatch(c.bot, /_log$/) < 1 : wood < need) }
    return false
  },
  sealed: (c) => { try { return boxedIn(c.bot) } catch { return false } },
  hostile_near: (c) => { const me = c.bot.entity?.position; return !!me && Object.values(c.bot.entities ?? {}).some((e) => e && e !== c.bot.entity && e.position && MOBS[e.name] && !MOBS[e.name].neutral && d3(e.position, me) <= 16 && relevantThreat(c.bot, e)) },
  exposed_to_shooter: (c) => { try { const t = rangedThreats(c.bot, 32); return t.length > 0 && exposedTo(c.bot, t).length > 0 } catch { return false } },
  person_online: (c, p) => !isIgnoredPlayer(p) && !!c.bot.players?.[p],
  person_visible: (c, p) => !!personEntity(c.bot, p),
  person_within: (c, p, r) => { const e = personEntity(c.bot, p); return !!e && d3(e.position, c.bot.entity.position) <= +r },
  far_from_origin: (c, r) => !!c.state?.origin && dxz(c.state.origin, c.bot.entity.position) >= +r,
  at_origin: (c, r = 6) => !!c.state?.origin && dxz(c.state.origin, c.bot.entity.position) <= +r,
}

const sub = (a, params) => (typeof a === 'string' && a.startsWith('$') ? String(params?.[a.slice(1)] ?? '') : a)
export function evalPred(spec, ctx) {
  let neg = false, s = String(spec)
  if (s.startsWith('!')) { neg = true; s = s.slice(1) }
  const [name, ...args] = s.split(':')
  const f = PRED[name]
  if (!f) throw new Error(`unknown predicate "${name}"`)
  let v = false
  try { v = !!f(ctx, ...args.map((a) => sub(a, ctx.params))) } catch { v = false }
  return neg ? !v : v
}
export const allTrue = (list, ctx) => (list ?? []).every((p) => evalPred(p, ctx))
/** check every predicate name in a definition exists (library validation in tests) */
export function predNames(spec) { return String(spec).replace(/^!/, '').split(':')[0] }
