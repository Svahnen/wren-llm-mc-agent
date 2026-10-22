// GOAL3: menu pieces about time and routines (kept apart from menu.js).
import { daylightInfo, TICKS_PER_MIN } from './daylight.js'
import { farmIdea } from './menu-farm1.js'
const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
/** is sleeping possible/sensible now? -> {ok, why}. Unknown tick = old behaviour (phase). Allowed from ~1 min before dusk. */
export function sleepNow(dg) {
  const night = dg.time.phase === 'night' || dg.thunder
  if (night) return { ok: true }
  const d = daylightInfo(dg)
  if (!d) return { ok: false, why: 'it is day' }
  if (d.night || (d.ticks >= 12542 - TICKS_PER_MIN)) return { ok: true }
  return { ok: false, why: `not night yet: dusk in ${d.minToDusk} min, use the daylight` }
}
/** feasible daytime projects (names only; she chooses or invents her own) */
export function projectOptions(dg) {
  const inv = dg.inventory ?? {}, o = []
  o.push('gather (wood, stone, coal, iron, ...)')
  if (!cnt(inv, /^(stone|iron|diamond)_pickaxe$/)) o.push('make tools')
  if (cnt(inv, /^[a-z_]+_(planks|log)$|^(cobblestone|dirt|stone)$/) >= 57) o.push('build a hut'); else o.push('collect materials to build')
  if (dg.time.phase !== 'night') o.push('explore')
  { const f = farmIdea(dg); if (f) o.push(f) }   // FARM1: offered, never set
  const person = dg.players?.[0]; if (person) o.push(`show ${person.name} something`)
  return o
}
