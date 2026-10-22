// FOOD4: a hungry, foodless body may take the body from NON-URGENT s1 work to hunt a visible animal or forage plants.
// observed: `hunt` was rejected busy under s1:shelter (twice, daylight), s1:explore (forage_plants) while food swung 0 -> 8 -> 4 at hp 8.
// Reflexes (eat, flee, creeper_distance, fire, drowning) and equal-priority urgent work (dig_in, sleep, take_cover, fight, defend, flee) are never preempted.
import { inventoryFacts } from './habits/needs.js'
import { phase } from './habits/safety.js'
import { hostilesAround } from './reflex/threats.js'
import { timeOfDay } from './skills/lib.js'

export const FOOD_PREEMPT_SKILLS = new Set(['hunt', 'forage_plants'])
export const HUNGRY_FOOD = 6
/** non-urgent at any safe time of day */
export const YIELD_ANYTIME = new Set(['explore', 'wander', 'idle', 'pick_flowers', 'fish', 'visit_player', 'gather_wood', 'gather_stone', 'collect', 'craft', 'idle_activity'])
/** sitting in cover / walking home: only given up in clear daylight with hours to dusk and no hostile near */
export const YIELD_DAYTIME = new Set(['shelter', 'return_home'])
export const SAFE_UNTIL_TICK = 9500   // 3000 ticks (2.5 real min) before night at 12542

/** -> { yes, why } whether skill `skill` (owner s1/s2) may take the body from the current holder label (owner s1). */
export function mayPreemptForFood(bot, skill, holder) {
  if (!FOOD_PREEMPT_SKILLS.has(skill) || !holder || holder.owner !== 's1') return { yes: false, why: 'not_applicable' }
  if (!(bot?.food <= HUNGRY_FOOD)) return { yes: false, why: 'not_hungry' }
  let facts; try { facts = inventoryFacts(bot) } catch { return { yes: false, why: 'no_facts' } }
  if (facts.food > 0) return { yes: false, why: 'holds_food' }
  const label = holder.label
  if (YIELD_ANYTIME.has(label)) return { yes: true, why: `s1:${label} is non-urgent` }
  if (YIELD_DAYTIME.has(label)) {
    if (phase(bot) !== 'day' || timeOfDay(bot) > SAFE_UNTIL_TICK) return { yes: false, why: 'dusk_or_night' }
    let hostile = true; try { hostile = hostilesAround(bot, 16).length > 0 } catch { /* keep true */ }
    if (hostile) return { yes: false, why: 'hostile_near' }
    return { yes: true, why: `s1:${label} in clear daylight` }
  }
  return { yes: false, why: 'holder_urgent' }
}
