// Barge-in SCORING: a transparent weighted score over a feature vector -> probabilities for four decisions
//   continue | finish_sentence | yield_trail_off | yield_now
// plus hard rules (below) that run BEFORE the score and are never overridable by weights or by a learned model.
// Every call returns the full feature vector, per-feature score components, logits, probabilities and the chosen action, so rows can be logged
// (voice/archive/<run>/turn_decisions.jsonl) and a model trained later. A learned model can replace/blend the weights: see TurnScorer (default off).
import fs from 'node:fs';
import { classify, tokens, CONTINUE, FINISH, TRAIL, NOW, OPTIONS, RANK } from './turntake.js';
export { CONTINUE, FINISH, TRAIL, NOW, OPTIONS, RANK };

export const KINDS = ['warning', 'answer', 'chatter', 'story', 'ack'];
export const DEFAULT_IMPORTANCE = { warning: 0.9, answer: 0.5, chatter: 0.3, story: 0.5, ack: 0.2 };
/** Defaults for POST /speak: kind from priority / reply, importance from kind (explicit values win). */
export function speakMeta({ kind, importance, priority, inReplyTo } = {}) {
  const k = KINDS.includes(kind) ? kind : priority === 'urgent' ? 'warning' : inReplyTo != null ? 'answer' : 'chatter';
  const imp = Number.isFinite(importance) ? Math.max(0, Math.min(1, importance)) : DEFAULT_IMPORTANCE[k];
  return { kind: k, importance: imp };
}

