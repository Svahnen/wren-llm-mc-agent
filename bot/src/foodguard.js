// DUSK1: foods that poison. observed: S2 named `eat item=pufferfish` at hp 12.5, food 10 and
// lost 12 hp in 8 s (Poison II + Hunger III, only 1 food point); the same thing again later (hp 19 -> 4). Pufferfish is never
// worth it. Spider eye / poisonous potato poison for a few seconds (up to ~4 hp): only when there is hp to spare.
export const NEVER_FOOD = new Set(['pufferfish'])
export const POISON_MIN_HP = { spider_eye: 9, poisonous_potato: 9 }
/** true when eating `name` at `hp` would poison her to the edge. Pure. */
export function foodForbidden(name, hp = 20) {
  if (NEVER_FOOD.has(name)) return true
  const min = POISON_MIN_HP[name]
  return min != null && hp < min
}

// RS3 eat_emergency: of the foods that can hurt, only these may be eaten out of hunger (rotten flesh: 4 hunger, 80 % Hunger for 30 s; golden food is plain good food).
// Spider eye, poisonous potato, chorus fruit, suspicious stew are never eaten because she is hungry: on Easy starvation stops at 5 hearts and cannot kill her.
export const EMERGENCY_OK = new Set(['rotten_flesh', 'golden_apple', 'golden_carrot'])
