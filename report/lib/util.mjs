// Small shared helpers for the report/journal tools. Zero dependencies.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const sum = (a) => a.reduce((x, y) => x + y, 0)
export const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d)

export function pct(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))
  return a[i]
}

/** Shannon entropy in bits of a Map/object of counts; also normalised 0..1 by log2(K). */
export function entropy(counts) {
  const v = (counts instanceof Map ? [...counts.values()] : Object.values(counts)).filter((n) => n > 0)
  const tot = sum(v)
  if (!tot) return { bits: 0, norm: 0, kinds: 0 }
  const bits = Math.max(0, -sum(v.map((n) => (n / tot) * Math.log2(n / tot))))
  return { bits, norm: v.length > 1 ? bits / Math.log2(v.length) : 0, kinds: v.length }
}

export const bump = (m, k, n = 1) => { m[k] = (m[k] ?? 0) + n; return m }
export const topEntries = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)

const p2 = (n) => String(n).padStart(2, '0')
export const ymd = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
export const hm = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }
export const hourOf = (ts) => new Date(ts).getHours()
export const ymdhm = (ts) => `${ymd(ts)} ${hm(ts)}`

export function fmtDur(s) {
  s = Math.round(s ?? 0)
  if (!Number.isFinite(s) || s < 0) return 'n/a'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}
export const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(+v) ? 'n/a' : (+v).toFixed(d).replace(/\.0+$/, ''))

/** Coarse skill categories for time-share. Unknown names go to "other". */
export function categoryOf(skill) {
  const s = String(skill ?? '')
  if (/^unstuck_|^escape_/.test(s)) return 'recovery'
  if (/^(wander|explore|move_to|return_home|goto|walk)/.test(s)) return 'movement'
  if (/^(gather|collect|pick|mine|chop|dig|fish)/.test(s)) return 'gathering'
  if (/^(craft|place|build|set_home|smelt|deposit)/.test(s)) return 'making'
  if (/^(eat|hunt|sleep|rest|shelter|heal|flee|drink)/.test(s)) return 'survival'
  if (/^(gesture|talk|say|greet|interact|follow|chat)/.test(s)) return 'social'
  if (/^idle/.test(s)) return 'idle'
  return 'other'
}
export const CATEGORIES = ['movement', 'gathering', 'making', 'survival', 'social', 'idle', 'other', 'recovery']

export const humanize = (s) => String(s ?? '').replace(/_/g, ' ')

/** Compass phrase for the offset (dx east, dz south) from a reference. Minecraft: +x east, +z south. */
export function compass(dx, dz) {
  const dist = Math.round(Math.hypot(dx, dz))
  if (dist < 6) return 'right next to home'
  const ang = (Math.atan2(dx, -dz) * 180) / Math.PI // 0 = north, 90 = east
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
  return `${dist} blocks ${names[Math.round(((ang + 360) % 360) / 45) % 8]} of home`
}

/** Tiny markdown to HTML for our own journal files (headings, bullets, bold, paragraphs). Escapes everything first. */
export function mdToHtml(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
  const out = []; let list = false
  const close = () => { if (list) { out.push('</ul>'); list = false } }
  for (const line of String(md).split('\n')) {
    let mm
    if ((mm = line.match(/^(#{1,3}) (.*)/))) { close(); out.push(`<h${mm[1].length}>${inline(mm[2])}</h${mm[1].length}>`) }
    else if ((mm = line.match(/^[-*] (.*)/))) { if (!list) { out.push('<ul>'); list = true } out.push(`<li>${inline(mm[1])}</li>`) }
    else if (!line.trim()) close()
    else { close(); out.push(`<p>${inline(line)}</p>`) }
  }
  close()
  return out.join('\n')
}