export const CFG = { overlapMinMs: 700, burstMs: 400, holdMs: 1000, wantFinish: 0.35, warningImportance: 0.85, nearEndFrac: 0.6, nearEndWords: 3 };
// DEFAULT WEIGHTS (logit contributions). Read as: "this feature pushes this decision up (+) or down (-)". The continue row is only used for
// logging/learned blending: after the hard rules, real addressed speech with >= overlapMinMs overlap chooses among finish/trail/now.
export const WEIGHTS = {
  // V4: imp_short = importance (above the answer level) x short overlap: an important line of her own (starving, low health) is finished, not trailed off, when he only overlaps briefly.
  // owed = she was already made to yield twice in a row to this person within 30 s: turn fairness favours finishing her sentence.
  [CONTINUE]: { bias: 0.5, near_end: 1.2, want: 1.0, far: 0.5, ov3: -1.5, explicit: -1.0, fam: -0.3, patience: -0.3, reply: -0.4, imp_short: 0.5, owed: 0.5 },
  [FINISH]: { bias: 0.4, near_end: 2.0, want: 2.2, words_left_small: 0.4, ov3: -1.2, explicit: -0.6, patience: -0.7, loud: -0.2, imp_short: 2.2, owed: 1.6 },
  [TRAIL]: { bias: 0.6, near_end: -1.2, want: -1.0, ov3: 1.0, explicit: 0.9, fam: 0.5, patience: 0.9, reply: 0.5, imp_short: -2.0, owed: -1.2 },
  [NOW]: { bias: -0.6, near_end: -2.0, want: -2.0, ov3: 1.8, explicit: 0.5, close: 0.5, loud: 1.0, patience: 0.4, fam: 0.3, reply: 0.3, imp_short: -1.0, owed: -0.8 },
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const softmax = (o) => { const ks = Object.keys(o), m = Math.max(...ks.map((k) => o[k])), e = ks.map((k) => Math.exp(o[k] - m)), s = e.reduce((a, b) => a + b, 0); return Object.fromEntries(ks.map((k, i) => [k, +(e[i] / s).toFixed(4)])); };

const DANGER = /\b(?:creeper|zombies?|skeletons?|spiders?|lava|fire|watch out|look out|behind you|be careful|careful|help|explod\w*|arrows?|drown\w*|falling|incoming|duck|danger|enderman|witch|pillagers?|run away|get out|get back)\b/i;
// extra filler shapes the streaming decoder produces for hesitations ("eehm", "ehhm", "uhhh", "mmmm", "aaah")
const FILLER_SHAPE = /^(?:e+h*m*|u+h+m*|h+m+|m{2,}|a+h+m*|o+h+m*|e+r+m*)$/;
export const isFillerWord = (w) => FILLER_SHAPE.test(w);

/** What kind of interruption is this? -> {type, v, why}. type: filler | backchannel | speech | command | name | danger. */
export function interruptionType({ text = '', voicedMs = 0, nameRx = null, burstMs = CFG.burstMs } = {}) {
  const toks = tokens(text);
  const v = classify(toks.filter((w) => !isFillerWord(w)).join(' ') || toks.join(' '), { runMs: voicedMs, nameRx });
  if (!toks.length) return { type: 'filler', v, why: voicedMs < burstMs ? 'no_text_short_burst' : 'no_text_hesitation' };
  if (toks.every(isFillerWord)) return { type: 'filler', v, why: 'filler_shape' };
  if (v.kind === 'filler' || v.kind === 'nonspeech') return { type: 'filler', v, why: v.why };
  if (v.stop) return { type: 'command', v, why: 'stop/wait' };
  if (v.name) return { type: 'name', v, why: 'her name' };
  if (DANGER.test(text) && toks.length <= 7) return { type: 'danger', v, why: 'danger word' };
  if (v.kind === 'backchannel') return { type: 'backchannel', v, why: v.why };
  return { type: 'speech', v, why: v.why };
}

/**
 * Feature vector. in: { text, voicedMs, overlapMs, addressed, dist, familiarity, u:{sentences, idx, sentMs, spans, priority, kind, importance, inReplyTo}, playedMs, replyToThis,
 *   recentInterrupts, loud, nameRx, wantFinish }
 */
export function features(i) {
  const it = interruptionType({ text: i.text, voicedMs: i.voicedMs ?? 0, nameRx: i.nameRx });
  const u = i.u || {};
  const kind = u.kind ?? 'chatter', importance = u.importance ?? DEFAULT_IMPORTANCE[kind] ?? 0.3;
  const urgent = u.priority === 'urgent' || kind === 'warning' || importance >= CFG.warningImportance;
  const sents = u.sentences ?? [], chars = sents.reduce((a, s) => a + s.length, 0) || 1;
  const sentMs = u.sentMs ?? 0, rate = sentMs > 0 ? sentMs / Math.max(1, sents.slice(0, (u.spans ?? []).length || 1).reduce((a, s) => a + s.length, 0)) : 65;
  const totalMs = Math.max(sentMs, rate * chars), playedMs = Math.min(i.playedMs ?? 0, totalMs);
  const fracSpoken = totalMs > 0 ? +clamp(playedMs / totalMs).toFixed(3) : 0;
  const wordsAll = sents.join(' ').split(/\s+/).filter(Boolean).length || 1, wordsLeft = Math.max(0, Math.round(wordsAll * (1 - fracSpoken)));
  const wantSetting = i.wantFinish ?? CFG.wantFinish;
  const f = { type: it.type, type_why: it.why, text: i.text ?? '', n_words: tokens(i.text).length, no_text: !tokens(i.text).length, voiced_ms: Math.round(i.voicedMs ?? 0), overlap_ms: Math.round(i.overlapMs ?? 0),
    addressed: !!i.addressed, dist: i.dist ?? null, familiarity: i.familiarity ?? 0, frac_spoken: fracSpoken, words_left: wordsLeft, played_ms: Math.round(playedMs), total_ms_est: Math.round(totalMs),
    importance, kind, urgent, want_finish_setting: wantSetting, want: +clamp(wantSetting + 0.5 * importance).toFixed(3), recent_interrupts: i.recentInterrupts ?? 0,
    owed: !!i.owed, reply_to_this: !!i.replyToThis, loud: !!i.loud, question: !!it.v.question, command: !!it.v.command, contra: !!it.v.contra, name: it.type === 'name', stop: it.type === 'command', danger: it.type === 'danger', final: !!i.final };
  // derived inputs of the weights (all 0..1)
  f.x = { near_end: +Math.max(clamp((fracSpoken - CFG.nearEndFrac) / 0.3), wordsLeft <= CFG.nearEndWords ? 1 : 0).toFixed(3), words_left_small: wordsLeft <= 5 ? 1 : 0, want: f.want,
    ov3: +clamp((f.overlap_ms - CFG.overlapMinMs) / 3000).toFixed(3), explicit: it.v.question || it.v.command || it.v.contra || it.v.name || it.v.addressed ? 1 : 0, fam: +clamp(f.familiarity).toFixed(2),
    patience: +clamp(f.recent_interrupts / 3).toFixed(2), reply: f.reply_to_this ? 1 : 0, close: f.dist != null && f.dist <= 3 ? 1 : 0, far: f.dist != null && f.dist > 10 ? 1 : 0, loud: f.loud ? 1 : 0, owed: f.owed ? 1 : 0 };
  f.x.imp_short = +(clamp((importance - 0.55) / 0.3) * (1 - f.x.ov3)).toFixed(3);
  return f;
}

export function linearLogits(x, W = WEIGHTS) {
  const logits = {}, comps = {};
  for (const o of OPTIONS) { let s = 0; comps[o] = []; for (const [k, w] of Object.entries(W[o])) { const val = k === 'bias' ? 1 : (x[k] ?? 0), c = w * val; if (c) comps[o].push({ f: k, x: +val.toFixed(3), w, c: +c.toFixed(3) }); s += c; } logits[o] = +s.toFixed(4); }
  return { logits, comps };
}

/** Learned-model plug-in: object with predict(features) -> {continue,finish_sentence,yield_trail_off,yield_now} (probs or logits) | null. */
export function loadLinearModel(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));      // {weights:{<option>:{bias, <x-feature>:w}}}
  return { name: m.name ?? file, predict: (f) => softmax(linearLogits(f.x, m.weights).logits) };
}

