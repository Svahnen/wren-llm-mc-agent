// S2 <-> S1 contract. Pure functions, no I/O.
//
// S2 output format (delimiter format, NOT one JSON object):
//   line 1: {act:<skill>,args:{key:value,...}}    keys bare or quoted, string values bare or quoted
//   line 2: ---
//   line 3+: 1-3 sentences of speech (ONE sentence when act != none)
//
// Everything here is deterministic; the engine (S1) trusts nothing the model says beyond what validate() accepts.

export const CONTRACT_VERSION = 1
import { getPlaybook, parsePlaybookTarget, playbookNames } from '../bot/src/playbooks/catalog.js'
import { activityMenu } from './menu.js'
import { daylightInfo } from './daylight.js'
import { GOAL_TYPES, normType, checkGoal, parsePlaceOps, textHash, compass8, cleanSpeech } from './goaltypes.js'

// ---------------------------------------------------------------- vocabulary
// Arg types: {t:'enum', values}, {t:'int', min, max}, {t:'ref', kinds:[...]} (id must exist in the digest),
// {t:'item'} (inventory key). `optional: true` allowed. The skill table is the ONE place that defines the closed vocabulary;
// bot/ (T1/T4) must register a skill for each name it wants S2 to be able to pick (see README, "aligning with the body").
const E = (...values) => ({ t: 'enum', values })
export const SKILLS = {
  none: { desc: 'keep doing whatever you are doing (or nothing); just say something', args: {}, ttl_s: 20, max_s: 20, interruptible: true },
  idle_activity: { desc: 'spend a moment passively', args: { kind: E('look_around', 'sit', 'watch_sky', 'rest'), seconds: { t: 'int', min: 5, max: 60, optional: true } }, ttl_s: 30, max_s: 60, interruptible: true },
  gesture: { desc: 'make a gesture with your body', args: { kind: E('wave', 'nod', 'shake_head', 'jump', 'crouch') }, ttl_s: 10, max_s: 10, interruptible: true },
  explore: { desc: 'walk toward somewhere you have not been', args: { direction: { ...E('north', 'south', 'east', 'west', 'any'), optional: true } }, ttl_s: 180, max_s: 180, interruptible: true },
  move_to: { desc: 'walk to coordinates', args: { x: { t: 'int', min: -30000000, max: 30000000 }, y: { t: 'int', min: -64, max: 320 }, z: { t: 'int', min: -30000000, max: 30000000 } }, ttl_s: 120, max_s: 120, interruptible: true },
  go_to: { desc: 'walk to a known place', args: { place: { t: 'ref', kinds: ['place'] } }, ttl_s: 120, max_s: 120, interruptible: true },
  follow: { desc: 'follow a player', args: { target: { t: 'ref', kinds: ['player'] } }, ttl_s: 120, max_s: 120, interruptible: true },
  approach: { desc: 'walk up to something or someone', args: { target: { t: 'ref', kinds: ['player', 'entity', 'block', 'place'] } }, ttl_s: 60, max_s: 60, interruptible: true },
  flee: { desc: 'run away from a hostile creature, a hazard, or a player who is hurting you (not from animals or fish)', args: { from: { t: 'ref', kinds: ['entity', 'hazard', 'player'] } }, ttl_s: 30, max_s: 30, interruptible: false },
  eat: { desc: 'eat a food item from your inventory', args: { item: { t: 'item', edible: true } }, ttl_s: 20, max_s: 20, interruptible: false },
  hunt: { desc: 'kill and collect food from an animal', args: { target: { t: 'ref', kinds: ['entity'], tag: 'animal' } }, ttl_s: 90, max_s: 90, interruptible: true },
  cook: { desc: 'cook raw meat from your inventory in a furnace (builds one from 8 cobblestone; needs fuel: coal, planks or logs)', args: {}, ttl_s: 150, max_s: 150, interruptible: true },
  fight: { desc: 'fight a hostile creature with the best weapon you hold', args: { target: { t: 'ref', kinds: ['entity'], optional: true } }, ttl_s: 40, max_s: 40, interruptible: true },
  defend: { desc: 'hit back at a player who is hurting you right now, with the best weapon you hold; it stops by itself when they stop hitting you (or after 20 s), never chases, only for someone who hurt you in the last 10 s', args: { target: { t: 'ref', kinds: ['player'] } }, ttl_s: 20, max_s: 20, interruptible: true },
  sleep: { desc: 'sleep in a bed (night or thunder only)', args: {}, ttl_s: 120, max_s: 120, interruptible: true },
  collect: { desc: 'gather a resource nearby', args: { resource: E('wood', 'stone', 'coal', 'iron', 'sand', 'dirt', 'plants') }, ttl_s: 150, max_s: 150, interruptible: true },
  pursue: { desc: 'internal: S2 stated a goal (type/target/intent); S1 chooses the skills', internal: true, args: {}, ttl_s: 600, max_s: 600, interruptible: true },
  interact: { desc: 'turn to face a person or creature and give it your attention (you cannot open, trade or use things)', args: { target: { t: 'ref', kinds: ['player', 'entity'] }, verb: E('look', 'talk') }, ttl_s: 40, max_s: 40, interruptible: true },
}
export const SKILL_NAMES = Object.keys(SKILLS)
export const PUBLIC_SKILL_NAMES = SKILL_NAMES.filter((n) => !SKILLS[n].internal)

export const EDIBLE = new Set(['bread', 'apple', 'golden_apple', 'carrot', 'potato', 'baked_potato', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries',
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'beef', 'porkchop', 'mutton', 'chicken',
  'rabbit', 'cod', 'salmon', 'cookie', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'dried_kelp', 'tropical_fish', 'golden_carrot', 'enchanted_golden_apple', 'honey_bottle'])
/** FOOD1: food points one item restores (vanilla values, for the Edible line) */
export const FOOD_PTS = { cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_salmon: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5, bread: 5, baked_potato: 5, beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, apple: 4, carrot: 3, potato: 1, beetroot: 1, melon_slice: 2, sweet_berries: 2, glow_berries: 2, cookie: 2, dried_kelp: 1, pumpkin_pie: 8, mushroom_stew: 6, rabbit_stew: 10, beetroot_soup: 6, golden_carrot: 6, golden_apple: 4, tropical_fish: 1, rotten_flesh: 4, spider_eye: 2, poisonous_potato: 2, pufferfish: 1 }
/** FOOD1: raw items the cook skill turns into food (furnace). Kelp is NOT edible raw; dried_kelp is. */
export const COOKABLE = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp' }
/** FOOD1: what she can eat right now and what she could cook. edible: [{k,n,pts,risky}] best first; cookable: [{k,n,to,pts}]. Risky food (rotten flesh) counts only when the body needs it. */
export function foodFacts(dg) {
  const riskyOk = dg.food <= 6 || (dg.health <= 6 && dg.food < 18)
  const inv = Object.entries(dg.inventory ?? {}).filter(([, n]) => n > 0)
  const edible = inv.filter(([k]) => EDIBLE.has(k) || (riskyOk && RISKY_FOOD.has(k))).map(([k, n]) => ({ k, n, pts: FOOD_PTS[k] ?? 2, risky: RISKY_FOOD.has(k) })).sort((a, b) => Number(a.risky) - Number(b.risky) || b.pts - a.pts)
  const cookable = inv.filter(([k]) => COOKABLE[k]).map(([k, n]) => ({ k, n, to: COOKABLE[k], pts: FOOD_PTS[COOKABLE[k]] ?? 2 }))
  return { edible, cookable }
}
export function edibleLine(dg) {
  const { edible } = foodFacts(dg)
  return edible.length ? `Edible: ${edible.map((f) => `${f.k} x${f.n} (+${f.pts}${f.n > 1 ? ' each' : ''}${f.risky ? ', can make you sick' : ''})`).join(', ')}` : 'Edible: nothing you hold'
}
export function cookableLine(dg) {
  const { cookable } = foodFacts(dg)
  return cookable.length ? `Cookable (needs a furnace and fuel): ${cookable.map((f) => `${f.k} x${f.n} -> ${f.to}`).join(', ')}` : ''
}
export const isFood = (k) => EDIBLE.has(k) || RISKY_FOOD.has(k)
/** food that can hurt (hunger effect, poison) but still fills the stomach: she may eat it when it is all she has (S1 does when food <= 6 or hp is low and regen is blocked). */
/** DUSK1: never offered as food: pufferfish (Poison II + Hunger III for 1 food point took her from hp 12 to 0.5 in 8 s, twice in one night). The body refuses it too. */
export const POISON_ITEMS = new Set(['pufferfish'])
export const RISKY_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'chorus_fruit', 'suspicious_stew'])
/** RS3 eat_emergency: of the risky foods only rotten flesh is ever offered or eaten out of hunger (on Easy starving stops at 5 hearts and cannot kill; poison is worse than hunger). Mirrors bot/src/foodguard.js EMERGENCY_OK. */
export const EMERGENCY_FOOD = new Set(['rotten_flesh'])
export const HAZARD_KINDS = new Set(['lava', 'fire', 'magma_block', 'cactus', 'cliff', 'deep_water', 'void', 'powder_snow', 'sweet_berry_bush', 'cobweb'])
export const CATEGORIES = ['player', 'animal', 'hostile', 'neutral', 'block', 'item', 'structure']
export const REASON_CODES = ['ok', 'stuck', 'no_progress', 'path_failed', 'target_gone', 'precondition_failed', 'unreachable', 'timeout', 'hazard', 'hostile',
  'low_health', 'inventory_full', 'no_tool', 'unknown_skill', 'invalid_args', 'reflex', 'human_override', 'aborted', 'died', 'disconnected', 'lag', 'expired', 'superseded', 'options_exhausted', 'goal_achieved']
export const STATUSES = ['started', 'progress', 'done', 'failed', 'preempted', 'blocked']
export const EVENT_TYPES = ['human_speech', 'report', 'drive_wake', 'heartbeat', 'reflection_due', 'sleep_pass_due', 'body_state']
export const PHASES = ['dawn', 'day', 'dusk', 'night']

