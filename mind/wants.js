// Wants -> goals -> projects, budgets, repeat caps, cycle detector with lockouts, novelty and curiosity targets.
// Everything keys on GAME seconds. Plain data, JSON-serialisable (toJSON/fromJSON).
import { DAY_S, dayOf, cellKey, cellOf, parseCell } from './util.js';

export const LIMITS = {
  repeatCapPerDay: 2,          // same goal type + same target, starts per game day
  attemptsPerDay: 4,           // starts per (goal_type, place) per game day
  failBudget: 3,               // failures per (goal_type, place) before it is blocked
  blockS: DAY_S / 2,           // how long an exhausted (type, place) stays blocked
  cycleWindowS: 1800, cyclePeriods: [2, 3, 4, 5, 6], cycleMinRepeats: 2, lockoutS: 1800,
  maxWants: 12, wantTtlS: 2 * DAY_S, goalTtlS: DAY_S,
};

export class WantsBook {
  constructor(limits = {}) {
    this.L = { ...LIMITS, ...limits };
    this.wants = []; this.goals = []; this.projects = [];
    this.starts = [];   // {t, type, target, place, token}
    this.fails = [];    // {t, type, place}
    this.lockouts = []; // {token|type+place, until, reason}
    this.visited = new Map(); // cell -> {visits, first_t, last_t}
    this.sightings = [];      // {id, kind, name, x,y,z, t, examined}
    this.seen = { biome: {}, mob: {}, block: {}, structure: {} }; // name -> count of observations
    this.nextId = 1; this.stats = { cycles: 0, capRefusals: 0, budgetRefusals: 0, lockoutRefusals: 0 };
  }
  id(p) { return p + this.nextId++; }
  token(type, place) { return `${type}@${place ?? '-'}`; }

  // ------------------------------------------------------------ wants / goals / projects
  addWant({ text, reason = '', drive = null, strength = 0.5, t = 0 }) {
    const dup = this.wants.find((w) => w.status === 'open' && w.text === text); if (dup) { dup.strength = Math.max(dup.strength, strength); return dup; }
    const w = { id: this.id('w'), text, reason, drive, strength, created_t: t, status: 'open' };
    this.wants.push(w);
    const open = this.wants.filter((x) => x.status === 'open');
    if (open.length > this.L.maxWants) { open.sort((a, b) => a.strength - b.strength)[0].status = 'dropped'; }
    return w;
  }
  strongestWant() { return this.wants.filter((w) => w.status === 'open').sort((a, b) => b.strength - a.strength)[0] ?? null; }
  expire(t) {
    for (const w of this.wants) if (w.status === 'open' && t - w.created_t > this.L.wantTtlS) w.status = 'expired';
    for (const g of this.goals) if (g.status === 'active' && t - g.started_t > this.L.goalTtlS) { g.status = 'expired'; }
    this.lockouts = this.lockouts.filter((l) => l.until > t);
    this.starts = this.starts.filter((s) => t - s.t < 2 * DAY_S); this.fails = this.fails.filter((f) => t - f.t < 2 * DAY_S);
  }

  /** May this goal start now? Checks lockouts, repeat cap, per-(type,place) attempt and failure budgets. */
  canStart({ type, target = null, place = null }, t) {
    const tok = this.token(type, place), day = dayOf(t);
    if (this.lockouts.some((l) => l.until > t && (l.token === tok || (l.type === type && l.place === place)))) { this.stats.lockoutRefusals++; return { ok: false, reason: 'locked_out' }; }
    const tgt = target ?? place ?? '-';
    const same = this.starts.filter((s) => s.type === type && (s.target ?? s.place ?? '-') === tgt && dayOf(s.t) === day).length;
    if (same >= this.L.repeatCapPerDay) { this.stats.capRefusals++; return { ok: false, reason: 'repeat_cap' }; }
    const att = this.starts.filter((s) => s.type === type && s.place === place && dayOf(s.t) === day).length;
    if (att >= this.L.attemptsPerDay) { this.stats.budgetRefusals++; return { ok: false, reason: 'attempt_budget' }; }
    const fl = this.fails.filter((f) => f.type === type && f.place === place && t - f.t < this.L.blockS).length;
    if (fl >= this.L.failBudget) { this.stats.budgetRefusals++; return { ok: false, reason: 'fail_budget' }; }
    return { ok: true };
  }

