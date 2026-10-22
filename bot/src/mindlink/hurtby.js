// PVP1: who hurt her. PERCEPTION ONLY: attributes each loss of health to a player / mob / environment, keeps the recent hits,
// and renders them as plain facts for S2 ('X hit you (-3 hp) 5 s ago'). No trust rules, no scripted grudges: S2 interprets.
import { isIgnoredPlayer } from '../ignore-players.js'
import { entityKind } from './digest.js'

const SWING_WINDOW_MS = 1500, PLAYER_REACH = 7, MOB_REACH = 5, ARROW_REACH = 5
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export function createHurtTracker({ now = Date.now, max = 60 } = {}) {
  const hits = []            // [{t, who, kind: player|mob|env, amount, pos, day}]
  const swings = new Map()   // username -> t of the last arm swing
  let bot = null, lastHp = null
  const day = () => Math.floor((bot?.time?.age ?? 0) / 24000)

  function attribute(amount) {
    const me = bot.entity?.position, t = now()
    if (!me) return { who: 'unknown', kind: 'env' }
    // 1. a player who swung at her just now and is within reach
    const sw = []
    for (const [name, ts] of swings) {
      if (t - ts > SWING_WINDOW_MS || isIgnoredPlayer(name)) continue
      const e = bot.players?.[name]?.entity; if (!e || d3(e.position, me) > PLAYER_REACH) continue
      sw.push({ name, d: d3(e.position, me) })
    }
    if (sw.length) return { who: sw.sort((a, b) => a.d - b.d)[0].name, kind: 'player' }
    // 2. an arrow close to her: its shooter (a player holding a bow / crossbow, else a skeleton-like mob)
    const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position)
    if (ents.some((e) => e.name === 'arrow' && d3(e.position, me) <= ARROW_REACH)) {
      const arch = Object.values(bot.players ?? {}).filter((p) => p.entity && p.username !== bot.username && !isIgnoredPlayer(p.username) && /bow$/.test(p.entity.heldItem?.name ?? '') && d3(p.entity.position, me) <= 60)
        .sort((a, b) => d3(a.entity.position, me) - d3(b.entity.position, me))[0]
      if (arch) return { who: arch.username, kind: 'player', via: 'arrow' }
    }
    // 3. a hostile mob in reach
    const mob = ents.filter((e) => e.type !== 'player' && entityKind(e)?.cat === 'hostile' && d3(e.position, me) <= MOB_REACH).sort((a, b) => d3(a.position, me) - d3(b.position, me))[0]
    if (mob) return { who: entityKind(mob).name, kind: 'mob' }
    return { who: amount >= 3 && bot.entity.onGround === false ? 'a fall' : 'the environment', kind: 'env' }
  }

  const api = {
    hits,
    /** subscribe to a mineflayer bot; onHurt(hit) is called for every attributed loss of health */
    attach(b, onHurt = () => {}) {
      // DUSK1: attached right after login mineflayer has no health yet (we used to assume 20); the FIRST server health packet (e.g. 3 hp)
      // is a sync, not damage. Live: 11 of 17 'a fall' hurt_by events in 12 h were this (-16.9 at every login) and told S2 she had taken a fall.
      bot = b; lastHp = Number.isFinite(b.health) ? b.health : null
      const onSwing = (e) => { if (e?.type === 'player' && e.username) swings.set(e.username, now()) }
      const onHealth = () => {
        if (lastHp == null) { lastHp = b.health; return }
        const d = lastHp - b.health; lastHp = b.health
        if (!(d > 0.05)) return
        const a = attribute(d)
        const hit = { t: now(), ...a, amount: +d.toFixed(1), pos: b.entity?.position ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z } : null, day: day() }
        hits.push(hit); if (hits.length > max) hits.shift()
        try { onHurt(hit) } catch { /* listener errors never break perception */ }
      }
      b.on('entitySwingArm', onSwing); b.on('health', onHealth)
      return () => { b.off?.('entitySwingArm', onSwing); b.off?.('health', onHealth) }
    },
    /** most recent hit by this player within maxAgeMs (or null) */
    lastFrom(name, maxAgeMs = 30000) { const t = now(); for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (h.who === name && h.kind === 'player' && t - h.t <= maxAgeMs) return h } return null },
    /** hits within maxAgeMs grouped by source: [{who, kind, n, amount, last_t, first_t}] newest group first */
    groups(maxAgeMs = 60000) {
      const t = now(), g = new Map()
      for (const h of hits) { if (t - h.t > maxAgeMs) continue; const k = h.kind + ':' + h.who; const r = g.get(k) ?? { who: h.who, kind: h.kind, n: 0, amount: 0, first_t: h.t, last_t: h.t, pos: h.pos }; r.n++; r.amount += h.amount; r.last_t = h.t; r.pos = h.pos; g.set(k, r) }
      return [...g.values()].map((r) => ({ ...r, amount: +r.amount.toFixed(1) })).sort((a, b) => b.last_t - a.last_t)
    },
    /** players that hit her within the last `ms` (they are 'attacking now') */
    attackers(ms = 6000) { return api.groups(ms).filter((g) => g.kind === 'player').map((g) => g.who) },
  }
  return api
}

const agoS = (s) => (s < 90 ? `${Math.round(s)} s ago` : `${Math.round(s / 60)} min ago`)
/**
 * Facts for the digest. history(name) -> {today, total, talked} | null (from people.js).
 * -> {lines:[str], structured:[{who, kind, hits, hp, ago_s, today, total, single}]}
 */
export function describeHurt(tracker, history = () => null, { now = Date.now(), windowMs = 120000, where = null } = {}) {
  const lines = [], structured = []
  for (const g of tracker.groups(windowMs)) {
    const ago = Math.max(0, (now - g.last_t) / 1000), hp = g.amount
    const hist = g.kind === 'player' ? history(g.who) : null
    const loc = where && g.pos ? where(g.pos) : null
    structured.push({ who: g.who, kind: g.kind, hits: g.n, hp, ago_s: Math.round(ago), ...(hist ? { today: hist.today, total: hist.total } : {}), ...(g.kind === 'player' && now - g.last_t <= 6000 ? { attacking_now: true } : {}) })
    if (g.kind === 'player') {
      lines.push(`${g.who} ${g.n === 1 ? 'hit you' : `hit you ${g.n} times`} (−${hp} hp${g.n > 1 ? ' in all' : ''}) ${agoS(ago)}${loc ? ' ' + loc : ''}`)
      if (hist) {
        const bits = []
        if (hist.total <= g.n) bits.push(g.n === 1 ? `a single hit, and the first time ${g.who} has hurt you` : `the first time ${g.who} has hurt you`)
        else bits.push(`${g.who} has hurt you ${hist.today}x today and ${hist.total}x in all`)
        if (hist.talked) bits.push(`you have talked with ${g.who} ${hist.talked} time(s)`)
        lines.push(bits.join('; '))
      }
    } else if (g.kind === 'mob') lines.push(`a ${g.who} hurt you (−${hp} hp) ${agoS(ago)}`)
    else lines.push(`you lost ${hp} hp to ${g.who} ${agoS(ago)}`)
  }
  return { lines, structured }
}
