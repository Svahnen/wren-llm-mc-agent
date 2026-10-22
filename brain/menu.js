import { pb4Menu } from './menu-pb4.js'
import { sleepNow } from './menu-goal3.js'
import { expeditionMenu } from './menu-exp1.js'
import { recoverMenu, forageMenu, waterOk, rodFacts } from './menu-food1.js'
import { farmMenu } from './menu-farm1.js'
import { roamMenu } from './menu-roam1.js'
import { rs3Menu } from './menu-rs3.js'
// PB1 (RS1 format): per turn, a filtered menu of 5-7 FEASIBLE playbooks with ready-to-use parameters plus one "NOT NOW" line with reasons. Pure function of the digest.
const BLOCK = /^(cobblestone|cobbled_deepslate|blackstone|dirt|coarse_dirt|stone|andesite|diorite|granite|deepslate|tuff|netherrack|sandstone|red_sandstone|terracotta|sand|red_sand|gravel|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood)$/
const cnt = (inv, re) => Object.entries(inv).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)

export function activityMenu(dg, { max = 7 } = {}) {
  const inv = dg.inventory ?? {}, blocks = cnt(inv, BLOCK), night = dg.time.phase === 'night' || dg.thunder
  const hostile = dg.nearby.some((n) => n.cat === 'hostile' && n.dist <= 16)
  const home = dg.places.find((p) => p.kind === 'home'), bed = dg.places.find((p) => p.kind === 'bed')
  const person = dg.players[0], place = dg.places.find((p) => p.kind !== 'home' && p.kind !== 'bed') ?? home
  const ok = [], no = []
  const add = (score, text) => ok.push({ score, text }), deny = (name, why) => no.push(`${name} (${why})`)
  const rec = recoverMenu(dg)   // FOOD1
  // PVP1: a player hurt her: bounded options, facts only. The reflex layer does body safety; what to do about the person is hers.
  for (const h of (dg.hurt_by ?? []).filter((x) => x.kind === 'player').slice(0, 1)) {
    const live = h.ago_s <= 10, who = h.who
    add(9.5, `say (your SAY line): tell ${who} how you feel or ask them to stop; they hear it if they are close`)
    add(9.4, `flee from=${who} (act flee): step away from ${who}`)
    if (live) add(9.3, `defend target=${who} (act defend): hit back with your best weapon only while ${who} keeps hitting you; it stops when they stop (max 20 s), never chases`)
    else deny('defend', `${who} last hit you ${h.ago_s} s ago, not hitting now`)
    if (home && home.dist > 8) add(9.2, `go_home (${home.dist} m ${home.dir ?? ''}): leave`)
    add(9.1, 'close_doors_nearby (act, not a playbook): close doors and gates around you')
    if (blocks >= 6) add(9, 'dig_in: seal yourself in right here')
  }
  if (hostile && blocks >= 6 && !(dg.hurt_by ?? []).some((x) => x.kind === 'player')) add(9, 'dig_in: seal yourself in right here (arrows and zombies cannot reach you)')
  if (hostile && blocks >= 8) add(6, 'wall_ring: wall of 2 blocks around you')
  const gfCd = (dg.playbook_cooldowns ?? []).find((c) => c.name === 'get_food')
  if (gfCd) deny('get_food', gfCd.text)
  else if (dg.food < 20) add(dg.food <= 6 ? 7 : 3, `get_food: ${cnt(inv, /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/) ? 'cook and eat the raw meat you hold' : (waterOk(dg) && (rodFacts(inv).rod || rodFacts(inv).canRod)) ? 'eat, hunt, fish or search' : `eat, hunt or search (no fishing: ${waterOk(dg) ? rodFacts(inv).why : 'no water near'})`}`); else deny('get_food', 'not hungry')
  if (person && place) add(5, `show_place_to_person person=${person.name} place=${place.id} (${place.dist ?? '?'} m ${place.dir ?? ''})`); else deny('show_place_to_person', !person ? 'nobody online' : 'no known place')
  if (rec.recovering && home && home.dist > 40) deny('go_home', `recovering at hp ${dg.health}: ${home.dist} m too far to walk at night while hurt`); else if (home && home.dist > 20 && !(dg.hurt_by ?? []).some((x) => x.kind === 'player')) add(4, `go_home (${home.dist} m ${home.dir ?? ''})`); else if (!home) deny('go_home', 'no home set')
  { const sl = sleepNow(dg); if (rec.recovering && bed && bed.dist > 40) deny('sleep_at_night', `recovering at hp ${dg.health}: ${bed.dist} m is too far to walk at night while hurt`); else if (sl.ok && bed) add(7, `sleep_at_night (${bed.id}, ${bed.dist} m)`); else deny('sleep_at_night', sl.ok ? 'no bed known' : sl.why) }   // GOAL3: not before ~1 min to dusk
  if (!cnt(inv, /_pickaxe$/)) add(4, 'make_tools: wood, table, pickaxe, then stone tools'); else if (!cnt(inv, /^(stone|iron|diamond)_pickaxe$/)) add(3, 'make_tools: stone tools')
  if (night || hostile) add(2.2, 'close_doors_nearby (act, not a playbook): close doors and gates around you')
  add(2, 'gather resource=<wood|stone|coal|iron|sand|dirt|plants> count=<n>')
  if (!night) add(1.5, 'explore_and_return radius=60'); else deny('explore_and_return', 'night')
  if (blocks >= 57) add(2.5, 'simple_hut size=5 (5x5, roof, door gap)'); else deny('simple_hut', `${blocks}/57 blocks; it collects them first if you start it`)
  if (blocks >= 6 && !hostile) add(1, 'build_shelter: safe enclosed place from whatever blocks you have')
  if (blocks < 4) deny('pillar_up', `${blocks}/4 blocks`)
  for (const o of rec.ok) add(o.score, o.text); for (const d of rec.no) no.push(d)
  if (!rec.ok.some((o) => /^forage/.test(o.text))) { const f = forageMenu(dg); if (f) add(f.score, f.text) }   // DAY1: hurt + foodless + daylight: forage is always offered
  { const x = expeditionMenu(dg); for (const o of x.ok) add(o.score, o.text); for (const d of x.no) no.push(d) }   // EXP1
  { const x = roamMenu(dg); for (const o of x.ok) add(o.score, o.text); for (const d of x.no) no.push(d) }   // ROAM1
  { const x = pb4Menu(dg); for (const o of x.ok) if (o.score > 0) add(o.score, o.text); for (const d of x.no) no.push(d) }   // PB4
  { const x = rs3Menu(dg); const fishNew = x.ok.some((o) => /^fish_(session|hit)\b/.test(o.text)); if (fishNew) for (let i = ok.length - 1; i >= 0; i--) if (/^fish( |:)/.test(ok[i].text)) ok.splice(i, 1); for (const o of x.ok) add(o.score, o.text); for (const d of x.no) no.push(d) }   // RS3
  { const x = farmMenu(dg); const names = new Set([...x.ok.map((o) => o.text.split(/[ (:]/)[0]), ...x.no.map((n) => n.split(/[ (:]/)[0])]); for (let i = ok.length - 1; i >= 0; i--) if (names.has(ok[i].text.split(/[ (:]/)[0]) && /^(harvest_farm|farm_plot|animal_pen|fish)\b/.test(ok[i].text)) ok.splice(i, 1); for (const o of x.ok) add(o.score, o.text); for (const d of x.no) if (!no.some((q) => q.split(/[ (:]/)[0] === d.split(/[ (:]/)[0])) no.push(d); else { const i = no.findIndex((q) => q.split(/[ (:]/)[0] === d.split(/[ (:]/)[0]); no[i] = d } }   // FARM1 (replaces the quiet PB4 line of the same name)
  const list = ok.sort((a, b) => b.score - a.score).slice(0, (dg.hurt_by ?? []).some((x) => x.kind === 'player') ? Math.max(max, 9) : max)
  return `Activities you could start right now (each is a playbook; the body does the steps):\n${list.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}${no.length ? `\nNOT NOW: ${no.slice(0, 11).join('; ')}` : ''}`
}