  /** Register a start. Returns {goal, cycle} where cycle is a detection result if this start completed a cycle. */
  startGoal({ type, target = null, place = null, args = {}, wantId = null, text = '' }, t) {
    const g = { id: this.id('g'), wantId, type, target, place, args, text, status: 'active', started_t: t, attempts: 1 };
    this.goals.push(g); if (this.goals.length > 200) this.goals.splice(0, this.goals.length - 200);
    this.starts.push({ t, type, target, place, token: this.token(type, place) });
    const cycle = this.detectCycle(t);
    if (cycle) this.applyCycle(cycle, t);
    return { goal: g, cycle };
  }
  finishGoal(id, outcome, t) {
    const g = this.goals.find((x) => x.id === id); if (!g) return null;
    g.status = outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : outcome; g.ended_t = t;
    if (outcome === 'failed' || outcome === 'died') this.fails.push({ t, type: g.type, place: g.place });
    const w = this.wants.find((x) => x.id === g.wantId); if (w && outcome === 'done') w.status = 'satisfied';
    return g;
  }

  // ------------------------------------------------------------ cycle detector
  /** Looks at the last 30 game minutes of goal-type+place tokens. A cycle of period p (2..6) = the last p*minRepeats tokens repeat
   *  with period p and the period contains >=2 distinct tokens (single-token repetition is the repeat cap's job). */
  detectCycle(t) {
    const seq = this.starts.filter((s) => t - s.t <= this.L.cycleWindowS).map((s) => s.token);
    for (const p of this.L.cyclePeriods) {
      const need = p * this.L.cycleMinRepeats; if (seq.length < need) continue;
      const tail = seq.slice(-need); let ok = true;
      for (let i = p; i < need; i++) if (tail[i] !== tail[i - p]) { ok = false; break; }
      if (!ok) continue;
      const unit = tail.slice(-p); if (new Set(unit).size < 2) continue;
      // reject if a shorter period explains it (report minimal period only)
      return { period: p, tokens: [...new Set(unit)] };
    }
    return null;
  }
  applyCycle(c, t) {
    this.stats.cycles++;
    for (const tok of c.tokens) {
      if (!this.lockouts.some((l) => l.token === tok && l.until > t)) this.lockouts.push({ token: tok, until: t + this.L.lockoutS, reason: `cycle_p${c.period}`, since: t });
    }
    this.forceDifferentDrive = { until: t + this.L.lockoutS, avoid: c.tokens };
  }
  activeLockouts(t) { return this.lockouts.filter((l) => l.until > t); }

  // ------------------------------------------------------------ projects (multi-day)
  addProject({ name, milestones = [], t = 0 }) { const p = { id: this.id('p'), name, created_t: t, status: 'active', milestones: milestones.map((m) => ({ text: m, done: false })) }; this.projects.push(p); return p; }
  milestoneDone(projectId, idx, t = 0) {
    const p = this.projects.find((x) => x.id === projectId); if (!p || !p.milestones[idx]) return null;
    p.milestones[idx].done = true; p.milestones[idx].t = t; if (p.milestones.every((m) => m.done)) p.status = 'done'; return p;
  }
  activeProjects() { return this.projects.filter((p) => p.status === 'active'); }

