// SURV1: "screen messages" sense. A real player SEES the action bar ("You can sleep only at night or during thunderstorms"), titles and system lines;
// Wren got nothing, so a failed sleep was a silent precondition_failed. Subscribes to mineflayer 'message' (position system/game_info) and title packets,
// renders translatable components to English (the server sends translation keys), dedupes repeats, and keeps the latest few with their age.
// Player chat is NOT handled here (chat channel). Her own lines are skipped.

/** vanilla 1.21.1 en_us texts for the keys a survival body meets (used when the registry language lacks one). */
export const EN = {
  'block.minecraft.bed.no_sleep': 'You can sleep only at night or during thunderstorms',
  'block.minecraft.bed.not_safe': 'You may not rest now; there are monsters nearby',
  'block.minecraft.bed.obstructed': 'This bed is obstructed',
  'block.minecraft.bed.too_far_away': "You can't sleep now; the bed is too far away",
  'block.minecraft.bed.occupied': 'This bed is occupied',
  'block.minecraft.spawn.not_valid': 'You have no home bed or charged respawn anchor, or it was obstructed',
  'block.minecraft.set_spawn': 'Respawn point set',
  'block.minecraft.bed.not_valid': 'Your home bed was missing or obstructed',
  'sleep.not_possible': 'No amount of resting can pass this night',
  'sleep.players_sleeping': '%s/%s players sleeping',
  'sleep.skipping_night': 'Sleeping through this night',
  'container.isLocked': '%s is locked!',
  'item.minecraft.debug_stick.empty': '%s has no properties',
  'build.tooHigh': 'Height limit for building is %s blocks',
  'tile.bed.noSleep': 'You can sleep only at night or during thunderstorms',
}
const NOISE = /^(chat\.type\.|multiplayer\.player\.|death\.|commands\.|chat\.|advancements\.)/

/** chat component (object | string | array) -> plain English text. lang: optional {key: template} from the registry. */
export function renderComponent(c, lang = null) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (typeof c === 'number' || typeof c === 'boolean') return String(c)
  if (Array.isArray(c)) return c.map((x) => renderComponent(x, lang)).join('')
  const v = c.value !== undefined && c.type === undefined && typeof c.value === 'object' ? c.value : c   // nbt-ish wrapper
  let out = ''
  if (typeof v.text === 'string' || (v.text && typeof v.text === 'object' && v.text.value !== undefined)) out += typeof v.text === 'string' ? v.text : String(v.text.value)
  const tr = v.translate ? (typeof v.translate === 'string' ? v.translate : v.translate.value) : null
  if (tr) {
    const tmpl = lang?.[tr] ?? EN[tr] ?? tr
    const withs = (v.with ?? v.with?.value ?? []); const wl = Array.isArray(withs) ? withs : (withs.value ?? [])
    let i = 0
    out += tmpl.replace(/%(?:(\d+)\$)?s/g, (_m, n) => renderComponent(wl[n ? Number(n) - 1 : i++], lang))
  }
  for (const x of (v.extra ?? v.extra?.value ?? [])) out += renderComponent(x, lang)
  return out
}

export function createScreen({ now = Date.now, max = 6, dedupeMs = 4000, onMessage = null } = {}) {
  const list = []   // {text, at, pos}
  return {
    /** record one message; returns the entry or null when skipped (empty, noise, duplicate within dedupeMs) */
    add(text, { position = 'game_info', key = null, self = null } = {}) {
      const t = String(text ?? '').replace(/§./g, '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 300) return null
      if (key && NOISE.test(key)) return null
      if (position === 'chat') return null
      if (self && t.startsWith(`<${self}>`)) return null
      const at = now(), last = list.find((m) => m.text === t)
      if (last && at - last.at < dedupeMs) { last.at = at; return null }
      const e = { text: t, at, position }
      if (last) list.splice(list.indexOf(last), 1)   // a later repeat refreshes the entry (and fires again); the list holds each text once
      list.unshift(e); if (list.length > max) list.pop()
      try { onMessage?.(e) } catch { /* ignore */ }
      return e
    },
    /** latest messages as the digest wants them: [{text, ago_s}] within maxAgeS, newest first */
    recent(maxAgeS = 120, n = 3) { const t = now(); return list.filter((m) => t - m.at <= maxAgeS * 1000).slice(0, n).map((m) => ({ text: m.text, ago_s: Math.round((t - m.at) / 1000) })) },
    /** the newest message within windowMs of time `at` (for attaching to a skill failure) */
    near(at, beforeMs = 4000, afterMs = 12000) { return list.find((m) => m.at >= at - beforeMs && m.at <= at + afterMs) ?? null },
    list: () => list.slice(),
    /** wire to a mineflayer bot. Returns a detach function. */
    attach(bot) {
      const lang = () => bot.registry?.language ?? null
      const onMsg = (jm, position) => {
        if (position === 'chat') return
        let text = ''
        try { text = typeof jm?.toString === 'function' && jm.json !== undefined ? jm.toString() : renderComponent(jm, lang()) } catch { text = renderComponent(jm?.json ?? jm, lang()) }
        const key = jm?.json?.translate ?? jm?.translate ?? null
        // mineflayer's toString may leave an unknown key as its raw key: prefer our table
        let final = text
        if (key && (!text || text === key || /^[a-z0-9_.]+$/.test(text)) && EN[key]) final = renderComponent(jm?.json ?? jm, lang())
        this.add(final, { position, key, self: bot.username })
      }
      bot.on('message', onMsg)
      const title = (kind) => (p) => { try { this.add(renderComponent(typeof p?.text === 'string' ? safeJson(p.text) : p?.text, lang()), { position: kind }) } catch { /* ignore */ } }
      const tt = title('title'), st = title('subtitle')
      try { bot._client?.on('set_title_text', tt); bot._client?.on('set_title_subtitle', st) } catch { /* ignore */ }
      return () => { try { bot.off('message', onMsg); bot._client?.off('set_title_text', tt); bot._client?.off('set_title_subtitle', st) } catch { /* ignore */ } }
    },
  }
}
const safeJson = (s) => { try { return JSON.parse(s) } catch { return s } }
