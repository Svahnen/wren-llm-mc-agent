// PB3: spare test bots (WrenT1, WrenT2, ...) are not people. ONE place decides who is ignored everywhere Wren perceives players.
// Override with env WREN_IGNORE_PLAYERS (comma separated; each item a name or a /regex/).
const DEFAULT = ['/^WrenT\\d+$/i']
function compile(spec) {
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^\/(.*)\/([a-z]*)$/.exec(s)
    if (m) { try { const re = new RegExp(m[1], m[2]); return (n) => re.test(n) } catch { return () => false } }
    const lo = s.toLowerCase(); return (n) => n.toLowerCase() === lo
  })
}
export function isIgnoredPlayer(name, spec = process.env.WREN_IGNORE_PLAYERS ?? DEFAULT.join(',')) {
  if (typeof name !== 'string' || !name) return false
  return compile(spec).some((f) => f(name))
}
/** drop test bots from a list of names or {name|username} records */
export const humansOnly = (list) => (list ?? []).filter((x) => !isIgnoredPlayer(typeof x === 'string' ? x : (x?.username ?? x?.name)))
