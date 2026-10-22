// ROAM1: menu entries for the roaming means (roam, make_camp, new_home) and the honest dusk line for the digest. Pure functions of the digest.
// Facts and options only: she chooses. The dusk constants mirror bot/src/habits/safety.js (DUSK1): dusk tick 11200, 3 blocks/s, 75 s margin.
import { daylightInfo } from './daylight.js'
import { depletedResource } from './menu-exp1.js'
const DUSK_START = 11200, NIGHT_START = 12542, WALK_BPS = 3.0, MARGIN_S = 75, CAMP_LEAD_S = 100, HOME_FAR = 25
const EDIBLE = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|apple|carrot|potato|baked_potato|cooked_[a-z_]+|sweet_berries|melon_slice|beetroot|golden_apple|pumpkin_pie|cookie)$/
const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
const BLOCK = /^(cobblestone|cobbled_deepslate|blackstone|dirt|coarse_dirt|stone|andesite|diorite|granite|deepslate|tuff|netherrack|sandstone|red_sandstone|terracotta|sand|red_sand|gravel|[a-z_]+_planks)$/
const homeOf = (dg) => (dg.places ?? []).find((p) => p.kind === 'home')

/** {homeDist, secs, homeReachable} from the digest, or null when the clock or the distance is unknown */
export function duskFactsDg(dg) {
  const t = dg?.time?.ticks, home = homeOf(dg)
  if (!Number.isFinite(t)) return null
  const k = ((Math.floor(t) % 24000) + 24000) % 24000
  if (k >= NIGHT_START) return null
  const secs = k < DUSK_START ? (DUSK_START - k) / 20 : 0, hd = home && Number.isFinite(home.dist) ? home.dist : null
  const walk = hd == null ? Infinity : hd / WALK_BPS
  return { ticks: k, secs, homeDist: hd, walk, homeReachable: hd != null && walk + 15 <= secs, minToDark: Math.max(1, Math.ceil((NIGHT_START - k) / 1200)) }
}
/** the honest dusk line for S2, or null (plenty of daylight, at home, night). */
export function duskLineDg(dg) {
  const f = duskFactsDg(dg); if (!f) return null
  if (f.homeDist != null && f.homeDist <= HOME_FAR) return null
  if (f.ticks < DUSK_START && f.secs > (f.homeDist != null ? f.walk : 0) + MARGIN_S + 180) return null
  const where = f.homeDist != null ? `home is ${Math.round(f.homeDist)} m away` : 'no home is set'
  return `${where}; dark in ${f.minToDark} min: ${f.homeReachable ? 'go home (go_home) or camp here (make_camp)' : 'home is too far to reach before dark: camp here (make_camp)'}`
}

const FOODFAIL = /forage_plants|hunt|get_food|fish|collect/i
export function roamMenu(dg) {
  const ok = [], no = [], add = (score, text) => ok.push({ score, text })
  const inv = dg.inventory ?? {}, night = dg.time?.phase === 'night' || !!dg.thunder, d = daylightInfo(dg), home = homeOf(dg)
  if (dg.playbook?.name === 'roam' && ['running', 'paused'].includes(dg.playbook.status)) return { ok, no }
  const foodHeld = cnt(inv, EDIBLE), blocks = cnt(inv, BLOCK), torches = cnt(inv, /^torch$/), bed = cnt(inv, /_bed$/) > 0
  const recent = (dg.failures ?? []).filter((f) => f.ago_s == null || f.ago_s <= 1800)
  const depl = recent.filter((f) => depletedResource(f) || (FOODFAIL.test(String(f.what)) && /no_target_found|no_animal|nothing_gained|found_nothing|no_food|no_plant|within \d+ m/i.test(String(f.reason))))
  const hungry = (dg.food ?? 20) <= 10 && foodHeld === 0
  const depleted = depl.length >= 2 || (depl.length >= 1 && hungry)
  const kit = `You carry ${blocks} building blocks, ${torches} torches${bed ? ', a bed' : ''}, ${foodHeld} food items`
  const remembered = (dg.places ?? []).filter((p) => ['food_area', 'meadow'].includes(p.kind)).sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))[0]
  if (night) no.push(`roam (it is night${d?.minToDawn ? `, a roam starts in the morning, dawn in ${d.minToDawn} min` : ''})`)
  else if (d && d.minToDusk < 4) no.push(`roam (not now: dusk in ${d.minToDusk} min; start in the morning, or make_camp if you stay out)`)
  else if (depleted) add(hungry && depl.length >= 2 ? 9.95 : 8.9, `roam days=2 (max 4) max_dist=400: the ground around home is used up (${depl.length} failed gather/forage/hunt in 30 min${hungry ? `, food ${dg.food} and nothing to eat` : ''}); walks out by day ${remembered ? `toward your remembered ${remembered.id} (${remembered.dist ?? '?'} m ${remembered.dir ?? ''})` : 'toward plains and forest with animals and grass'}, hunts, forages and picks grass seeds on the way (a farm needs seeds), remembers food/water/tree places, makes a night camp where dusk finds you instead of walking home, then returns. ${kit}${blocks < 9 ? ' (a camp needs 9 blocks for a pillbox; a hole needs none)' : ''}${d ? `. About ${d.minToDusk} min of daylight left` : ''}`)
  else add(1.4, 'roam days=<1-4> direction=<north|south|east|west|any>: a multi-day trip toward food-rich ground with night camps; for when home is used up')
  // dusk: camp here, with the honest facts
  const f = duskFactsDg(dg)
  if (!night && f && (home == null || (home.dist ?? 0) > HOME_FAR) && f.secs <= 6 * 60 + (f.homeDist != null ? f.walk : 0)) {
    const line = duskLineDg(dg)
    add(f.homeReachable ? 5 : 8.4, `make_camp: ${line ?? 'camp here'} (a torch, then a pillbox with 9+ blocks or a hole with no blocks; you wait inside until morning; bed=yes sleeps in a bed item and sets your spawn). ${kit}`)
  }
  // a much better place found while roaming
  const site = (dg.places ?? []).find((p) => p.kind === 'good_site' && (p.dist ?? 1e9) <= 30)
  if (site && home && (home.dist ?? 0) > 120 && !night) add(6.6, `new_home: this place has food, water, trees and grass together (${site.note ?? 'good site'}); make it your home (your old home ${home.dist} m away stays remembered as old_home)`)
  return { ok, no }
}
