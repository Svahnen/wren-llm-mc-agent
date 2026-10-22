// Sleep-pass reflection quality gate (R1). Pure, no I/O. The LLM (S2) writes her self-summary; we never write it for her, but we
// refuse to store garbage as her self-description: too short, header-like, code, or a raw echo of the prompt.
export const MIN_SUMMARY_CHARS = 200 // about 35 words; the prompt asks for 100-180 words
export const MIN_SENTENCES = 3

export function reflectionProblem(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length < MIN_SUMMARY_CHARS) return `too_short(${t.length})`
  if (/\{\s*act\s*:|```|^---/m.test(t)) return 'format'
  if (/^(STATE|What has happened since|What you wrote)/i.test(t)) return 'echo'
  const sents = t.split(/(?<=[.!?…])\s+/).filter((s) => s.length > 8)
  if (sents.length < MIN_SENTENCES) return `few_sentences(${sents.length})`
  return null
}

/** Deterministic account of the day from buildSleepDigest(). Facts only, no personality. Used as a reflection line (NOT as the
 *  self-summary) when S2 fails twice. */
export function deterministicDaySummary(d = {}) {
  const parts = []
  const kinds = Object.entries(d.kinds ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} ${k}`)
  parts.push(`Day ${d.day ?? '?'}: ${d.new_episode_count ?? 0} things happened${kinds.length ? ' (' + kinds.join(', ') + ')' : ''}.`)
  const deaths = (d.deaths ?? []).slice(0, 2).map((x) => String(x.text).replace(/\.$/, ''))
  if (deaths.length) parts.push(`I died: ${deaths.join('; ')}.`)
  const notable = (d.notable ?? []).filter((n) => n.kind !== 'death').slice(0, 3).map((n) => String(n.text).replace(/\.$/, ''))
  if (notable.length) parts.push(`Most notable: ${notable.join('; ')}.`)
  const lessons = (d.lessons ?? []).slice(0, 2).map((l) => `${l.goal_type ?? 'something'} ${l.result}`)
  if (lessons.length) parts.push(`Lessons: ${lessons.join(', ')}.`)
  return parts.join(' ').slice(0, 480)
}

/**
 * ask(nudge|null) -> Promise<string> (one LLM call). Returns {self_summary?, reflections[], source:'llm'|'llm_retry'|'fallback', problem?}.
 * self_summary is present ONLY when the text passed reflectionProblem(); on two failures a deterministic day line is returned as a
 * reflection and the existing self-summary stays untouched.
 */
export async function reflectOnce(digest, ask) {
  const nudge = 'That is too short or not a description. Write at least 5 full sentences in the first person about what has happened to you, where you were, what you liked or disliked, and what you want.'
  const clean = (x) => String(x ?? '').replace(/\s+/g, ' ').trim()
  let text = '', problem = null, errors = 0, lastErr = null
  for (let i = 0; i < 2; i++) {
    try { text = clean(await ask(i === 0 ? null : { nudge, previous: text })) } catch (e) { errors++; lastErr = e; problem = 'llm_error'; continue }
    problem = reflectionProblem(text)
    if (!problem) {
      const first = text.split(/(?<=[.!?])\s+/)[0]
      return { self_summary: text.slice(0, 1400), reflections: first && first.length > 20 ? [first.slice(0, 240)] : [], source: i ? 'llm_retry' : 'llm' }
    }
  }
  if (errors === 2) throw lastErr // S2 is down: leave the DB untouched so the next pass retries with the same material
  return { reflections: [deterministicDaySummary(digest)], source: 'fallback', problem }
}
