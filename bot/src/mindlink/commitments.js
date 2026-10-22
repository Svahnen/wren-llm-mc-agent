// V3: commitments = MEMORY + REMINDERS, never rules. When S2 agrees to a request from a person (follow, come, go to X, wait) the promise is written down;
// every S2 prompt shows it first, and S2 gets an EVENT when the person has been gone for a while (it decides what to do). Nothing here ends a promise by a timer:
// it ends when S2 explicitly chooses something else (recorded with its reason) or reports the goal done. Body execution of her chosen 'follow' is a re-submit of HER intent.
import fs from 'node:fs'

export const ABSENT_NOTICE_MS = 60000          // when to TELL S2 that the person is gone (an event, not a release)
const KIND_BY_GOAL = { follow: 'follow', approach: 'come', go_to: 'go_to', move_to: 'go_to' }
const WAIT_RX = /\b(wait|stay|stand)\b/i

/** Does this S2 intent (answering a person) make a promise? -> {person, kind, goal, args} | null */
export function commitmentFromIntent(it, { jobKind, speech, talkName, knownPlayer = () => false } = {}) {
  if (jobKind !== 'human_speech' || !speech) return null
  const target = it.args?.target
  const person = knownPlayer(target) ? target : talkName
  if (!person) return null
  const kind = KIND_BY_GOAL[it.goal] ?? (['idle_activity', 'gesture', 'look_at', 'none'].includes(it.goal) && WAIT_RX.test(speech) ? 'wait' : null)
  if (!kind) return null
  if ((kind === 'go_to' || kind === 'come') && !(it.args?.place || it.args?.target || it.args?.x != null)) return null
  return { person, kind, goal: it.goal, args: it.args ?? {} }
}

export class CommitmentBook {
  constructor({ file = null, now = Date.now } = {}) {
    Object.assign(this, { file, now }); this.items = []; this.n = 0
    try { if (file) { this.items = JSON.parse(fs.readFileSync(file, 'utf8')); this.n = this.items.length } } catch { /* first run */ }
  }
  save() { if (!this.file) return; try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.items.slice(-40))); fs.renameSync(this.file + '.tmp', this.file) } catch { /* ignore */ } }
  active() { return this.items.filter((c) => c.status === 'active') }
  add(c, said = '') {
    const same = this.active().find((x) => x.person === c.person && x.kind === c.kind && x.goal === c.goal)
    if (same) { same.said = said || same.said; same.renewed = this.now(); this.save(); return same }
    const rec = { id: 'c' + (++this.n), ...c, said, started: this.now(), status: 'active', absentSince: null, notified: false }
    this.items.push(rec); this.save(); return rec
  }
  end(rec, how, why = '') { if (rec.status !== 'active') return rec; Object.assign(rec, { status: how, ended: this.now(), why: String(why).slice(0, 160) }); this.save(); return rec }
  /** S2 chose an intent: promises it does not continue are ended, explicitly, with its reason (this records her choice; it does not make it). */
  onChosen(it, why = '') {
    const out = []
    if (['none', 'gesture', 'look_at'].includes(it.goal)) return out   // small acts inside a promise do not break it
    for (const c of this.active()) {
      const keeps = it.goal === c.goal && (c.kind !== 'follow' || it.args?.target === c.args?.target)
      if (!keeps) out.push(this.end(c, 'broken_by_choice', `${it.goal}${why ? ': ' + why : ''}`))
    }
    return out
  }
  /** The prompt block: first thing S2 reads. present(name) -> {dist}|null (null = not in hearing range). */
  reminders(present = () => null) {
    const t = this.now()
    return this.active().map((c) => {
      const ago = Math.round((t - c.started) / 1000), when = ago < 90 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`
      const p = present(c.person)
      const where = p ? `they are ${Math.round(p.dist)} m away` : `they are not in hearing range${c.absentSince ? ` (${Math.round((t - c.absentSince) / 1000)} s)` : ''}`
      const verb = { follow: 'follow them', come: 'come to them', go_to: `go to ${c.args?.place ?? c.args?.target ?? 'where they said'}`, wait: 'wait for them' }[c.kind] ?? c.kind
      return `You promised ${c.person} to ${verb} ${when}${c.said ? ` (you said: "${String(c.said).slice(0, 80)}")` : ''}; ${where}. Keep it, or end it yourself with an abandon line and a reason.`
    })
  }
  /** Presence bookkeeping. -> commitments whose person has now been gone ABSENT_NOTICE_MS and S2 was not told yet (S2 decides; nothing is released here). */
  checkPresence(present = () => null, loggedOff = () => false) {
    const t = this.now(), out = []
    for (const c of this.active()) {
      if (present(c.person)) { c.absentSince = null; c.notified = false; continue }
      c.absentSince ??= t
      if (!c.notified && t - c.absentSince >= ABSENT_NOTICE_MS) { c.notified = true; out.push({ c, logged_off: loggedOff(c.person) }) }
    }
    if (out.length) this.save()
    return out
  }
}
