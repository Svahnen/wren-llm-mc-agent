// S1G: the goal layer of the S2 <-> S1 contract. System 2 states WHAT she wants (`intent:` in her own words + a goal TYPE from a
// small extensible set + target + modulators); System 1 selects the concrete skills (bot/src/s1/). Pure functions, no I/O.
import { getPlaybook, parsePlaybookTarget, resolveParams, playbooksText } from '../bot/src/playbooks/catalog.js'
// Everything here is vocabulary and validation of NAMES; no behavioural outcome is encoded (what to do about a goal stays with S2, how to
// reach it with S1's selector).

/** target kinds: 'player' (an id of a player), 'place' (a known place id or "x,y,z"), 'entity' (nearby creature id), 'resource' (word), 'any' (free text), null = no target.
 *  `needs`: the target is required. Add a type with registerGoalType(); unknown names an answer uses fall back to `custom` with a warning. */
export const GOAL_TYPES = {
  follow_person: { desc: 'stay with a person and go where they go', target: 'player', needs: true },
  go_to_place: { desc: 'travel to a known place (a name from your places list) or to coordinates x,y,z', target: 'place', needs: true },
  get_food: { desc: 'get something to eat (eat, hunt, gather or look for food)', target: 'any', needs: false },
  find_resource: { desc: 'look for and collect a material (wood, stone, coal, iron, sand, dirt, plants)', target: 'resource', needs: false },
  build_shelter: { desc: 'make yourself a safe enclosed place', target: null, needs: false },
  explore_area: { desc: 'go and see somewhere new (target may be a direction or a place)', target: 'any', needs: false },
  rest: { desc: 'recover energy and health (sleep, sit, stay safe)', target: null, needs: false },
  talk: { desc: 'give your attention to a person or creature and speak with them', target: 'any', needs: false },
  defend: { desc: 'protect yourself or someone from a threat', target: 'any', needs: false },
  avoid: { desc: 'get away from and stay away from something', target: 'any', needs: false },
  playbook: { desc: 'run a ready-made step-by-step procedure (the body does the steps, retries, and picks up again after interruptions); target = playbook name plus its parameters, see the playbook list', target: 'any', needs: true },
  custom: { desc: 'something else, described only in your intent line', target: 'any', needs: false },
}
export const RESOURCES = ['wood', 'stone', 'coal', 'iron', 'sand', 'dirt', 'plants']
export function registerGoalType(name, spec = {}) {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(name)) throw new Error('bad goal type name')
  GOAL_TYPES[name] = { desc: spec.desc ?? name, target: spec.target ?? 'any', needs: !!spec.needs }
  return GOAL_TYPES[name]
}
export const goalTypeNames = () => Object.keys(GOAL_TYPES)
export const normType = (s) => String(s ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')

export function goalTypesText() {
  return Object.entries(GOAL_TYPES).map(([n, s]) => `- ${n}${s.target ? ` (target: ${s.target === 'player' ? 'a player name' : s.target === 'place' ? 'a place name or x,y,z' : s.target === 'resource' ? RESOURCES.join('|') : s.target === 'entity' ? 'a creature id' : 'optional'}${s.needs ? ', required' : ''})` : ''}: ${s.desc}`).join('\n')
}

/** stable 32-bit FNV-1a hash of the intent text, hex. Used as the (anonymous) goal feature in S1 decision logs. */
export function textHash(s) { let h = 2166136261; for (const c of String(s ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16) }

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
/** Minecraft axes: north = -z, east = +x, south = +z, west = -x. (dx,dz) is the vector TO the thing. */
export function compass8(dx, dz) {
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9)) return null
  const a = (Math.atan2(dx, -dz) * 180) / Math.PI
  return COMPASS[((Math.round(a / 45) % 8) + 8) % 8]
}
/** F3-style facing from a mineflayer look vector or from a Notchian yaw in degrees. */
export function facingFromYawDeg(yawDeg) {
  const y = (((yawDeg + 180) % 360) + 360) % 360 - 180
  const rad = (y * Math.PI) / 180 // Notchian: 0 = south (+z), 90 = west (-x)
  return { yaw: +y.toFixed(1), compass: compass8(-Math.sin(rad), Math.cos(rad)) }
}
/** Minecraft ticks of day (0 = 06:00) -> "HH:MM". */
export function clockFromTicks(ticks) {
  if (!Number.isFinite(ticks)) return null
  const t = ((Math.floor(ticks) % 24000) + 24000) % 24000
  const mins = Math.floor((t / 1000) * 60 + 6 * 60) % 1440
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------- places (LLM-authored names)
export function placeName(s) {
  return String(s ?? '').toLowerCase().trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
}
const RESERVED_PLACE = /^(?:player|hazard|none|self|me|you|north|south|east|west|any)$/
export function parseRemember(v) {
  const s = String(v ?? '').trim(); if (!s) return null
  const m = /^"?([^"—–:;,(]+?)"?\s*(?:[—–:;,(]|\s-\s)\s*(.*?)\)?\s*$/.exec(s)
  const name = placeName(m ? m[1] : s), note = (m ? m[2] : '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return name && !RESERVED_PLACE.test(name) ? { op: 'remember', name, note } : null
}
export function parseRename(v) {
  const m = /^\s*"?(.+?)"?\s*(?:->|=>|→|\bto\b|\binto\b)\s*"?(.+?)"?\s*$/i.exec(String(v ?? ''))
  if (!m) return null
  const from = placeName(m[1]), to = placeName(m[2])
  return from && to && from !== to && !RESERVED_PLACE.test(to) ? { op: 'rename', name: from, to } : null
}
/** meta.remember/forget/rename may be string or string[]. Returns up to 3 well-formed ops; unknown forget/rename names (vs `known` ids) are reported, not dropped silently. */
export function parsePlaceOps(meta = {}, known = null) {
  const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x])
  const ops = [], notes = []
  for (const v of arr(meta.remember)) { const o = parseRemember(v); if (o) ops.push(o); else notes.push(`remember: could not read a place name from "${String(v).slice(0, 40)}"`) }
  for (const v of arr(meta.forget)) { const n = placeName(v); if (n) ops.push({ op: 'forget', name: n }) }
  for (const v of arr(meta.rename)) { const o = parseRename(v); if (o) ops.push(o); else notes.push(`rename: use "old -> new"`) }
  const ok = []
  for (const o of ops) {
    if (ok.length >= 3) break
    if (known && (o.op === 'forget' || o.op === 'rename') && !known.has(o.name)) { notes.push(`${o.op}: you have no place called "${o.name}"`); continue }
    if (known && o.op === 'rename' && known.has(o.to)) { notes.push(`rename: "${o.to}" already exists`); continue }
    ok.push(o)
  }
  return { ops: ok, notes }
}

