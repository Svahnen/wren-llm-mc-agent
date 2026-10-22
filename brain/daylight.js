// GOAL3: time awareness as plain facts (no advice): how much daylight is left, in real minutes and on the game clock.
// 24000 ticks = one game day = 20 real minutes (1200 ticks per real minute). Beds work from tick 12542 until 23459 (night) or in thunder.
import { clockFromTicks } from './goaltypes.js'
export const DUSK_TICK = 12542, DAWN_TICK = 23460, TICKS_PER_MIN = 1200
/** dg.time.ticks (0..23999, optional) -> null | {night, minToDusk, minToDawn, dusk, now}. Pure. */
export function daylightInfo(dg) {
  const t = dg?.time?.ticks
  if (!Number.isFinite(t)) return null
  const k = ((Math.floor(t) % 24000) + 24000) % 24000
  const night = k >= DUSK_TICK && k < DAWN_TICK
  const mins = (x) => Math.max(0, Math.ceil(x / TICKS_PER_MIN))
  return { night, ticks: k, minToDusk: night ? 0 : mins(k < DUSK_TICK ? DUSK_TICK - k : 24000 - k + DUSK_TICK), minToDawn: night ? mins(DAWN_TICK - k) : null, dusk: clockFromTicks(DUSK_TICK), now: clockFromTicks(k) }
}
/** the one-line fact for the digest */
export function daylightLine(dg) {
  const d = daylightInfo(dg); if (!d) return null
  if (d.night) return `daylight: it is night (clock ${d.now}); dawn in about ${d.minToDawn} min of real time`
  return `daylight: about ${d.minToDusk} min of real time left until dusk (game clock ${d.now} now, dusk at ${d.dusk}); beds work from dusk`
}
/** the note S2 gets when she wrote a routine as goal: (plain facts) */
export function routineNote(r, dg) {
  const d = daylightInfo(dg), what = r.kind === 'sleep' ? 'Sleeping' : r.kind === 'eat' ? 'Eating' : r.kind === 'heal' ? 'Healing' : 'Shelter for the night'
  let t = `${what} is a routine, not a long-term goal: it is stored as "${r.label}: ${r.trigger}" (${r.id}) and does not use one of your 3 goal slots.`
  if (r.kind === 'sleep' || r.kind === 'shelter') {
    if (d && !d.night) t += ` It is ${d.now} on the game clock; dusk is at ${d.dusk}, in about ${d.minToDusk} min of real time. Until then you have about ${d.minToDusk} minutes of daylight to use.`
    else if (d?.night) t += ' It is night now, so sleep_at_night is possible right now.'
  }
  return t + ' Pick or make up a project for your free time.'
}
