// Drives + mood. Body physics, not personality: all five needs have EQUAL fixed strength,
// urgency = (1-level)^2, mood decays to a NEUTRAL (0,0,0) baseline. Nothing here is authored taste.
import { DAY_S, clamp } from './util.js';

export const DRIVE_NAMES = ['hunger', 'energy', 'safety', 'curiosity', 'social'];
export const DEFAULTS = {
  low: 0.4, critical: 0.15, rearm: 0.55,            // threshold levels and re-arm hysteresis
  cooldownS: { low: 180, critical: 90 },            // per drive+kind, game seconds
  hungerOfflineS: DAY_S * 0.7,                      // offline: full -> empty
  energyAwakeS: DAY_S * 1.5, energySleepS: DAY_S * 0.1, energyRestS: DAY_S * 0.15,
  safetyRecoverS: 60,
  curiosityBoredS: DAY_S * 0.4, curiosityPerNewCell: 0.08,
  socialLonelyS: DAY_S * 1.2, socialContactS: 30,
  frustrationDecayS: DAY_S * 0.5,
  moodHalfLifeS: { p: 600, a: 300, d: 900 },
};
// appraisal deltas per unit magnitude (pleasure, arousal, dominance)
export const APPRAISAL = {
  damage: [-0.30, 0.40, -0.20], death: [-0.80, 0.50, -0.60], discovery: [0.40, 0.30, 0.10],
  social: [0.30, 0.10, 0.10], goal_done: [0.30, 0.00, 0.30], goal_failed: [-0.25, 0.10, -0.30],
  satisfaction: [0.20, -0.10, 0.10], frustration: [-0.20, 0.20, -0.20],
  // continuous, body-grounded (Q1): an unmet need and a present threat colour the mood while they last
  deprivation: [-0.25, 0.15, -0.15], threat: [-0.15, 0.40, -0.25],
};
// Repeated pleasant events of the same kind lose force (habituation, half-life in game seconds): twenty routine
// successes or thirteen first sightings at spawn must not pin the mood at its ceiling for hours (Q1 finding).
export const HABITUATE = new Set(['goal_done', 'discovery', 'satisfaction', 'social']);
const HABITUATION_HALF_LIFE_S = 600;