// ---------------------------------------------------------------- digest
// Digest (S1 -> S2), the ONLY source of truth S2 sees. Ids are opaque strings chosen by S1 (e.g. "cow_1", "zombie_2", "diamond_ore_1",
// player names, "home"); S2 must copy them exactly. Every field is optional; normalizeDigest fills defaults.
//  { time:{day,phase}, thunder?, pos:[x,y,z], health, food, energy (0..20), needs:{hunger,energy,safety,curiosity,social} (0 fine .. 1 urgent),
//    inventory:{item:n}, free_slots, nearby:[{id,kind,cat,dist,pos?,tags?}], hazards:[{id,kind,dist,pos?}], players:[{name,dist?}],
//    places:[{id,kind,pos,dist?}], events:[str], chat:[{from,text}], recent_intents:[{goal,args,status}], activity:{intent_id,goal,status} }
function withDir(p, pos) {
  if (p.dir || !Array.isArray(p.pos) || !Array.isArray(pos) || pos.length !== 3) return p
  const dx = p.pos[0] - pos[0], dz = p.pos[2] - pos[2]
  return { ...p, dir: compass8(dx, dz) ?? 'here', dist: Number.isFinite(p.dist) ? p.dist : Math.round(Math.hypot(dx, dz)) }
}
export function normalizeDigest(d = {}) {
  const arr = (x) => (Array.isArray(x) ? x : [])
  const num = (x, def) => (Number.isFinite(x) ? x : def)
  const nearby = arr(d.nearby).filter((n) => n && typeof n.id === 'string').map((n) => ({ ...n, cat: n.cat ?? 'neutral', tags: arr(n.tags) }))
  return {
    time: { day: num(d.time?.day, 1), phase: PHASES.includes(d.time?.phase) ? d.time.phase : 'day', ...(Number.isFinite(d.time?.ticks) ? { ticks: d.time.ticks } : {}) },
    thunder: !!d.thunder,
    at: Number.isFinite(d.at) ? d.at : null,   // GATH1: when the body built this digest (ms epoch): the prompt says how old the position is
    sheltered: !!d.sheltered,   // GATH1: sealed in her own shelter (resting, not trapped)
    pos: Array.isArray(d.pos) && d.pos.length === 3 && d.pos.every(Number.isFinite) ? d.pos : [0, 64, 0],
    health: num(d.health, 20), food: num(d.food, 20), energy: num(d.energy, 20),
    needs: { hunger: 0, energy: 0, safety: 0, curiosity: 0, social: 0, ...(d.needs ?? {}) },
    inventory: d.inventory && typeof d.inventory === 'object' ? d.inventory : {},
    free_slots: num(d.free_slots, 30),
    nearby,
    hazards: arr(d.hazards).filter((h) => h && typeof h.id === 'string'),
    players: arr(d.players).filter((p) => p && typeof p.name === 'string'),
    places: arr(d.places).filter((p) => p && typeof p.id === 'string').map((p) => withDir(p, d.pos)),
    facing: d.facing && typeof d.facing === 'object' && typeof d.facing.compass === 'string' ? { yaw: num(d.facing.yaw, 0), compass: d.facing.compass } : null,
    biome: typeof d.biome === 'string' ? d.biome : null, dimension: typeof d.dimension === 'string' ? d.dimension : null,
    light: Number.isFinite(d.light) ? d.light : null, clock: typeof d.clock === 'string' ? d.clock : null,
    low_hp_s: Number.isFinite(d.low_hp_s) ? d.low_hp_s : 0,   // FOOD1: seconds hp has been <= 6
    explored: d.explored && typeof d.explored === 'object' ? d.explored : null,
    water_near_m: Number.isFinite(d.water_near_m) ? d.water_near_m : (d.water_near_m === null ? null : undefined),   // HOME2: nearest water within 24 m (null = none); undefined = body does not report
    food_episodes: d.food_episodes && typeof d.food_episodes === 'object' ? { day: +d.food_episodes.day || 0, today: +d.food_episodes.today || 0, yesterday: +d.food_episodes.yesterday || 0, in_episode: !!d.food_episodes.in_episode } : null,   // FOOD4
    food_security: d.food_security && typeof d.food_security === 'object' ? d.food_security : null,   // FARM1: farm/pen/rod/berries facts from the body
    gear: arr(d.gear).map(String).slice(0, 14), food_sources: arr(d.food_sources).filter((f) => f && typeof f.name === 'string').slice(0, 6), failures: arr(d.failures).filter((f) => f && typeof f.what === 'string').slice(0, 5),
    screen: arr(d.screen).filter((x) => x && typeof x.text === 'string').slice(0, 3),
    events: arr(d.events).map(String),
    chat: arr(d.chat).filter((c) => c && typeof c.text === 'string'),
    recent_intents: arr(d.recent_intents),
    activity: d.activity ?? null,
    objective: d.objective && typeof d.objective === 'object' && typeof d.objective.text === 'string' ? d.objective : null,   // G2: the body's view of her current objective + interruption state
    holding: typeof d.holding === 'string' ? d.holding : null,
    difficulty: typeof d.difficulty === 'string' ? d.difficulty : null,   // PB1: real server difficulty (bot.game.difficulty)
    playbook_cooldowns: arr(d.playbook_cooldowns).filter((c) => c && typeof c.name === 'string' && typeof c.text === 'string'),   // PB3: playbooks just tried here without result
    playbook: d.playbook && typeof d.playbook === 'object' && typeof d.playbook.name === 'string' ? d.playbook : null,   // PB1: active playbook + step k/n
    hurt_by: arr(d.hurt_by).filter((h) => h && typeof h.who === 'string').slice(0, 5),   // PVP1: who hurt her recently [{who, kind, hits, hp, ago_s, today?, total?, attacking_now?}]
  }
}

export function distance(a, b) { return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity }

/** id lookup: id -> {kind:'player'|'entity'|'block'|'place'|'hazard', cat, pos, dist, tags, rec} */
export function indexDigest(dg) {
  const m = new Map()
  for (const p of dg.players) m.set(p.name, { kind: 'player', cat: 'player', pos: p.pos, dist: p.dist, tags: [], rec: p })
  for (const n of dg.nearby) {
    const kind = n.cat === 'player' ? 'player' : n.cat === 'block' ? 'block' : 'entity'
    m.set(n.id, { kind, cat: n.cat, pos: n.pos, dist: n.dist, tags: n.tags, rec: n })
  }
  for (const pl of dg.places) m.set(pl.id, { kind: 'place', cat: 'place', pos: pl.pos, dist: pl.dist, tags: [], rec: pl })
  for (const h of dg.hazards) m.set(h.id, { kind: 'hazard', cat: 'hazard', pos: h.pos, dist: h.dist, tags: [], rec: h })
  return m
}

export function foodKnown(dg) {
  const risky = dg.food <= 6 || (dg.health <= 6 && dg.food < 18)   // when the body needs it, risky food counts as food
  const inv = Object.entries(dg.inventory).filter(([k, n]) => (EDIBLE.has(k) || (risky && EMERGENCY_FOOD.has(k))) && n > 0).map(([k]) => k)
  const animals = dg.nearby.filter((n) => n.cat === 'animal' && (n.tags.includes('animal') || n.tags.includes('edible') || true) && (n.dist ?? 0) <= 40)
  return { inventory: inv, animals }
}

// ---------------------------------------------------------------- relaxed header parser
// Accepts {act:name,args:{k:v}} with bare or quoted keys and values. Not JSON.Parse because the model emits bare words.
class HeaderError extends Error {}
function parseRelaxed(src) {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++ }
  const bare = (key = false) => { const s = i; const re = key ? /[A-Za-z0-9_.\-]/ : /[A-Za-z0-9_.:@+\-]/; while (i < src.length && re.test(src[i])) i++; return src.slice(s, i) }
  function str(q) {
    i++; let out = ''
    while (i < src.length && src[i] !== q) { if (src[i] === '\\' && i + 1 < src.length) { i++; out += src[i++] } else out += src[i++] }
    if (src[i] !== q) throw new HeaderError('unterminated string')
    i++; return out
  }
  function value() {
    ws()
    const c = src[i]
    if (c === '{') return object()
    if (c === '[') {
      i++; const a = []; ws()
      if (src[i] === ']') { i++; return a }
      for (;;) { a.push(value()); ws(); if (src[i] === ',') { i++; continue } if (src[i] === ']') { i++; return a } throw new HeaderError('bad array') }
    }
    if (c === '"' || c === "'") return str(c)
    const b = bare()
    if (!b) throw new HeaderError(`unexpected character "${c ?? 'end'}" at ${i}`)
    if (/^-?\d+(\.\d+)?$/.test(b)) return Number(b)
    if (b === 'true') return true
    if (b === 'false') return false
    if (b === 'null') return null
    return b
  }
  function object() {
    i++; const o = {}; ws()
    if (src[i] === '}') { i++; return o }
    for (;;) {
      ws()
      const k = src[i] === '"' || src[i] === "'" ? str(src[i]) : bare(true)
      if (!k) throw new HeaderError(`missing key at ${i}`)
      ws(); if (src[i] !== ':') throw new HeaderError(`expected ":" after key ${k}`)
      i++
      if (Object.hasOwn(o, k)) throw new HeaderError(`duplicate key ${k}`)
      o[k] = value(); ws()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return o }
      throw new HeaderError(`expected "," or "}" at ${i}`)
    }
  }
  ws()
  if (src[i] !== '{') throw new HeaderError('header must start with "{"')
  const v = object(); ws()
  if (i < src.length) throw new HeaderError('trailing text after header')
  return v
}


