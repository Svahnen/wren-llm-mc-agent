// Hostile knowledge and the fight/flee/avoid decision (pure given a bot snapshot, unit tested).
export const MOBS = {
  zombie: { dmg: 3, hp: 20, fight: true }, husk: { dmg: 3, hp: 20, fight: true }, drowned: { dmg: 3, hp: 20, fight: true },
  zombie_villager: { dmg: 3, hp: 20, fight: true }, skeleton: { dmg: 3, hp: 20, fight: true, ranged: true },
  stray: { dmg: 3, hp: 20, fight: true, ranged: true }, bogged: { dmg: 3, hp: 16, fight: true, ranged: true },
  spider: { dmg: 2, hp: 16, fight: true }, cave_spider: { dmg: 2, hp: 12, fight: true }, silverfish: { dmg: 1, hp: 8, fight: true },
  phantom: { dmg: 3, hp: 20, fight: true }, slime: { dmg: 2, hp: 16, fight: true }, endermite: { dmg: 1, hp: 8, fight: true },
  creeper: { creeper: true, hp: 20 },
  witch: { dmg: 4, hp: 26, flee: true }, vindicator: { dmg: 8, hp: 24, flee: true }, pillager: { dmg: 4, hp: 24, flee: true, ranged: true },
  evoker: { dmg: 6, hp: 24, flee: true }, ravager: { dmg: 12, hp: 100, flee: true }, warden: { dmg: 30, hp: 500, flee: true },
  blaze: { dmg: 5, hp: 20, flee: true }, wither_skeleton: { dmg: 8, hp: 20, flee: true }, hoglin: { dmg: 8, hp: 40, flee: true },
  zoglin: { dmg: 8, hp: 40, flee: true }, guardian: { dmg: 6, hp: 30, flee: true }, elder_guardian: { dmg: 8, hp: 80, flee: true },
  vex: { dmg: 8, hp: 14, flee: true }, ghast: { dmg: 8, hp: 10, flee: true }, wither: { dmg: 20, hp: 300, flee: true },
  // neutral: ignored unless they hurt us (enderman must not even be looked at)
  enderman: { neutral: true }, zombified_piglin: { neutral: true }, piglin: { neutral: true }, wolf: { neutral: true }, iron_golem: { neutral: true }, bee: { neutral: true },
}

const WEAPONS = [ // [name, damage, attack interval ms]
  ['netherite_sword', 8, 625], ['diamond_sword', 7, 625], ['iron_sword', 6, 625], ['stone_sword', 5, 625], ['golden_sword', 4, 625], ['wooden_sword', 4, 625],
  ['netherite_axe', 10, 1000], ['diamond_axe', 9, 1000], ['iron_axe', 9, 1111], ['stone_axe', 9, 1250], ['golden_axe', 7, 1000], ['wooden_axe', 7, 1250],
  ['netherite_pickaxe', 6, 833], ['diamond_pickaxe', 5, 833], ['iron_pickaxe', 4, 833], ['stone_pickaxe', 3, 833], ['wooden_pickaxe', 2, 833], ['golden_pickaxe', 2, 833],
  ['netherite_shovel', 5.5, 1000], ['diamond_shovel', 5, 1000], ['iron_shovel', 4.5, 1000], ['stone_shovel', 3.5, 1000], ['wooden_shovel', 2.5, 1000],
]
export const FIST = { name: null, dmg: 1, interval: 500 }

/** Damage per second of a weapon row; swords get a small preference (sweep, reach of the 0.625 s cooldown, durability on mobs). */
const dps = (w) => (w[1] * 1000) / w[2] * (w[0].endsWith('_sword') ? 1.15 : 1)

/** Best melee item in the inventory: highest dps, a sword beats an axe of similar strength (B1), axe beats pickaxe beats shovel. */
export function bestWeapon(bot) {
  const items = bot.inventory?.items?.() ?? []
  const held = bot.heldItem ? [bot.heldItem] : []
  let best = null, bestScore = -1
  for (const it of [...items, ...held]) {
    const w = WEAPONS.find((x) => x[0] === it.name)
    if (!w) continue
    const sc = dps(w)
    if (sc > bestScore) { bestScore = sc; best = { name: w[0], dmg: w[1], interval: w[2], item: it } }
  }
  return best ?? FIST
}

export function armorPoints(bot) {
  const slots = bot.inventory?.slots ?? []
  const pts = { leather: 1, golden: 2, chainmail: 2, iron: 2, diamond: 3, netherite: 3 }
  let total = 0
  for (const i of [5, 6, 7, 8]) { const n = slots[i]?.name; if (n) total += pts[n.split('_')[0]] ?? 0 }
  return total
}

/** SURV5: a drowned holding a trident (main or off hand) throws it: a ranged, hard-hitting (8) mob that must be avoided, not walked up to. */
export const holdsTrident = (e) => [e?.equipment?.[0], e?.equipment?.[1], e?.heldItem].some((i) => i?.name === 'trident')
export const TRIDENT_DROWNED = { dmg: 8, hp: 20, flee: true, ranged: true, trident: true }
/** Profile of one entity: MOBS[name], upgraded for a trident drowned. */
export function profOf(e) {
  const p = MOBS[e?.name]
  return p && e.name === 'drowned' && holdsTrident(e) ? TRIDENT_DROWNED : p
}