export class Drives {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts, cooldownS: { ...DEFAULTS.cooldownS, ...(opts.cooldownS || {}) } };
    this.t = opts.t ?? 0; // game seconds
    this.level = Object.fromEntries(DRIVE_NAMES.map((d) => [d, 0.9]));
    this.frustration = Object.fromEntries(DRIVE_NAMES.map((d) => [d, 0]));
    this.armed = Object.fromEntries(DRIVE_NAMES.map((d) => [d, { low: true, critical: true }]));
    this.lastEmit = {};
    this.mood = { p: 0, a: 0, d: 0 };
    this.hab = {};
    this.stats = { satisfactions: 0, frustrations: 0, events: 0 };
  }

  urgency(d) { return (1 - this.level[d]) ** 2; }
  urgencies() { return Object.fromEntries(DRIVE_NAMES.map((d) => [d, this.urgency(d)])); }
  ranked() { return DRIVE_NAMES.map((d) => ({ drive: d, level: this.level[d], urgency: this.urgency(d) })).sort((a, b) => b.urgency - a.urgency); }

  /** Advance by dt REAL seconds. digest: {food 0-20, hp 0-20, tps, threats, danger, humansNearby, newCells, sleeping, resting}.
   *  Returns events [{type, ...}]. Safe at 1 Hz; dt may be large (offline) -> use offlineDecay for gaps. */
  tick(dt, digest = {}) {
    const tps = digest.tps ?? 20;
    const g = Math.max(0, dt) * clamp(tps / 20, 0, 1);       // game seconds that really elapsed (TPS-aware)
    const c = this.cfg, L = this.level, before = { ...L }, events = [];
    this.t += g;
    // hunger: ground truth from body when known, else coarse decay
    if (Number.isFinite(digest.food)) L.hunger = clamp(digest.food / 20);
    else L.hunger = clamp(L.hunger - g / c.hungerOfflineS);
    // energy
    if (digest.sleeping) L.energy = clamp(L.energy + g / c.energySleepS);
    else if (digest.resting) L.energy = clamp(L.energy + g / c.energyRestS);
    else L.energy = clamp(L.energy - g / c.energyAwakeS);
    // safety: drops instantly with threat, recovers slowly
    let target = 1;
    if (Number.isFinite(digest.hp)) target = Math.min(target, digest.hp / 20);
    if (digest.threats) target = Math.min(target, 1 - 0.2 * digest.threats);
    if (digest.danger) target = Math.min(target, 0.2);
    target = clamp(target);
    L.safety = target < L.safety ? target : Math.min(target, L.safety + g / c.safetyRecoverS);
    // curiosity / boredom
    L.curiosity = clamp(L.curiosity - g / c.curiosityBoredS + (digest.newCells || 0) * c.curiosityPerNewCell);
    // social
    if (digest.humansNearby > 0) L.social = clamp(L.social + g / c.socialContactS);
    else L.social = clamp(L.social - g / c.socialLonelyS);

    for (const d of DRIVE_NAMES) {
      this.frustration[d] = Math.max(0, this.frustration[d] - g / c.frustrationDecayS);
      const delta = L[d] - before[d];
      if (before[d] < 0.5 && delta >= 0.05) events.push(this._satisfy(d, delta)); // relief of a real deficit
      events.push(...this._thresholds(d));
    }
    this._bodyMood(g, digest);
    this._decayMood(g);
    this.stats.events += events.length;
    return events.filter(Boolean);
  }

  /** Coarse catch-up for a gap with no ticks (bot offline). Steps of `step` game seconds, no events except a summary. */
  offlineDecay(gapGameS, step = 60) {
    const evs = [];
    for (let left = gapGameS; left > 0; left -= step) {
      this.tick(Math.min(step, left), { tps: 20, food: undefined });
    }
    for (const d of DRIVE_NAMES) { this.armed[d] = { low: this.level[d] > this.cfg.low, critical: this.level[d] > this.cfg.critical }; }
    return evs;
  }

  _thresholds(d) {
    const c = this.cfg, lv = this.level[d], a = this.armed[d], out = [];
    for (const kind of ['critical', 'low']) {
      const thr = c[kind];
      if (lv > c.rearm) a[kind] = true;
      if (lv <= thr && a[kind]) {
        const key = d + ':' + kind;
        if (this.lastEmit[key] === undefined || this.t - this.lastEmit[key] >= c.cooldownS[kind]) {
          a[kind] = false; this.lastEmit[key] = this.t;
          out.push({ type: 'drive_threshold', drive: d, kind, level: +lv.toFixed(3), t: this.t });
          break; // critical supersedes low in same tick
        }
      }
    }
    return out;
  }

  _satisfy(d, amount) {
    this.stats.satisfactions++;
    this.frustration[d] = Math.max(0, this.frustration[d] - amount);
    this.appraise('satisfaction', Math.min(1, amount * 2));
    return { type: 'satisfaction', drive: d, amount: +amount.toFixed(3), t: this.t };
  }
  /** External satisfaction (e.g. ate a steak): raise level, signal. */
  satisfy(d, amount) { this.level[d] = clamp(this.level[d] + amount); return this._satisfy(d, amount); }
  /** Failed attempt to meet a need; accumulates (decaying) frustration, lowers mood. */
  frustrate(d, amount = 0.2) {
    this.stats.frustrations++;
    this.frustration[d] = clamp(this.frustration[d] + amount, 0, 2);
    this.appraise('frustration', Math.min(1, amount * 2));
    return { type: 'frustration', drive: d, amount, total: +this.frustration[d].toFixed(3), t: this.t };
  }

  /** Mood follows the body's real state, not only discrete events: an unmet need (level < low) and threats near lower pleasure/dominance and
   *  raise arousal for as long as they last. Only when the digest carries real body data (hp), so offline catch-up stays neutral. */
  _bodyMood(g, digest) {
    if (!(g > 0) || !Number.isFinite(digest?.hp)) return;
    const low = this.cfg.low;
    let def = 0;
    for (const n of ['hunger', 'energy', 'safety']) def = Math.max(def, (low - this.level[n]) / low);
    if (def > 0) this.appraise('deprivation', Math.min(1, def) * g / 150);
    const threat = digest.danger ? 1 : Math.min(1, (digest.threats || 0) * 0.35);
    if (threat > 0) this.appraise('threat', threat * g / 60);
  }

  /** Appraisal of an event type with magnitude 0..1 moves PAD, scaled so mood stays within [-1,1]. */
  appraise(type, magnitude = 1) {
    const row = APPRAISAL[type]; if (!row) return this.mood;
    if (HABITUATE.has(type)) {
      const h = this.hab[type] ?? { v: 0, t: this.t };
      const v = h.v * Math.pow(0.5, Math.max(0, this.t - h.t) / HABITUATION_HALF_LIFE_S);
      magnitude = magnitude / (1 + v); this.hab[type] = { v: v + 1, t: this.t };
    }
    const m = this.mood; const k = ['p', 'a', 'd'];
    k.forEach((key, i) => { const dv = row[i] * magnitude; m[key] = clamp(m[key] + dv * (1 - Math.abs(m[key]) * 0.5), -1, 1); });
    return m;
  }
  _decayMood(g) {
    for (const k of ['p', 'a', 'd']) this.mood[k] *= Math.pow(0.5, g / this.cfg.moodHalfLifeS[k]); // neutral baseline = 0
  }
  /** Mood is PAD in [-1,1], 0 = neutral (NOT 0..1 with 0.5 neutral). Octant label with a neutral deadband: inside radius 0.25 the mood is 'neutral'
   *  and an axis within +-0.12 of zero counts as undecided (it never flips the octant by noise). Arousal keeps its 0.15 split (leftover arousal is not energy). */
  moodLabel() {
    const { p, a, d } = this.mood;
    if (Math.hypot(p, a, d) < 0.25) return 'neutral'; // Q1: a mild state is not 'exuberant'
    if (Math.max(Math.abs(p), Math.abs(a), Math.abs(d)) < 0.12) return 'neutral';
    if (p >= 0) return a >= 0.15 ? (d >= 0 ? 'exuberant' : 'dependent') : (d >= 0 ? 'relaxed' : 'docile');
    return a >= 0.15 ? (d >= 0 ? 'hostile' : 'anxious') : (d >= 0 ? 'disdainful' : 'bored');
  }
  /** Plain-language reading with strength, e.g. "mildly happy, alert and confident". */
  moodDesc() {
    const { p, a, d } = this.mood, label = this.moodLabel();
    if (label === 'neutral') return 'neutral, nothing stands out';
    const mag = Math.hypot(p, a, d), strength = mag < 0.5 ? 'mildly' : mag < 0.9 ? 'fairly' : 'very';
    const words = { exuberant: 'happy, alert and confident', relaxed: 'content, calm and confident', dependent: 'happy and alert but unsure of myself', docile: 'content, calm and a bit passive',
      hostile: 'unhappy, tense and forceful', anxious: 'unhappy, tense and powerless', disdainful: 'unhappy, flat and aloof', bored: 'unhappy, tired and subdued' };
    return `${strength} ${words[label]}`;
  }
  snapshot() {
    return { levels: Object.fromEntries(DRIVE_NAMES.map((d) => [d, +this.level[d].toFixed(2)])),
      urgencies: Object.fromEntries(DRIVE_NAMES.map((d) => [d, +this.urgency(d).toFixed(2)])),
      mood: { p: +this.mood.p.toFixed(2), a: +this.mood.a.toFixed(2), d: +this.mood.d.toFixed(2), label: this.moodLabel(), desc: this.moodDesc(), scale: '-1..1, 0 = neutral' } };
  }
  toJSON() { return { t: this.t, level: this.level, frustration: this.frustration, armed: this.armed, lastEmit: this.lastEmit, mood: this.mood, hab: this.hab, stats: this.stats }; }
  static fromJSON(j, opts) { const d = new Drives(opts); Object.assign(d, { t: j.t, level: j.level, frustration: j.frustration, armed: j.armed, lastEmit: j.lastEmit, mood: j.mood, hab: j.hab ?? {}, stats: j.stats }); return d; }
}
