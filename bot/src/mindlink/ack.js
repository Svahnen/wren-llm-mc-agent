// VAL2: spoken acknowledgement. When a human addresses her by voice and S2 has not answered within ~1.5 s she says ONE short natural filler
// ('Hm, let me think.', 'One sec.', 'Mm?') so the silence does not read as ignoring. Pure decision + template code; index.js wires it.
//  - once per utterance (heard id), never when her real answer is already spoken/queued, nor when it is about to start (< ack_min_remaining_ms),
//    never over a human who is still talking or while she is speaking, never for acknowledgements (isAck) or typed chat.
//  - the line is chosen at random from a small template set per situation (question / request / other), never the same one twice in a row.
//  - WREN_ACK=on|off (default on).
export const ACK_DELAY_MS = 1500
export const ACK_MIN_REMAINING_MS = 500

export const ACK_TEMPLATES = Object.freeze({
  question: ['Hm, let me think.', 'Good question, one sec.', 'Mm, let me think.', 'Hm, one moment.'],
  request: ['Sure, one sec.', 'On it, one moment.', 'Okay, one sec.'],
  other: ['Mm?', 'One sec.', 'Hm, let me think.', 'Mm, one moment.'],
})

export const ackEnabled = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.WREN_ACK ?? 'on').trim())

export function situationOf(text) {
  const t = String(text ?? '').trim().toLowerCase()
  if (/^(can|could|would|will) you\b/.test(t)) return 'request'
  if (/\?\s*$/.test(t) || /^(what|why|how|where|when|who|which|do you|are you|did you|is there|have you)\b/.test(t)) return 'question'
  if (/^(please\b|go\b|come\b|follow\b|stop\b|wait\b|bring\b|get\b|give\b|show\b|build\b|make\b|craft\b|mine\b|dig\b|look\b|hold\b|help\b|let's\b|let us\b)/.test(t)) return 'request'
  return 'other'
}

export function pickAck(text, { rng = Math.random, last = null } = {}) {
  const set = ACK_TEMPLATES[situationOf(text)]
  const pool = set.filter((s) => s !== last)
  return (pool.length ? pool : set)[Math.floor(rng() * (pool.length || set.length)) % (pool.length || set.length)]
}

/**
 * Should the filler be spoken NOW? s = { enabled, heardId, doneIds:Set, voiceUp, speaking, queued, humanTalking, answered, lastSayAt, sentAt, etaMs }
 * etaMs: estimated ms until S2's answer starts (null = unknown). -> { ok } | { ok:false, reason }
 */
export function ackDecision(s, { minRemainingMs = ACK_MIN_REMAINING_MS } = {}) {
  if (!s.enabled) return { ok: false, reason: 'off' }
  if (s.doneIds?.has(s.heardId)) return { ok: false, reason: 'once_per_utterance' }
  if (!s.voiceUp) return { ok: false, reason: 'voice_down' }
  if (s.answered || (s.lastSayAt ?? 0) >= s.sentAt) return { ok: false, reason: 'answered' }
  if (s.speaking || s.queued) return { ok: false, reason: 'speaking' }
  if (s.humanTalking) return { ok: false, reason: 'human_talking' }
  if (s.etaMs != null && s.etaMs < minRemainingMs) return { ok: false, reason: 'answer_imminent' }
  return { ok: true }
}
