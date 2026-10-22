// Typed arg validation against skills.json. No dependencies; safe for brain/ to import:
//   import { SKILL_NAMES, validateArgs } from '../bot/src/skills/schema.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills.json')
export const REGISTRY = JSON.parse(fs.readFileSync(FILE, 'utf8'))
export const SKILLS = REGISTRY.skills
export const SKILL_NAMES = Object.keys(SKILLS)

/** @returns {{ok:true,args:object}|{ok:false,errors:string[],valid?:string[]}} defaults filled, unknown args rejected, ints coerced only from integers. */
export function validateArgs(name, args = {}) {
  const spec = SKILLS[name]
  if (!spec) return { ok: false, errors: [`unknown skill "${name}"`], valid: SKILL_NAMES }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, errors: ['args must be an object'] }
  const errors = []
  const out = {}
  for (const k of Object.keys(args)) if (!(k in spec.args)) errors.push(`unknown arg "${k}" (valid: ${Object.keys(spec.args).join(', ') || 'none'})`)
  for (const [k, a] of Object.entries(spec.args)) {
    let v = args[k]
    if (v === undefined || v === null) {
      if (a.required) errors.push(`missing arg "${k}"`)
      else if (a.default !== undefined) out[k] = a.default
      continue
    }
    switch (a.type) {
      case 'int': if (!Number.isInteger(v)) { errors.push(`${k} must be an integer`); continue } break
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${k} must be a number`); continue } break
      case 'bool': if (typeof v !== 'boolean') { errors.push(`${k} must be boolean`); continue } break
      case 'enum': if (!a.values.includes(v)) { errors.push(`${k} must be one of ${a.values.join('|')}`); continue } break
      case 'string': case 'ref': case 'item':
        if (typeof v !== 'string' || !v.length || v.length > 64 || !/^[\w .:@-]+$/.test(v)) { errors.push(`${k} must be a short id string`); continue }
        break
      default: errors.push(`${k}: bad schema type`); continue
    }
    if ((a.type === 'int' || a.type === 'number') && ((a.min !== undefined && v < a.min) || (a.max !== undefined && v > a.max))) { errors.push(`${k} out of range ${a.min}..${a.max}`); continue }
    out[k] = v
  }
  return errors.length ? { ok: false, errors } : { ok: true, args: out }
}
