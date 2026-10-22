// Habit catalog: each habit = {name, category, applies(c), utility(c), plan(c) -> {skill,args}}.
// c = {bot, needs:{levels,urgencies,facts}, inv, env, night, thunder, light, animals, water, underground, homeDist, hasHome, bedKnown, players, rng}
// Utilities are plain numbers from needs + situation; the engine adds recency/lockout penalties and a small seeded noise.
const pick = (rng, a) => a[Math.floor(rng() * a.length) % a.length]
const U = (c, k) => c.needs.urgencies[k]
import { FOOD_RESERVE, SHELTER_BLOCKS } from './safety.js'
// observed: she put all her torches in one spot. The client-side light value does not reliably rise after placing a
// torch, so 'light <= 4' stayed true and the habit fired again on the same spot: never place a torch with one within 6 blocks.
const torchNear = (bot) => { try { return !!bot?.findBlock?.({ matching: (b) => /(^|_)torch$/.test(b?.name ?? ''), maxDistance: 6 }) } catch { return false } }
// H1 priority model: survival habits (cover, shelter, sleep, food) carry utilities far above leisure (< 3.5) so they win whenever they apply.
const HUNGER_BOOST = [0, 1.2, 3.5, 6]   // by hunger tier 0..3
const day = (c) => !c.dark && c.exposed.length === 0

