// L1: lesson hazard zones for the mineflayer pathfinder. Movements.exclusionAreasStep entries are (block) => extra step cost.
// hooks.costAt(p) is the sum of the cost providers (mindlink: lesson zones, Infinity inside a forbid radius). Finite and capped, so
// A* routes around a zone but can still leave it when she stands inside one (a huge finite cost never makes the start unreachable).
const FORBIDDEN_COST = 1500
const LAVA_COST = 1500 // never step into / land in lava, whatever the zone knowledge says
export function zoneStepCost(hooks) {
  return (block) => {
    if (!block?.position) return 0
    if (block.name === 'lava') return LAVA_COST
    if (!hooks.hasCostProviders()) return 0
    const c = hooks.costAt(block.position)
    return c === Infinity ? FORBIDDEN_COST : Math.min(c, FORBIDDEN_COST)
  }
}
