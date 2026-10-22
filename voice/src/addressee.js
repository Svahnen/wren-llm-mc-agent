// Who is a player talking to? A player within NEAR blocks speaking is addressed to her; anyone saying her name within FAR blocks too.
// V3: a speaker she is in an active conversation with (spoke to her, or she answered him, within 45 s) stays addressed up to FAR blocks without the name.
// Anything else is ambient talk: heard (logged, returned by /heard with addressed:false) but not answered.
export const NEAR = 6, FAR = 48, CONVO_MS = 45000;
// Name spellings the streaming ASR produces for "Wren" (it is lowercase and has no names in its vocabulary).
const NAME_RX = /\b(?:wren|wrenn|wran|rhen|ren|wrin|rin)\b/i;

// The 80 ms NeMo model hears "wren" as run/ran/rain/when/rent; accept those only as a vocative right after a greeting ("hey run").
const GREET_RX = /^\s*(?:hey|hi|hello|yo|oh|ok|okay|hey there)\s+(?:run|ran|rain|rent|when|wrench|rend)\b/i;
export function saysName(text, rx = NAME_RX) { return rx.test(text || '') || GREET_RX.test(text || ''); }
export function isAddressed({ text, dist, botOnline = true }, opts = {}) {
  const near = opts.near ?? NEAR, far = opts.far ?? FAR;
  if (!botOnline) return false;
  if (!text || !/[a-z]/i.test(text)) return false;
  if (!Number.isFinite(dist)) return false;
  if (dist <= near) return true;
  if (dist <= far && saysName(text, opts.nameRx)) return true;
  if (dist <= far && opts.convo) return true;      // V3: conversation continuity: she and this speaker talked within CONVO_MS and he is within hearing range
  return false;
}
