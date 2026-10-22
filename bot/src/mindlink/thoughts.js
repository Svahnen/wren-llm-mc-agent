// AI1: inner thoughts (never spoken) and the speaking gate. Pure helpers + an append-only JSONL log.
// Each record carries everything a tool needs to regenerate the thought as audio bit-identically (voice, speed, emotion, seed);
// NO audio is stored. Thoughts are never dropped by rate limits (only speech is rate limited).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const HEARING_RANGE = 48

/** Same algorithm as voice/src/archive.js seedFor (copied, not imported: the voice package belongs to VS2). */
export function seedFor(text, voice, speed, emotion = 'calm') {
  return crypto.createHash('sha256').update(`${text}\u0000${voice}\u0000${speed ?? ''}\u0000${emotion}`).digest().readUInt32LE(0) & 0x7fffffff
}

/** Decide whether a SAY/template/legacy line may be heard. -> {speak, why}. Pure.
 *  near: players within hearing range; answering: a human spoke to her within 90 s; kind: say|legacy|template|started; urgent: warning. */
export function speakDecision({ kind = 'say', near = 0, answering = false, urgent = false, sinceTemplateMs = Infinity, templateGapMs = 60000 }) {
  if (kind === 'template') {
    if (answering) return { speak: true, why: 'answering' }
    if (!near) return { speak: false, why: 'nobody_near' }
    if (sinceTemplateMs < templateGapMs) return { speak: false, why: 'template_rate' }
    return { speak: true, why: 'near' }
  }
  if (answering) return { speak: true, why: 'answering' }
  if (near > 0) return { speak: true, why: urgent ? 'urgent_near' : 'near' }
  return { speak: false, why: 'nobody_near' }
}

export function muttersAllowed(lastAt, now, gapMs = 600000) { return !lastAt || now - lastAt >= gapMs }

export class ThoughtLog {
  constructor({ file, extraFile = null, now = Date.now, voiceCfg = () => ({ voice: 'af_heart', speed: null, emotion: 'calm' }) }) {
    Object.assign(this, { file, extraFile, now, voiceCfg }); this.n = 0
    for (const f of [file, extraFile]) if (f) try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch { /* ignore */ }
  }
  /** -> the record. kind: thought | mutter | demoted_say */
  add({ text, kind = 'thought', goal = null, mood = null, pos = null, gameTime = null, players = [], humanNear = false, job_id = null, intent_id = null, importance = null, why = null }) {
    const t = String(text ?? '').trim(); if (!t) return null
    const ts = this.now(), tts = this.voiceCfg()
    const rec = {
      thought_id: `th-${ts.toString(36)}-${(++this.n).toString(36)}`, ts_ms: ts, ts_iso: new Date(ts).toISOString(), game_time: gameTime,
      pos, players_near: players, human_near: !!humanNear, text: t, goal, mood, job_id, intent_id, kind, importance, why,
      tts: { voice: tts.voice, speed: tts.speed ?? null, emotion: tts.emotion ?? 'calm', seed: seedFor(t, tts.voice, tts.speed, tts.emotion ?? 'calm') },
    }
    const line = JSON.stringify(rec) + '\n'
    for (const f of [this.file, this.extraFile]) if (f) try { fs.appendFileSync(f, line) } catch { /* ignore */ }
    return rec
  }
}
