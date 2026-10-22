// RS3: menu entries for the survival strategies of RS2 section 3 (seed_hunt, bootstrap_kit, make_torches, fish_session / fish_hit, chicken_loop, village_forage,
// bonemeal_grass / bonemeal_ripen) and the eat-emergency line. Pure function of the digest; facts and options only, she chooses.
// Every line states the REAL state it is based on (seeds held, rod, logs, bone meal, daylight) and says plainly what is unknown (yields not yet measured on this server).
import { foodSecurity, chronicFood } from './menu-farm1.js'
import { waterOk, FISH_RANGE_M, rodFacts } from './menu-food1.js'
import { daylightInfo } from './daylight.js'
import { foodFacts } from './contract.js'

const cnt = (inv, re) => Object.entries(inv ?? {}).filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0)
const WALK_BPS = 3.0
export const SEED_GOAL = 9

export function rs3Menu(dg) {
  const ok = [], no = [], inv = dg.inventory ?? {}
  const add = (score, text) => ok.push({ score, text }), deny = (name, why) => no.push(`${name} (${why})`)
  const d = daylightInfo(dg), night = dg.time?.phase === 'night' || !!dg.thunder || !!d?.night
  const hostile = (dg.nearby ?? []).some((n) => n.cat === 'hostile' && Number.isFinite(n.dist) && n.dist <= 16)
  const fs = dg.food_security ?? {}, sec = foodSecurity(dg), low = sec.level !== 'ok', chronic = chronicFood(dg)
  const cd = (name) => (dg.playbook_cooldowns ?? []).find((c) => c.name === name)
  const left = d && !d.night ? d.minToDusk : null
  const seeds = cnt(inv, /^wheat_seeds$/), eggs = cnt(inv, /^egg$/), boneMeal = cnt(inv, /^bone_meal$/)
  const food = dg.food ?? 20

  // --- eat emergency (RS2 entry 26): rotten flesh at food <= 6 when nothing better is held, eat until 18 so she heals by herself
  { const rf = cnt(inv, /^rotten_flesh$/), { edible } = foodFacts(dg), better = edible.filter((e) => !e.risky).length
    if (rf > 0 && !better && (food <= 6 || ((dg.health ?? 20) <= 6 && food < 18))) add(9.3, `eat item=rotten_flesh (emergency, food ${food}): you hold ${rf} rotten flesh and nothing better. Each is +4 food and has an 80% chance of the Hunger effect for 30 s; the body keeps eating until food is 18, the level where you heal by yourself. On Easy starving stops at 5 hearts and cannot kill you; spider eyes, poisonous potatoes and pufferfish are never worth it`) }

  // --- seed_hunt: the first step of a farm
  { const farm = fs.farm
    if (seeds >= SEED_GOAL) deny('seed_hunt', `${seeds}/${SEED_GOAL} wheat seeds held already`)
    else if (farm && seeds >= 3) deny('seed_hunt', `a farm exists and you hold ${seeds} seeds`)
    else if (night) deny('seed_hunt', 'night: grass is broken in daylight')
    else if (hostile) deny('seed_hunt', 'hostile near')
    else if (cd('seed_hunt')) deny('seed_hunt', cd('seed_hunt').text)
    else {
      const need = SEED_GOAL - seeds
      const bm = boneMeal ? `; you hold ${boneMeal} bone meal and it is used on grass when the grass runs out (yield per bone meal not measured on this server yet)` : ''
      const score = chronic ? 9.1 : low && food <= 12 ? (farm ? 4.5 : 7.0) : low && !farm ? 2.4 : 0.4
      add(score, `seed_hunt count=${SEED_GOAL}: you hold ${seeds}/${SEED_GOAL} wheat seeds. Break grass and ferns by hand: about 1 break in 8 drops a seed, so roughly ${need * 8} breaks for ${need} more; it stops when the meadow is used up and says how many you got${bm}${left != null ? `. About ${left} min of daylight left` : ''}. Seeds feed chickens and are planted by a farm`) }
  }

  // --- make_torches / bootstrap_kit
  { const torches = cnt(inv, /^torch$/), coal = cnt(inv, /^(coal|charcoal)$/), logs = cnt(inv, /_log$/), planks = cnt(inv, /_planks$/), cobble = cnt(inv, /^(cobblestone|cobbled_deepslate)$/)
    const home = (dg.places ?? []).find((p) => p.kind === 'home'), farm = fs.farm
    if (torches >= 8) deny('make_torches', `${torches} torches held`)
    else if (cd('make_torches')) deny('make_torches', cd('make_torches').text)
    else if (night && logs < 7 && !coal) deny('make_torches', 'night: logs and stone are gathered by day')
    else if (farm || fs.pen || coal || (night && home)) {
      const route = coal ? `you hold ${coal} coal/charcoal` : `no coal: logs are smelted into charcoal in a furnace (8 cobblestone), about 7 logs for 8 torches because the logs are also the fuel`
      add(farm ? 5.2 : fs.pen ? 3.6 : 3.0, `make_torches count=8: you hold ${torches} torches, ${logs} logs, ${planks} planks, ${cobble} cobblestone; ${route}. A torch every ~10 blocks keeps monsters from spawning at home, the pen and the farm; a torch beside the farm lets crops grow at night`)
    }
    const pick = cnt(inv, /^(stone|iron|diamond)_pickaxe$/), hoe = cnt(inv, /_hoe$/), depleted = (dg.failures ?? []).filter((f) => /gather_wood|gather_stone|make_tools/.test(String(f.what)) && /no_target|used up|no_wood|no_stone|within/i.test(String(f.reason))).length
    if (cd('bootstrap_kit')) deny('bootstrap_kit', cd('bootstrap_kit').text)
    else if (night) deny('bootstrap_kit', 'night: wood and stone are gathered by day')
    else if (!pick && depleted) add(6.4, `bootstrap_kit kit=stone_tools: one chain trees -> table -> wooden pickaxe -> stone pickaxe, axe, sword; needs about 5 logs and 10 cobblestone (you hold ${logs} logs, ${cobble} cobblestone, no stone pickaxe); trees or stone near home are used up, so it may stop honestly and say what is missing (then resource_expedition)`)
    else if (pick && !farm && !hoe && low && food <= 12) add(5.4, `bootstrap_kit kit=farm_kit: stone hoe + 4 torches for a farm (about 8 logs, 18 cobblestone; you hold ${logs} logs, ${cobble} cobblestone); farm_plot alone makes only a wooden hoe`)
  }

  // --- fishing: rod session or hitting fish by hand
  { const { rod, canRod, why } = rodFacts(inv), water = waterOk(dg), wm = dg.water_near_m
    const fish = (dg.nearby ?? []).filter((n) => /^(cod|salmon)/.test(String(n.kind ?? n.id ?? '')) && Number.isFinite(n.dist))
    if (night) { deny('fish_session', 'night: drowned spawn in dark water'); deny('fish_hit', 'night') }
    else if (hostile) { deny('fish_session', 'hostile near'); deny('fish_hit', 'hostile near') }
    else {
      if (food >= 18 && !low) { deny('fish_session', `food ${food}/20`) }
      else if (cd('fish_session')) deny('fish_session', cd('fish_session').text)
      else if (!(rod || canRod)) deny('fish_session', why)
      else if (!water) deny('fish_session', `no water within ${FISH_RANGE_M} m (${wm == null ? 'none known' : wm + ' m'})`)
      else add(food <= 12 ? 6.6 : low ? 5.4 : 2.6, `fish_session minutes=5: ${rod ? 'your rod is in the bag' : 'a rod is crafted first (3 sticks + 2 string)'}, water ${wm ?? '?'} m away; roughly 1 fish per 40 s under open sky (about 7 in 5 min, an estimate), stops at food 18 or when night or a hostile comes; the catch is cooked and eaten`)
      if (rod) deny('fish_hit', 'you have a rod: fish_session is faster')
      else if (cd('fish_hit')) deny('fish_hit', cd('fish_hit').text)
      else if (fish.length) add(food <= 12 ? 6.2 : 2.4, `fish_hit count=2: no rod needed, ${fish.length} ${fish[0].kind ?? 'fish'} in view (nearest ${Math.round(fish[0].dist)} m); hit them from the bank, slow, 1 raw fish per kill (cod and salmon only), then cook and eat`)
      else deny('fish_hit', 'no cod or salmon in view')
    }
  }

  // --- chicken_loop
  { const pen = fs.pen, penChickens = pen?.kinds?.chicken ?? 0
    const near = (dg.nearby ?? []).filter((n) => /^chicken/.test(String(n.kind ?? n.id ?? '')) && Number.isFinite(n.dist) && n.dist <= 16).length
    const chickens = Math.max(penChickens, near)
    if (night || hostile) deny('chicken_loop', night ? 'night' : 'hostile near')
    else if (cd('chicken_loop')) deny('chicken_loop', cd('chicken_loop').text)
    else if (!chickens) deny('chicken_loop', 'no chickens in the pen or within 16 m')
    else if (seeds < 2 && eggs < 1) deny('chicken_loop', `${chickens} chickens but ${seeds} seeds and ${eggs} eggs held (2 seeds breed a pair; seed_hunt gets them)`)
    else add(low ? 5.6 : 2.8, `chicken_loop: ${chickens} chickens (${penChickens ? 'in your pen' : 'near you'}), you hold ${seeds} seeds and ${eggs} eggs. One pass: feed two hens (a chick is born; parents rest 5 min, chicks need 20 min to grow), pick up eggs (a hen lays one per 5-10 min), throw eggs at the flock (about 1 egg in 8 hatches), take meat only when the pen has 3+ and cook it. The result lists each part`)
  }

  // --- village_forage
  { const villages = (dg.places ?? []).filter((p) => p.kind === 'village' || /village/i.test(String(p.id)) ).concat((dg.nearby ?? []).filter((n) => n.cat === 'structure' && /village/.test(String(n.kind ?? n.id))).map((n) => ({ id: n.id, dist: n.dist, dir: n.dir })))
    const v = villages.filter((p) => Number.isFinite(p.dist)).sort((a, b) => a.dist - b.dist)[0]
    if (!v) { if (low) deny('village_forage', 'no village known') }
    else if (night) deny('village_forage', `night: go in the morning (${Math.round(v.dist)} m)`)
    else if (cd('village_forage')) deny('village_forage', cd('village_forage').text)
    else {
      const walkMin = Math.round((v.dist / WALK_BPS + 90) / 6) / 10
      if (left != null && walkMin > left) deny('village_forage', `${Math.round(v.dist)} m needs about ${walkMin} min with the work, only ${left} min of daylight left; go in the morning`)
      else add(low ? 7.6 : 3.4, `village_forage place=${v.id} (${Math.round(v.dist)} m ${v.dir ?? ''}): hay bales (1 bale = 9 wheat, one bale always stays), ONLY ripe crops (replanted), then bread; never touches villagers or chests. About ${walkMin} min there and back with the work${left != null ? `, ${left} min of daylight left` : ''}; a shared server's villagers lose that food, so use it when you need it`)
    }
  }

  // --- bone meal (S2 only: nothing starts it by itself)
  if (boneMeal > 0) {
    const farm = fs.farm
    if (cd('bonemeal_ripen')) deny('bonemeal_ripen', cd('bonemeal_ripen').text)
    else if (farm && !night && farm.stage !== 'ripe' && (farm.crops ?? 0) > 0) add(low ? 6.8 : 3.6, `bonemeal_ripen: you hold ${boneMeal} bone meal; the farm (${farm.dist} m) has ${farm.crops} crops, ${farm.ripe ?? 0} ripe, ${Math.round((farm.avg_age ?? 0) * 100)}% grown. Each wheat plant takes 2-5 uses to ripen (not measured here yet), then it harvests, replants and bakes bread`)
    else deny('bonemeal_ripen', !farm ? 'no farm' : night ? 'night' : farm.stage === 'ripe' ? 'crops are ripe, harvest_farm' : 'nothing planted')
    if (cd('bonemeal_grass')) deny('bonemeal_grass', cd('bonemeal_grass').text)
    else if (!night && !hostile && seeds < SEED_GOAL) add(3.4, `bonemeal_grass uses=2: you hold ${boneMeal} bone meal and ${seeds} seeds; bone meal on open grass makes new grass to break for seeds (on 1.21.1 short grass and flowers). The yield per bone meal is NOT measured on this server yet (a few seeds expected, an estimate); the result reports the real count`)
    else deny('bonemeal_grass', night ? 'night' : hostile ? 'hostile near' : `${seeds} seeds held already`)
  }
  return { ok, no }
}
