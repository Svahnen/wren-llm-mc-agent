// VINT: who is who. Identity key = the player NAME exactly as typed (offline-mode server: anyone can join under any name, no whitelist),
// so a changed name is a NEW person. The uuid is recorded and a different uuid under a known name is flagged, not trusted.
import { isIgnoredPlayer } from '../ignore-players.js'
import fs from 'node:fs'

const clamp = (x) => Math.max(0, Math.min(1, x))
export class PeopleBook {
  constructor(file = null, now = Date.now) { this.file = file; this.now = now; this.p = new Map(); try { if (file) for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) this.p.set(r.name, r) } catch { /* first run */ } }
  /** One interaction with `name`. -> {rec, first, uuidChanged} */
  meet(name, { uuid = null, topic = null, via = 'chat', dist = null } = {}) {
    if (isIgnoredPlayer(name)) return { rec: null, first: false, uuidChanged: false, ignored: true }   // PB3: test bots never enter memory
    const t = this.now(); let r = this.p.get(name); const first = !r
    if (!r) { r = { name, uuid, uuids: uuid ? [uuid] : [], first_t: t, last_seen: t, interactions: 0, voice: 0, topics: [], familiarity: 0, trust: 0.1, uuid_changes: 0 }; this.p.set(name, r) }
    let uuidChanged = false
    if (uuid && !r.uuids.includes(uuid)) { if (r.uuids.length) { r.uuid_changes++; uuidChanged = true } r.uuids.push(uuid); r.uuids = r.uuids.slice(-4); r.uuid = uuid }
    r.last_seen = t; r.interactions++; if (via === 'voice') r.voice++
    if (topic) { r.topics.push(String(topic).slice(0, 80)); r.topics = r.topics.slice(-5) }
    r.familiarity = +clamp(Math.log1p(r.interactions) / Math.log(40)).toFixed(2)
    r.trust = +clamp(0.1 + 0.02 * r.interactions - 0.2 * r.uuid_changes).toFixed(2) // slow, simple; a new uuid under the same name costs trust
    this.save()
    return { rec: r, first, uuidChanged }
  }
  get(name) { return this.p.get(name) ?? null }
  /** PVP1: a fact, not a verdict. Records that `name` hurt her (amount hp, game day, where); trust/familiarity are NOT touched: S2 interprets the counts. */
  hurt(name, { amount = 0, day = 0, where = null } = {}) {
    if (isIgnoredPlayer(name)) return null
    const t = this.now(); let r = this.p.get(name)
    if (!r) { this.meet(name, { topic: null }); r = this.p.get(name); r.interactions-- }   // first sight is a meeting; the hit itself is not a conversation
    r.hurts = [...(r.hurts ?? []), { t, day, amount: +Number(amount).toFixed(1), ...(where ? { where } : {}) }].slice(-40); r.hurt_total = (r.hurt_total ?? 0) + 1
    this.save(); return r
  }
  /** -> {today, total, talked, last_t} for the digest (today = same game day) */
  hurtHistory(name, day = 0) {
    const r = this.p.get(name); if (!r) return null
    const hs = r.hurts ?? []
    return { today: hs.filter((h) => h.day === day).length, total: r.hurt_total ?? 0, talked: r.interactions ?? 0, last_t: hs.at(-1)?.t ?? null }
  }
  /** Memory lines for the prompt: only people who are around right now. */
  nearbyLines(names) {
    const t = this.now(); const out = []
    for (const n of names) {
      const r = this.p.get(n); if (!r) continue
      const ago = Math.round((t - r.first_t) / 60000)
      out.push(`${r.name}: talked with ${r.interactions} time(s)${r.voice ? ` (${r.voice} by voice)` : ''}, first met ${ago < 2 ? 'just now' : ago < 120 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago'}, familiarity ${r.familiarity}, trust ${r.trust}${r.topics.length ? `, last talked about "${r.topics.at(-1)}"` : ''}${r.uuid_changes ? ', NOTE: a different account has used this name' : ''}${r.hurt_total ? `; has hurt you ${r.hurt_total} time(s)${r.hurts?.length ? ', last ' + this.ago(t - r.hurts.at(-1).t) + (r.hurts.at(-1).where ? ' ' + r.hurts.at(-1).where : '') : ''}` : ''}`)
    }
    return out
  }
  ago(ms) { const m = Math.round(ms / 60000); return m < 2 ? 'just now' : m < 120 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago' }
  save() { if (!this.file) return; try { fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.p.values()])); fs.renameSync(this.file + '.tmp', this.file) } catch { /* ignore */ } }
}
