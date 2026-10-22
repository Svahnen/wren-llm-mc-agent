// PB1: built-in step operations that are more than one skill call. Each: async (x, step, args) -> {status:'done'|'failed'|'skipped', reason?, detail?}
//   x = { bot(), runSkill(name,args), sleep, now, notify(kind,text,data), params, state, env, aborted(), screenRecent?, log }
import { isIgnoredPlayer } from '../ignore-players.js'
import { placePos, personEntity } from './predicates.js'
import { straightHops } from '../s1/trails.js'
import { compass8 } from '../../../brain/goaltypes.js'

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const ok = (extra = {}) => ({ status: 'done', ...extra })
const fail = (reason, extra = {}) => ({ status: 'failed', reason, ...extra })
const PREEMPT = /preempt|reflex|superseded|unstuck/

/** walk toward goal in short straight hops; stopIf() is evaluated between hops. -> {status, reason} */
export async function hopTo(x, goal, { hop = 24, radius = 4, stopIf = null, tries = 3 } = {}) {
  let fails = 0
  for (let guard = 0; guard < 60; guard++) {
    const bot = x.bot(); if (!bot?.entity) return fail('no_body')
    if (x.aborted()) return fail('aborted')
    const me = bot.entity.position
    if (dxz(me, goal) <= radius + 1.5) return ok()
    if (stopIf && (await stopIf())) return ok({ detail: 'stopped' })
    const wp = straightHops(me, goal, hop)[0]
    const r = await x.runSkill('move_to', { x: Math.round(wp.x), y: Math.round(wp.y), z: Math.round(wp.z), radius: wp === straightHops(me, goal, hop).at(-1) ? radius : 4 })
    if (r.status === 'done') { fails = 0; continue }
    if (r.status === 'aborted' && PREEMPT.test(r.reason ?? '') || (r.status === 'rejected' && /busy|unstuck/.test(r.reason ?? ''))) return { status: 'interrupted', reason: r.reason }
    if (r.status === 'aborted') return fail(r.reason ?? 'aborted')
    if (++fails >= tries) return fail('unreachable', { detail: r.reason })
    // sidestep: aim a few blocks off the straight line
    const ang = Math.atan2(goal.z - me.z, goal.x - me.x) + (fails % 2 ? 0.6 : -0.6)
    await x.runSkill('move_to', { x: Math.round(me.x + Math.cos(ang) * 10), y: Math.round(me.y), z: Math.round(me.z + Math.sin(ang) * 10), radius: 4 })
  }
  return fail('too_many_hops')
}

