// SURV1: critical-state facts for S2. Pure functions of the normalized digest (no I/O, no LLM).
// The body states WHAT is physically possible right now, ranked by how fast S1 can carry it out; S2 still chooses.
import { EDIBLE, RISKY_FOOD, EMERGENCY_FOOD, FOOD_PTS, COOKABLE } from './contract.js'

export const CRIT_HP = 6, CRIT_FOOD = 6, REGEN_FOOD = 18
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|kelp)$/
const PLACEABLE = /^(cobblestone|cobbled_deepslate|dirt|coarse_dirt|stone|andesite|diorite|granite|deepslate|tuff|netherrack|[a-z_]+_planks)$/
const FUEL = /^(coal|charcoal|[a-z_]+_planks|[a-z_]+_log)$/

/** hp shown with one decimal below 10 and never as 0 while alive */
export function fmtHp(h) {
  if (!Number.isFinite(h)) return '?'
  if (h <= 0) return '0'
  if (h < 10) return String(Math.max(0.1, Math.round(h * 10) / 10))
  return String(Math.round(h))
}
// PB1: low food is critical only where it can hurt: Hard (or unknown difficulty), or when she is already hurt. On Easy/Normal hunger cannot kill her.
export const foodCritical = (dg) => dg.food <= CRIT_FOOD && (dg.difficulty === 'hard' || !dg.difficulty || dg.health < 10)
export const isCritical = (dg) => dg.health <= CRIT_HP || foodCritical(dg)

const cnt = (dg, re) => Object.entries(dg.inventory).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
const foodItems = (dg, risky) => Object.entries(dg.inventory).filter(([k, n]) => n > 0 && (EDIBLE.has(k) || (risky && EMERGENCY_FOOD.has(k)))).map(([k, n]) => ({ k, n, pts: FOOD_PTS[k] ?? 2 }))

/** Ranked means of survival that are possible with what she holds and knows. Each: {key, secs (rough time to take effect), text, line (how to ask for it)} */
export function survivalOptions(dg) {
  const out = []
  const hostiles = dg.nearby.filter((n) => n.cat === 'hostile' && Number.isFinite(n.dist)).sort((a, b) => a.dist - b.dist)
  const night = dg.time.phase === 'night' || dg.thunder
  const needRegen = dg.health < 20 && dg.food < REGEN_FOOD
  // 1. eat: safe foods first; risky ones count when the body needs them
  const riskyOk = dg.food <= CRIT_FOOD || needRegen
  const safe = foodItems(dg, false).sort((a, b) => b.pts - a.pts)
  const risky = riskyOk ? foodItems(dg, true).filter((f) => RISKY_FOOD.has(f.k)) : []
  const eatable = [...safe, ...risky]
  if (eatable.length && dg.food < 20) {
    const total = eatable.reduce((s, f) => s + f.n * f.pts, 0)
    const first = eatable[0]
    const note = RISKY_FOOD.has(first.k) ? ' (it can make you sick with hunger for a while, but it still fills the stomach)' : ''
    out.push({ key: 'eat', secs: 2, text: `eat what you hold: ${eatable.map((f) => `${f.k} x${f.n}`).join(', ')} (about +${Math.min(total, 20)} food in all)${note}. Natural healing only happens while food is ${REGEN_FOOD} or more; at food ${dg.food} your health does not come back`, line: `{act:eat,args:{item:${first.k}}}` })
  }
  // 2. emergency shelter: blocks around you (about 10 s), no walking
  const blocks = Object.entries(dg.inventory).filter(([k]) => PLACEABLE.test(k)).reduce((s, [, n]) => s + n, 0)
  const digTool = cnt(dg, /_(pickaxe|shovel)$/) > 0
  if (blocks >= 6 || (digTool && blocks >= 1)) out.push({ key: 'dig_in', secs: 10, text: `seal yourself into a 1x1 hole right where you stand (${blocks} placeable blocks${digTool ? ', and a digging tool' : ''}); arrows and zombies cannot reach you inside, you can eat and heal there`, line: '{type:build_shelter}  with  intent: dig in here now' })
  // 3. bed / home
  const bed = dg.places.find((p) => p.kind === 'bed' && Number.isFinite(p.dist))
  const home = dg.places.find((p) => p.kind === 'home' && Number.isFinite(p.dist))
  if (night && bed && bed.dist <= 40) out.push({ key: 'sleep', secs: Math.round(bed.dist / 4) + 5, text: `sleep in your bed (${bed.id}, ${bed.dist} m ${bed.dir ?? ''}); it is night`.replace('  ', ' '), line: '{act:sleep,args:{}}' })
  const refuge = bed ?? home
  if (refuge) {
    const far = refuge.dist > 100
    const nightWalk = night && dg.health <= CRIT_HP && refuge.dist > 40   // FOOD1: hurt at night, a long walk is the dangerous part
    out.push({ key: 'go_refuge', secs: Math.round(refuge.dist / 4), text: `walk to ${refuge.id} (${refuge.dist} m ${refuge.dir ?? ''})${nightWalk ? ': at night and hurt this is a long way in the dark; staying in cover and healing first is safer unless you decide you must' : ''}${far ? ': that is far, ' + (hostiles.length ? 'with hostile mobs around you would be on foot a long time' : 'a long walk') : ''}`, line: `{act:go_to,args:{place:${refuge.id}}}` })
  }
  // 4. cook
  const raw = cnt(dg, RAW), fuel = cnt(dg, FUEL)
  if (raw > 0 && fuel > 0 && !(hostiles[0] && hostiles[0].dist < 12)) out.push({ key: 'cook', secs: 60, text: `cook your raw food (${raw} pieces: ${Object.entries(dg.inventory).filter(([k, n]) => n > 0 && RAW.test(k)).map(([k, n]) => `${k} x${n} -> ${COOKABLE[k]}`).join(', ')}); cooked gives more food`, line: '{act:cook,args:{}}' })
  // 5. get away from the shooter
  if (hostiles[0] && hostiles[0].dist <= 20 && dg.health <= CRIT_HP) out.push({ key: 'flee', secs: 15, text: `run away from ${hostiles[0].id} (${hostiles[0].dist} m)`, line: `{act:flee,args:{from:${hostiles[0].id}}}` })
  return out.sort((a, b) => a.secs - b.secs).map((o, i) => ({ ...o, rank: i + 1 }))
}

/** Text block for the S2 prompt, or '' when she is not in a critical state. */
export function renderCritical(dg) {
  if (!isCritical(dg)) return ''
  const L = []
  const why = []
  if (dg.health <= CRIT_HP) why.push(`health ${fmtHp(dg.health)}/20 (${dg.health < 3 ? 'one hit from a skeleton or zombie can kill you' : 'you are close to death'})`)
  if (foodCritical(dg)) why.push(`food ${Math.round(dg.food)}/20 (low: you do not heal and cannot sprint${dg.difficulty === 'hard' ? '; at 0 hunger damage can kill you on Hard' : '; hunger itself cannot kill you here, but you are hurt'})`)
  L.push(`CRITICAL STATE: ${why.join('; ')}.`)
  const opts = survivalOptions(dg)
  if (opts.length) {
    L.push('Ways to survive that are possible right now with what you hold and know, fastest first (you choose; each line shows how to ask for it):')
    for (const o of opts) L.push(`${o.rank}. ${o.text}  ->  ${o.line}`)
  } else L.push('Nothing in your pack or known places can be used right away to heal or hide; hunting, fleeing and finding blocks to build with are what is left.')
  L.push('Words in THINK or SAY do nothing: only the header line (line 1) makes your body act.')
  return L.join('\n')
}
