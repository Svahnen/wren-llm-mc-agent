// BAT1: shared "this resource is used up around here" memory. A gather that found nothing at a place puts that (resource, place) on a cooldown
// for every caller (S2 intents, playbook steps, habits), so the same search is not repeated 13 times in 15 minutes.
// Pure helpers on env.depleted (Map key -> {res,x,z,t,detail}); `now` is injectable for tests.
export const DEPLETED_TTL_MS = 5 * 60000
export const DEPLETED_RADIUS = 48
const HINT = { wood: 'resource_expedition resource=wood max_dist=200 (daylight) walks to a remembered or new forest', stone: 'resource_expedition resource=stone max_dist=200 (daylight) walks to a stone area', food: 'resource_expedition resource=food (daylight)' }

export function noteDepleted(env, res, pos, detail, now = Date.now()) {
  if (!env || !pos) return
  const m = (env.depleted ??= new Map())
  m.set(`${res}:${Math.round(pos.x / 16)}:${Math.round(pos.z / 16)}`, { res, x: pos.x, z: pos.z, t: now, detail: String(detail ?? '') })
  for (const [k, v] of m) if (now - v.t > DEPLETED_TTL_MS * 2) m.delete(k)
}

/** the active cooldown for `res` within DEPLETED_RADIUS of pos, or null */
export function depletedAt(env, res, pos, now = Date.now(), ttl = DEPLETED_TTL_MS) {
  if (!env?.depleted || !pos) return null
  let best = null
  for (const v of env.depleted.values()) {
    if (v.res !== res || now - v.t >= ttl) continue
    if (Math.hypot(v.x - pos.x, v.z - pos.z) > DEPLETED_RADIUS) continue
    if (!best || v.t > best.t) best = v
  }
  if (!best) return null
  const left_s = Math.max(1, Math.round((ttl - (now - best.t)) / 1000))
  const text = `on cooldown for ${left_s >= 90 ? Math.round(left_s / 60) + ' min' : left_s + ' s'}: the same search here found nothing ${Math.max(1, Math.round((now - best.t) / 1000))} s ago (${best.detail.slice(0, 110)}); ${HINT[res] ?? 'try a different area'}`
  return { left_s, text, detail: best.detail, t: best.t }
}
export const depletedMap = (env, pos, now = Date.now()) => { const o = {}; for (const r of ['wood', 'stone']) o[r] = !!depletedAt(env, r, pos, now); return o }