export const OPS = {
  /** locate a person: visible entity within render distance, else wait up to max_s */
  async find_person(x, step, a) {
    const p = a.person, t0 = x.now(); let said = false
    if (isIgnoredPlayer(p) || !x.bot().players?.[p]) return fail('person_offline')
    while (x.now() - t0 < (a.max_s ?? 40) * 1000) {
      if (x.aborted()) return fail('aborted')
      const e = personEntity(x.bot(), p)
      if (e) { x.state.personDist = Math.round(d3(e.position, x.bot().entity.position)); return ok() }
      if (!said && x.now() - t0 > 8000) { said = true; x.notify('person_not_visible', `${p} is online but you cannot see them from here. Waiting a little; tell them to come to you if you want.`, { person: p }) }
      await x.sleep(1000)
    }
    return fail('person_not_found')
  },
  async approach_person(x, step, a) {
    for (let i = 0; i < 3; i++) {
      const e = personEntity(x.bot(), a.person); if (!e) return fail('person_not_visible')
      if (d3(e.position, x.bot().entity.position) <= (a.radius ?? 6) + 1.5) return ok()
      const r = await x.runSkill('approach', { target: a.person })
      if (r.status === 'aborted' && PREEMPT.test(r.reason ?? '')) return { status: 'interrupted', reason: r.reason }
    }
    const e = personEntity(x.bot(), a.person)
    return e && d3(e.position, x.bot().entity.position) <= (a.radius ?? 6) + 3 ? ok() : fail('could_not_reach_person')
  },
  /** a prompt for S2 (facts + invitation to speak); the words are never authored here */
  async cue(x, step, a) {
    const bot = x.bot(), pos = a.place ? placePos(x, a.place) : null
    const dist = pos ? Math.round(dxz(pos, bot.entity.position)) : '?'
    const dir = pos ? compass8(pos.x - bot.entity.position.x, pos.z - bot.entity.position.z) ?? 'here' : '?'
    const text = String(a.text ?? '').replace(/\$place_dist/g, dist).replace(/\$place_dir/g, dir).replace(/\$(\w+)/g, (m, k) => x.params[k] ?? m)
    x.notify(a.cue ?? 'cue', text, { cue: a.cue })
    return ok()
  },
  /** walk to the place with the person: hop, check they follow, wait if they fall behind, give up politely if they are lost */
  async escort(x, step, a) {
    const goal = placePos(x, a.place); if (!goal) return fail('unknown_place')
    const radius = a.radius ?? 4, fr = a.follow_radius ?? 10, waitMax = (a.wait_max_s ?? 90) * 1000
    let waited = 0, lostSince = null, behindNoted = false
    const st = (x.state.escort ??= { hops: 0, waits: 0, waited_s: 0, lost: 0 })
    for (let guard = 0; guard < 400; guard++) {
      const bot = x.bot(); if (!bot?.entity) return fail('no_body')
      if (x.aborted()) return fail('aborted')
      const me = bot.entity.position
      if (dxz(me, goal) <= radius + 1.5) return ok({ detail: `arrived after ${st.hops} hops, waited ${st.waited_s}s` })
      const e = personEntity(bot, a.person)
      const dist = e ? d3(e.position, me) : Infinity
      if (!e || dist > fr * 2.2) {
        lostSince ??= x.now()
        if (!behindNoted) { behindNoted = true; st.lost++; x.notify('person_behind', `${a.person} fell behind (${e ? Math.round(dist) + ' m' : 'out of sight'}). You are waiting for them on the way to ${a.place}.`, { person: a.person, dist: Number.isFinite(dist) ? Math.round(dist) : null }) }
        if (waited >= waitMax) { x.notify('person_lost', `${a.person} did not catch up in ${Math.round(waitMax / 1000)} s; you stopped the walk to ${a.place}.`, { person: a.person }); return fail('person_lost') }
        try { await x.abortCurrent?.() } catch { /* ignore */ }
        if (e) { try { await x.bot().lookAt(e.position.offset(0, 1.6, 0)) } catch { /* ignore */ } }
        await x.sleep(1000); waited += 1000; st.waits++; st.waited_s = Math.round(waited / 1000); continue
      }
      if (dist > fr) { // a bit behind: stand and let them close up
        try { await x.bot().lookAt(e.position.offset(0, 1.6, 0)) } catch { /* ignore */ }
        await x.sleep(1000); waited += 1000; st.waits++; st.waited_s = Math.round(waited / 1000)
        if (waited >= waitMax) return fail('person_lost')
        continue
      }
      lostSince = null; behindNoted = false
      const wp = straightHops(me, goal, a.hop ?? 16)[0]
      st.hops++
      const r = await x.runSkill('move_to', { x: Math.round(wp.x), y: Math.round(wp.y), z: Math.round(wp.z), radius: 3 })
      if (r.status === 'aborted' && PREEMPT.test(r.reason ?? '') || (r.status === 'rejected' && /busy|unstuck/.test(r.reason ?? ''))) return { status: 'interrupted', reason: r.reason }
      if (r.status === 'aborted') return fail(r.reason ?? 'aborted')
      if (r.status !== 'done') {
        st.hopFails = (st.hopFails ?? 0) + 1
        if (st.hopFails >= 4) return fail('unreachable', { detail: r.reason })
        const ang = Math.atan2(goal.z - me.z, goal.x - me.x) + (st.hopFails % 2 ? 0.7 : -0.7)
        await x.runSkill('move_to', { x: Math.round(me.x + Math.cos(ang) * 10), y: Math.round(me.y), z: Math.round(me.z + Math.sin(ang) * 10), radius: 4 })
      }
    }
    return fail('too_many_hops')
  },
  async wait_for_person(x, step, a) {
    const t0 = x.now()
    while (x.now() - t0 < (a.max_s ?? 45) * 1000) {
      if (x.aborted()) return fail('aborted')
      const e = personEntity(x.bot(), a.person)
      if (e && d3(e.position, x.bot().entity.position) <= (a.radius ?? 8)) return ok()
      await x.sleep(1000)
    }
    return fail('person_not_arrived')
  },
  async mark_origin(x) { const p = x.bot().entity.position; x.state.origin = { x: p.x, y: p.y, z: p.z }; return ok() },
  async go_origin(x, step, a) { if (!x.state.origin) return fail('no_origin'); const r = await hopTo(x, x.state.origin, { hop: 30, radius: a.radius ?? 5 }); return r },
  /** walk toward the nearest remembered herd */
  async route_food(x) {
    const t = x.now(), me = x.bot().entity.position; let best = null
    for (const f of x.env?.foodSeen?.values?.() ?? []) { if (t - f.t > 360000) continue; const d = d3(f, me); if (d > 6 && (!best || d < best.d)) best = { ...f, d } }
    if (!best) return fail('no_food_source_known')
    const animalsNear = () => Object.values(x.bot().entities ?? {}).some((e) => e?.position && ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(e.name) && d3(e.position, x.bot().entity.position) <= 24)
    return hopTo(x, best, { hop: 24, radius: 8, stopIf: async () => animalsNear() })
  },
  async wait(x, step, a) { await x.sleep(a.ms ?? 1000); return ok() },
  async fail(x, step, a) { return fail(a.reason ?? 'failed') },
  /** read the game's own messages (action bar / system lines) and hand them to S2 */
  async screen_report(x) {
    const msgs = x.screenRecent?.(60, 3) ?? []
    if (msgs.length) x.notify('screen', `The game said: ${msgs.map((m) => `"${m.text}"`).join('; ')}`, { messages: msgs })
    return ok({ detail: msgs.map((m) => m.text).join(' | ') })
  },
}
