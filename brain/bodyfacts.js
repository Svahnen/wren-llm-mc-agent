// PB1: TRUE body facts (Minecraft Java mechanics), derived from the real difficulty. Pure. The old prompt text implied that hunger kills; on Easy it cannot.
// Sources: wiki Hunger: starvation damage at food 0 every 4 s, but only while health > 10 (Easy), > 1 (Normal), always (Hard); natural regeneration needs food >= 18
// (fast at 20 with saturation); sprinting needs food > 6; Peaceful: no hunger loss, health regenerates.
export const STARVE_FLOOR = { peaceful: null, easy: 10, normal: 1, hard: 0 }
export const normDifficulty = (d) => { const s = String(d ?? '').toLowerCase(); return ['peaceful', 'easy', 'normal', 'hard'].includes(s) ? s : ({ 0: 'peaceful', 1: 'easy', 2: 'normal', 3: 'hard' }[d] ?? null) }
/** can hunger alone kill her here? true | false | null (unknown) */
export const hungerCanKill = (d) => (d === 'hard' ? true : d ? false : null)

export function bodyFacts(dg) {
  const d = normDifficulty(dg.difficulty), L = []
  const head = d ? `How your body works (this world is on ${d.toUpperCase()}):` : 'How your body works (the difficulty is not known to you):'
  L.push(head)
  if (d === 'peaceful') L.push('- Hunger does not drain and health regenerates by itself.')
  else if (d === 'easy') L.push('- Hunger cannot kill you here: at food 0 you slowly lose health, but only down to 10/20 (5 hearts), then it stops. Mobs, falls, fire, lava and drowning still can.')
  else if (d === 'normal') L.push('- At food 0 you slowly lose health, but only down to 1/20; hunger alone cannot finish you on Normal. Mobs, falls, fire, lava and drowning still can.')
  else if (d === 'hard') L.push('- At food 0 you slowly lose health and on Hard that CAN kill you, so do not stay at 0 food for long.')
  else L.push('- Starvation damage at food 0 is limited by difficulty (Easy: stops at 10/20, Normal: at 1/20, Hard: can kill); you do not know which applies, so treat food 0 as costly but slow (one point of health every 4 seconds).')
  L.push('- Health only comes back by itself while food is 18 or more (fast at 20). Below 18 you do not heal. At food 6 or less you cannot sprint. Walking costs almost no food; sprinting, jumping, fighting and healing do.')
  const f = dg.food, h = dg.health
  if (d !== 'peaceful') {
    if (f <= 0) L.push(`- Right now: food 0. Health is draining slowly${d === 'hard' ? ' and it can kill you' : d === 'easy' ? ' but will stop at 10/20' : ' but will stop at 1/20'}.`)
    else if (f <= 6) L.push(`- Right now: food ${f}: no healing, no sprinting. Nothing is draining yet; starvation damage starts only at food 0.`)
    else if (f < 18 && h < 20) L.push(`- Right now: food ${f} and health ${h}: you will not heal until food is 18 or more.`)
  }
  return L.join('\n')
}
