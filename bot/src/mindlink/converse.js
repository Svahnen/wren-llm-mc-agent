// V3: conversation rules for a voice dialogue. Pure functions (index.js wires them), so they are unit-testable.
//  - isAck: 'Yeah.' / 'mhm' / 'okay' are acknowledgements, not questions: no answer job (and never a flush; the voice service is the one barge-in authority).
//  - answerGate: exactly ONE answer per human utterance; later jobs (heartbeat, drive wake, idle re-prompt) may only add a real follow-up.
//  - convoFact: a movement skill that takes her away from a conversation partner is reported to S2 as a FACT (S2 decides; V3 adds no rule).
export const CONVO_MS = 45000          // a conversation is 'active' this long after the last exchange
export const CONVO_NEAR = 8            // blocks
export const FOLLOWUP_GAP_MS = 20000   // a follow-up needs at least this much quiet since her last spoken line
// movement skills that carry her away from the person she is talking to
export const AWAY_GOALS = new Set(['explore', 'move_to', 'go_to', 'hunt', 'collect', 'flee_far', 'sleep', 'approach_far'])

const ACK_WORDS = new Set('yeah yes yep yup ya okay ok k mhm mmhm mm hmm hm uh um er ah oh huh aha right sure alright all fine cool nice good great i see got it thanks thank you well so then and true indeed really wow go on ahead'.split(' '))
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z']+/g) ?? [])
export const jaccard = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n) }

/** Is this transcript only an acknowledgement / filler? An answer to a question she asked a moment ago ('Yes.') is NOT one. */
export function isAck(text, { classify, lastSayText = null, lastSayAt = 0, now = Date.now(), nameRx = /\b(?:wren)\b/i } = {}) {
  const c = classify(text, { nameRx })
  if (!['backchannel', 'filler', 'nonspeech'].includes(c.kind)) return false
  const toks = String(text).toLowerCase().replace(/’/g, "'").match(/[a-z']+/g) ?? []
  if (!toks.length || !toks.every((w) => ACK_WORDS.has(w))) return false   // 'hi it is me' is not an acknowledgement: closed list only
  if (c.name || c.stop) return false
  if (lastSayText && /\?\s*$/.test(String(lastSayText).trim()) && now - lastSayAt < 15000) return false   // she asked, he says 'yes'
  return true
}

/**
 * Should a spoken line be said, for the voice thread `th` ({heardId, answeredId, lastAt}) ?
 * jobKind: scheduler job that produced it (human_speech | heartbeat | drive_wake | ...); answers: utterance ids that job was answering.
 * -> {ok} | {ok:false, reason}
 */
export function answerGate({ th, jobKind, answers = [], lastSayAt = 0, lastSays = [], text = '', now = Date.now(), urgent = false }) {
  if (!th || urgent) return { ok: true }
  const newest = th.heardId ?? 0, answered = th.answeredId ?? 0
  const maxAns = answers.length ? Math.max(...answers) : null
  if (jobKind === 'human_speech' && maxAns != null) {
    if (maxAns <= answered) return { ok: false, reason: 'already_answered' }
    if (maxAns < newest) return { ok: false, reason: 'stale_answer' }   // a newer utterance of this person exists: the newest gets the answer
    return { ok: true, answers: maxAns }
  }
  if (newest > answered) return { ok: false, reason: 'unanswered_belongs_to_answer_job' }     // only the answer job answers; others stay quiet
  // later job, utterance already answered: a follow-up only if the conversation is still active, she was quiet a while, and it adds something new
  if (now - (th.lastAt ?? 0) > CONVO_MS) return { ok: true }                                  // not a conversation any more: ordinary speech rules apply
  if (now - lastSayAt < FOLLOWUP_GAP_MS) return { ok: false, reason: 'already_answered' }
  if (lastSays.some((s) => jaccard(s, text) >= 0.4)) return { ok: false, reason: 'repeat' }
  return { ok: true, followup: true }
}

/**
 * Facts (never a rule) for S2 when a movement skill is about to carry her away from someone she is talking with.
 * -> string | null. The body executes her choice; she sees the fact in her next prompt and decides.
 */
export function convoFact({ goal, talk, now = Date.now(), dist = null }) {
  if (!talk || now - talk.at > CONVO_MS || !AWAY_GOALS.has(goal)) return null
  const d = dist ?? talk.dist
  if (!(d <= CONVO_NEAR)) return null
  return `${talk.name} talked with you ${Math.round((now - talk.at) / 1000)} s ago and is ${Math.round(d)} m away; ${goal} takes you away from them`
}
