import { waterOk, FISH_RANGE_M, rodFacts } from './menu-food1.js'
// PB4: menu entries for the activity playbooks (hole_and_cap, leave_hole, roof_over_me, torch_perimeter, fish, farm_plot, harvest_farm, stair_down, animal_pen).
// Pure function of the digest; returns { ok:[{score,text}], no:["name (reason)"] }. Merged into activityMenu (menu.js).
const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
const BLOCK = /^(cobblestone|cobbled_deepslate|blackstone|dirt|coarse_dirt|stone|andesite|diorite|granite|deepslate|tuff|netherrack|sandstone|red_sandstone|terracotta|sand|red_sand|gravel|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood)$/

export function pb4Menu(dg) {
  const inv = dg.inventory ?? {}, blocks = cnt(inv, BLOCK), night = dg.time?.phase === 'night' || !!dg.thunder, day = dg.time?.phase === 'day' && !dg.thunder
  const near = dg.nearby ?? [], hostile = near.some((n) => n.cat === 'hostile' && n.dist <= 16)
  const sky = near.some((n) => /^(skeleton|stray|bogged|phantom)/.test(n.kind ?? '') && (n.dist ?? 99) <= 40)
  const hole = (dg.hazards ?? []).some((h) => h.kind === 'in_hole') || !!dg.in_hole
  const ok = [], no = []
  const add = (score, text) => ok.push({ score, text }), deny = (name, why) => no.push(`${name} (${why})`)
  const home = (dg.places ?? []).find((p) => p.kind === 'home'), farm = (dg.places ?? []).find((p) => p.id === 'farm' || p.kind === 'farm')
  const animals = near.filter((n) => n.cat === 'animal').length

  if (hole) { if (day && !hostile) add(8, 'leave_hole: you are sealed in a hole and it is safe to climb out now'); else deny('leave_hole', hostile ? 'hostile near' : 'it is night') }
  if ((night || hostile) && !hole) add(night && blocks < 6 ? 6.5 : 3, 'hole_and_cap: dig 2 down and cap the hole above you (needs no blocks); climbs out again in the morning'); else if (!hole) deny('hole_and_cap', 'day and no danger')
  if (sky || dg.rain) { if (blocks >= 12) add(sky ? 8.5 : 4, `roof_over_me: 3x3 roof 3 m above you (${sky ? 'skeletons/phantoms near' : 'rain'}); needs 12 blocks, you have ${blocks}`); else deny('roof_over_me', `${blocks}/12 blocks`) } else deny('roof_over_me', 'no skeleton, phantom or rain')
  const torches = cnt(inv, /^torch$/), coal = cnt(inv, /^(coal|charcoal)$/)
  if (home && (torches >= 3 || coal >= 1)) add(night ? 3 : 2, `torch_perimeter radius=6: ring ${torches >= 3 ? 'home' : 'a spot'} with torches ~6 m apart${torches >= 3 ? '' : ' (crafts them from coal first)'}`); else deny('torch_perimeter', !home ? 'no home set' : 'no torches or coal')
  const { rod, canRod, why: rodWhy } = rodFacts(inv)   // FOOD4
  if (day && (rod || canRod) && waterOk(dg)) add(hostile ? 0.5 : 2.4, `fish catches=2: ${rod ? 'cast your rod from a bank' : 'make a rod from 3 sticks + 2 string, then fish'}`); else deny('fish', !day ? 'night' : !(rod || canRod) ? rodWhy : `no water within ${FISH_RANGE_M} m`)
  const hoe = cnt(inv, /_hoe$/), wood = cnt(inv, /(_planks|_log)$/)
  if (day && !hostile && (hoe || wood >= 2)) add(1.8, `farm_plot: 3x3 crops ${hoe ? '' : '(makes a hoe first) '}${cnt(inv, /_seeds$/) ? 'with the seeds you hold' : 'with seeds from tall grass'}`); else deny('farm_plot', !day ? 'night' : hostile ? 'hostile near' : 'no hoe and under 2 planks/logs')
  if (farm) { if (day) add(2.6, `harvest_farm (${farm.dist ?? '?'} m ${farm.dir ?? ''}): collect ripe crops and replant`); else deny('harvest_farm', 'night') } else deny('harvest_farm', 'no farm made yet')
  add(1.2, 'stair_down target_y=<y>: safe staircase down (never straight down; stops at lava, water, air gaps)')
  if (day && !hostile && animals >= 1 && (blocks >= 28 || cnt(inv, /_fence$/) >= 15)) add(1.6, `animal_pen: 5x5 fence, ${cnt(inv, /^(wheat|carrot|potato|beetroot|.*_seeds)$/) ? 'lure animals with the food you hold' : 'no lure food held'} (${animals} animals near)`); else deny('animal_pen', !animals ? 'no animals near' : blocks < 28 ? `${blocks}/28 blocks or 15 fences` : 'night or hostile near')
  return { ok, no }
}