export class TurnScorer {
  constructor({ weights = WEIGHTS, model = null, alpha = Number(process.env.VOICE_TURN_ALPHA || 0), cfg = {} } = {}) { Object.assign(this, { weights, model, alpha: model ? alpha : 0 }); this.cfg = { ...CFG, ...cfg }; }
  setModel(model, alpha) { this.model = model; this.alpha = model ? alpha : 0; }
  /** -> {action, source, rules[], probs (allowed options, normalised), probs_all, logits, components, learned, features, duck_db} */
  score(f) {
    const rules = [], out = (action, source, extra = {}) => ({ action, source, rules, features: f, duck_db: 0, ...extra });
    const { logits, comps } = linearLogits(f.x, this.weights), probsAll = softmax(logits);
    let learned = null, blended = probsAll;
    if (this.model && this.alpha > 0) { try { learned = this.model.predict(f); const ks = OPTIONS; const s = ks.reduce((a, k) => a + (learned[k] ?? 0), 0) || 1; blended = Object.fromEntries(ks.map((k) => [k, (1 - this.alpha) * probsAll[k] + this.alpha * ((learned[k] ?? 0) / s)])); } catch { learned = null; } }
    const base = { logits, components: comps, probs_all: probsAll, learned, blended: this.alpha > 0 ? blended : null };
    const done = (a, src, probs) => out(a, src, { ...base, probs: probs ?? { [a]: 1 } });
    // ---- hard rules (order matters)
    if (f.type === 'filler') { rules.push('filler_never_cuts'); return done(CONTINUE, 'rule:filler'); }
    if (f.type === 'backchannel') { rules.push('backchannel_never_cuts'); return { ...done(CONTINUE, 'rule:backchannel'), duck_db: f.overlap_ms > 1500 ? -2 : 0 }; }
    if (!f.addressed) { rules.push('not_addressed'); return done(CONTINUE, 'rule:ambient'); }
    if (f.urgent) {
      rules.push('warning_not_cut');
      return f.stop ? done(FINISH, 'rule:warning+stop') : done(CONTINUE, 'rule:warning');
    }
    if (f.stop) { rules.push('stop_yields_now'); return done(NOW, 'rule:stop'); }
    if (f.danger) { rules.push('danger_word'); return done(f.frac_spoken > 0.9 ? FINISH : NOW, 'rule:danger'); }
    const allowed = f.name ? [FINISH, TRAIL, NOW] : [FINISH, TRAIL, NOW];
    if (f.name) rules.push('her_name');
    else if (f.overlap_ms < this.cfg.overlapMinMs) { rules.push('overlap_under_min'); return done(CONTINUE, 'rule:overlap<min'); }
    else rules.push('speech_overlap>=min');
    const pool = this.alpha > 0 ? blended : probsAll;
    const sub = Object.fromEntries(allowed.map((o) => [o, pool[o]])), s = Object.values(sub).reduce((a, b) => a + b, 0) || 1;
    const probs = Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, +(v / s).toFixed(4)]));
    const action = allowed.reduce((a, b) => (probs[b] > probs[a] ? b : a));
    return out(action, this.alpha > 0 ? 'score+model' : 'score', { ...base, probs });
  }
}

/** Hysteresis: a cutting decision holds for holdMs and may only escalate afterwards; explicit stop overrides. */
export class TurnState {
  constructor({ holdMs = CFG.holdMs } = {}) { this.holdMs = holdMs; this.level = RANK[CONTINUE]; this.action = CONTINUE; this.at = -1e9; }
  /** -> {action, held:boolean, changed:boolean} */
  apply(res, now) {
    const want = res.action, hard = res.source === 'rule:stop' || res.source === 'rule:danger';
    if (this.level > 0 && now - this.at < this.holdMs && !hard) return { action: this.action, held: want !== this.action, changed: false };
    if (RANK[want] > this.level) { this.level = RANK[want]; this.action = want; this.at = now; return { action: want, held: false, changed: true }; }
    return { action: this.level > 0 ? this.action : CONTINUE, held: false, changed: false };
  }
}