export const CATALOG = [
  { name: 'set_home', category: 'memory',
    applies: (c) => !c.hasHome && c.bot.entity?.onGround, utility: () => 2.2, plan: () => ({ skill: 'set_home', args: {} }) },
  // --- danger first: a skeleton with a clear line to us beats everything ---
  { name: 'take_cover', category: 'safety',
    applies: (c) => c.exposed.length > 0, utility: () => 9, plan: () => ({ skill: 'take_cover', args: {} }) },
  { name: 'eat', category: 'survival',
    applies: (c) => (c.bot.food <= 14 || ((c.bot.health ?? 20) < 20 && c.bot.food < 18)) && (c.inv.food > 0 || (c.inv.badFood > 0 && (c.bot.food <= 6 || ((c.bot.health ?? 20) <= 6 && c.bot.food < 18)))),
    // SURV1: eat drive also while hurt with food < 18 (natural regeneration needs 18); the lower the health, the stronger
    utility: (c) => 0.3 + 4 * U(c, 'hunger') + HUNGER_BOOST[c.tier] + ((c.bot.health ?? 20) < 20 && c.bot.food < 18 && !c.exposed.length ? 0.5 + 0.35 * (20 - (c.bot.health ?? 20)) : 0), plan: () => ({ skill: 'eat', args: {} }) },
  // food chain: keep FOOD_RESERVE edible items; the hungrier, the stronger (tier 2+ beats everything but danger/night)
  { name: 'hunt', category: 'survival',
    applies: (c) => c.inv.food < FOOD_RESERVE && c.animals > 0 && c.inv.free >= 2 && (!c.dark || c.animalNear < 20) && (c.bot.food <= 19 || c.inv.food === 0),
    utility: (c) => 0.5 + 0.25 * (FOOD_RESERVE - c.inv.food) + 3.2 * U(c, 'hunger') + HUNGER_BOOST[c.tier] * (c.inv.food === 0 ? 1 : 0.5),
    plan: () => ({ skill: 'hunt', args: {} }) },
  // hungry, nothing to eat, no animal in sight: go look for some (daylight only)
  { name: 'seek_food', category: 'survival',
    applies: (c) => c.tier >= 1 && c.inv.food === 0 && c.animals === 0 && day(c), utility: (c) => 1.6 + HUNGER_BOOST[c.tier],
    plan: (c) => ({ skill: 'explore', args: { direction: pick(c.rng, ['north', 'south', 'east', 'west', 'any']) } }) },
  // bed chain: sheep -> wool (shears if any) -> craft bed (craft habit) -> sleep
  { name: 'get_wool', category: 'resource',
    applies: (c) => c.inv.beds === 0 && !c.bedKnown && c.inv.wool < 3 && c.sheep > 0 && day(c) && c.inv.free >= 2 && c.tier < 2,
    utility: () => 1.5, plan: () => ({ skill: 'hunt', args: { target: 'sheep' } }) },
  // --- night routine ---
  { name: 'sleep', category: 'rest',
    applies: (c) => !c.sleepRefused && (c.night || c.thunder || c.phase === 'night') && (c.bedKnown || c.inv.beds > 0), utility: (c) => 7 + 2 * U(c, 'energy'), plan: () => ({ skill: 'sleep', args: { max_stay_s: 120 } }) },
  { name: 'go_bed', category: 'rest',
    applies: (c) => c.phase === 'dusk' && c.bedKnown && !c.sleepLocked && c.bedDist > 4, utility: () => 6.5, plan: () => ({ skill: 'go_to', args: { place: 'bed' } }) },
  // SURV1: nearly dead, dark or under fire, not yet sealed in: seal the cell right here (no walking), then eat/heal inside. Beats take_cover (9): arrows stop at the walls.
  { name: 'dig_in', category: 'safety',
    applies: (c) => (c.bot.health ?? 20) <= 6 && (c.dark || c.hostiles > 0 || c.exposed.length > 0) && !c.sealed && !c.underground && (c.inv.blocks >= 6 || (c.inv.pickaxe > 0 && c.inv.blocks >= 1)),
    utility: () => 9.6, plan: () => ({ skill: 'dig_in', args: {} }) },
  { name: 'shelter', category: 'safety',
    applies: (c) => c.dark && (c.sealed || c.inv.blocks >= SHELTER_BLOCKS) && !((c.phase === 'night') && (c.bedKnown || c.inv.beds > 0) && !c.sleepLocked) && !(c.phase === 'dusk' && c.bedKnown && !c.sleepLocked),
    utility: () => 7, plan: () => ({ skill: 'shelter', args: {} }) },
  // keep >= 12 placeable blocks (a pillbox needs 9-10); at dusk/night with fewer than 9 this is the top priority
  { name: 'stock_blocks', category: 'resource',
    applies: (c) => c.inv.blocks < 12 && c.inv.free >= 2 && c.exposed.length === 0 && !c.sealed,
    utility: (c) => (c.dark && c.inv.blocks < SHELTER_BLOCKS ? 6 : c.dark ? 0 : 0.5 + 0.9 * (1 - c.inv.blocks / 12)), plan: () => ({ skill: 'collect', args: { resource: 'dirt', count: 12 } }) },
  { name: 'rest', category: 'rest',
    applies: (c) => U(c, 'energy') > 0.35 && !(c.night && c.bedKnown), utility: (c) => 0.3 + 2 * U(c, 'energy'), plan: () => ({ skill: 'idle_activity', args: { kind: 'rest' } }) },
  { name: 'place_torch', category: 'safety',
    applies: (c) => c.inv.torches > 0 && c.light <= 4 && !torchNear(c.bot), utility: () => 3, plan: () => ({ skill: 'place_torch', args: {} }) },
  { name: 'return_to_surface', category: 'safety',
    applies: (c) => c.underground, utility: (c) => 2 + 2 * U(c, 'safety'), plan: () => ({ skill: 'return_to_surface', args: {} }) },
  // H1: only with a reason (inventory full, low health, danger, lost) and a 5 min cool-down; the night is handled by shelter/sleep
  { name: 'return_home', category: 'safety',
    applies: (c) => !!c.returnWhy && !c.dark,
    utility: (c) => 1.4 + (c.returnWhy === 'low_health' ? 2 : c.returnWhy === 'far' ? 1 : c.returnWhy === 'before_dusk' ? 3 : 0) + 2 * U(c, 'safety'),
    plan: () => ({ skill: 'return_home', args: {} }) },
  // ROAM1: roaming, dusk close, home too far: make a camp right here (pillbox when 9+ blocks are held, else a hole with a cap); the morning exit is the shelter / leave_hole logic
  { name: 'camp_here', category: 'safety',
    applies: (c) => !!c.campWhy && !c.sealed && !c.underground,
    utility: () => 7.5, plan: (c) => (c.inv.blocks >= SHELTER_BLOCKS ? { skill: 'shelter', args: {} } : { skill: 'hole_and_cap', args: {} }) },
  { name: 'tidy', category: 'inventory',
    applies: (c) => c.inv.free <= 6 && (c.chestKnown || c.inv.chest > 0 || c.surplus > 0),
    utility: (c) => 1.4 + (6 - c.inv.free) * 0.5,
    plan: (c) => ((c.chestKnown || c.inv.chest > 0) ? { skill: 'store_in_chest', args: {} } : { skill: 'drop_junk', args: {} }) },
  { name: 'craft', category: 'crafting',
    applies: (c) => !!c.craftNext, utility: (c) => (c.craftNext === 'bed' ? 5 : 1.2), plan: (c) => ({ skill: 'craft', args: { item: c.craftNext } }) },
  { name: 'gather_wood', category: 'resource',
    applies: (c) => c.inv.free >= 2 && day(c) && c.tier < 3 && !c.depleted?.wood, utility: (c) => Math.max(0, 1.1 * (1 - (c.inv.logs + c.inv.planks / 4) / 12)) + 0.1, plan: () => ({ skill: 'gather_wood', args: { count: 4 } }) },
  { name: 'gather_stone', category: 'resource',
    applies: (c) => c.inv.free >= 2 && day(c) && c.tier < 3 && (c.inv.pickaxe > 0 || c.inv.logs + c.inv.planks / 4 >= 2) && c.inv.cobble < 32 && !c.depleted?.stone,
    utility: (c) => 0.2 + 0.8 * (1 - c.inv.cobble / 32), plan: () => ({ skill: 'gather_stone', args: { count: 8 } }) },
  { name: 'gather_coal', category: 'resource',
    applies: (c) => c.inv.free >= 2 && day(c) && c.tier < 3 && c.inv.pickaxe > 0 && c.inv.coal < 8, utility: () => 0.45, plan: () => ({ skill: 'collect', args: { resource: 'coal', count: 3 } }) },
  { name: 'pick_flowers', category: 'leisure',
    applies: (c) => c.inv.free >= 4 && day(c) && c.tier < 2, utility: (c) => 0.25 + 0.4 * U(c, 'curiosity'), plan: () => ({ skill: 'collect', args: { resource: 'plants', count: 2 } }) },
  { name: 'fish', category: 'leisure',
    applies: (c) => c.inv.rod > 0 && c.water && !c.dark, utility: (c) => 0.8 + 0.5 * U(c, 'curiosity') + HUNGER_BOOST[c.tier] * (c.inv.food < FOOD_RESERVE ? 0.7 : 0), plan: () => ({ skill: 'fish', args: {} }) },
  { name: 'explore', category: 'movement',
    applies: (c) => day(c) && !c.underground && !(c.tier >= 2 && c.inv.food === 0 && c.animals > 0 && !c.huntLocked), utility: (c) => 0.45 + 2.4 * U(c, 'curiosity'), plan: (c) => ({ skill: 'explore', args: { direction: pick(c.rng, ['north', 'south', 'east', 'west', 'any', 'any']) } }) },
  { name: 'wander', category: 'movement',
    applies: (c) => day(c) && !c.underground && !(c.tier >= 2 && c.inv.food === 0 && c.animals > 0 && !c.huntLocked), utility: (c) => 0.8 + 0.4 * U(c, 'curiosity'), plan: () => ({ skill: 'wander', args: {} }) },
  { name: 'visit_player', category: 'social',
    applies: (c) => c.players.length > 0 && day(c), utility: (c) => 0.2 + 3 * U(c, 'social'), plan: (c) => ({ skill: 'approach', args: { target: c.players[0] } }) },
  { name: 'greet', category: 'social',
    applies: (c) => c.playerNear, utility: (c) => 0.6 + 1.5 * U(c, 'social'), plan: (c) => ({ skill: c.rng() < 0.5 ? 'look_at' : 'gesture', args: c.rng() < 0.5 ? {} : { kind: 'wave' } }) },
  { name: 'idle', category: 'leisure', noLock: true,
    applies: () => true, utility: () => 0.55,
    // P1: never idle while hungry in daylight: go look for food instead
    plan: (c) => (c.tier >= 1 && day(c) && !c.underground ? { skill: 'explore', args: { direction: pick(c.rng, ['north', 'south', 'east', 'west', 'any']) } } : c.rng() < 0.5 ? { skill: 'idle_activity', args: { kind: pick(c.rng, ['look_around', 'watch_sky', 'sit']) } } : { skill: 'gesture', args: { kind: pick(c.rng, ['nod', 'shake_head', 'jump', 'crouch']) } }) },
]
