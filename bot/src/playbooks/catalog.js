// PB1: playbook catalog (pure, no bot): loads the data files in ./library/*.json, parses S2's `name k=v k=v` target, validates parameters, describes playbooks for the prompt.
// A playbook is DATA: { name, desc, params, commitment?, done_if?, steps:[...] }; a step is { id, desc?, when?, done_if?, ok?, retry?, on_fail?, and one of
//   do:{skill,args} | op:'name' (+args) | choose:[options] (first feasible option that works) , optional loop:{until,max} (repeat until predicates hold) }.
// Predicates and ops live in predicates.js / ops.js; to add an activity, drop a JSON file here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import './ops-goal3.js'   // GOAL3: night_gate op (sleep_at_night ends early in daylight)
import './predicates-pb4.js'   // PB4: side effect only (adds predicates and ops for the activity playbooks)
import './expedition.js'   // EXP1: side effect only (adds the resource_expedition ops)
import './roam.js'   // ROAM1: side effect only (roam, make_camp, new_home ops)
import { derivedRs3 } from './rs3.js'   // RS3: ops and predicates for the survival-strategy playbooks; derivedRs3 adds the computed parameters

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'library')
const RESOURCES = ['wood', 'stone', 'coal', 'iron', 'sand', 'dirt', 'plants']
export const KITS = ['stone_tools', 'torches', 'farm_kit']   // RS3 bootstrap_kit targets
const CRAFTABLE = ['planks', 'stick', 'crafting_table', 'chest', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'torch', 'furnace', 'bed', 'fishing_rod', 'wooden_hoe', 'bread', 'stone_hoe']

let LIB = null
export function loadLibrary(dir = DIR) {
  const lib = new Map()
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const errs = validateDef(def); if (errs.length) throw new Error(`playbook ${f}: ${errs.join('; ')}`)
    lib.set(def.name, def)
  }
  return lib
}
export const library = () => (LIB ??= loadLibrary())
export const getPlaybook = (name) => library().get(String(name ?? '').toLowerCase().replace(/[\s-]+/g, '_'))
export const playbookNames = () => [...library().keys()]

const STEP_KINDS = ['do', 'op', 'choose']
export function validateDef(d) {
  const e = []
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(d?.name ?? '')) e.push('bad name')
  if (!Array.isArray(d?.steps) || !d.steps.length) e.push('no steps')
  const ids = new Set()
  const chk = (s, where) => {
    if (!s.id) e.push(`${where}: step without id`); else if (ids.has(s.id) && where === 'top') e.push(`duplicate id ${s.id}`)
    ids.add(s.id)
    const kinds = STEP_KINDS.filter((k) => s[k] !== undefined)
    if (kinds.length !== 1) e.push(`${s.id}: needs exactly one of do/op/choose`)
    if (s.choose) for (const o of s.choose) chk(o, 'option')
    if (s.do && !s.do.skill) e.push(`${s.id}: do.skill missing`)
  }
  for (const s of d?.steps ?? []) chk(s, 'top')
  return e
}

