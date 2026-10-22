// FOOD4: food-insecurity episodes per in-game day. An episode starts when food drops to <= 6 after she had recovered (food >= 8) and is counted once.
// Persisted (small JSON, atomic write) so a restart does not forget today's count. Perception only; brain/menu-food4.js decides how to say it.
import fs from 'node:fs'

export const EPISODE_FOOD = 6, RECOVER_FOOD = 8, KEEP_DAYS = 6
export const dayOf = (bot) => Math.floor((bot?.time?.age ?? 0) / 24000) + 1

export class FoodEpisodes {
  constructor({ file = null } = {}) {
    this.file = file; this.days = {}; this.inEpisode = false
    if (file) try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.days === 'object') { this.days = j.days; this.inEpisode = !!j.inEpisode } } catch { /* first run */ }
  }
  /** call with every digest; returns true when a new episode began */
  tick(bot) {
    const f = bot?.food; if (!Number.isFinite(f) || !bot?.time) return false
    const day = dayOf(bot); let started = false, changed = false
    if (!this.inEpisode && f <= EPISODE_FOOD) { this.inEpisode = true; this.days[day] = (this.days[day] ?? 0) + 1; started = changed = true; this.#prune(day) }
    else if (this.inEpisode && f >= RECOVER_FOOD) { this.inEpisode = false; changed = true }
    if (changed) this.save()
    return started
  }
  #prune(day) { for (const k of Object.keys(this.days)) if (+k < day - KEEP_DAYS) delete this.days[k] }
  save() { if (!this.file) return; try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ days: this.days, inEpisode: this.inEpisode })); fs.renameSync(this.file + '.tmp', this.file) } catch { /* ignore */ } }
  /** { day, today, yesterday, recent:[[day,n]] , in_episode } or null when there was never an episode */
  facts(bot) {
    const day = dayOf(bot), today = this.days[day] ?? 0, yesterday = this.days[day - 1] ?? 0
    if (!today && !yesterday) return null
    return { day, today, yesterday, in_episode: this.inEpisode }
  }
}