/** "x,y,z" | "x z" | "x,z" -> {x,y,z|null} or null */
export function parseCoords(s) {
  const m = /^\s*\(?\s*(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)(?:[\s,;]+(-?\d+(?:\.\d+)?))?\s*\)?\s*$/.exec(String(s ?? ''))
  if (!m) return null
  return m[3] === undefined ? { x: Math.round(+m[1]), y: null, z: Math.round(+m[2]) } : { x: Math.round(+m[1]), y: Math.round(+m[2]), z: Math.round(+m[3]) }
}

/** Validate a goal spec {type, target, text} against the digest index. -> {goal, errors, warnings}. Only NAMES and referents are checked. */
export function checkGoal(g, dg, idx) {
  const errors = [], warnings = []
  let type = normType(g.type) || 'custom'
  let tgtIn = g.target
  // PB1: the playbook's own name used as the type ({type:show_place_to_person,target:...}) is accepted as that playbook
  if (type !== 'playbook' && !GOAL_TYPES[type] && getPlaybook(type)) { tgtIn = `${type} ${g.target ?? ''}`.trim(); type = 'playbook'; warnings.push({ code: 'playbook_type_inferred', msg: `"${g.type}" is a playbook; run it with type:playbook` }) }
  if (!GOAL_TYPES[type]) { warnings.push({ code: 'goal_type_unknown', msg: `"${g.type}" is not a goal type; treated as custom (types: ${goalTypeNames().join(', ')})` }); type = 'custom' }
  if (type === 'playbook') {
    const pb = parsePlaybookTarget(tgtIn)
    const def = pb && getPlaybook(pb.name)
    if (!def) return { goal: { type, target: null, text: String(g.text ?? '').trim().slice(0, 240) }, errors: [{ code: 'playbook_unknown', msg: `playbook.target: "${String(tgtIn ?? '').slice(0, 40)}" is not a playbook; playbooks:\n${playbooksText()}` }], warnings }
    const players = [...idx.entries()].filter(([, v]) => v.kind === 'player').map(([k]) => k)
    const rp = resolveParams(def, pb.args, { players, places: (dg.places ?? []).map((p) => p.id) })
    for (const m of rp.errors) errors.push({ code: 'playbook_args', msg: `playbook.target: ${m}` })
    for (const m of rp.warnings) warnings.push({ code: 'playbook_arg_unknown', msg: m })
    const tgt = `${def.name} ${Object.entries(rp.params).map(([k, v]) => `${k}=${/[\s,]/.test(String(v)) ? '"' + v + '"' : v}`).join(' ')}`.trim()
    return { goal: { type, target: tgt.slice(0, 120), text: String(g.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) }, errors, warnings }
  }
  const spec = GOAL_TYPES[type]
  let target = g.target === undefined || g.target === null || String(g.target).trim() === '' || /^(none|null|nothing|-)$/i.test(String(g.target).trim()) ? null : String(g.target).trim()
  const bad = (code, msg) => errors.push({ code, msg: `${type}.target: ${msg}` })
  if (spec.needs && !target) bad('goal_target_missing', `${type} needs a target (${spec.target === 'player' ? 'a player name from the state' : 'a place from your known places, or x,y,z'})`)
  if (target) {
    const r = idx.get(target)
    if (spec.target === 'player') {
      const pn = [...idx.entries()].filter(([, v]) => v.kind === 'player').map(([k]) => k)
      if (!r || r.kind !== 'player') bad('id_unknown', `"${target}" is not a player in the current state; players: ${pn.join(', ') || 'none online'}`)
    } else if (spec.target === 'place') {
      const c = parseCoords(target)
      const pn = dg.places.map((p) => p.id)
      if (c) target = `${c.x},${c.y ?? Math.round(dg.pos[1])},${c.z}`
      else if (!r || r.kind !== 'place') {
        const alt = pn.find((n) => n.toLowerCase() === target.toLowerCase())
        if (alt) target = alt
        else bad('id_unknown', `"${target}" is not a known place; places: ${pn.join(', ') || 'none yet (use x,y,z)'}`)
      }
    } else if (spec.target === 'resource') {
      const w = target.toLowerCase().replace(/^(?:some|the)\s+/, '')
      const hit = RESOURCES.find((x) => w === x || w === x + 's' || w.startsWith(x)) ?? (/log|tree|oak|birch/.test(w) ? 'wood' : /cobble|rock/.test(w) ? 'stone' : null)
      if (hit) target = hit; else warnings.push({ code: 'resource_unknown', msg: `"${target}" is not a resource S1 can collect (${RESOURCES.join(', ')}); passed on as text` })
    }
    target = target && target.slice(0, 60)
  }
  return { goal: { type, target, text: String(g.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) }, errors, warnings }
}

