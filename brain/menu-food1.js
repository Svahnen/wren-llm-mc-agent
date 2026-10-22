// FOOD1: the 'recover' plan: hurt (hp <= 6) for more than 2 minutes while safe in cover. Natural healing needs food >= 18, so: eat edible food, else cook raw food
// (furnace + fuel), else wait in cover until day and then get food. At night no long walks (a bed 100 m away is the dangerous part). Pure function of the digest.
import { foodFacts } from './contract.js'
import { daylightInfo } from './daylight.js'
export const RECOVER_HP = 6, RECOVER_AFTER_S = 120, REGEN_FOOD = 18
/** HOME2: the fish skill needs a bank within 16 m. Unknown (older body) counts as possible. */
export const FISH_RANGE_M = 16
export const waterOk = (dg) => dg.water_near_m === undefined || (dg.water_near_m !== null && dg.water_near_m <= FISH_RANGE_M)
/** FOOD4: fishing needs a rod: held, or 2 string + (3 sticks, or 2 planks / 1 log that become sticks). -> { rod, canRod, why } */
export const rodFacts = (inv) => { const c = (re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
  const rod = c(/^fishing_rod$/) > 0, str = c(/^string$/), st = c(/^stick$/), canRod = str >= 2 && (st >= 3 || c(/_planks$/) >= 2 || c(/_log$/) >= 1)
  return { rod, canRod, why: rod || canRod ? '' : str < 2 ? `no fishing rod and ${str} string (a rod is 3 sticks + 2 string; string comes from spiders)` : `no fishing rod: you have ${str} string but ${st} stick${st === 1 ? '' : 's'} (a rod is 3 sticks + 2 string; get wood for sticks first)` } }
const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)

export function recoverMenu(dg) {
  const ok = [], no = []
  const night = dg.time?.phase === 'night' || !!dg.thunder
  const hostile = (dg.nearby ?? []).some((n) => n.cat === 'hostile' && Number.isFinite(n.dist) && n.dist <= 16)
  if (!(dg.health <= RECOVER_HP)) return { ok, no, recovering: false }
  if (!((dg.low_hp_s ?? 0) > RECOVER_AFTER_S)) return { ok, no, recovering: false }
  if (hostile) { no.push('recover (hostile mob within 16 m, deal with it first)'); return { ok, no, recovering: false } }
  const inv = dg.inventory ?? {}
  const { edible, cookable } = foodFacts(dg)
  const gap = Math.max(0, REGEN_FOOD - dg.food)
  const recovering = night
  const hp = `hp ${dg.health} for ${Math.round(dg.low_hp_s / 60)} min`
  if (edible.length && gap > 0) {
    ok.push({ score: 9.6, text: `recover (${hp}): eat until food is ${REGEN_FOOD} so you heal naturally: ${edible.slice(0, 4).map((f) => `${f.k} x${f.n}`).join(', ')}; start with {act:eat,args:{item:${edible[0].k}}} (it keeps eating while food < 20)` })
  } else if (edible.length) {
    ok.push({ score: 9.2, text: `recover (${hp}): food is already ${dg.food}, you heal naturally; stay in cover and rest, no walking${night ? ' until day' : ''}` })
  } else if (cookable.length) {
    const fuel = cnt(inv, /^(coal|charcoal)$/) * 8 + cnt(inv, /(_planks|_log)$/) * 1.5
    const furnace = cnt(inv, /^furnace$/) > 0 || cnt(inv, /^(cobblestone|cobbled_deepslate|blackstone)$/) >= 8
    const c = cookable.slice().sort((a, b) => b.pts * b.n - a.pts * a.n)[0]
    if (fuel >= 1 && furnace) ok.push({ score: 9.5, text: `recover (${hp}): you hold no edible food but raw ${cookable.map((f) => `${f.k} x${f.n} -> ${f.to}`).join(', ')}: cook it right here in cover ({act:cook,args:{}}), then eat ${c.to}` })
    else no.push(`cook (${fuel < 1 ? 'no fuel (coal, charcoal, planks or logs)' : 'no furnace and under 8 cobblestone'})`)
  }
  if (!ok.length && !night) { const f = forageMenu(dg, { hp }); if (f) { ok.push(f); return { ok, no, recovering } } }
  if (!ok.length) {
    const d = daylightInfo(dg)
    ok.push({ score: 9.3, text: night ? `recover (${hp}): no edible food and nothing to cook: wait in cover until day${d?.minToDawn ? ` (about ${d.minToDawn} min)` : ''}, then get_food; do not walk far in the dark while hurt` : `recover (${hp}): no edible food and nothing to cook: get_food now while it is day (hunt, fish, search), then return to cover` })
  }
  if (night) no.push('long walks (hurt at night: heal in cover first; only if you explicitly decide you must)')
  return { ok, no, recovering }
}

/** DAY1: hurt and without food in daylight: 'forage' is ALWAYS the top option while daylight remains (never 'no options'). The body routine (bot recover.js) does it by itself
 *  at hp <= 6 after 2 min in cover; this line also covers hp 7-10 and the first 2 minutes. Pure function of the digest. -> {score, text} | null */
export function forageMenu(dg, { hp = `hp ${dg.health}` } = {}) {
  const d = daylightInfo(dg)
  if (dg.thunder || d?.night || dg.time?.phase === 'night') return null
  if (!(dg.health <= 10 || dg.food <= 6)) return null
  const { edible, cookable } = foodFacts(dg)
  if (edible.length) return null
  const left = d?.minToDusk
  if (Number.isFinite(left) && left < 2) return null
  const inv = dg.inventory ?? {}
  const rod = cnt(inv, /^fishing_rod$/) > 0, canRod = cnt(inv, /^string$/) >= 2 && (cnt(inv, /^stick$/) >= 3 || cnt(inv, /_planks$/) >= 2 || cnt(inv, /_log$/) >= 1)
  const animals = (dg.nearby ?? []).filter((n) => /^(cow|pig|sheep|chicken|rabbit)/.test(n.id ?? n.name ?? '') && Number.isFinite(n.dist) && n.dist <= 48)
  const seen = (dg.food_sources ?? [])[0]
  const way = [animals.length ? `${animals.length} animals within 48 m (hunt)` : null, seen ? `remembered food source: ${typeof seen === 'string' ? seen : seen.name ?? 'animals'}${seen.dist ? ` ${Math.round(seen.dist)} m` : ''}` : null, waterOk(dg) ? (rod ? `fish with your rod (water ${dg.water_near_m ?? 'near'} m away)` : canRod ? 'craft a fishing rod (sticks + string) and fish' : null) : null, 'ripe berries, crops or apples from oak leaves', 'resource_expedition resource=food max_dist=120 if nothing is near'].filter(Boolean)
  const hostile = (dg.nearby ?? []).some((n) => n.cat === 'hostile' && Number.isFinite(n.dist) && n.dist <= 16)
  return { score: hostile ? 8.8 : 9.9, text: `forage (${hp}, food ${dg.food}, you hold nothing edible${Number.isFinite(left) ? `, about ${left} min of daylight left` : ''}): food is what heals you now, so go and get it while it is day: ${way.join('; ')}. Start with the playbook get_food (it hunts, walks to herds, ${waterOk(dg) && (rod || canRod) ? 'fishes, ' : ''}picks plants), return to cover before dusk${hostile ? '; a hostile mob is within 16 m: deal with it or stay in cover first, then forage' : ''}` }
}
