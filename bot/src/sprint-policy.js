// PB1: food-conserving movement policy (S1 body policy, not an S2 decision). Vanilla: walking costs no hunger, sprinting 0.1 exhaustion/m, sprint-jumping 0.2, jumping 0.05.
// Default: Movements.allowSprinting=false and allowParkour=false. Sprint only when (a) fleeing/fighting a REAL threat (reflex/threats.js relevantThreat),
// (b) S2 asked for high urgency (modulator urgency >= 0.8), (c) a long trip (goal > 40 m away) while food >= 18 (no healing pending, nothing to lose).
import { hostilesAround } from './reflex/threats.js'

export const URGENT_AT = 0.8, LONG_TRIP_M = 40, SPRINT_FOOD = 18

/** pure: -> { sprint:boolean, reason } */
export function sprintDecision({ threat = false, urgency = 0, tripM = 0, food = 20 } = {}) {
  if (threat) return { sprint: true, reason: 'threat' }
  if (urgency >= URGENT_AT) return { sprint: true, reason: 'urgent' }
  if (tripM > LONG_TRIP_M && food >= SPRINT_FOOD) return { sprint: true, reason: 'long_trip_fed' }
  return { sprint: false, reason: food <= 6 ? 'food_low' : 'conserve' }
}

/** make Movements conservative (call where Movements are created) */
export function conservativeMovements(mv) { mv.allowSprinting = false; mv.allowParkour = false; return mv }

/** 1 Hz policy loop: flips bot.pathfinder.movements.allowSprinting and logs sprint_on / sprint_off with the reason. Returns a stop function. */
export function installSprintPolicy(bot, { trace = null, getUrgency = () => bot._urgency ?? 0, everyMs = 1000, now = Date.now } = {}) {
  let on = false, since = 0, stats = bot._sprintStats = { on: 0, off: 0, reasons: {} }
  const tick = () => {
    const mv = bot.pathfinder?.movements; if (!mv || !bot.entity) return
    let threat = false; try { threat = hostilesAround(bot, 16).length > 0 } catch { /* ignore */ }
    const g = bot.pathfinder?.goal, me = bot.entity.position
    const tripM = g && Number.isFinite(g.x) && Number.isFinite(g.z) ? Math.hypot(g.x - me.x, g.z - me.z) : 0
    const d = sprintDecision({ threat, urgency: getUrgency(), tripM, food: bot.food ?? 20 })
    if (d.sprint !== on) {
      on = d.sprint; since = now(); mv.allowSprinting = on
      stats[on ? 'on' : 'off']++; stats.reasons[d.reason] = (stats.reasons[d.reason] ?? 0) + 1
      trace?.event(on ? 'sprint_on' : 'sprint_off', { reason: d.reason, food: bot.food, trip_m: Math.round(tripM) })
    } else if (mv.allowSprinting !== on) mv.allowSprinting = on
  }
  const t = setInterval(tick, everyMs); t.unref?.()
  return () => clearInterval(t)
}
