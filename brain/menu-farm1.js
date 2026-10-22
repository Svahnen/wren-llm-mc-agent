// FARM1: food security. A pure view of the digest (no advice about WHAT she wants): how much food she holds in hunger points, which renewable sources she knows
// (farm + growth stage, pen + animals, fishing + rod durability, remembered berries), roughly how many game days that lasts, and, when it is low, 'set up a food
// source' options with their feasibility. Means only: S2 chooses; nothing here sets a goal.
import { foodFacts } from './contract.js'
import { waterOk, FISH_RANGE_M, rodFacts } from './menu-food1.js'
import { daylightInfo } from './daylight.js'
const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
/** assumption (labelled in the text): about this many food points are used per game day (20 real minutes) of normal activity */
export const PTS_PER_GAME_DAY = 10
export const LOW_DAYS = 1.5, MIN_PEN = 3, BREED_CAP = 6

/** -> { pts, raw_pts, days, sources:[{kind,...}], renewable, level:'none'|'low'|'ok', text } ; pure */
export function foodSecurity(dg) {
  const fs = dg.food_security ?? {}
  const { edible, cookable } = foodFacts(dg)
  const pts = edible.filter((f) => !f.risky).reduce((s, f) => s + f.pts * f.n, 0)
  const rawPts = cookable.reduce((s, f) => s + f.pts * f.n, 0)
  const days = Math.round(((pts + rawPts + (dg.food ?? 0)) / PTS_PER_GAME_DAY) * 10) / 10
  const inv = dg.inventory ?? {}, src = [], parts = []
  if (fs.farm) {
    const f = fs.farm, st = f.stage === 'ripe' ? `${f.ripe}/${f.crops} ripe, harvest now` : f.stage === 'growing' ? `${f.crops} crops growing (${Math.round((f.avg_age ?? 0) * 100)}% grown)` : f.stage === 'empty' ? 'nothing planted (replant)' : 'not in view'
    src.push({ kind: 'farm', productive: f.stage === 'ripe' || f.stage === 'growing' }); parts.push(`farm plot ${f.dist} m away: ${st}`)
  }
  if (fs.pen) {
    const p = fs.pen, k = Object.entries(p.kinds ?? {}).map(([n, c]) => `${c} ${n}`).join(', ')
    const n = p.total
    src.push({ kind: 'pen', productive: n != null && n >= MIN_PEN, animals: n }); parts.push(`animal pen ${fs.pen.dist} m away: ${n == null ? 'animals unknown' : `${n} animals${k ? ' (' + k + ')' : ''}${p.babies ? `, ${p.babies} babies` : ''}${p.stale ? ' (last seen)' : ''}`}${n != null && n < MIN_PEN ? `, killing waits until ${MIN_PEN}` : ''}`)
  }
  { const rod = fs.rod ?? (cnt(inv, /^fishing_rod$/) ? { durability_left: null } : null)
    if (rod) { src.push({ kind: 'fishing', productive: rod.durability_left == null || rod.durability_left > 0 }); parts.push(`fishing rod${rod.durability_left != null ? ` (${rod.durability_left} casts of durability left)` : ''}`) } }
  if (fs.berries) { src.push({ kind: 'berries', productive: false }); parts.push(`sweet berry bushes remembered ${fs.berries.dist} m away`) }
  const renewable = src.some((s) => s.productive)
  const level = days >= 3 || (renewable && days >= 1) ? 'ok' : days < LOW_DAYS ? 'low' : renewable ? 'ok' : 'none'
  const held = `${pts} hunger points of food in your bag${rawPts ? ` (+${rawPts} if you cook what is raw)` : ''}, body food ${dg.food}/20`
  const text = `food security: ${held}, about ${days} game days of food at roughly ${PTS_PER_GAME_DAY} points per game day (an estimate)${parts.length ? '; known sources: ' + parts.join('; ') : '; no farm, animal pen or fishing spot of your own yet'}`
  return { pts, raw_pts: rawPts, days, sources: src, renewable, level, text }
}

/** morning = first ~3 game hours of daylight (ticks 0..6000 after sunrise; 23460+ also counts) */
export const isMorning = (dg) => { const t = dg.time?.ticks; return Number.isFinite(t) ? (t < 6000 || t >= 23460) : false }