  // ------------------------------------------------------------ novelty + curiosity targets from HER knowledge map
  noteVisit(x, z, t = 0) {
    const k = cellKey(x, z); const v = this.visited.get(k);
    if (v) { v.visits++; v.last_t = t; return false; }
    this.visited.set(k, { visits: 1, first_t: t, last_t: t }); return true; // true = new cell (novelty!)
  }
  /** 1 for never-visited, falls with visits. Use inside the S1 utility. */
  noveltyAt(x, z) { const v = this.visited.get(cellKey(x, z)); return v ? 1 / (1 + v.visits) : 1; }
  noteSeen(kind, name) { const m = this.seen[kind]; if (m) m[name] = (m[name] || 0) + 1; }
  noteSighting({ kind, name, x, y = 0, z, t = 0 }) {
    const ex = this.sightings.find((s) => s.kind === kind && s.name === name && Math.hypot(s.x - x, s.z - z) < 8);
    if (ex) return ex;
    const s = { id: this.id('s'), kind, name, x, y, z, t, examined: false }; this.sightings.push(s);
    if (this.sightings.length > 200) this.sightings.shift(); this.noteSeen(kind, name); return s;
  }
  /** Mark every unexamined sighting named `name` within `radius` of (x,z) as examined (she walked up to / looked at / hunted one). */
  markExaminedNear(name, x, z, radius = 24) {
    let n = 0; for (const s of this.sightings) if (!s.examined && s.name === name && (!Number.isFinite(x) || Math.hypot(s.x - x, s.z - z) <= radius)) { s.examined = true; n++; }
    return n;
  }
  markExamined(id) { const s = this.sightings.find((x) => x.id === id); if (s) s.examined = true; }
  /** Open curiosity targets computed from her own observations: (a) sighted but unexamined things, (b) frontier cells
   *  (unvisited neighbours of visited cells), (c) kinds seen only once. Nothing here comes from S2's imagination. */
  curiosityTargets(pos, { max = 5, radius = 200, cooldown = null } = {}) {
    const out = [];
    const nearestOf = new Map(); // one open target per (kind,name): three sheep in a field are one "sheep I have not looked at", not three lines
    for (const s of this.sightings) if (!s.examined) { const k = s.kind + ':' + s.name, d = Math.hypot(s.x - pos.x, s.z - pos.z); const o = nearestOf.get(k); if (!o || d < o.d) nearestOf.set(k, { s, d }); }
    for (const { s, d } of nearestOf.values()) {
      if (d <= radius) out.push({ id: s.id, kind: 'sighting', text: `unexamined ${s.kind} "${s.name}"`, x: s.x, y: s.y, z: s.z, dist: Math.round(d), score: 1 - d / (radius * 1.5) + 0.3 });
    }
    const front = new Map();
    for (const k of this.visited.keys()) {
      const [cx, cz] = parseCell(k);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nk = `${cx + dx},${cz + dz}`; if (this.visited.has(nk)) continue;
        const f = front.get(nk) ?? { cx: cx + dx, cz: cz + dz, n: 0 }; f.n++; front.set(nk, f);
      }
    }
    for (const [k, f] of front) {
      const x = f.cx * 16 + 8, z = f.cz * 16 + 8, d = Math.hypot(x - pos.x, z - pos.z);
      if (d > radius || (cooldown && cooldown.has(k))) continue;
      out.push({ id: 'cell:' + k, kind: 'frontier', text: `unvisited area ${k}`, x, z, dist: Math.round(d), score: 0.5 + 0.05 * f.n - d / (radius * 2) });
    }
    for (const kind of ['mob', 'block', 'biome', 'structure']) for (const [name, n] of Object.entries(this.seen[kind])) if (n === 1) {
      const s = this.sightings.find((q) => q.kind === kind && q.name === name); if (s && s.examined) out.push({ id: `rare:${kind}:${name}`, kind: 'rare', text: `${kind} "${name}" seen once`, x: s.x, z: s.z, dist: Math.round(Math.hypot(s.x - pos.x, s.z - pos.z)), score: 0.35 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, max);
  }

  toJSON() { const { L, ...r } = this; return { ...r, visited: [...this.visited], L }; }
  static fromJSON(j) { const b = new WantsBook(j.L); Object.assign(b, j); b.visited = new Map(j.visited); return b; }
}
