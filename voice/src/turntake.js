// Turn-taking while a player talks over Wren (pure logic, no audio/network),
// no decision model (a prior alone decides, deterministic). Options: continue / finish_sentence / yield_trail_off / yield_now.
export const CONTINUE = 'continue', FINISH = 'finish_sentence', TRAIL = 'yield_trail_off', NOW = 'yield_now';
export const OPTIONS = [CONTINUE, FINISH, TRAIL, NOW];
export const RANK = Object.fromEntries(OPTIONS.map((o, i) => [o, i]));
const S = (s) => new Set(s.split(/\s+/).filter(Boolean));
const FILLER = S(`uh um umm er erm ah oh huh hm hmm hmmm mm mmm mhm mmhm mhmm eh ehm ugh ha haha hah ahem aah ooh uhh uhm uhhh aw aww psst tsk tch pfft pff shh hmph sigh cough sniff breath laugh gasp ow ouch whoa oops yawn hee heh eww ew`);
const BACK = S(`yeah yes yep yup yea ya sure okay ok k right alright aha really wow cool nice true exactly indeed fine good great gotcha understood totally absolutely definitely agreed interesting well so then and`);
const BACK_PHRASES = ['i see', 'got it', 'go on', 'keep going', 'makes sense', 'that makes sense', 'of course', 'i know', "that's right", 'thats right', "that's true", 'thats true', 'fair enough', 'sounds good', 'no way', 'is that so', 'oh really', 'all right', 'carry on', 'i get it', 'uh huh', 'mm hmm', 'very good', 'good point', 'i hear you', 'i understand', 'go ahead', 'please continue', 'sounds right', 'well said'].sort((a, b) => b.length - a.length);
const SHORT_REAL = S('what sorry pardon no nope why how who where when which wait stop hold hang excuse but actually however although');
const WEAK = S('you the a an and so i it is to of in on at or if');
const STOP = /\b(?:stop|wait|hold on|hang on|hold up|shut up|be quiet|keep quiet|quiet down|quiet please|silence|enough of this|enough already|that(?:'?s| is) enough|pause|one (?:sec|second|moment|minute)|just a (?:sec|second|moment|minute)|let me (?:talk|speak|say|finish)|hush|shh+|cut it out|never ?mind|listen)\b/i;
const WH = /^(?:what|why|how|where|who|when|which|whose|can|could|would|will|do|does|did|are|is|am|was|were|have|has|should|isn'?t|aren'?t|don'?t|didn'?t|won'?t)\b/;
const IMPER = /^(?:please|come|go|give|take|follow|open|close|bring|show|tell|look|check|use|drink|eat|put|drop|pick|grab|help|heal|attack|kill|run|sneak|sit|rest|let'?s|lets|don'?t|do|try|find|get|make|leave|turn|stay|keep|say|remember|forget|ask|call|move|equip|wear|draw|switch|unlock|lock)\b/;
const CONTRA = /^(?:no|nope|nah|not|wrong|that(?:'?s| is) (?:not|wrong|false)|i (?:do not|don'?t|disagree|doubt)|it'?s not|it is not|you'?re wrong)\b/;
const YOU = /\b(?:you|your|you'?re|yours|yourself)\b/;
export const tokens = (t) => ((t || '').toLowerCase().replace(/’/g, "'").match(/[a-z']+/g)) || [];

export function classify(text, { runMs = 0, nameRx = null } = {}) {
  const toks = tokens(text), n = toks.length, joined = toks.join(' ');
  const V = (kind, p, why, x = {}) => ({ kind, p, why, stop: false, name: false, question: false, command: false, addressed: false, contra: false, ambiguous: false, n, content: 0, ...x, speech: kind === 'speech' });
  if (n === 0) return V('nonspeech', 0.03, 'no words');
  // "stop"/"wait" only as the opening of a turn ("no wait", "hold on"), not inside a statement ("i will wait here")
  const stop = STOP.test(toks.slice(0, 3).join(' ')) && !/^(?:i|we|they|he|she|i'?ll|we'?ll|i'?m|will|can|could|should|would|to)\b/.test(joined);
  let name = false;
  if (nameRx) { const m = nameRx.exec(joined); if (m && (n <= 6 || tokens(joined.slice(0, m.index)).length < 4)) name = true; }
  const rest = toks.filter((w) => !FILLER.has(w));
  if (!rest.length) return V('filler', 0.02, 'only filler');
  let rs = joined; for (const ph of BACK_PHRASES) rs = rs.split(ph).join(' ');
  const content = rs.split(/\s+/).filter((w) => w && !FILLER.has(w) && !BACK.has(w) && !WEAK.has(w));
  const nf = rest.join(' ');
  const question = (WH.test(joined) && n >= 2) || (/\?\s*$/.test(text || '') && n >= 2);
  const command = IMPER.test(nf) && content.length >= 1;
  const addressed = name || YOU.test(joined), contra = CONTRA.test(nf);
  const x = { stop, name, question, command, addressed, contra, content: content.length };
  if (stop) return V('speech', 0.99, 'explicit stop/wait', x);
  if (name) return V('speech', 0.95, 'called her by name', x);
  if (!content.length) {
    if (n <= 5 && !toks.some((w) => SHORT_REAL.has(w))) return V('backchannel', 0.05, 'backchannel only', x);
    if (toks.every((w) => WEAK.has(w) || FILLER.has(w))) return V('nonspeech', 0.05, 'weak words only', x);
  }
  if (content.length >= 3 || (content.length >= 2 && runMs >= 1000) || question || command || (content.length >= 2 && content.every((w) => SHORT_REAL.has(w))))
    return V('speech', 0.9, 'real utterance', x);
  if (content.length === 1 && SHORT_REAL.has(content[0])) return V('speech', 0.8, 'short claim on the turn', x);
  return V('backchannel', 0.35, 'short and unclear (fail safe: not an attempt)', { ...x, ambiguous: true });
}

const norm = (p) => { const s = Object.values(p).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / s])); };
export function prior(c, v = null) {
  const p = { [CONTINUE]: 0.28, [FINISH]: 0.46, [TRAIL]: 0.18, [NOW]: 0.08 };
  if (c.secsLeft <= 1.0 || c.wordsLeft <= 3) { p[CONTINUE] *= 1.4; p[FINISH] *= 1.6; p[TRAIL] *= 0.45; p[NOW] *= 0.25; }
  if (c.runS >= 1.5) { p[CONTINUE] *= 0.7; p[TRAIL] *= 1.5; }
  if (c.runS >= 3.0) { p[CONTINUE] *= 0.5; p[FINISH] *= 0.85; p[TRAIL] *= 1.6; p[NOW] *= 1.4; }
  if (c.runS >= 5.0) { p[CONTINUE] *= 0.4; p[TRAIL] *= 1.3; p[NOW] *= 2.0; }
  if (c.loud) { p[CONTINUE] *= 0.7; p[TRAIL] *= 1.3; p[NOW] *= 1.5; }
  if (v) {
    if (v.addressed || v.question || v.command || v.contra) { p[CONTINUE] *= 0.4; p[FINISH] *= 0.9; p[TRAIL] *= 2.2; p[NOW] *= 1.4; }
    if (v.command) { p[TRAIL] *= 1.4; p[FINISH] *= 0.8; }
    if (v.content >= 6) { p[TRAIL] *= 1.3; p[CONTINUE] *= 0.8; }
  }
  if ((c.sentencesLeft ?? 0) >= 2) { p[FINISH] *= 1.2; p[CONTINUE] *= 0.8; }
  if (['angry', 'excited', 'passionate', 'scared', 'worried'].includes(c.emotion)) { p[CONTINUE] *= 1.3; p[NOW] *= 0.8; }
  return norm(p);
}

// Hard rules first (urgent never yields; stop/wait yields now; her name: only trail/now), then argmax of the human-like prior.
export function choose(c, v) {
  if (c.urgent) { const o = v.stop ? FINISH : CONTINUE; return { option: o, probs: { [o]: 1 }, source: 'rule:urgent' }; }
  if (v.stop) return { option: NOW, probs: { [NOW]: 1 }, source: 'rule:stop' };
  const pr = prior(c, v), allowed = v.name ? [TRAIL, NOW] : OPTIONS;
  const comb = norm(Object.fromEntries(allowed.map((o) => [o, pr[o]])));
  const option = allowed.reduce((a, b) => (comb[b] > comb[a] ? b : a));
  return { option, probs: comb, source: v.name ? 'rule:name' : 'prior' };
}

// One overlap. The decision only escalates continue -> finish -> trail -> now.
export class Episode {
  constructor(t0) { this.t0 = t0; this.level = -1; this.decision = null; this.lastEval = -1e9; this.lastN = 0; this.evals = 0; this.applied = []; }
  due(now, nTokens) {
    if (this.level >= RANK[NOW]) return false;
    const gap = now - this.lastEval;
    if (gap < 400) return false;
    if (this.level < 0) return true;
    return nTokens - this.lastN >= 3 || gap >= 1500;
  }
  noteEval(now, nTokens) { this.lastEval = now; this.lastN = nTokens; this.evals++; }
  escalate(d) { if (RANK[d.option] <= this.level) return false; this.level = RANK[d.option]; this.decision = d; this.applied.push(d.option); return true; }
}

// Silence needed to end an utterance, from its transcript so far.
// Our nemo80 STT has no punctuation, so the "no punctuation" tier applies unless the model supplies it.
const CONT = S(`and but or so because the a an to of for with that which who if when while then my your his her their our this these those is are was i we you it in on at about should could would can do just`);
export function eotRequiredMs(text, { fast = 250, mid = 500, hold = 1000 } = {}) {
  const t = (text || '').trim();
  if (!t) return fast;
  if (/(\.\.\.|…|,|-|—|;|:)$/.test(t)) return hold;
  const core = t.replace(/["' ]+$/, '');
  if (core && '.?!'.includes(core[core.length - 1])) {
    const w = core.replace(/[.?!]+$/, '').split(/\s+/); return ['um', 'uh', 'er', 'erm'].includes((w[w.length - 1] || '').toLowerCase()) ? hold : fast;
  }
  const last = t.split(/\s+/).pop().replace(/["']/g, '').toLowerCase();
  return CONT.has(last) || FILLER.has(last) ? hold : mid;
}
