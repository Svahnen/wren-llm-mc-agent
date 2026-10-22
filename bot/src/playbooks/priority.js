// PB1: priority calibration. Commitments to people and long-term goals keep priority; hunger is queued as an "after this" note unless it really matters.
// Hunger interrupts a running playbook ONLY when food <= 6 AND (hp < 10 OR a food source is within ~16 m (incl. food in the pack)).
// Danger (a real threat per reflex/threats.js relevantThreat) is handled by the reflexes and by S1's safety yield, and always interrupts; the playbook resumes at its step.
export const HUNGER_FOOD = 6, HUNGER_HP = 10, HUNGER_SRC_M = 16

/** -> { interrupt: boolean, defer: boolean, why } . src = distance in blocks to the nearest food (0 = in the pack), Infinity if none known. */
export function hungerPolicy({ food = 20, hp = 20, src = Infinity } = {}) {
  if (!(food <= HUNGER_FOOD)) return { interrupt: false, defer: false, why: 'not_hungry_enough' }
  if (hp < HUNGER_HP) return { interrupt: true, defer: false, why: 'low_food_and_hurt' }
  if (src <= HUNGER_SRC_M) return { interrupt: true, defer: false, why: 'low_food_and_food_close' }
  return { interrupt: false, defer: true, why: 'low_food_no_food_close' }
}
export const afterThisNote = (food) => `get food (food ${Math.round(food)}/20)`

// FOOD3: playbooks that can wait while she is starving with nothing to eat. A hungry, foodless body does not ring torches or walk home in daylight;
// the food plan (get_food / hunt / forage) goes first. Shelter, digging in, sleeping and getting food itself are never in this set.
export const NON_URGENT = new Set(['torch_perimeter', 'go_home', 'breed_animals', 'animal_pen', 'make_tools', 'craft', 'farm_plot', 'wall_ring', 'simple_hut', 'seed_hunt', 'bootstrap_kit', 'make_torches', 'chicken_loop', 'bonemeal_grass', 'bonemeal_ripen'])
/** true when starting/continuing playbook `name` should give way to getting food. night = true keeps go_home (shelter at dusk) alive. */
export function yieldsToFood(name, { food = 20, hasFood = false, night = false } = {}) {
  if (!NON_URGENT.has(name)) return false
  if (!(food <= HUNGER_FOOD) || hasFood) return false
  if (name === 'go_home' && night) return false
  return true
}

// FOOD4: fishing needs a rod. Offered/started only with a rod in the pack or the means to craft one (3 sticks, or 2 planks / 1 log that become sticks, + 2 string).
export const rodStatus = ({ rod = 0, string = 0, sticks = 0, planks = 0, logs = 0 } = {}) => {
  if (rod > 0) return { ok: true, have: true }
  if (string < 2) return { ok: false, reason: 'no_rod', text: `no fishing rod and ${string} string (a rod is 3 sticks + 2 string; string comes from spiders)` }
  if (sticks >= 3 || planks >= 2 || logs >= 1) return { ok: true, have: false }
  return { ok: false, reason: 'no_rod', text: `no fishing rod: you have ${string} string and ${sticks} stick${sticks === 1 ? '' : 's'}; a rod is 3 sticks + 2 string (2 planks make sticks)` }
}