// ---------------------------------------------------------------- speech hygiene (live defect: "serve: G2" was spoken aloud)
const DROP_LABELS = 'serves?|goal|why|plan|done|abandon|note|horizon|value|importance|urgency|caution|sociability|intent|type|target|remember|forget|rename|think|mutter|chat|act|args'
const DROP_RE = new RegExp(`^\\s*(?:\\*\\*)?(?:${DROP_LABELS})(?:\\*\\*)?\\s*:`, 'i')
/** Strip every structured contract token from text that may reach voice or chat: {act:..} headers, --- delimiters, labelled lines/sentences
 *  (serve:, goal:, plan:, done:, abandon:, intent:, remember:, THINK:, MUTTER:, CHAT: ...), a leading SAY: label. A line that is only a goal id (G2, G2.1) is dropped. */
export function cleanSpeech(text) {
  let s = String(text ?? '').replace(/\{\s*act\s*:[^}]*(?:\{[^}]*\}[^}]*)?\}/gi, ' ').replace(/(?:^|\s)(?:-{3,}|[—–]{2,}|\*{3,})(?=\s|$)/g, ' ')
  const parts = s.split(/\n+|(?<=[.!?…])\s+/)
  const keep = []
  for (let p of parts) {
    p = p.replace(/^\s*(?:\*\*)?say(?:\*\*)?\s*:\s*/i, '').trim()
    if (!p || DROP_RE.test(p) || /^(?:G\d+(?:\.\d+)?[\s,;.]*)+$/i.test(p) || /^[^\p{L}\p{N}]+$/u.test(p)) continue
    keep.push(p)
  }
  return keep.join(' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- means: what she holds and what it is good for, in plain words (perception, no advice)
const RAW_FOOD = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
export function describeItem(name, n = 1) {
  const x = `${name.replace(/_/g, ' ')}${n > 1 ? ' x' + n : ''}`
  if (/_sword$/.test(name)) return `${x}: weapon (melee)`
  if (name === 'bow' || name === 'crossbow') return `${x}: ranged weapon (needs arrows)`
  if (/_(pickaxe|axe|shovel|hoe)$/.test(name)) return `${x}: tool (${name.endsWith('pickaxe') ? 'mines stone and ore' : name.endsWith('_axe') ? 'chops wood' : name.endsWith('shovel') ? 'digs dirt and sand' : 'tills soil'}; an axe is also a weak weapon)`
  if (name === 'fishing_rod') return `${x}: tool (fishing, needs water)`
  if (RAW_FOOD.test(name)) return `${x}: food (raw; cooking in a furnace gives more)`
  if (/^(cooked_|bread$|apple$|golden_apple$|carrot$|baked_potato$|potato$|melon_slice$|sweet_berries$|cookie$|pumpkin_pie$|beetroot$|dried_kelp$|mushroom_stew$)/.test(name)) return `${x}: food`
  if (/_bed$/.test(name)) return `${x}: bed (sleep at night)`
  if (name === 'torch') return `${x}: light`
  if (/^(cobblestone|dirt|stone|oak_planks|planks)$|_planks$/.test(name)) return `${x}: building block`
  if (/_log$/.test(name)) return `${x}: wood`
  return null
}
export function gearNotes(inventory = {}) {
  return Object.entries(inventory).filter(([, n]) => n > 0).map(([k, n]) => describeItem(k, n)).filter(Boolean).slice(0, 14)
}