/** options + feasibility. -> { ok:[{score,text}], no:["name (reason)"] } */
export function farmMenu(dg) {
  const ok = [], no = [], inv = dg.inventory ?? {}, fs = dg.food_security ?? {}
  const sec = foodSecurity(dg), low = sec.level !== 'ok'
  const d = daylightInfo(dg), night = dg.time?.phase === 'night' || !!dg.thunder || d?.night
  const left = d && !d.night ? d.minToDusk : null
  const hostile = (dg.nearby ?? []).some((n) => n.cat === 'hostile' && n.dist <= 16)
  const add = (score, text) => ok.push({ score, text }), deny = (n, why) => no.push(`${n} (${why})`)
  const hoe = cnt(inv, /_hoe$/), wood = cnt(inv, /(_planks)$/) + cnt(inv, /_log$/) * 4, sticks = cnt(inv, /^stick$/)
  const seeds = cnt(inv, /^(wheat_seeds|beetroot_seeds)$/), wheat = cnt(inv, /^wheat$/)
  const farm = fs.farm, pen = fs.pen
  // --- crops: harvest + bread
  if (farm && !night) {
    if (farm.stage === 'ripe') add(low ? 8.6 : 5, `harvest_farm (${farm.dist} m): ${farm.ripe}/${farm.crops} crops are ripe; it harvests and replants, wheat becomes bread (3 wheat each)`)
    else if (farm.stage === 'empty') add(low ? 7.4 : 3, `harvest_farm (${farm.dist} m): the plot is empty, it needs replanting (hold seeds)`)
    else if (farm.stage === 'growing') deny('harvest_farm', `crops about ${Math.round((farm.avg_age ?? 0) * 100)}% grown, not ripe yet`)
  }
  if (wheat >= 3) add(low ? 7.2 : 4.2, `craft item=bread: ${Math.floor(wheat / 3)} bread from ${wheat} wheat (+5 food each)`)
  else if (wheat > 0) deny('bread', `${wheat}/3 wheat`)
  // --- animals
  if (pen) {
    const n = pen.total
    const crowded = Object.entries(pen.kinds ?? {}).find(([, c]) => c >= BREED_CAP)   // RS3 breed guard: a kind at 6 is not bred further
    if (crowded) deny('breed_animals', `${crowded[1]} ${crowded[0]}s in the pen; it is kept at 4-6 per kind, take meat (pen_slaughter) instead`)
    else if (cnt(inv, /^(wheat|carrot|potato|beetroot|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/) >= 2 && (n == null || n >= 2) && !night && !hostile) add(low ? 6.4 : 3.2, `breed_animals: feed two adults in your pen (${n ?? '?'} animals now) so a baby is born; wheat for cows/sheep, carrots/potatoes for pigs, seeds for chickens. Parents rest 5 min after a birth, a baby needs 20 min to grow, and the pen is kept at 4-6 animals of a kind`)
    else if (n != null && n >= 2) deny('breed_animals', night ? 'night' : 'no feed held (wheat, carrots, potatoes or seeds)')
    if (n != null && n >= MIN_PEN && !night && !hostile) add(sec.pts + 0 < 8 && dg.food <= 12 ? 7.9 : 3.4, `pen_slaughter: take meat from the pen (${n} animals; it kills one adult and leaves the rest to breed), then cook it`)
    else if (n != null) deny('pen_slaughter', `the pen has ${n} animals, killing waits until ${MIN_PEN}`)
  }
  // --- morning routine hook: a farm or pen exists
  const feed = cnt(inv, /^(wheat|carrot|potato|beetroot|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/) >= 2
  const useful = farm?.stage === 'ripe' || farm?.stage === 'empty' || wheat >= 3 || (pen && feed && (pen.total == null || pen.total >= 2))
  if ((farm || pen) && useful && !night && !hostile) {
    const m = isMorning(dg)
    add(m ? (low ? 8.1 : 6.6) : 2.1, `food_round (${[farm ? 'farm' : null, pen ? 'pen' : null].filter(Boolean).join(' + ')}): ${m ? 'good morning routine: ' : ''}harvest and replant, bake bread, feed the animals so they breed${m ? '' : ' (any time in daylight)'}`)
  }
  // --- set up a source when food is low and nothing renewable exists (or this kind is missing)
  if (low || !sec.renewable) {
    const want = low ? 1 : 0
    if (!farm) {
      const how = []
      const tableHeld = cnt(inv, /^crafting_table$/) > 0, needW = 2 + (sticks >= 2 ? 0 : 2) + (tableHeld ? 0 : 4)   // FOOD4: honest wood count (a table is made when none is within reach)
      how.push(hoe ? 'hoe in your bag' : wood >= needW ? `hoe can be crafted (${needW} planks worth of wood needed incl. a crafting table if none is within reach; you hold ${wood})` : `no hoe: crafting one needs about ${needW} planks of wood (2 logs), you hold ${wood}; gather wood first`)
      how.push(seeds ? `${seeds} seeds held` : 'seeds come from breaking tall grass in daylight')
      how.push('it tills best next to water, then you plant and the place is remembered')
      const feasible = (hoe || wood >= needW) && !night && !hostile
      if (feasible) add((low ? 7.6 : 3.6) + want * 0, `farm_plot: set up a 3x3 wheat farm near home, a food source that does not run out (${how.join('; ')}${left != null ? `; ${left} min of daylight left, crops need real time to grow` : ''})`)
      else if (!night && !hostile && chronicFood(dg)) { deny('farm_plot', `no hoe and only ${wood} planks of wood (need ${needW})`); add(9.4, `gather resource=wood count=8: wood for a hoe and a crafting table is the first step to a farm (${chronicFood(dg).why})`) }
      else deny('farm_plot', night ? 'night: collect seeds and plant in daylight' : hostile ? 'hostile near' : `no hoe and only ${wood} planks of wood (need ${needW}): gather wood first`)
    }
    if (!pen) {
      const animals = (dg.nearby ?? []).filter((n) => n.cat === 'animal' && /^(cow|sheep|pig|chicken)/.test(n.kind ?? n.id ?? '')).length
      const blocks = cnt(inv, /^(cobblestone|dirt|coarse_dirt|stone|[a-z_]+_planks)$/), fences = cnt(inv, /_fence$/)
      if (animals && (blocks >= 28 || fences >= 15) && !night && !hostile) add(low ? 6.8 : 3, `animal_pen: fence a 5x5 pen and lure ${animals} animals near you with wheat, seeds or carrots (${blocks >= 28 ? blocks + ' blocks' : fences + ' fences'} held); with 2 adults it breeds, killing waits until 3 animals`)
      else deny('animal_pen', !animals ? 'no cows, sheep, pigs or chickens near' : night ? 'night' : `${blocks}/28 blocks or 15 fences`)
    }
    if (!sec.sources.some((s) => s.kind === 'fishing')) {
      const { rod: haveRod, canRod, why: rodWhy } = rodFacts(inv)   // FOOD4
      if ((haveRod || canRod) && !night && waterOk(dg)) add(low ? 5.2 : 2.2, (haveRod ? 'fish: cast your rod at a pond' : 'fish: craft a rod from 3 sticks + 2 string and fish') + ' (slow but renewable)')
      else deny('fish', (haveRod || canRod) ? (night ? 'night' : `no water within ${FISH_RANGE_M} m`) : rodWhy)
    }
  }
  // FOOD4: chronic food poverty (2+ food-insecurity episodes today): in daylight, setting up a renewable source goes to the top (she still chooses)
  const ch = chronicFood(dg)
  if (ch && !night && !(ch.starving)) { for (const o of ok) if (/^(farm_plot|animal_pen)\b/.test(o.text)) { o.score = Math.max(o.score, /^farm_plot/.test(o.text) ? 10.2 : 10.1); o.text = `${o.text}. ${ch.why}` } }
  else if (ch && !night) { for (const o of ok) if (/^(farm_plot|animal_pen)\b/.test(o.text)) { o.score = Math.max(o.score, /^farm_plot/.test(o.text) ? 9.8 : 9.7); o.text = `${o.text}. ${ch.why} (eat first if you can: crops take game days to grow)` } }
  return { ok, no, sec }
}

export function foodSecurityLine(dg) { const s = foodSecurity(dg); return dg.food_security || s.level !== 'ok' || dg.food <= 14 ? s.text : null }
/** the project idea for the no-goal prompt (never set automatically): only when food is not secure */
export function farmIdea(dg) { const s = foodSecurity(dg); return s.level !== 'ok' && !(dg.food_security?.farm) ? 'make a farm near home (a food source that does not run out)' : null }
/** daily routine hook: when a farm or a pen exists, the morning routine includes harvest / replant / feed. A line for the prompt (an offer; she starts it). */
export function morningRoundLine(dg) {
  const fs = dg.food_security; if (!fs || (!fs.farm && !fs.pen)) return null
  const what = [fs.farm ? 'harvest and replant the farm' : null, fs.pen ? 'feed the animals in the pen' : null, fs.farm ? 'bake bread when you hold 3 wheat' : null].filter(Boolean)
  return `Your morning round (a daily routine you can run when the day starts; the playbook food_round does it, or do the parts yourself): ${what.join('; ')}.`
}

/** FOOD4: chronic food poverty from the body's per-day episode count. -> { n, why, starving } or null */
export function chronicFood(dg) {
  const e = dg.food_episodes, n = e?.today ?? 0
  if (n < 2) return null
  const starving = dg.food <= 6 && !foodFacts(dg).edible.length && (dg.health ?? 20) <= 10
  return { n, starving, why: `you ran out of food ${n} times today, hunting and foraging near home is not enough, a renewable source is how it stops` }
}
/** the plain digest sentence, also when it was bad yesterday */
export function foodEpisodeLine(dg) {
  const e = dg.food_episodes; if (!e) return null
  if (e.today >= 2) return `food history: You ran out of food ${e.today} times today (food fell to 6 or below and recovered); hunting/foraging near home is not enough. A renewable source (a farm plot near home, or an animal pen with breeding) is on your menu${e.yesterday >= 2 ? `; yesterday it happened ${e.yesterday} times too` : ''}.`
  if (e.today === 1 && e.yesterday >= 2) return `food history: you ran out of food ${e.yesterday} times yesterday and once so far today.`
  return null
}
