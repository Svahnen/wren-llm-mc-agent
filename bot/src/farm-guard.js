// RS3: farmland is trampled by a jump or a fall onto it (chance = fall height - 0.5; RS2 0.1.5). Two small protections, neither is a ban:
//   1. farmlandStepCost(bot): pathfinder step cost (Movements.exclusionAreasStep entry) for cells that stand on / are farmland, so A* walks around a plot when it can.
//   2. installFarmGuard(bot): while she stands on farmland the 'jump' control is dropped. A jump that is wanted for 2 s in a row (a real obstacle, the unstuck ladder)
//      is let through: being stuck on a plot is worse than one trampled tile. Every suppressed jump is counted in bot._farmGuard.
export const FARM_STEP_COST = 12
export const JUMP_RELEASE_TICKS = 40

const isFarmland = (b) => !!b && b.name === 'farmland'

/** (block) => extra step cost; pure on bot.blockAt */
export function farmlandStepCost(bot, cost = FARM_STEP_COST) {
  return (block) => {
    if (!block?.position) return 0
    if (isFarmland(block)) return cost
    try { return isFarmland(bot.blockAt(block.position.offset(0, -1, 0))) ? cost : 0 } catch { return 0 }
  }
}

/** the decision, pure: should this physics tick drop the jump control? state = { held } (ticks the jump was wanted on farmland in a row) */
export function farmJumpDecision({ jump, onFarmland, onGround, held = 0 }) {
  if (!jump || !onFarmland || !onGround) return { release: false, held: 0 }
  const h = held + 1
  return h > JUMP_RELEASE_TICKS ? { release: false, held: h, stuck: true } : { release: true, held: h }
}

export function installFarmGuard(bot) {
  if (!bot || bot._farmGuard) return () => {}
  const st = bot._farmGuard = { suppressed: 0, letThrough: 0, held: 0 }
  const tick = () => {
    try {
      const e = bot.entity; if (!e?.position) return
      const below = bot.blockAt(e.position.offset(0, -0.5, 0))
      const d = farmJumpDecision({ jump: !!bot.controlState?.jump, onFarmland: isFarmland(below), onGround: !!e.onGround, held: st.held })
      st.held = d.held
      if (d.release) { bot.setControlState('jump', false); st.suppressed++ } else if (d.stuck) st.letThrough++
    } catch { /* never break the physics tick */ }
  }
  bot.on('physicsTick', tick)
  return () => { try { bot.removeListener('physicsTick', tick) } catch { /* ignore */ } bot._farmGuard = null }
}