/** "show_place_to_person person=Alex place=house" | "gather(resource=wood, count=8)" | "gather wood 8" -> {name, args:{}, raw}; null when empty. Values may be quoted. */
export function parsePlaybookTarget(text) {
  let t = String(text ?? '').trim()
  if (/^(["'`]).*\1$/s.test(t) && (t.match(/["'`]/g) ?? []).length === 2) t = t.slice(1, -1)
  if (!t) return null
  const m = /^([A-Za-z][\w-]*)\s*(?:\((.*)\))?\s*(.*)$/s.exec(t)
  if (!m) return null
  const name = m[1].toLowerCase().replace(/-/g, '_')
  const rest = `${m[2] ?? ''} ${m[3] ?? ''}`.trim()
  const args = {}, pos = []
  const re = /([A-Za-z_]\w*)\s*[=:]\s*("([^"]*)"|'([^']*)'|[^\s,;]+)|"([^"]*)"|([^\s,;]+)/g
  let x
  while ((x = re.exec(rest))) { if (x[1]) args[x[1].toLowerCase()] = (x[3] ?? x[4] ?? x[2]).replace(/^["']|["']$/g, ''); else pos.push(x[5] ?? x[6]) }
  const def = getPlaybook(name)
  if (def) { const order = Object.keys(def.params ?? {}).filter((k) => args[k] === undefined); pos.forEach((v, i) => { if (order[i] !== undefined) args[order[i]] = v }) }
  return { name, args }
}

/** validate + normalise params. know = {players:[names], places:[names]} (optional: when absent, names are not checked). -> {ok, params, errors[], warnings[]} */
export function resolveParams(def, args = {}, know = null) {
  const params = {}, errors = [], warnings = []
  for (const [k, spec] of Object.entries(def.params ?? {})) {
    let v = args[k]
    if (v === undefined || v === null || v === '') {
      if (spec.required) { errors.push(`${def.name}.${k} is required (${hint(spec)})`); continue }
      if (spec.default !== undefined) params[k] = spec.default
      continue
    }
    v = String(v).trim()
    switch (spec.kind) {
      case 'int': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) { errors.push(`${def.name}.${k} must be a whole number`); continue } params[k] = Math.min(64, Math.max(1, n)); break }
      case 'sint': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) { errors.push(`${def.name}.${k} must be a whole number`); continue } params[k] = Math.min(320, Math.max(-60, n)); break }   // PB4: signed (a y level)
      case 'resource': { const w = v.toLowerCase().replace(/s$/, ''); const hit = RESOURCES.find((r) => w === r || w.startsWith(r)) ?? (/log|tree|oak|birch/.test(w) ? 'wood' : /cobble|rock/.test(w) ? 'stone' : null); if (!hit) { errors.push(`${def.name}.${k}: "${v}" is not one of ${RESOURCES.join(', ')}`); continue } params[k] = hit; break }
      case 'xres': { const w = v.toLowerCase(); const hit = /^(wood|log|tree|forest|timber)/.test(w) ? 'wood' : /^(stone|cobble|rock|ore|coal|iron)/.test(w) ? 'stone' : /^(food|meat|animal|cow|eat|fish)/.test(w) ? 'food' : /^(any|all|whatever|anything)/.test(w) ? 'any' : null; if (!hit) { errors.push(`${def.name}.${k}: "${v}" is not one of wood, stone, food, any`); continue } params[k] = hit; break }
      case 'dist': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) { errors.push(`${def.name}.${k} must be a whole number`); continue } params[k] = Math.min(400, Math.max(40, n)); break }   // EXP1: metres
      case 'rdist': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) { errors.push(`${def.name}.${k} must be a whole number`); continue } params[k] = Math.min(800, Math.max(60, n)); break }   // ROAM1: metres (multi-day trips)
      case 'minutes': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) { errors.push(`${def.name}.${k} must be a whole number`); continue } params[k] = Math.min(30, Math.max(1, n)); break }   // RS3: a session length
      case 'kit': { const w = v.toLowerCase().replace(/[\s-]+/g, '_'); const hit = KITS.find((q) => w === q || q.startsWith(w) || w.startsWith(q.split('_')[0])); if (!hit) { errors.push(`${def.name}.${k}: "${v}" is not one of ${KITS.join(', ')}`); continue } params[k] = hit; break }
      case 'craftable': { const w = v.toLowerCase().replace(/[\s-]+/g, '_'); if (!CRAFTABLE.includes(w)) { errors.push(`${def.name}.${k}: "${v}" cannot be crafted; use one of ${CRAFTABLE.join(', ')}`); continue } params[k] = w; break }
      case 'player': { if (know?.players && !know.players.some((p) => p.toLowerCase() === v.toLowerCase())) { errors.push(`${def.name}.${k}: "${v}" is not a player online now (online: ${know.players.join(', ') || 'none'})`); continue } params[k] = know?.players?.find((p) => p.toLowerCase() === v.toLowerCase()) ?? v; break }
      case 'place': { const c = /^\s*(-?\d+)[\s,;]+(-?\d+)(?:[\s,;]+(-?\d+))?\s*$/.exec(v); if (c) { params[k] = v; break } const hit = know?.places?.find((p) => p.toLowerCase() === v.toLowerCase()); if (know?.places && !hit) { errors.push(`${def.name}.${k}: "${v}" is not a known place (known: ${know.places.join(', ') || 'none; use x,y,z'})`); continue } params[k] = hit ?? v; break }
      default: params[k] = v.slice(0, 40)
    }
  }
  for (const k of Object.keys(args)) if (!(k in (def.params ?? {}))) warnings.push(`${def.name} has no parameter "${k}"`)
  return { ok: !errors.length, params, errors, warnings }
}
const hint = (s) => (s.kind === 'player' ? 'a player name' : s.kind === 'place' ? 'a known place or x,y,z' : s.kind)

/** params derived from others (not given by S2) */
export function derived(def, params) {
  const out = { ...params }
  if (def.name === 'simple_hut') { const n = params.size ?? 5; out.hut_blocks = 4 * (n - 1) * 2 - 2 + n * n + 2 }   // 2-high walls minus the door gap, roof, door seal (equals build.js PLANS.simple_hut + 2)
  derivedRs3(def, params, out)
  return out
}

/** goal type -> default playbook (S1 uses it when S2 states a goal type without naming a playbook). null = keep the classic selector. */
export function defaultPlaybookFor(spec) {
  switch (spec.type) {
    case 'get_food': return { name: 'get_food', args: {} }
    case 'build_shelter': return { name: 'build_shelter', args: {} }
    case 'find_resource': return RESOURCES.includes(spec.target) ? { name: 'gather', args: { resource: spec.target, count: spec.target === 'wood' ? 4 : 6 } } : null
    default: return null
  }
}

export function playbooksText() {
  return [...library().values()].map((d) => `- ${d.name}${Object.keys(d.params ?? {}).length ? ' ' + Object.entries(d.params).map(([k, s]) => `${k}=<${s.kind === 'player' ? 'player' : s.kind === 'place' ? 'place or x,y,z' : s.kind === 'resource' ? RESOURCES.join('|') : s.kind === 'xres' ? 'wood|stone|food|any' : (s.kind === 'dist' || s.kind === 'rdist') ? 'metres' : s.kind === 'minutes' ? 'minutes' : s.kind === 'kit' ? KITS.join('|') : s.kind === 'craftable' ? 'item' : s.kind}>${s.required ? '' : ' (optional)'}`).join(' ') : ''}: ${d.desc}`).join('\n')
}