// ---------------------------------------------------------------- PB2: forgiving header for playbook answers
// observed: `{type:playbook,target:explore_and_return radius=40 direction=west}` was rejected header_syntax (bare value with spaces / '=').
// A header that clearly names a known playbook is never rejected; the playbook still goes through checkGoal (params validated there).
const PAIR_RE = /^\s*["']?([A-Za-z_][\w-]*)["']?\s*:\s*(.*)$/s
function splitPairs(s) {
  const parts = []; let depth = 0, q = null, start = 0, prev = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if ((c === '"' || c === "'") && (prev === '' || /[:,{\[]/.test(prev))) { q = c; prev = c; continue }
    if (!/\s/.test(c)) prev = c
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth <= 0 && /^\s*["']?[A-Za-z_][\w-]*["']?\s*:/.test(s.slice(i + 1))) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts
}
function cleanVal(v) {
  let t = String(v).trim()
  const cnt = (ch) => (t.match(new RegExp('\\' + ch, 'g')) ?? []).length
  while (t.endsWith('}') && cnt('}') > cnt('{')) t = t.slice(0, -1).trimEnd()
  if (/^(["']).*\1$/s.test(t) && t.length >= 2) t = t.slice(1, -1)
  else if (/^["']/.test(t)) t = t.slice(1).replace(/["']\s*$/, '')
  else t = t.replace(/["']\s*$/, (m) => (/["']/.test(t.slice(0, -1)) ? m : ''))
  return t.trim()
}
function looseObject(body) {
  const o = {}
  for (const part of splitPairs(body)) {
    const m = PAIR_RE.exec(part); if (!m) continue
    const k = m[1], raw = m[2].trim()
    if (Object.hasOwn(o, k)) continue
    if (raw.startsWith('{')) { let inner = raw.slice(1); while (inner.trimEnd().endsWith('}') && (inner.match(/}/g) ?? []).length > (inner.match(/{/g) ?? []).length) inner = inner.trimEnd().slice(0, -1); o[k] = looseObject(inner) }
    else { const v = cleanVal(raw); o[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v }
  }
  return o
}
/** Never throws. -> object or null. Accepts missing braces/quotes, bare values with spaces, 'name k=v' targets. */
export function looseHeader(line) {
  let h = String(line ?? '').trim()
  if (!h) return null
  h = h.replace(/^\{+\s*/, '')
  const o = looseObject(h)
  if (Object.keys(o).length) return o
  return null
}
const pbArgStr = (a) => Object.entries(a ?? {}).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object').map(([k, v]) => `${k}=${/[\s,"']/.test(String(v)) ? '"' + String(v).replace(/"/g, '') + '"' : v}`).join(' ')
const isPlaybookName = (s) => { if (typeof s !== 'string') return null; const p = parsePlaybookTarget(s); return p && getPlaybook(p.name) ? p : null }
/** {playbook:name,args:{..}} | {act:name} | {type:playbook,target:..,args:{..}} -> {type:'playbook',target:'name k=v'}; returns true when it changed h */
export function normalizePlaybookHeader(h) {
  if (!h || typeof h !== 'object') return false
  let name = null
  const argObj = h.args && typeof h.args === 'object' && !Array.isArray(h.args) ? h.args : {}
  if (typeof h.playbook === 'string' && isPlaybookName(h.playbook)) name = h.playbook
  else if (typeof h.act === 'string' && !SKILLS[h.act] && getPlaybook(h.act)) name = h.act
  else if (typeof h.act === 'string' && /^playbook$/i.test(h.act) && typeof h.target === 'string' && isPlaybookName(h.target)) name = h.target
  else if (typeof h.act === 'string' && /^playbook$/i.test(h.act) && typeof argObj.name === 'string' && isPlaybookName(argObj.name)) { name = argObj.name; delete argObj.name }   // PB3: {act:playbook,args:{name:..,k:v}}
  else if (typeof h.act === 'string' && /^playbook$/i.test(h.act) && typeof argObj.playbook === 'string' && isPlaybookName(argObj.playbook)) { name = argObj.playbook; delete argObj.playbook }
  else if (typeof h.act === 'string' && /^playbook$/i.test(h.act) && typeof h.name === 'string' && isPlaybookName(h.name)) { name = h.name }
  else if (String(h.type ?? '').toLowerCase() === 'playbook' && typeof h.target === 'string' && isPlaybookName(h.target)) name = h.target
  else if (String(h.type ?? '').toLowerCase() === 'playbook' && typeof h.target === 'string' && h.args !== undefined) return false
  else return false
  const extra = Object.fromEntries(Object.entries(h).filter(([k]) => !HEADER_KEYS.has(k) && k !== 'playbook' && typeof h[k] !== 'object'))
  const tgt = [String(name).trim(), pbArgStr({ ...extra, ...argObj })].filter(Boolean).join(' ')
  for (const k of Object.keys(extra)) delete h[k]
  delete h.playbook; delete h.act; delete h.args
  h.type = 'playbook'; h.target = tgt
  return true
}
/** last resort: a header line that contains a known playbook name anywhere */
function playbookFromText(line) {
  const t = String(line)
  for (const n of playbookNames()) {
    const m = new RegExp(`(?<![A-Za-z_])${n}(?![A-Za-z_])`, 'i').exec(t)
    if (!m) continue
    const rest = t.slice(m.index + n.length).replace(/[{}"']/g, ' ')
    const args = {}; let x; const re = /([A-Za-z_]\w*)\s*[=:]\s*([^\s,;]+)/g
    while ((x = re.exec(rest))) args[x[1].toLowerCase()] = x[2]
    return { type: 'playbook', target: [n, pbArgStr(args)].filter(Boolean).join(' ') }
  }
  return null
}

export function splitSentences(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=[A-Z"'“(\d]|$)/).map((s) => s.trim()).filter(Boolean)
}

const HEADER_KEYS = new Set(['act', 'args', 'type', 'target', 'intent', 'urgency', 'caution', 'sociability'])
const HEADERLESS_RE = /^\s*(?:\*\*)?(?:intent|type|target|remember|forget|rename|playbook|now)(?:\*\*)?\s*:/i
const DELIM_RE = /^\s*(?:-{2,}|—+|–+|\*{3,}|_{3,}|(?:-\s){2,}-)\s*$/

/** Add the closing braces a truncated header lacks, or the outer braces of "act:x,args:{...}". Only for a one-line header; the
 *  result still goes through the strict parser and the validator, so skills/args/targets stay strict. */
function repairHeader(line) {
  let h = line.trim()
  if (/^act\s*:/.test(h)) h = '{' + h + '}'
  let depth = 0, q = null
  for (let i = 0; i < h.length; i++) {
    const c = h[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '{') depth++
    else if (c === '}') depth--
  }
  if (!q && depth > 0 && depth <= 2 && h.startsWith('{')) h += '}'.repeat(depth)
  return h
}


// ---------------------------------------------------------------- AI1: labelled sections after the header (tolerant, all optional)
// THINK: private inner monologue (never spoken). SAY: words aloud. MUTTER: rare quiet remark to herself. Plus goal-store lines.
// Plain prose with no labels is the OLD format (speech); mindlink decides whether it is heard (a human in range) or demoted to a thought.
const TEXT_KEYS = new Set(['think', 'say', 'mutter', 'chat'])
const MULTI_KEYS = new Set(['remember', 'forget', 'rename'])
const META_KEYS = new Set(['intent', 'type', 'target', 'remember', 'forget', 'rename', 'goal', 'why', 'plan', 'done', 'abandon', 'note', 'serves', 'horizon', 'value', 'importance', 'urgency', 'caution', 'sociability', 'now', 'playbook'])
const KEY_ALIAS = { reflect: 'think', thought: 'think', thoughts: 'think', speak: 'say', mutters: 'mutter', write: 'chat', serve: 'serves', drop: 'abandon', progress: 'note', objective: 'now' }
const LABEL_RE = /^\s*(?:\*\*)?([A-Za-z]+)(?:\*\*)?\s*:\s*(.*)$/
export function extractSections(lines) {
  const sec = { think: [], say: [], mutter: [], chat: [] }, meta = {}, prose = [], multi = {}
  let open = null, any = false
  const lastLabel = lines.reduce((a, ln, i) => { const m = LABEL_RE.exec(ln); const k = m && (KEY_ALIAS[m[1].toLowerCase()] ?? m[1].toLowerCase()); return k && (TEXT_KEYS.has(k) || META_KEYS.has(k)) ? i : a }, -1)
  for (const [i, ln] of lines.entries()) {
    if (i < lastLabel && /^\s*(?:-{3,}|—+|–+|\*{3,}|_{3,})\s*$/.test(ln)) continue // a --- before the labelled lines
    const m = LABEL_RE.exec(ln)
    let key = m ? m[1].toLowerCase() : null
    if (key) key = KEY_ALIAS[key] ?? key
    if (key && (TEXT_KEYS.has(key) || META_KEYS.has(key))) {
      any = true
      if (TEXT_KEYS.has(key)) { sec[key].push(m[2].trim()); open = key } else { if (MULTI_KEYS.has(key)) (multi[key] ??= []).push(m[2].trim()); else if (meta[key] === undefined) meta[key] = m[2].trim(); open = null }
    } else if (open && ln.trim()) sec[open].push(ln.trim())
    else if (open && !ln.trim()) open = null
    else prose.push(ln)
  }
  const join = (a) => a.join(' ').replace(/\s+/g, ' ').trim()
  const num01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined }
  // tolerant: "goal: X, why: Y, plan: A; B" all on one line (seen in the first live run)
  for (const k of ['goal', 'why', 'plan', 'now']) {
    const v = meta[k]; if (typeof v !== 'string') continue
    const m = /^(.*?)[,;]?\s+(why|plan|serves)\s*:\s*(.*)$/i.exec(v)
    if (m) { meta[k] = m[1].trim(); const rest = `${m[2]}: ${m[3]}`; for (const part of rest.split(/[,;]?\s+(?=(?:why|plan|serves|horizon)\s*:)/i)) { const mm = /^(\w+)\s*:\s*(.*)$/.exec(part); if (mm && meta[mm[1].toLowerCase()] === undefined) meta[mm[1].toLowerCase()] = mm[2].trim() } }
  }
  const mod = {}; for (const k of ['urgency', 'caution', 'sociability']) { const n = num01(meta[k]); if (n !== undefined) mod[k] = n }
  return { any, prose, think: join(sec.think).slice(0, 1500), say: join(sec.say), mutter: join(sec.mutter).slice(0, 160), chat: join(sec.chat).slice(0, 500),
    meta: { playbook: meta.playbook, now: meta.now, intent: meta.intent, type: meta.type, target: meta.target, places: multi, goal: meta.goal, why: meta.why, plan: meta.plan, done: meta.done, abandon: meta.abandon, note: meta.note, serves: meta.serves, horizon: meta.horizon?.toLowerCase(), value: meta.value, importance: num01(meta.importance), mod } }
}

/** Parse raw S2 text. Never throws. -> {ok, act, args, speech, raw_header, errors:[{code,msg}], warnings:[{code,msg}]}
 *  Tolerant where safe (R1): header-only answers, blank lines before ---, ---/—/*** variants, "{...} --- speech" on one line,
 *  speech directly under the header, header missing outer or closing braces. Not tolerant: anything about skills, args, targets. */
export function parseOutput(text) {
  const errors = [], warnings = []
  const err = (code, msg) => errors.push({ code, msg })
  const raw = String(text ?? '').replace(/^﻿/, '')
  if (raw.includes('```')) err('code_fence', 'do not use code fences')
  const lines = raw.replace(/^\s*\n/g, '').split('\n')
  let first = (lines[0] ?? '').trim()
  let inlineSpeech = null
  // "{...} --- speech" on one line
  const m = /^(\{.*\})\s*(?:-{2,}|—+)\s*(\S.*)?$/.exec(first)
  if (m) { first = m[1]; inlineSpeech = m[2] ?? ''; warnings.push({ code: 'delimiter_inline', msg: 'header and --- on one line' }) }
  let act = null, args = null, hdr = {}, headerless = false, emptyCustom = false
  if (first && !first.startsWith('{') && /^(?:type|target)\s*:.*,\s*(?:target|type)\s*:/i.test(first)) { first = '{' + first.replace(/\}+\s*$/, '') + '}'; warnings.push({ code: 'header_braces_repaired', msg: 'header braces added' }) }
  if (!first) err('empty', 'empty answer')
  else if (!first.startsWith('{') && !/^act\s*:/.test(first) && HEADERLESS_RE.test(first)) { headerless = true } // S1G: `intent:` / `type:` lines may stand alone, no {..} header
  else {
    const attempt = (src) => parseRelaxed(src)
    let h
    try { h = attempt(first) } catch (e0) {
      const fixed = repairHeader(first)
      if (fixed === first) err('header_syntax', e0 instanceof HeaderError ? e0.message : String(e0))
      else {
        try { h = attempt(fixed); warnings.push({ code: 'header_braces_repaired', msg: 'header braces completed' }); first = fixed } catch (e) { err('header_syntax', e instanceof HeaderError ? e.message : String(e)) }
      }
      if (!h) {   // PB2: forgiving second chance (bare values with spaces, k=v targets, missing quotes/braces)
        const lo = looseHeader(first)
        const keys = lo ? Object.keys(lo) : []
        let cand = null
        if (lo && keys.length && keys.every((k) => HEADER_KEYS.has(k) || k === 'playbook' || (typeof lo.playbook === 'string' || getPlaybook(lo.act)))) cand = lo
        if (cand && !cand.act && !cand.intent && !String(cand.target ?? '').trim() && normType(cand.type) === 'custom') { cand = null; emptyCustom = true }   // IMP1: {type:custom,target:} says nothing: a quiet {act:none}, no error
        if (cand && cand.type !== undefined && !GOAL_TYPES[normType(cand.type)] && !getPlaybook(normType(cand.type)) && playbookFromText(first)) cand = null
        if (cand) normalizePlaybookHeader(cand)
        if (cand && (cand.act !== undefined || cand.args !== undefined)) cand = null   // strictness on skills/args stays: only playbook/goal headers are read leniently
        if (cand && (cand.type !== undefined || cand.target !== undefined)) { h = cand; errors.length = 0; warnings.push({ code: 'header_loose', msg: 'header parsed leniently' }) }
        else { const pt = playbookFromText(first); if (pt) { h = pt; errors.length = 0; warnings.push({ code: 'header_loose', msg: 'playbook name found in an unparsable header' }) } }
      }
    }
    if (h && normalizePlaybookHeader(h)) warnings.push({ code: 'playbook_header_mapped', msg: 'playbook header mapped to type:playbook' })
    if (h) {
      hdr = h
      const extra = Object.keys(h).filter((k) => !HEADER_KEYS.has(k))
      if (extra.length) err('unknown_header_key', `unknown header key(s): ${extra.join(', ')}; allowed: ${[...HEADER_KEYS].join(', ')}`)
      if (typeof h.act === 'string') act = h.act
      else if (h.act !== undefined) err('act_missing', 'act must be a skill name')
      if (act !== null || h.args !== undefined) {
        if (h.args === undefined) err('args_missing', 'args:{...} is required (use args:{} when the skill takes none)')
        else if (!h.args || typeof h.args !== 'object' || Array.isArray(h.args)) err('args_not_object', 'args must be an object')
        else args = h.args
      }
    }
  }
  if (emptyCustom && !act) { for (let i = errors.length - 1; i >= 0; i--) if (errors[i].code === 'header_syntax') errors.splice(i, 1); if (!errors.length) { act = 'none'; args = {}; warnings.push({ code: 'empty_custom_goal', msg: '{type:custom,target:} said nothing: treated as {act:none}' }) } }
  // body after the header: [blank lines] [delimiter] [blank lines] speech
  const rest = inlineSpeech !== null ? [inlineSpeech, ...lines.slice(1)] : headerless ? lines.filter((l) => !DELIM_RE.test(l)) : lines.slice(1)
  let k = 0
  while (k < rest.length && !rest[k].trim()) k++
  let hasDelim = inlineSpeech !== null
  if (!hasDelim && k < rest.length && DELIM_RE.test(rest[k])) { hasDelim = true; if (k > 0 || rest[k].trim() !== '---') warnings.push({ code: 'delimiter_variant', msg: 'delimiter not on line 2 or not exactly ---' }); k++ }
  let speech = ''
  const bodyLines = hasDelim ? (inlineSpeech !== null ? rest : rest.slice(k)) : rest.slice(k)
  const sec = extractSections(bodyLines)
  if (hasDelim) speech = sec.prose.join(' ').replace(/\s+/g, ' ').trim()
  else if (k >= rest.length) warnings.push({ code: 'delimiter_absent', msg: 'header only: no --- and no speech' }) // silent act
  else {
    const body = sec.prose.join(' ').replace(/\s+/g, ' ').trim()
    if (!body && sec.any) { /* labelled sections directly under the header: fine */ } else
    if (/\{\s*act\s*:/.test(body)) err('delimiter_missing', 'line 2 must be exactly ---')
    else { speech = body; warnings.push({ code: 'delimiter_inferred', msg: 'speech without ---' }) }
  }
  // Q1: a closing delimiter after the speech ("... nagging at me.\n---") reached the in-game chat as "... nagging at me. ---"
  const closed = speech.replace(/(?:\s*(?:-{3,}|[—–]{1,}|\*{3,}))+\s*$/, '').trim()
  if (closed !== speech) { speech = closed; warnings.push({ code: 'trailing_delimiter', msg: 'closing delimiter removed from speech' }) }
  // S1G: the goal S2 states (what she wants), instead of or in addition to a named skill
  const mod = { ...sec.meta.mod }
  for (const k of ['urgency', 'caution', 'sociability']) { const n = Number(hdr[k]); if (hdr[k] !== undefined && Number.isFinite(n)) mod[k] = Math.min(1, Math.max(0, n)) }
  sec.meta.mod = mod
  const gType = hdr.type ?? sec.meta.type, gTarget = hdr.target ?? sec.meta.target, gText = hdr.intent ?? sec.meta.intent
  let goal = null
  if (gType !== undefined || gText !== undefined || gTarget !== undefined) goal = { type: gType, target: gTarget, text: gText, via_act: act !== null }
  const hasPlaceOps = Object.values(sec.meta.places ?? {}).some((a) => a.length)
  // PB1: `now: <playbook> k=v ...` starts that playbook; `playbook: skip | abort <why> | set k=v` steers the running one
  if (!act && (!goal || (goal.type === undefined && goal.target === undefined)) && sec.meta.now) { const pn = parsePlaybookTarget(sec.meta.now); if (pn && getPlaybook(pn.name)) goal = { type: 'playbook', target: String(sec.meta.now).trim(), text: goal?.text ?? String(sec.meta.now).trim(), via_act: false } }
  const pbOps = parsePlaybookOps(sec.meta.playbook)
  if (!act && !goal && pbOps.length && !errors.length) { act = 'none'; args = {}; warnings.push({ code: 'act_none_inferred', msg: 'playbook steering only: act none' }) }
  sec.meta.playbook_ops = pbOps
  if (!act && !goal && hasPlaceOps && !errors.length) { act = 'none'; args = {}; warnings.push({ code: 'act_none_inferred', msg: 'place note only: act none' }) }
  if (!act && !goal && !errors.some((e) => ['header_syntax', 'empty', 'unknown_header_key', 'args_not_object', 'act_missing'].includes(e.code))) err('act_missing', 'name a skill with act:<skill>, or state a goal with intent: and type:')
  if (!act && goal && !gText && gType === undefined) err('act_missing', 'state a goal with intent: and type:')
  let speech_kind = speech ? 'legacy' : null
  if (sec.say) { speech = sec.say.replace(/(?:\s*(?:-{3,}|[—–]{1,}|\*{3,}))+\s*$/, '').trim(); speech_kind = 'say'; if (sec.prose.join('').trim()) sec.think = (sec.think + ' ' + sec.prose.join(' ')).trim() }
  if (!/\{\s*act\s*:/.test(speech)) speech = cleanSpeech(speech) // header-like speech stays visible so validate() rejects it
  return { ok: errors.length === 0, act, args, goal, speech, speech_kind, think: sec.think, mutter: sec.mutter, chat: sec.chat, meta: sec.meta, raw_header: first, errors, warnings }
}

// ---------------------------------------------------------------- validator
const PASSIVE = new Set(['idle_activity', 'gesture', 'sleep', 'explore', 'collect', 'none', 'interact'])
const key = (act, args) => act + ':' + JSON.stringify(Object.fromEntries(Object.entries(args ?? {}).sort()))

function checkArg(act, name, spec, val, idx, dg, out) {
  const bad = (code, msg) => out.errors.push({ code, msg: `${act}.${name}: ${msg}` })
  if (spec.t === 'enum') {
    if (typeof val !== 'string' || !spec.values.includes(val)) bad('arg_enum', `"${val}" is not allowed; use one of: ${spec.values.join(', ')}`)
  } else if (spec.t === 'int') {
    if (typeof val !== 'number' || !Number.isFinite(val)) bad('arg_type', `must be a number, got ${typeof val}`)
    else if (!Number.isInteger(val)) bad('arg_type', 'must be a whole number')
    else if (val < spec.min || val > spec.max) bad('arg_range', `${val} outside ${spec.min}..${spec.max}`)
  } else if (spec.t === 'item') {
    if (typeof val !== 'string') return bad('arg_type', 'must be an inventory item name')
    if (!(dg.inventory[val] > 0)) bad('item_missing', `you do not hold "${val}"; inventory: ${Object.keys(dg.inventory).join(', ') || 'empty'}`)
    else if (spec.edible && !isFood(val)) bad('item_not_edible', `"${val}" is not edible${COOKABLE[val] ? ` raw (cook it into ${COOKABLE[val]} first: {act:cook,args:{}})` : ''}. ${edibleLine(dg)}${cookableLine(dg) ? '. ' + cookableLine(dg) : ''}`)
  } else if (spec.t === 'ref') {
    if (typeof val !== 'string') return bad('arg_type', 'must be an id string copied from the state')
    const r = idx.get(val)
    if (!r) {
      const pool = [...idx.entries()].filter(([, v]) => spec.kinds.includes(v.kind)).map(([k]) => k)
      return bad('id_unknown', `"${val}" is not in the current state; valid ids: ${pool.slice(0, 12).join(', ') || 'none present'}`)
    }
    if (!spec.kinds.includes(r.kind)) return bad('id_wrong_kind', `"${val}" is a ${r.kind}; need a ${spec.kinds.join(' or ')}`)
    if (spec.tag && !r.tags.includes(spec.tag) && r.cat !== spec.tag) bad('id_wrong_kind', `"${val}" is not tagged ${spec.tag}`)
  }
}

/** Rules that may be downgraded to warnings so the validator can never leave S2 with zero acceptable actions (P1). */
export const RELAXABLE = ['needs_starving', 'injured']
/** AI1 (WREN_AUTONOMY=high): survival-judgement rules that become warnings fed back to S2. Physically impossible/invalid actions stay hard errors. */
export const ADVISORY = new Set(['needs_starving', 'injured', 'threat_ignored', 'approach_hostile', 'hazard_target', 'hazard_near_target', 'move_to_hostile', 'repeat_goal'])

/** Short list of what WOULD be accepted now, for the repair prompt (mirrors semantic()). */
export function allowedActs(digestIn, opts = {}) {
  const dg = normalizeDigest(digestIn)
  const relax = opts.relax instanceof Set ? opts.relax : new Set(opts.relax ?? [])
  const fk = foodKnown(dg)
  const starving = dg.food <= 4 || (dg.health <= 8 && dg.food <= 6)
  const closeHostile = dg.nearby.some((n) => n.cat === 'hostile' && Number.isFinite(n.dist) && n.dist <= 6)
  const out = []
  const foodBound = starving && (fk.inventory.length || fk.animals.length) && !relax.has('needs_starving')
  if (fk.inventory.length && dg.food < 20) out.push(`eat {item:${fk.inventory[0]}}`)
  const a = fk.animals[0]
  if (a) { out.push(`hunt {target:${a.id}}`); out.push(`approach {target:${a.id}}`) }
  const hostile = dg.nearby.find((n) => n.cat === 'hostile')
  if (hostile) { out.push(`flee {from:${hostile.id}}`); if (Object.keys(dg.inventory).some((k) => k.endsWith('_sword') || k.endsWith('_axe'))) out.push(`fight {target:${hostile.id}}`) }
  if (Object.keys(dg.inventory).some((k) => COOKABLE[k] && dg.inventory[k] > 0)) out.push('cook {}')
  if (!foodBound) {
    out.push('idle_activity {kind:rest}')
    if (!(dg.health <= 6 && !closeHostile && !relax.has('injured'))) out.push('explore {direction:any}')
    const home = dg.places.find((p) => p.kind === 'home')
    if (home) out.push(`go_to {place:${home.id}}`)
  } else if (dg.health <= 6) out.push('go_to {place:home} (if known)')
  return out.slice(0, 7)
}

/**
 * Validate parsed output against the digest. -> {ok, errors, warnings, act, args, speech, trimmed}
 * `ok` is false when any error exists; the caller does one repair retry, then falls back to habits.
 * opts.recent: recent intents [{goal,args}] (defaults to digest.recent_intents).
 */
export function validate(parsed, digestIn, opts = {}) {
  const dg = normalizeDigest(digestIn)
  const errors = [...parsed.errors]
  const warnings = [...(parsed.warnings ?? [])]
  const out = { errors, warnings }
  const w = (code, msg) => warnings.push({ code, msg })
  const relax = opts.relax instanceof Set ? opts.relax : new Set(opts.relax ?? [])
  const e = (code, msg) => {
    if (relax.has(code)) warnings.push({ code: code + '_relaxed', msg })
    else if (opts.advisory && ADVISORY.has(code)) warnings.push({ code: code + '_advisory', msg, advisory: true }) // AI1: survival judgement is hers; she is told, not stopped
    else errors.push({ code, msg })
  }
  const res = { ok: false, errors, warnings, goal: null, place_ops: [], act: parsed.act, args: parsed.args ?? {}, speech: parsed.speech, trimmed: false, speech_kind: parsed.speech_kind ?? null, think: parsed.think ?? '', mutter: parsed.mutter ?? '', chat: parsed.chat ?? '', meta: parsed.meta ?? {} }
  const spec = parsed.act ? SKILLS[parsed.act] : null
  if (parsed.act && (!spec || spec.internal)) e('vocab', `"${parsed.act}" is not a skill; use one of: ${PUBLIC_SKILL_NAMES.join(', ')}`)
  const idx = indexDigest(dg)
  // S1G: goal (what she wants) and place notes
  let goalMode = false
  if (parsed.goal) {
    const g = checkGoal(parsed.goal, dg, idx)
    for (const x of g.errors) errors.push(x)
    for (const x of g.warnings) warnings.push(x)
    res.goal = { ...g.goal, via_act: !!parsed.goal.via_act }
    goalMode = !parsed.act
  }
  { const po = parsePlaceOps(parsed.meta?.places ?? {}, new Set(dg.places.map((p) => p.id)))
    res.place_ops = po.ops
    for (const m of po.notes) warnings.push({ code: 'place_op', msg: m }) }
  if (spec && parsed.args) {
    for (const k of Object.keys(parsed.args)) if (!(k in spec.args)) e('arg_unknown', `${parsed.act}: unknown arg "${k}"; valid: ${Object.keys(spec.args).join(', ') || '(none)'}`)
    for (const [name, s] of Object.entries(spec.args)) {
      const v = parsed.args[name]
      if (v === undefined) { if (!s.optional) e('arg_missing', `${parsed.act}: missing arg "${name}"`); continue }
      checkArg(parsed.act, name, s, v, idx, dg, out)
    }
  }
  if (spec && parsed.args && !spec.internal) semantic(parsed.act, parsed.args, dg, idx, opts, e, w)

  // speech
  let sents = splitSentences(parsed.speech)
  if (/\{\s*act\s*:|```|^---$/m.test(parsed.speech)) e('speech_format', 'speech must be plain sentences, no header or code')
  const limit = parsed.act === 'none' || (goalMode && ['talk', 'rest', 'playbook'].includes(res.goal?.type)) ? 3 : 1
  if (sents.length > limit) { sents = sents.slice(0, limit); res.trimmed = true; w('speech_trimmed', `speech cut to ${limit} sentence(s)`) }
  let speech = sents.join(' ')
  if ((speech.match(/"/g) ?? []).length % 2 === 1) speech = speech.replace(/"/g, '') // a cut inside a quotation leaves a dangling quote
  if (speech.length > 300) { speech = sents[0].slice(0, 300); res.trimmed = true; w('speech_trimmed', 'speech cut to 300 chars') }
  if (!speech) {
    if (dg.chat.length) e('reply_missing', 'a person spoke to you; say something back in 1-3 sentences (or one sentence if you act)')
    else w('silent', 'no speech')
  }
  res.speech = speech
  res.ok = errors.length === 0
  return res
}

function semantic(act, args, dg, idx, opts, e, w) {
  const hp = dg.health, food = dg.food
  const fk = foodKnown(dg)
  const starving = food <= 4 || (hp <= 8 && food <= 6)
  const hungry = food <= 8
  const hostiles = dg.nearby.filter((n) => n.cat === 'hostile' && Number.isFinite(n.dist))
  const closeHostile = hostiles.filter((n) => n.dist <= 6)
  const tgt = (args.target ?? args.from ?? args.place) && idx.get(args.target ?? args.from ?? args.place)

  if (starving) {
    const foodActs = new Set(['eat', 'hunt', 'flee', 'cook', 'fight'])
    const approachesFood = act === 'approach' && tgt && (tgt.cat === 'animal')
    if ((fk.inventory.length || fk.animals.length) && !foodActs.has(act) && !approachesFood && !(closeHostile.length && act === 'go_to'))
      e('needs_starving', `you are starving (food ${food}/20) and food is available (${[...fk.inventory.map((i) => `${i} in inventory`), ...fk.animals.slice(0, 2).map((a) => `${a.id} ${a.dist}m`)].join(', ')}); "${act}" ignores that`)
    else if (!fk.inventory.length && !fk.animals.length && ['idle_activity', 'gesture', 'sleep', 'none'].includes(act)) w('needs_starving_idle', 'starving with no known food and you chose a passive act')
  } else if (hungry && (fk.inventory.length || fk.animals.length) && ['explore', 'idle_activity', 'gesture', 'collect'].includes(act)) w('needs_hungry_ignored', `hungry (food ${food}/20) with food known`)
  if (act === 'eat' && food >= 20) e('needs_not_hungry', 'food is already full')

  // hazards: target or destination near a hazard
  const hz = [...dg.hazards, ...dg.nearby.filter((n) => HAZARD_KINDS.has(n.kind))]
  if (tgt?.kind === 'hazard' && (act === 'approach' || act === 'interact')) e('hazard_target', `"${args.target}" is a hazard`)
  const dest = act === 'move_to' ? [args.x, args.y, args.z] : ['approach', 'interact', 'hunt', 'follow'].includes(act) ? tgt?.pos : null
  if (dest && act === 'move_to') for (const n of hostiles) if (distance(dest, n.pos) <= 4) e('move_to_hostile', `the destination is ${distance(dest, n.pos).toFixed(1)}m from ${n.id} (hostile)`)
  if (dest) {
    for (const h of hz) {
      const d = distance(dest, h.pos)
      if (d <= (act === 'move_to' ? 3 : 4)) e('hazard_near_target', `the destination is ${d.toFixed(1)}m from ${h.id ?? h.kind} (${h.kind}); that is dangerous`)
    }
  }
  if (act === 'explore') for (const h of hz) if ((h.dist ?? 99) <= 3) w('hazard_adjacent', `${h.kind} is ${h.dist}m away while exploring`)

  // threats
  if (closeHostile.length && hp <= 10 && PASSIVE.has(act)) e('threat_ignored', `${closeHostile.map((h) => `${h.id} ${h.dist}m`).join(', ')} close and health ${hp}/20; "${act}" is passive`)
  else if (hostiles.some((h) => h.dist <= 8) && PASSIVE.has(act) && act !== 'none') w('threat_passive', 'hostile within 8m and a passive act')
  if (act === 'defend') {
    const h = dg.hurt_by.find((x) => x.kind === 'player' && x.who === args.target)
    if (!h) e('defend_not_hurt', `"${args.target}" has not hurt you, so you cannot hit them (hit back only at someone who is hurting you)`)
    else if (!(h.ago_s <= 10)) e('defend_not_attacking', `"${args.target}" last hit you ${h.ago_s} s ago; hitting back only fits while they are still hitting you`)
  }
  if (act === 'flee' && tgt && tgt.kind === 'entity' && tgt.cat !== 'hostile') e('flee_nonhostile', `"${args.from}" is ${tgt.cat === 'animal' ? 'an animal' : 'not hostile'} and cannot hurt you; flee needs a hostile creature or a hazard (hostile here: ${hostiles.slice(0, 3).map((h) => h.id).join(', ') || 'none'})`)
  if (['approach', 'hunt', 'follow', 'interact'].includes(act) && tgt?.cat === 'hostile') e('approach_hostile', `"${args.target}" is hostile; do not walk up to it`)

  if (hp <= 6 && ['explore', 'collect', 'move_to'].includes(act) && !closeHostile.length) e('injured', `health ${hp}/20: ${act} is risky now`)
  else if (hp <= 10 && ['explore', 'collect'].includes(act)) w('injured_active', `health ${hp}/20`)
  if (dg.energy <= 4 && ['explore', 'collect'].includes(act)) w('energy_low', `energy ${dg.energy}/20`)

  if (act === 'sleep') {
    const night = dg.time.phase === 'night' || dg.thunder
    const bed = dg.places.some((p) => p.kind === 'bed') || Object.keys(dg.inventory).some((k) => k.endsWith('_bed'))
    if (!night) e('sleep_daytime', `you can only sleep at night or in thunder (it is ${dg.time.phase})`)
    else if (!bed) e('no_bed', 'no bed known')
  }
  if (act === 'collect' && dg.free_slots <= 0) e('inventory_full', 'inventory is full; free space first')
  if (act === 'move_to') {
    const d = distance([args.x, args.y, args.z], dg.pos)
    if (d > 256) e('too_far', `${Math.round(d)}m away; max 256m per move_to`)
  }
  if (['follow', 'approach', 'interact'].includes(act) && tgt?.dist != null && tgt.dist > 64) e('too_far', `"${args.target}" is ${Math.round(tgt.dist)}m away`)

  // repeat budget
  const recent = (opts.recent ?? dg.recent_intents).slice(-8)
  const sig = key(act, args)
  const same = recent.filter((r) => r && r.goal && key(r.goal, r.args) === sig).length
  if (act !== 'none') {
    if (same >= 3) e('repeat_goal', `you already did ${act} ${JSON.stringify(args)} ${same} times recently; choose something different`)
    else if (same >= 2) w('repeat_goal', 'same act twice already')
  }
}

// ---------------------------------------------------------------- intents
let _ctr = 0
export function newIntentId(now = Date.now()) { return `i${now.toString(36)}-${(++_ctr).toString(36)}` }

/** Deterministic modulators (0..1) from the digest: not chosen by S2 (compact header), so S2 cannot invent them. */
export function modulatorsFor(dg) {
  const n = dg.needs
  const hostile = dg.nearby.some((x) => x.cat === 'hostile' && x.dist <= 12)
  return {
    urgency: round2(Math.max(n.hunger ?? 0, n.energy ?? 0, n.safety ?? 0)),
    caution: round2(Math.min(1, (hostile ? 0.6 : 0) + (dg.health <= 10 ? 0.3 : 0) + (dg.hazards.length ? 0.2 : 0))),
    sociability: round2(dg.chat.length ? 0.9 : Math.min(1, n.social ?? 0)),
  }
}
const round2 = (x) => Math.round(x * 100) / 100

/** G2: the `now:` line (her current objective, minutes long). -> {text, end:'done'|'dropped'|null} or null when absent */
export function parseNow(raw) {
  if (raw === undefined || raw === null) return null
  const t = String(raw).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!t) return null
  if (/^(done|finished|complete[d]?|achieved|reached)\b/i.test(t)) return { text: '', end: 'done' }
  if (/^(none|nothing|no objective|dropped?|cancel(l?ed)?|abandon(ed)?|-)\b/i.test(t)) return { text: '', end: 'dropped' }
  return { text: t, end: null }
}

/** PB1: steering of the running playbook. 'skip' | 'abort [why]' | 'set k=v k=v' (also 'continue': no-op). -> [{op, reason?, set?}] */
export function parsePlaybookOps(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim(); if (!t) return []
  const m = /^(skip|abort|cancel|stop|set|change|continue|keep)\b\s*(.*)$/i.exec(t); if (!m) return []
  const k = m[1].toLowerCase(), rest = m[2].trim()
  if (k === 'skip') return [{ op: 'skip' }]
  if (k === 'abort' || k === 'cancel' || k === 'stop') return [{ op: 'abort', reason: rest.slice(0, 60) || 'aborted_by_s2' }]
  if (k === 'continue' || k === 'keep') return [{ op: 'continue' }]
  const set = {}; for (const x of rest.matchAll(/([A-Za-z_]\w*)\s*[=:]\s*("([^"]*)"|[^\s,;]+)/g)) set[x[1].toLowerCase()] = (x[3] ?? x[2]).replace(/^"|"$/g, '')
  return Object.keys(set).length ? [{ op: 'set', set }] : []
}

/** validated output -> versioned intent. */
export function makeIntent(v, digestIn, { intent_id = newIntentId(), now = Date.now(), plan_id = null, source = 's2', serves = null } = {}) {
  const dg = normalizeDigest(digestIn)
  const goalMode = !v.act && !!v.goal
  const s = SKILLS[goalMode ? 'pursue' : v.act]
  return {
    v: CONTRACT_VERSION, intent_id, goal: goalMode ? 'pursue' : v.act, args: goalMode ? { type: v.goal.type, ...(v.goal.target ? { target: v.goal.target } : {}) } : v.args,
    goal_spec: v.goal ? { type: v.goal.type, target: v.goal.target, text: v.goal.text, hash: textHash(v.goal.text), via_act: !!v.goal.via_act } : null, place_ops: v.place_ops ?? [], playbook_ops: v.meta?.playbook_ops ?? [],
    modulators: { ...modulatorsFor(dg), ...(v.meta?.mod ?? {}) }, serves, objective: parseNow(v.meta?.now), importance: v.meta?.importance ?? null, value: v.meta?.value || null, think: v.think || null, mutter: v.mutter || null, chat: v.chat || null, speech_kind: v.speech_kind ?? null,
    constraints: { avoid: [...dg.hazards.map((h) => h.id), ...dg.nearby.filter((n) => n.cat === 'hostile' && v.act !== 'flee').map((n) => n.id)], area: null, max_s: s.max_s },
    ttl_s: s.ttl_s, interruptible: s.interruptible, plan_id, source, created_at_ms: now,
  }
}

export function validateIntent(o) {
  const errs = []
  if (!o || typeof o !== 'object') return ['not an object']
  if (o.v !== CONTRACT_VERSION) errs.push(`v must be ${CONTRACT_VERSION}`)
  if (typeof o.intent_id !== 'string' || !o.intent_id) errs.push('intent_id')
  if (!SKILLS[o.goal]) errs.push('goal not in vocabulary')
  if (!o.args || typeof o.args !== 'object') errs.push('args')
  for (const m of ['urgency', 'caution', 'sociability']) if (!(o.modulators?.[m] >= 0 && o.modulators[m] <= 1)) errs.push(`modulators.${m}`)
  if (!Array.isArray(o.constraints?.avoid)) errs.push('constraints.avoid')
  if (!(o.ttl_s > 0)) errs.push('ttl_s')
  if (typeof o.interruptible !== 'boolean') errs.push('interruptible')
  return errs
}

export function intentExpired(intent, now = Date.now()) { return now > intent.created_at_ms + intent.ttl_s * 1000 }

// ---------------------------------------------------------------- S1 -> S2 events
/** -> {ok, errors, event}. Unknown fields are dropped; digest is normalised. */
export function validateEvent(ev) {
  const errors = []
  if (!ev || typeof ev !== 'object') return { ok: false, errors: ['event must be an object'] }
  if (!EVENT_TYPES.includes(ev.type)) errors.push(`type must be one of ${EVENT_TYPES.join(', ')}`)
  const out = { v: CONTRACT_VERSION, type: ev.type, t_ms: Number.isFinite(ev.t_ms) ? ev.t_ms : Date.now(), digest: ev.digest ? normalizeDigest(ev.digest) : null }
  if (ev.type === 'report') {
    if (typeof ev.intent_id !== 'string') errors.push('report.intent_id required')
    if (!STATUSES.includes(ev.status)) errors.push(`report.status must be one of ${STATUSES.join(', ')}`)
    if (ev.reason_code !== undefined && !REASON_CODES.includes(ev.reason_code)) errors.push(`report.reason_code must be one of ${REASON_CODES.join(', ')}`)
    Object.assign(out, { intent_id: ev.intent_id, status: ev.status, reason_code: ev.reason_code ?? 'ok' })
  } else if (ev.type === 'human_speech') {
    if (typeof ev.from !== 'string' || typeof ev.text !== 'string' || !ev.text.trim()) errors.push('human_speech needs from and text')
    Object.assign(out, { from: ev.from, text: String(ev.text ?? '').slice(0, 500) })
    if (ev.via === 'voice') out.via = 'voice' // VINT: spoken aloud (voice mod), not typed
    else if (ev.via === 'chat') out.via = 'chat' // V4: in-game chat (global text, any distance)
    if (typeof ev.uuid === 'string' && ev.uuid) out.uuid = ev.uuid.slice(0, 64)
    if (Number.isFinite(ev.ts)) out.ts = ev.ts
    if (Array.isArray(ev.overlap)) { const o = ev.overlap.filter((x) => typeof x === 'string').slice(0, 4); if (o.length >= 2) out.overlap = o } // who spoke at the same time
    if (Number.isFinite(ev.dist)) out.dist = Math.round(ev.dist * 10) / 10
    if (Number.isFinite(ev.utt_id)) out.utt_id = ev.utt_id // V3: id of the voice utterance (answers are tagged with it)
    if (typeof ev.unspoken === 'string' && ev.unspoken.trim()) out.unspoken = ev.unspoken.slice(0, 300) // what she was cut off before saying
  } else if (ev.type === 'drive_wake') {
    if (typeof ev.drive !== 'string') errors.push('drive_wake.drive required')
    Object.assign(out, { drive: ev.drive, level: Number.isFinite(ev.level) ? ev.level : null })
  } else if (ev.type === 'body_state') {
    if (typeof ev.state !== 'string') errors.push('body_state.state required')
    out.state = ev.state
  }
  if (ev.context && typeof ev.context === 'object') out.context = ev.context
  return { ok: errors.length === 0, errors, event: out }
}

// ---------------------------------------------------------------- cancel / correction templates (no LLM)
// Neutral, factual wording only. Chosen deterministically from a seed so identical failures do not
// always produce the identical sentence.
const TEMPLATES = {
  failed: ['That did not work.', 'I could not do that.', 'That failed, I will rethink.'],
  blocked: ['I am stuck here.', 'I cannot get further this way.', 'Something is blocking me.'],
  preempted_reflex: null, // silent: a reflex took over, cancel any unplayed speech
  preempted: null,
  invalid: ['Sorry, I did not get that out properly. Could you say it again?', 'I lost my train of thought. Could you repeat that?'],
  offline: ['My thinking is offline right now, I will keep to simple routines.'],
  online: ['My thinking is back.'],
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
export function templateLine(kind, seed = '') {
  const t = TEMPLATES[kind]
  return t ? t[hash(seed) % t.length] : null
}
/** What to do with the unplayed speech of an intent when S1 reports status. -> {cancel_speech, template} */
export function speechPolicy(status, reason_code, seed = '') {
  if (status === 'failed') return { cancel_speech: true, template: templateLine('failed', seed + reason_code) }
  if (status === 'blocked') return { cancel_speech: true, template: templateLine('blocked', seed + reason_code) }
  if (status === 'preempted') return { cancel_speech: true, template: null }
  return { cancel_speech: false, template: null }
}

// ---------------------------------------------------------------- SURV1: words are not actions
// observed: she listed the right options in THINK/SAY ("eat the rotten flesh", "build a shelter") under {act:none}; nothing happened and she died.
// If the text names exactly ONE clear action she can carry out, turn it into the intent she obviously meant; if it names several or none, the caller may re-prompt once.
// IMP1: sentence-level inference. Each sentence of NOW / THINK / SAY is scanned on its own; status talk about the past ("the get_food playbook failed") is ignored;
// several kinds in ONE sentence stay ambiguous; across sentences the NOW line wins, then an explicit menu choice ("I'll go with 2"), then the LAST committed sentence.
// Intentional waiting ("wait for dusk", "stay by the bed") becomes a short explicit idle_activity rest, so it is an action and is logged. A real "let the body continue" stays none.
const NEG = /(?:\bnot|n't|\bnever|\bcannot|\bno\b|\bwithout|\binstead of)\s+(?:\w+\s+){0,2}$/i
const STATUS_AFTER = /^[^,.;]{0,30}?\b(?:failed|fails|finished|finishes|completed|ended|keeps?|kept|broke|breaks|breaking|says?|said|reported|was|were|did(?:n'?t| not)|couldn'?t|could not|has|have|had|is (?:still )?running|is (?:done|over)|done)\b/i
const STATUS_BEFORE = /\b(?:after|since|because|when|once|until|last|previous|earlier|which|that)\s+(?:the\s+|my\s+|a\s+)?(?:\w+\s+){0,2}$/i
const PAST_SENT = /\b(?:failed|fail|didn'?t|did not|couldn'?t|could not|tried)\b/i
const CUE = /\b(?:i(?:'ll| will| should| need to| must| want to| can| could| have to|'m going to| am going to| shall)|let me|let's|lets|going to|time to|gonna|maybe|then|should|ought to|first|next|go ahead and|trying to|try to|want to|wants to)\b/i
const STRONG = /\b(?:i(?:'ll| will| should| need to| must| have to|'m going to| am going to)|let me|let's|going to|time to|gonna|go ahead and|so i|just)\b/i
const HEDGE = /\b(?:maybe|perhaps|either|or i|or just|or else|could also|might)\b/i
const LATER = /\b(?:after (?:that|this|which)|later|afterwards?|tonight|once (?:i|it|that)|when (?:night|dusk|it)|eventually)\b/i
const SEQ = /\b(?:then|first|and then|after that)\b/i
const ALT = /\beither\b|\bor\s+(?:maybe\s+|just\s+|else\s+)?(?:i\s+)?(?:go|sleep|build|eat|cook|explore|wait|rest|stay|head|walk|fish|dig|\(\w\))/i
const CONTINGENT = /\b(?:otherwise|if (?:it|that|this|they|the \w+) (?:fails?|doesn'?t|does not|can'?t|cannot|won'?t)|in case|if not|else i)\b/i
const WAIT_RX = [
  /\b(?:wait|waiting)\s+(?:it out|here|there|at|by|near|for\s+(?:about\s+|another\s+)?\d+|for\s+(?:the\s+)?(?:dusk|dark|night|nightfall|sunset|sundown|dawn|morning|sunrise|evening|bed|day|sun)|until|a (?:bit|while|moment|minute)|patiently)/i,
  /\b(?:stay|remain|sit|stand|hang around|hole up)\s+(?:right\s+|safely\s+)?(?:here|there|put|still|tight|by|at|near|close|next to|beside|inside|home|in place|and wait)/i,
  /\brest\s+(?:here|there|a (?:bit|while|moment)|until|now|up|for|at|by|near)/i,
  /\b(?:not|n't)\s+(?:moving|going anywhere|leaving|wandering)\b/i,
  /\bjust\s+(?:wait|rest|sit|stay)\b/i,
]
const CONTINUE_RX = /\b(?:let|allow)\s+(?:the\s+|my\s+)?(?:body|ladder|escape|it|that|them|playbook|routine|habit|activity)\b[^.]{0,40}\b(?:continue|finish|run|work|do (?:its|it)|go on|handle)|\b(?:not|n't)\s+(?:to\s+)?(?:interrupt|interfere|override|disturb)|\bkeep (?:going|doing what)|\bcontinue (?:what|with what)|\bnothing (?:more )?to do\b/i
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 }
const PREF_RX = /\b(?:i(?:'ll| will| am going to|'m going to| choose| pick| take| prefer| go with| would go with| should go with)|let me|let's|going with|go with|pick|choose|choosing|picking|taking|prefer|best (?:is|option is)|decid(?:ed|e) on)\s+(?:to\s+)?(?:go with\s+|pick\s+|take\s+|do\s+|start\s+)?(?:the\s+)?(?:option\s+|number\s+|choice\s+|menu\s+(?:item\s+)?|item\s+|#)?(\d|one|two|three|four|five|six|seven|first|second|third|fourth|fifth|sixth|seventh)(?:\s+(?:option|choice|one|item))?(?=\s*(?:[.,;:!)?]|$|\band\b|\bbecause\b|\bsince\b|\bfor\b|\bas\b|\bso\b|\bthen\b|\bwhich\b))/i
const OPT_TRAIL = /\b(?:option|number|choice|menu item|item|#)\s*(\d)\b[^.]{0,20}$/i

/** menu line "go_home (98 m west)" / "explore_and_return radius=60" -> playbook hit | null */
function menuHit(line) {
  const m = /^([a-z_]+)(?:\s+([^(:]*))?/i.exec(line.trim()); if (!m) return null
  const name = m[1].toLowerCase()
  if (name === 'close_doors_nearby' || /<|show_place_to_person|^gather$/.test(line.slice(0, 60)) || !getPlaybook(name)) return null
  const args = {}; for (const x of (m[2] ?? '').matchAll(/(\w+)=([\w-]+)/g)) if (!/^[<]/.test(x[2])) args[x[1]] = /^\d+$/.test(x[2]) ? Number(x[2]) : x[2]
  return name === 'dig_in' ? { goal: { type: 'build_shelter', target: null, text: 'seal myself in right here' } } : { goal: { type: 'playbook', target: [name, pbArgStr(args)].filter(Boolean).join(' '), text: name.replace(/_/g, ' ') } }
}
function waitSeconds(s) { const m = /\b(?:for\s+)?(?:about\s+|another\s+)?(\d+)\s*(s|sec|secs|seconds?|min|mins|minutes?)\b/i.exec(s); if (!m) return 30; const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1); return Math.max(10, Math.min(60, n)) }

/** -> {hit:{act,args}|{goal}, kinds:[...], why} | {ambiguous:[...]} | {none:true, why?} */
export function inferAction(parsed, digestIn, { menu = null } = {}) {
  const dg = normalizeDigest(digestIn)
  const custom = parsed.goal && normType(parsed.goal.type) === 'custom' ? `${parsed.goal.target ?? ''} ${parsed.goal.text ?? ''}` : ''
  const split = (s, src) => String(s ?? '').split(/\n+/).filter((l) => !/^\s*(?:\d+[.)]|[-*])\s/.test(l)).flatMap((l) => l.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)).map((t) => t.trim()).filter(Boolean).filter((t, i, a) => !/^\d{1,2}[.)]$/.test(t) && !/^\d{1,2}[.)]$/.test(a[i - 1] ?? '')).map((t) => ({ t, src }))
  const sents = [...split(parsed.think, 'think'), ...split(parsed.speech, 'say'), ...split(custom, 'goal'), ...split(parsed.meta?.now, 'now')]
  const night = dg.time.phase === 'night' || dg.thunder
  const bed = dg.places.find((p) => p.kind === 'bed')
  const hasBedItem = Object.keys(dg.inventory).some((k) => k.endsWith('_bed'))
  const held = Object.entries(dg.inventory).filter(([k, n]) => n > 0 && isFood(k)).map(([k]) => k)
  const rawHeld = Object.keys(dg.inventory).some((k) => /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/.test(k))
  const pbHit = (name, args = {}) => ({ goal: { type: 'playbook', target: [name, pbArgStr(args)].filter(Boolean).join(' '), text: name.replace(/_/g, ' ') } })
  const SHELTER = { goal: { type: 'build_shelter', target: null, text: 'seal myself in right here' } }
  const bedNear = !!bed && Number.isFinite(bed.dist) && bed.dist <= 4
  const perSent = []   // [{src, idx, found:Map}]
  sents.forEach((S, idx) => {
    const text = S.t, found = new Map(), pos = new Map(); let curIdx = 0
    const _set = found.set.bind(found); found.set = (k, v) => { if (!pos.has(k)) pos.set(k, curIdx); return _set(k, v) }
    const fire = (re, f) => { const g = new RegExp(re.source, 'gi'); let m; while ((m = g.exec(text))) { if (NEG.test(text.slice(Math.max(0, m.index - 28), m.index))) continue; curIdx = m.index; f(m) } }
    const cued = (i) => S.src === 'now' || S.src === 'goal' || text.slice(0, i).trim() === '' || CUE.test(text.slice(0, i))
    const fireCued = (re, f) => fire(re, (m) => { if (cued(m.index)) f(m) })
    for (const k of held) {
      const nm = k.replace(/_/g, '[ _]')
      fire(new RegExp(`\\b(?:eat|eating|eat up|consume|munch|chew)\\s+(?:on\\s+)?(?:the |a |an |some |one |my |that |those |all (?:the |my )?)?(?:\\w+\\s+){0,1}?${nm}s?\\b`), () => found.set('eat:' + k, { act: 'eat', args: { item: k } }))
    }
    if (rawHeld) fireCued(/\b(?:cook|roast|smelt)\s+(?:the |my |a |some |that |those )?(?:raw )?(?:cod|salmon|fish|meat|beef|porkchop|mutton|chicken|rabbit|tropical fish|them|it)\b/, () => found.set('cook', { act: 'cook', args: {} }))
    fire(/\b(?:dig in|dig down|dig a hole|pillar up|seal myself|wall myself|wall (?:myself )?in|build (?:a |an |myself a )?(?:quick |small |emergency )?(?:shelter|pillbox|hole)|make (?:a |an )?(?:emergency |quick )?shelter|hide in a hole)\b/, () => found.set('shelter', SHELTER))
    fireCued(/\b(?:gather|collect|mine|chop)\s+(?:some |more |a few |about )?(\d+\s+)?(?:the |my )?(wood|logs?|stone|cobblestone|coal|iron|sand|dirt|plants)\b/, (m) => { const r = /^(?:log|wood)/.test(m[2]) ? 'wood' : /^(?:stone|cobble)/.test(m[2]) ? 'stone' : m[2]; if (dg.playbook?.name !== 'gather') found.set('pb:gather', pbHit('gather', { resource: r, ...(m[1] ? { count: Math.min(32, Number(m[1])) } : {}) })) })
    fire(/\b(?:sleep in (?:my|the) bed|go to (?:my )?bed and sleep)\b/, () => { if (night && dg.places.some((p) => p.kind === 'bed')) found.set('sleep', { act: 'sleep', args: {} }) })
    for (const name of playbookNames()) {
      if (['show_place_to_person', 'gather', 'craft', 'dig_in'].includes(name)) continue
      const nm = name.replace(/_/g, '[ _]')
      fireCued(new RegExp(`\\b(?:pick |use |run |start |do |try |the )?(?:${nm})\\b([^.\\n]{0,60})`), (m) => {
        if (S.src !== 'now' && (STATUS_AFTER.test(m[1] ?? '') || STATUS_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index)))) return   // status talk, not a decision
        const args = {}; let x; const re = /\b([a-z_]+)\s*=\s*("?)([A-Za-z0-9_-]+)\2/gi
        while ((x = re.exec(m[1] ?? ''))) args[x[1].toLowerCase()] = /^\d+$/.test(x[3]) ? Number(x[3]) : x[3].toLowerCase()
        if (dg.playbook?.name === name) return   // already running: do not restart it
        if (name === 'sleep_at_night' && !(night && (bed || hasBedItem))) return
        if (name === 'go_home' && !dg.places.some((p) => p.kind === 'home')) return
        if (name === 'build_shelter') { found.set('shelter', SHELTER); return }
        found.set('pb:' + name, pbHit(name, args))
      })
    }
    fireCued(/\b(?:explore|head|walk|go|travel)\s+(?:out\s+|off\s+)?(?:to the |towards? the |toward |to |and explore )?(north|south|east|west|northeast|northwest|southeast|southwest)\b(?!\s*(?:(?:to|toward|towards|back to)\s+(?:my |the )?(?:home|bed|base|shelter|house|\w+_base)\b|and (?:then )?(?:back|home)\b))/, (m) => { if (!found.has('pb:explore_and_return')) found.set('pb:explore_and_return', pbHit('explore_and_return', { direction: m[1].toLowerCase() })) })
    for (const pl of dg.places) {
      if (pl.kind === 'bed') continue
      const nm = pl.id.replace(/[_ ]+/g, '[ _]').replace(/[^\w\[\] ]/g, '')
      fireCued(new RegExp(`\\b(?:go(?:ing)?|walk(?:ing)?|head(?:ing)?|return(?:ing)?|get(?:ting)?|travel(?:ing)?|run(?:ning)?|move|make my way)\\s+(?:right\\s+|straight\\s+)?(?:back\\s+|over\\s+)?(?:(?:north|south|east|west)(?:east|west)?\\s+)?(?:to|toward|towards|for)\\s+(?:the\\s+|my\\s+)?${nm}\\b`), () => {
        if (Number.isFinite(pl.dist) && pl.dist <= 4) return
        if (pl.kind === 'home') { if (dg.playbook?.name !== 'go_home') found.set('pb:go_home', pbHit('go_home')) } else found.set('place:' + pl.id, { goal: { type: 'go_to_place', target: pl.id, text: `walk to ${pl.id}` } })
      })
    }
    fireCued(/\b(?:go(?:ing)? (?:to|back to|over to)|get(?:ting)? to|head(?:ing)? (?:to|for|back to)|walk(?:ing)?(?: over)? to|return(?:ing)? to|back to|make my way to|approach(?:ing)?)\s+(?:my |the |a )?(?:own )?bed\b/, () => {
      if (night && (bed || hasBedItem)) found.set('pb:sleep_at_night', pbHit('sleep_at_night'))
      else if (bedNear) found.set('wait', { act: 'idle_activity', args: { kind: 'rest', seconds: waitSeconds(text) } })
      else if (bed && bed.id) found.set('bedwalk', { goal: { type: 'go_to_place', target: bed.id, text: 'walk to my bed' } })
    })
    fire(/\b(?:go to sleep|get some sleep|sleep through the night|sleep now|sleep tonight|sleep until (?:morning|dawn)|(?:to|should|will|'ll|must|need to|let me|gonna) sleep)\b/, () => { if (night && (bed || hasBedItem)) found.set('pb:sleep_at_night', pbHit('sleep_at_night')) })
    if (!PAST_SENT.test(text) || S.src === 'now') for (const re of WAIT_RX) (re === WAIT_RX[3] ? fire : fireCued)(re, () => { if (!found.has('wait')) found.set('wait', { act: 'idle_activity', args: { kind: 'rest', seconds: waitSeconds(text) } }) })
    if (found.has('sleep') && found.has('pb:sleep_at_night')) { if (bed && bed.dist > 4) found.delete('sleep'); else found.delete('pb:sleep_at_night') }
    if (found.has('pb:sleep_at_night') && found.has('bedwalk')) found.delete('bedwalk')
    if (CONTINGENT.test(text)) found.clear()   // a fallback plan is not the decision
    perSent.push({ src: S.src, idx, found, text, pos, later: LATER.test(text), alt: S.src !== 'now' && ALT.test(text) })
  })
  const all = new Map(); for (const p of perSent) for (const [k, v] of p.found) if (!all.has(k)) all.set(k, v)
  // honest none: the body is already doing the right thing and she says so
  const fullText = sents.map((s) => s.t).join(' ')
  const wantsContinue = CONTINUE_RX.test(fullText)
  const bodyBusy = ['running', 'paused'].includes(dg.playbook?.status) || /confined and cannot move|escape ladder/i.test(JSON.stringify([dg.events, dg.failures, dg.objective, dg.activity])) || (wantsContinue && dg.activity?.status === 'running')
  const critical = dg.health <= 6 || dg.nearby.some((n) => n.cat === 'hostile' && n.dist <= 16)
  const finish = (kinds, why) => ({ hit: all.get(kinds[0]), kinds, why, from: perSent.find((p) => p.found.has(kinds[0]))?.text.slice(0, 140) })
  let daylightIdle = false
  const drop = (k) => all.delete(k)
  if (all.has('wait') && (critical || bodyBusy)) drop('wait')
  // GOAL3: waiting by the bed in daylight is not a default: one short rest is fine, a second one in a row (full health, > 1 min to dusk) is not
  if (all.has('wait') && dg.health >= 20 && !night) { const d = daylightInfo(dg); const restedBefore = (dg.recent_intents ?? []).slice(-3).filter((r) => r.goal === 'idle_activity' && ['rest', 'sit'].includes(r.args?.kind)).length; if (restedBefore >= 1 && !(d && d.minToDusk <= 1)) { drop('wait'); daylightIdle = true } }
  // the body is climbing out of a trap: only eating or sealing in may be started, never a walk
  const escaping = /confined and cannot move|escape ladder/i.test(JSON.stringify([dg.events, dg.failures, dg.objective, dg.activity]))
  if (escaping) for (const k of [...all.keys()]) if (!/^eat:/.test(k)) drop(k)
  // 1. explicit menu choice ("I'll go with 2")
  const menuLines = menu ?? (dg.playbook ? [] : activityMenu(dg).split('\n').slice(1).filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\.\s*/, '')))
  if (menuLines.length) {
    let pick = null
    for (const p of perSent) { const m = PREF_RX.exec(p.text); if (m && !NEG.test(p.text.slice(Math.max(0, m.index - 28), m.index))) pick = NUMW[m[1].toLowerCase()] ?? Number(m[1]) }
    if (pick && pick >= 1 && pick <= menuLines.length) { const h = menuHit(menuLines[pick - 1]); if (h) return { hit: h, kinds: ['menu:' + pick], why: 'menu_choice' } }
  }
  // a kind named only inside an either/or sentence is an open question, not a choice
  const altDropped = []
  for (const k of [...all.keys()]) if (!perSent.some((p) => p.found.has(k) && !p.alt)) { all.delete(k); altDropped.push(k) }
  if ([...all.keys()].some((k) => k.startsWith('eat:'))) all.delete('pb:get_food')   // get_food would eat what she holds anyway
  // sentences about 'later' do not decide what to do now when something else was named
  if (perSent.some((p) => !p.later && p.found.size)) for (const p of perSent) if (p.later) for (const k of p.found.keys()) if (![...perSent].some((q) => !q.later && q.found.has(k))) all.delete(k)
  const kinds = [...all.keys()]
  const groups = new Set(kinds.map((k) => k.split(':')[0]))
  if (kinds.length === 1) return finish(kinds, 'single')
  if (groups.size === 1 && groups.has('eat')) return finish(kinds, 'eat_first')
  if (kinds.length > 1) {
    // 2. the NOW line is what she wrote down as her choice
    const noWait = (ks) => (ks.length > 1 ? ks.filter((k) => k !== 'wait') : ks)
    const seqPick = (p, ks) => (ks.length > 1 && (p.src === 'now' || SEQ.test(p.text)) ? [ks.reduce((a, b) => ((p.pos.get(b) ?? 0) < (p.pos.get(a) ?? 0) ? b : a))] : ks)
    const nowKs = perSent.filter((p) => p.src === 'now')
    if (nowKs.length === 1) { const ks = seqPick(nowKs[0], noWait([...nowKs[0].found.keys()].filter((k) => all.has(k)))); if (ks.length === 1) return finish(ks, 'now_line') }
    const nowK = noWait([...new Set(perSent.filter((p) => p.src === 'now').flatMap((p) => [...p.found.keys()]))].filter((k) => all.has(k)))
    if (nowK.length === 1) return finish(nowK, 'now_line')
    // 3. the last committed sentence names exactly one thing and is not a hedge
    for (let i = perSent.length - 1; i >= 0; i--) {
      const p = perSent[i], ks = seqPick(p, noWait([...p.found.keys()].filter((k) => all.has(k))))
      if (!ks.length) continue
      if (ks.length === 1 && STRONG.test(p.text) && !HEDGE.test(p.text)) return finish(ks, 'last_committed')
      break
    }
    // a wait loses against a real action when both were named (the action brings her where the wait would happen)
    if (all.has('wait')) { const rest = kinds.filter((k) => k !== 'wait'); if (rest.length === 1) return finish(rest, 'action_over_wait') }
    return { ambiguous: kinds }
  }
  if (altDropped.length > 1) return { ambiguous: altDropped }
  return { none: true, why: daylightIdle ? 'daylight_idle' : altDropped.length ? 'alternatives' : wantsContinue || bodyBusy ? 'body_continues' : 'no_option' }
}

/** does THINK/SAY talk about doing something (so a silent {act:none} is probably a lost action)? */
export const MENTIONS_ACTION = /\b(?:i (?:will|should|need to|must|can|could|have to|'ll)|let me|i'm going to|going to|maybe i|then i)\b[^.]{0,60}\b(?:eat|cook|dig|build|shelter|sleep|flee|run|fight|hunt|go home|go to|walk|stop moving|stay)\b/i

// FOOD2: feasibility of {act:cook} from the inventory (fuel plus a furnace item or 8 cobble to craft one), the 'eat <raw cookable>' -> cook mapping and the short action re-prompt.
const sumInv = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
export function cookFeasible(dg) {
  const inv = dg.inventory ?? {}
  if (!Object.keys(inv).some((k) => COOKABLE[k] && inv[k] > 0)) return false
  const fuel = sumInv(inv, /^(coal|charcoal)$/) * 8 + sumInv(inv, /(_planks|_log)$/) * 1.5
  return fuel >= 1 && (sumInv(inv, /^furnace$/) > 0 || sumInv(inv, /^(cobblestone|cobbled_deepslate|blackstone)$/) >= 8)
}
/** {act:eat,args:{item:kelp}} rejected only for item_not_edible, item is raw-cookable and cooking is feasible -> {parsed: cook, item, note}; else null. */
export function eatToCook(parsed, dg, v) {
  if (!parsed || parsed.act !== 'eat' || v?.ok) return null
  const errs = v?.errors ?? []
  if (!errs.length || !errs.every((e) => e.code === 'item_not_edible')) return null
  const item = parsed.args?.item
  if (!COOKABLE[item] || !cookFeasible(dg)) return null
  return { item, parsed: { ...parsed, act: 'cook', args: {}, errors: [] }, note: `You answered eat ${item}, but raw ${item} is not food; your body is cooking it into ${COOKABLE[item]} instead (cook {}). Eat ${COOKABLE[item]} when it is done.` }
}
export function reactionMsg(dg) {
  const ex = cookFeasible(dg) ? '{act:cook,args:{}}' : (dg.nearby ?? []).find((n) => n.cat === 'hostile') ? `{act:flee,args:{from:${dg.nearby.find((n) => n.cat === 'hostile').id}}}` : '{act:idle_activity,args:{kind:rest}}'
  return `Line 1 of your last answer was {act:none}. Words do nothing. Answer again with a real action in line 1, for example ${ex} then a line --- then one sentence. ${Object.keys(dg.inventory ?? {}).some((k) => COOKABLE[k]) ? 'Raw items such as kelp cannot be eaten: use cook.' : ''}`.trim()
}