/**
 * VAL1: is this mob a RELEVANT threat right now? Close (<= 5 m) always. Beyond that a melee mob must be on about our level (not behind
 * rock 8 m below / above) and in line of sight; ranged mobs need line of sight. Passive and unknown entities are never threats (callers
 * only pass MOBS members). Without a world raycast (test doubles) everything within the radius counts as before.
 */
export function relevantThreat(bot, e, prof = profOf(e)) {
  const me = bot.entity?.position
  if (!me || !e?.position || !prof || prof.neutral) return false
  const d = me.distanceTo(e.position)
  if (d <= 5 || prof.trident) return true   // SURV5: a thrown trident arcs over water edges the ray test calls blocked
  if (Math.abs(e.position.y - me.y) > 6 && !prof.ranged) return false
  return hasLineOfSight(bot, e)
}

export function hasLineOfSight(bot, e) {
  try {
    const raycast = bot.world?.raycast
    if (typeof raycast !== 'function') return true
    const from = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
    const to = e.position.offset(0, (e.height ?? 1.8) * 0.6, 0)
    const dir = to.minus(from), len = dir.norm()
    if (!(len > 0)) return true
    const hit = raycast.call(bot.world, from, dir.scaled(1 / len), len)
    return !hit || from.distanceTo(hit.position ?? to) >= len - 1.2
  } catch { return true }
}

export function hostilesAround(bot, radius) {
  const me = bot.entity?.position
  if (!me) return []
  const out = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !e.position) continue
    const prof = profOf(e)
    if (!prof || prof.neutral) continue
    if (e.isValid === false || e.health === 0) continue
    const d = me.distanceTo(e.position)
    if (d <= radius && relevantThreat(bot, e, prof)) out.push({ e, d, prof, name: e.name })
  }
  return out.sort((a, b) => a.d - b.d)
}

/**
 * decision: null | 'fight' | 'flee' ; creepers separately. Reason string for the trace.
 * Rule: flee when a flee-class mob is near, when health is at/below fleeHealth with fighters near, or when the
 * estimated time to kill them all exceeds 60 % of the time we survive their damage.
 */
export function assess(bot, cfg) {
  const all = hostilesAround(bot, cfg.threatRadius + 4)
  const creepers = all.filter((t) => t.prof.creeper && t.d <= cfg.creeperRadius)
  const fleeClass = all.filter((t) => t.prof.flee && t.d <= 14)
  const fighters = all.filter((t) => t.prof.fight && t.d <= cfg.fightRadius)
  const hp = bot.health ?? 20
  const w = bestWeapon(bot)
  const armed = w !== FIST && w.dmg >= 4 // B1: a sword / axe (or a stone pick) is a real weapon
  const armorFactor = 1 - Math.min(0.8, armorPoints(bot) * 0.04)
  // B1: fight arithmetic. Sequential kills: mob i keeps hitting until it dies. Mobs land ~0.6 hits/s (knockback, cooldown, misses), not 1.
  const HIT_RATE = 0.6, RESERVE = cfg.fightReserve ?? 4
  let clock = 0, expectedLoss = 0
  for (const t of fighters) {
    clock += Math.ceil(t.prof.hp / w.dmg) * (w.interval / 1000)
    expectedLoss += t.prof.dmg * armorFactor * HIT_RATE * clock
  }
  const killTime = clock
  const fleeAt = armed ? Math.max(4, cfg.fleeHealth - 2) : cfg.fleeHealth // armed fighters keep fighting down to ~6 hp
  let decision = null, reason = null
  if (fleeClass.length) { decision = 'flee'; reason = `flee_class:${fleeClass[0].name}` }
  else if (fighters.length && hp <= fleeAt) { decision = 'flee'; reason = `low_health:${hp}` }
  else if (fighters.length && !armed && (fighters.length > 1 || hp < 14)) { decision = 'flee'; reason = 'unarmed' }
  else if (fighters.length && expectedLoss > hp - RESERVE) { decision = 'flee'; reason = `outmatched:loss${expectedLoss.toFixed(1)}>hp${hp}-${RESERVE}` }
  else if (fighters.length) { decision = 'fight'; reason = `fight:${fighters.length}` }
  return { decision, reason, all, fighters, fleeClass, creepers, weapon: w, hp, killTime, expectedLoss }
}

/** Facts for S2's prompt (the choice to engage or avoid in a non-emergency is S2's): 'zombie 5 m, you hold an iron sword, hp 14'. */
export function combatFacts(bot, cfg) {
  const a = assess(bot, cfg)
  const near = a.all[0] ?? null
  const held = bot.heldItem?.name ?? null
  const w = a.weapon.name
  const hold = w ? `you carry ${w.replace(/_/g, ' ')}${held === w ? ' (in hand)' : ' (not in hand)'}` : 'you have no weapon'
  const armor = armorPoints(bot)
  return {
    nearest: near ? { name: near.name, d: +near.d.toFixed(1) } : null, hostiles: a.all.length, hp: a.hp, armor, weapon: w, held,
    expected_loss_hp: +a.expectedLoss.toFixed(1), kill_time_s: +a.killTime.toFixed(1), reflex_decision: a.decision, reflex_reason: a.reason,
    text: near ? `${near.name} ${Math.round(near.d)} m, ${hold}, hp ${Math.round(a.hp)}${armor ? `, armour ${armor}` : ''}${a.decision ? `; reflex would ${a.decision}` : ''}` : '',
  }
}
