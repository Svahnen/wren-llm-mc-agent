// Long-term memory on node:sqlite (no native deps). SINGLE-WRITER RULE: exactly one process (the brain host) opens the
// DB read-write; every other process (bot, tools) asks that process via the JSON API or opens with {readOnly:true}.
// WAL + busy_timeout protect against accidental overlap but are not a substitute for the rule. retrieve() also writes
// (recall counters), so call it from the writer only, or pass {touch:false}.
import { DatabaseSync } from 'node:sqlite';
import { DAY_S, dayOf, cellKey, tokens, jaccard, cosine, clamp } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS episodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, t_last REAL, day INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, tags TEXT DEFAULT '',
  cell TEXT, x REAL, y REAL, z REAL, activity TEXT, goal_type TEXT, outcome TEXT,
  importance REAL DEFAULT 0.3, valence REAL DEFAULT 0, arousal REAL DEFAULT 0, strength REAL DEFAULT 1,
  count INTEGER DEFAULT 1, recall_count INTEGER DEFAULT 0, last_recalled REAL,
  core INTEGER DEFAULT 0, habit INTEGER DEFAULT 0, habit_key TEXT, archived INTEGER DEFAULT 0, archived_t REAL,
  embedding BLOB, emb_model TEXT);
CREATE INDEX IF NOT EXISTS ep_t ON episodes(t); CREATE INDEX IF NOT EXISTS ep_cell ON episodes(cell);
CREATE INDEX IF NOT EXISTS ep_hab ON episodes(habit_key);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, tags, content='episodes', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS ep_ai AFTER INSERT ON episodes BEGIN INSERT INTO episodes_fts(rowid,text,tags) VALUES(new.id,new.text,new.tags); END;
CREATE TRIGGER IF NOT EXISTS ep_ad AFTER DELETE ON episodes BEGIN INSERT INTO episodes_fts(episodes_fts,rowid,text,tags) VALUES('delete',old.id,old.text,old.tags); END;
CREATE TRIGGER IF NOT EXISTS ep_au AFTER UPDATE OF text,tags ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts,rowid,text,tags) VALUES('delete',old.id,old.text,old.tags);
  INSERT INTO episodes_fts(rowid,text,tags) VALUES(new.id,new.text,new.tags); END;
CREATE TABLE IF NOT EXISTS facts(
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL, key TEXT NOT NULL, value TEXT, text TEXT, confidence REAL DEFAULT 0.6,
  valid_from REAL, valid_to REAL, superseded_by INTEGER, last_verified REAL, source_episode INTEGER, identity INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS f_sk ON facts(subject,key);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, subject, content='facts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS f_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid,text,subject) VALUES(new.id,coalesce(new.text,new.key||' '||new.value),new.subject); END;
CREATE TRIGGER IF NOT EXISTS f_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts,rowid,text,subject) VALUES('delete',old.id,coalesce(old.text,old.key||' '||old.value),old.subject); END;
CREATE TABLE IF NOT EXISTS lessons(
  id INTEGER PRIMARY KEY, goal_type TEXT NOT NULL, cell TEXT, x REAL, y REAL, z REAL, approach TEXT DEFAULT '', result TEXT NOT NULL,
  cause TEXT DEFAULT '', extent REAL DEFAULT 0, strength REAL DEFAULT 1, count INTEGER DEFAULT 1, created_t REAL, last_t REAL, used_count INTEGER DEFAULT 0, changed_count INTEGER DEFAULT 0,
  UNIQUE(goal_type, cell, approach, result, cause));
CREATE TABLE IF NOT EXISTS places(
  cell TEXT PRIMARY KEY, visits INTEGER DEFAULT 0, first_t REAL, last_t REAL, notable TEXT DEFAULT '[]', danger REAL DEFAULT 0, name TEXT);
CREATE TABLE IF NOT EXISTS relationships(
  name TEXT PRIMARY KEY, familiarity REAL DEFAULT 0, affinity REAL DEFAULT 0, interactions INTEGER DEFAULT 0, first_t REAL, last_seen REAL, notes TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS preferences(
  activity TEXT PRIMARY KEY, pleasant_count INTEGER DEFAULT 0, days TEXT DEFAULT '[]', status TEXT DEFAULT 'candidate', first_t REAL, last_t REAL);
CREATE TABLE IF NOT EXISTS self_summary(version INTEGER PRIMARY KEY, t REAL, text TEXT NOT NULL, author TEXT DEFAULT 'self');
CREATE TABLE IF NOT EXISTS core_memories(id INTEGER PRIMARY KEY, t REAL, text TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS reflections(id INTEGER PRIMARY KEY, t REAL, text TEXT NOT NULL);
`;

export const KIND_IMPORTANCE = { death: 1, discovery: 0.6, damage: 0.4, social: 0.5, goal_done: 0.4, goal_failed: 0.45, lesson: 0.7, routine: 0.1 };
/** "Pleasant" is defined HERE, in code: healthy, no death, non-negative pleasure, and at least one of
 *  drive satisfied / novelty / social contact. A preference needs pleasant episodes on 3+ separate game days. */
export function isPleasant(ev) {
  if (ev.kind === 'death') return false;
  const healthy = (ev.damage ?? 0) < 2 && (ev.hpMin ?? 20) >= 10;
  const satisfied = (ev.satisfied?.length ?? 0) > 0, novel = (ev.novelty ?? 0) > 0, social = (ev.social ? 1 : 0) > 0;
  return healthy && (ev.pad?.p ?? 0) >= 0 && (satisfied || novel || social);
}
export const PREFERENCE_DAYS = 3;

const ftsQuery = (q) => { const t = [...new Set(tokens(q))].slice(0, 24); return t.length ? t.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ') : null; };
const J = (v) => JSON.stringify(v);

export class Memory {
  constructor(path = ':memory:', opts = {}) {
    this.db = new DatabaseSync(path, { readOnly: !!opts.readOnly });
    this.opts = { maxEpisodes: 1500, halfLifeDays: 3, recencyDays: 3, mmrLambda: 0.7, embedder: null, embeddingModel: null, ...opts };
    if (!opts.readOnly) {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL;');
      this.db.exec(SCHEMA);
    }
  }
  close() { this.db.close(); }
  get(k, d = null) { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; }
  set(k, v) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, J(v)); }

  // ---------------------------------------------------------------- episodes
  /** event: {t, kind, text, x,y,z, activity, goal_type, outcome, pad:{p,a,d}, importance, damage, hpMin, satisfied[], novelty, social, core, tags}
   *  Near-identical consecutive events (same kind+text within 120 gs) are counted, not duplicated. Returns episode id. */
  remember(ev) {
    const t = ev.t ?? 0, kind = ev.kind ?? 'routine';
    if (!ev.text) throw new Error('remember: text required');
    const dup = this.db.prepare('SELECT id FROM episodes WHERE kind=? AND text=? AND archived=0 AND t_last>=? ORDER BY id DESC LIMIT 1').get(kind, ev.text, t - 120);
    let id;
    if (dup) { this.db.prepare('UPDATE episodes SET count=count+1, t_last=? WHERE id=?').run(t, dup.id); id = dup.id; }
    else {
      const imp = clamp(ev.importance ?? KIND_IMPORTANCE[kind] ?? 0.3);
      const hasPos = Number.isFinite(ev.x) && Number.isFinite(ev.z);
      const r = this.db.prepare(`INSERT INTO episodes(t,t_last,day,kind,text,tags,cell,x,y,z,activity,goal_type,outcome,importance,valence,arousal,core)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(t, t, dayOf(t), kind, ev.text, ev.tags ?? '', hasPos ? cellKey(ev.x, ev.z) : null,
        ev.x ?? null, ev.y ?? null, ev.z ?? null, ev.activity ?? null, ev.goal_type ?? null, ev.outcome ?? null, imp, ev.pad?.p ?? 0, ev.pad?.a ?? 0, ev.core ? 1 : 0);
      id = Number(r.lastInsertRowid);
      if (Number(this.get('ins_since_cap', 0)) + 1 >= 50) { this.set('ins_since_cap', 0); this._enforceCap(); } else this.set('ins_since_cap', Number(this.get('ins_since_cap', 0)) + 1);
    }
    if (ev.activity && isPleasant(ev)) this._pleasant(ev.activity, t);
    if (Number.isFinite(ev.x) && Number.isFinite(ev.z)) this.visitPlace(ev.x, ev.y, ev.z, t, { danger: ev.kind === 'death' ? 1 : 0, bump: false });
    return id;
  }

  _pleasant(activity, t) {
    const day = dayOf(t); const r = this.db.prepare('SELECT * FROM preferences WHERE activity=?').get(activity);
    const days = r ? JSON.parse(r.days) : [];
    if (!days.includes(day)) days.push(day);
    const status = days.length >= PREFERENCE_DAYS ? 'established' : 'candidate';
    this.db.prepare(`INSERT INTO preferences(activity,pleasant_count,days,status,first_t,last_t) VALUES(?,1,?,?,?,?)
      ON CONFLICT(activity) DO UPDATE SET pleasant_count=pleasant_count+1, days=excluded.days, status=excluded.status, last_t=excluded.last_t`).run(activity, J(days), status, t, t);
  }
  /** Preferences that exist ONLY because of repeated pleasant episodes on 3+ separate game days. */
  preferences(all = false) { return this.db.prepare(`SELECT activity, pleasant_count, days, status FROM preferences ${all ? '' : "WHERE status='established'"} ORDER BY pleasant_count DESC`).all().map((r) => ({ ...r, days: JSON.parse(r.days) })); }

  /** retrieve(query, k, ctx) ctx: {now, x,y,z, queryVec, touch}. Score = relevance+recency+importance+emotion+use, then MMR. Works without embeddings. */
  retrieve(query, k = 5, ctx = {}) {
    const now = ctx.now ?? this.get('now', 0), cand = new Map(), q = ftsQuery(query);
    const place = Number.isFinite(ctx.x) ? cellKey(ctx.x, ctx.z) : null;
    if (q) {
      for (const r of this.db.prepare(`SELECT e.*, bm25(episodes_fts) AS bm FROM episodes_fts JOIN episodes e ON e.id=episodes_fts.rowid
        WHERE episodes_fts MATCH ? AND e.archived=0 ORDER BY bm LIMIT 60`).all(q)) cand.set(r.id, { ...r, rel: -r.bm });
    }
    const extra = [];
    if (place) extra.push(...this.db.prepare('SELECT * FROM episodes WHERE cell=? AND archived=0 ORDER BY importance DESC, t DESC LIMIT 15').all(place));
    extra.push(...this.db.prepare('SELECT * FROM episodes WHERE archived=0 ORDER BY t DESC LIMIT 8').all());
    extra.push(...this.db.prepare('SELECT * FROM episodes WHERE archived=0 AND (core=1 OR importance>=0.9) ORDER BY importance DESC, t DESC LIMIT 6').all());
    for (const r of extra) if (!cand.has(r.id)) cand.set(r.id, { ...r, rel: 0 });
    const rows = [...cand.values()]; if (!rows.length) return [];
    const maxRel = Math.max(...rows.map((r) => r.rel), 1e-9);
    const qt = new Set(tokens(query));
    for (const r of rows) {
      let rel = r.rel / maxRel;
      if (place && r.cell === place) rel = Math.min(1, rel + 0.3);
      if (ctx.queryVec && r.embedding) rel = Math.max(rel, cosine(ctx.queryVec, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))));
      const age = Math.max(0, now - (r.t_last ?? r.t)) / DAY_S;
      r.parts = { rel, rec: Math.exp(-age / this.opts.recencyDays), imp: r.importance * r.strength, emo: clamp(Math.abs(r.valence) * 0.6 + r.arousal * 0.4 + 0.0), use: Math.min(1, Math.log1p(r.recall_count) / Math.log(6)) };
      r.score = 0.35 * r.parts.rel + 0.2 * r.parts.rec + 0.2 * r.parts.imp + 0.15 * r.parts.emo + 0.1 * r.parts.use;
      // Q1 satiation: what was put in front of her a moment ago is not news. Without this, recall_count fed `use` and the same 6-8 episodes
      // ("I saw zombie for the first time", "Routine: explore done") sat in 25-55 % of ~110 prompts in 40 min.
      if (r.last_recalled != null) r.score -= 0.3 * Math.exp(-Math.max(0, now - r.last_recalled) / (this.opts.satiationS ?? 900));
      r.tok = new Set(tokens(r.text + ' ' + (r.tags || '')));
    }
    const sel = [], pool = rows.sort((a, b) => b.score - a.score);
    const lam = this.opts.mmrLambda;
    while (sel.length < k && pool.length) {
      let best = -1, bi = 0;
      pool.forEach((r, i) => {
        const sim = sel.length ? Math.max(...sel.map((s) => (ctx.queryVec && r.embedding && s.embedding ? 0 : jaccard(r.tok, s.tok)))) : 0;
        const m = lam * r.score - (1 - lam) * sim; if (m > best) { best = m; bi = i; }
      });
      sel.push(pool.splice(bi, 1)[0]);
    }
    if (ctx.touch !== false) { const st = this.db.prepare('UPDATE episodes SET recall_count=recall_count+1, last_recalled=? WHERE id=?'); for (const r of sel) st.run(now, r.id); }
    return sel.map((r) => ({ id: r.id, t: r.t, kind: r.kind, text: r.text, count: r.count, importance: r.importance, score: +r.score.toFixed(3), cell: r.cell, habit: !!r.habit, core: !!r.core }));
  }

  // ---------------------------------------------------------------- facts
  currentFact(subject, key) { return this.db.prepare('SELECT * FROM facts WHERE subject=? AND key=? AND superseded_by IS NULL AND valid_to IS NULL ORDER BY id DESC LIMIT 1').get(subject, key) ?? null; }
  /** Assert a fact. Same value -> confirms it; different value -> old one is superseded (kept for history). */
  setFact({ subject, key, value, text = null, confidence = 0.6, t = 0, source = null, identity = false }) {
    const cur = this.currentFact(subject, key), v = String(value);
    if (cur && cur.value === v) { this.db.prepare('UPDATE facts SET confidence=min(1,confidence+0.1), last_verified=? WHERE id=?').run(t, cur.id); return { status: 'confirmed', id: cur.id }; }
    const r = this.db.prepare('INSERT INTO facts(subject,key,value,text,confidence,valid_from,last_verified,source_episode,identity) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(subject, key, v, text, confidence, t, t, source, identity ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    if (cur) this.db.prepare('UPDATE facts SET superseded_by=?, valid_to=? WHERE id=?').run(id, t, cur.id);
    return { status: cur ? 'superseded' : 'new', id, previous: cur?.id ?? null };
  }
  /** World observation beats memory: call with what she just saw. */
  verifyFact(subject, key, observed, t = 0) {
    const cur = this.currentFact(subject, key);
    if (!cur) return this.setFact({ subject, key, value: observed, confidence: 0.8, t });
    if (cur.value === String(observed)) { this.db.prepare('UPDATE facts SET confidence=min(1,confidence+0.1), last_verified=? WHERE id=?').run(t, cur.id); return { status: 'confirmed', id: cur.id }; }
    return this.setFact({ subject, key, value: observed, confidence: 0.8, t, identity: !!cur.identity });
  }
  staleFacts(now, olderThanS = 2 * DAY_S) { return this.db.prepare('SELECT * FROM facts WHERE superseded_by IS NULL AND valid_to IS NULL AND last_verified < ? AND identity=0').all(now - olderThanS); }
  factsAbout(subject) { return this.db.prepare('SELECT subject,key,value,confidence,last_verified FROM facts WHERE subject=? AND superseded_by IS NULL AND valid_to IS NULL').all(subject); }
  searchFacts(query, k = 5) { const q = ftsQuery(query); if (!q) return []; return this.db.prepare('SELECT f.* FROM facts_fts JOIN facts f ON f.id=facts_fts.rowid WHERE facts_fts MATCH ? AND f.superseded_by IS NULL ORDER BY bm25(facts_fts) LIMIT ?').all(q, k); }

  // ---------------------------------------------------------------- lessons
  /** lesson: {goal_type, x,y,z, approach, result:'death'|'fail'|'success', cause, extent (blocks the hazard was seen to span around x,y,z), strength, t}. Repeats strengthen the same row. */
  recordLesson(l) {
    const cell = Number.isFinite(l.x) ? cellKey(l.x, l.z) : (l.cell ?? null);
    const t = l.t ?? 0, st = l.strength ?? (l.result === 'death' ? 1.5 : 0.6);
    const where = [l.goal_type, cell, l.approach ?? '', l.result, l.cause ?? ''];
    const cur = this.db.prepare('SELECT id FROM lessons WHERE goal_type=? AND cell IS ? AND approach=? AND result=? AND cause=?').get(...where);
    if (cur) { this.db.prepare('UPDATE lessons SET strength=min(5,strength+?), count=count+1, last_t=?, x=coalesce(?,x), y=coalesce(?,y), z=coalesce(?,z), extent=max(extent,?) WHERE id=?').run(st * 0.5, t, l.x ?? null, l.y ?? null, l.z ?? null, l.extent ?? 0, cur.id); return cur.id; }
    return Number(this.db.prepare('INSERT INTO lessons(goal_type,cell,x,y,z,approach,result,cause,extent,strength,created_t,last_t) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(l.goal_type, cell, l.x ?? null, l.y ?? null, l.z ?? null, l.approach ?? '', l.result, l.cause ?? '', l.extent ?? 0, st, t, t).lastInsertRowid);
  }
  /** Lessons relevant to a goal type at a place (same or adjacent cell, or placeless). place: {x,z} | "cx,cz" | null. */
  lessonsFor(goalType, place = null) {
    const cell = place && typeof place === 'object' ? cellKey(place.x, place.z) : place;
    const rows = this.db.prepare('SELECT * FROM lessons WHERE (goal_type=? OR ?1 IS NULL) ORDER BY strength DESC, last_t DESC').all(goalType ?? null);
    if (!cell) return rows;
    const [cx, cz] = cell.split(',').map(Number);
    return rows.filter((r) => { if (!r.cell) return true; const [a, b] = r.cell.split(',').map(Number); return Math.abs(a - cx) <= 1 && Math.abs(b - cz) <= 1; });
  }
  allLessons(minStrength = 0) { return this.db.prepare('SELECT * FROM lessons WHERE strength>=? ORDER BY strength DESC').all(minStrength); }
  markLessonUsed(id, changedAction) { this.db.prepare('UPDATE lessons SET used_count=used_count+1, changed_count=changed_count+? WHERE id=?').run(changedAction ? 1 : 0, id); }

  // ---------------------------------------------------------------- places, relationships
  visitPlace(x, y, z, t = 0, { notable, danger = 0, name, bump = true } = {}) {
    const cell = cellKey(x, z); const cur = this.db.prepare('SELECT * FROM places WHERE cell=?').get(cell);
    const nots = cur ? JSON.parse(cur.notable) : []; if (notable && !nots.includes(notable)) nots.push(notable);
    this.db.prepare(`INSERT INTO places(cell,visits,first_t,last_t,notable,danger,name) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(cell) DO UPDATE SET visits=visits+?, last_t=?, notable=?, danger=max(danger,?), name=coalesce(?,name)`)
      .run(cell, bump ? 1 : 0, t, t, J(nots.slice(-12)), danger, name ?? null, bump ? 1 : 0, t, J(nots.slice(-12)), danger, name ?? null);
    return cell;
  }
  places() { return this.db.prepare('SELECT * FROM places ORDER BY visits DESC').all().map((r) => ({ ...r, notable: JSON.parse(r.notable) })); }
  noteInteraction(name, { t = 0, affinityDelta = 0, note = null } = {}) {
    const cur = this.db.prepare('SELECT * FROM relationships WHERE name=?').get(name);
    const notes = cur ? JSON.parse(cur.notes) : []; if (note) { notes.push(note); }
    const n = (cur?.interactions ?? 0) + 1;
    this.db.prepare(`INSERT INTO relationships(name,familiarity,affinity,interactions,first_t,last_seen,notes) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET familiarity=?, affinity=?, interactions=?, last_seen=?, notes=?`)
      .run(name, 0.1, clamp(affinityDelta, -1, 1), 1, t, t, J(notes.slice(-10)), clamp(Math.log1p(n) / Math.log(40)), clamp((cur?.affinity ?? 0) + affinityDelta, -1, 1), n, t, J(notes.slice(-10)));
  }
  relationships() { return this.db.prepare('SELECT * FROM relationships ORDER BY familiarity DESC').all().map((r) => ({ ...r, notes: JSON.parse(r.notes) })); }

  // ---------------------------------------------------------------- self summary, core, reflections (HERS; we never write these ourselves)
  setSelfSummary(text, t = 0, author = 'self') {
    text = String(text || '').trim(); if (!text) return null;
    const cur = this.getSelfSummary(); if (cur && cur.text === text) return cur.version;
    const v = (cur?.version ?? 0) + 1; this.db.prepare('INSERT INTO self_summary(version,t,text,author) VALUES(?,?,?,?)').run(v, t, text, author); return v;
  }
  getSelfSummary() { return this.db.prepare('SELECT * FROM self_summary ORDER BY version DESC LIMIT 1').get() ?? null; }
  selfSummaryHistory() { return this.db.prepare('SELECT version,t,author,length(text) AS len FROM self_summary ORDER BY version').all(); }
  addCore(text, t = 0) { const r = this.db.prepare('INSERT OR IGNORE INTO core_memories(t,text) VALUES(?,?)').run(t, String(text).trim()); return r.changes > 0; }
  coreMemories() { return this.db.prepare('SELECT * FROM core_memories ORDER BY id').all(); }
  /** Reflection dedupe: skip if token-Jaccard > 0.9 vs any of the last 50 (embedding similarity can replace it later). */
  addReflection(text, t = 0, threshold = 0.9) {
    const tk = new Set(tokens(text)); if (!tk.size) return { added: false, reason: 'empty' };
    for (const r of this.db.prepare('SELECT id,text FROM reflections ORDER BY id DESC LIMIT 50').all()) if (jaccard(tk, new Set(tokens(r.text))) > threshold) return { added: false, reason: 'duplicate', of: r.id };
    return { added: true, id: Number(this.db.prepare('INSERT INTO reflections(t,text) VALUES(?,?)').run(t, text).lastInsertRowid) };
  }
  reflections(n = 5) { return this.db.prepare('SELECT * FROM reflections ORDER BY id DESC LIMIT ?').all(n); }
  /** Reflection rate limit (12.3.5): at most one per `minEpisodes` new episodes, and at least one new episode. */
  canReflect(minEpisodes = 10) { const last = this.get('reflect_ep_id', 0); const n = this.db.prepare('SELECT count(*) AS n FROM episodes WHERE id>?').get(last).n; return n >= minEpisodes; }
  markReflected() { this.set('reflect_ep_id', this.db.prepare('SELECT coalesce(max(id),0) AS m FROM episodes').get().m); }

  // ---------------------------------------------------------------- optional embeddings (OFF by default)
  /** opts.embedder = {model:'name', embed(text)->Float32Array|number[]|Promise}. Retrieval never requires it. */
  async embedPending(limit = 64) {
    const e = this.opts.embedder; if (!e) return 0;
    const rows = this.db.prepare('SELECT id,text FROM episodes WHERE archived=0 AND (embedding IS NULL OR emb_model IS NOT ?) LIMIT ?').all(e.model ?? null, limit);
    for (const r of rows) { const v = Float32Array.from(await e.embed(r.text)); this.db.prepare('UPDATE episodes SET embedding=?, emb_model=? WHERE id=?').run(new Uint8Array(v.buffer), e.model ?? null, r.id); }
    return rows.length;
  }

  // ---------------------------------------------------------------- housekeeping
  _enforceCap() {
    const live = this.db.prepare('SELECT count(*) AS n FROM episodes WHERE archived=0').get().n; const over = live - this.opts.maxEpisodes;
    if (over > 0) this.db.prepare('DELETE FROM episodes WHERE id IN (SELECT id FROM episodes WHERE core=0 AND habit=0 AND archived=0 ORDER BY importance*strength ASC, t ASC LIMIT ?)').run(over + Math.floor(this.opts.maxEpisodes * 0.1));
  }
  stats() {
    const c = (t, w = '') => this.db.prepare(`SELECT count(*) AS n FROM ${t} ${w}`).get().n;
    const pc = this.db.prepare('PRAGMA page_count').get().page_count, ps = this.db.prepare('PRAGMA page_size').get().page_size;
    return { episodes: c('episodes', 'WHERE archived=0'), archived: c('episodes', 'WHERE archived=1'), habits: c('episodes', 'WHERE habit=1'), core: c('core_memories'), facts: c('facts'), lessons: c('lessons'), places: c('places'), relationships: c('relationships'), reflections: c('reflections'), preferences: c('preferences', "WHERE status='established'"), bytes: pc * ps };
  }

  /** Nightly (game time) consolidation. Idempotent for the same `now`. summarize(digest) is an injected (maybe async, may throw) callback
   *  returning {self_summary?, reflections?[], facts?[], core?[]} written by HER; it is skipped when nothing new happened. */
  async sleepPass(now, { summarize = null, maxEpisodes = this.opts.maxEpisodes, minGroup = 3, halfLifeDays = this.opts.halfLifeDays } = {}) {
    const d = this.db, res = { merged: 0, habitsTouched: 0, archivedPurged: 0, pruned: 0, decayed: 0, error: null, applied: null };
    const last = this.get('last_sleep_t', null), since = last ?? -Infinity, elapsed = last === null ? 0 : Math.max(0, now - last);
    const lastEpId = this.get('last_sleep_ep_id', 0);
    d.exec('BEGIN');
    try {
      // 1. merge repetitive low-importance episodes into habits
      const groups = new Map();
      for (const e of d.prepare("SELECT * FROM episodes WHERE archived=0 AND habit=0 AND core=0 AND importance<0.6").all()) {
        const key = [e.kind, e.activity ?? e.goal_type ?? '', e.cell ?? '', e.outcome ?? ''].join('|'); (groups.get(key) ?? groups.set(key, []).get(key)).push(e);
      }
      for (const [key, arr] of groups) {
        if (arr.length < minGroup) continue;
        const n = arr.reduce((s, e) => s + e.count, 0), t0 = Math.min(...arr.map((e) => e.t)), t1 = Math.max(...arr.map((e) => e.t_last ?? e.t));
        const habit = d.prepare('SELECT id,count FROM episodes WHERE habit_key=?').get(key);
        const label = arr[0].activity ?? arr[0].goal_type ?? arr[0].kind;
        const text = `Habit: ${label}${arr[0].cell ? ' around ' + arr[0].cell.split(',').map((v) => Number(v) * 16 + 8).join(',') : ''}${arr[0].outcome ? ' (' + arr[0].outcome + ')' : ''}`;
        if (habit) { d.prepare('UPDATE episodes SET count=count+?, t_last=?, strength=1 WHERE id=?').run(n, t1, habit.id); }
        else d.prepare("INSERT INTO episodes(t,t_last,day,kind,text,tags,cell,activity,goal_type,outcome,importance,strength,count,habit,habit_key) VALUES(?,?,?,'habit',?,?,?,?,?,?,0.35,1,?,1,?)")
          .run(t0, t1, dayOf(t0), text, 'habit ' + label, arr[0].cell, arr[0].activity, arr[0].goal_type, arr[0].outcome, n, key);
        d.prepare(`UPDATE episodes SET archived=1, archived_t=? WHERE id IN (${arr.map((e) => e.id).join(',')})`).run(now);
        res.merged += arr.length; res.habitsTouched++;
      }
      // 2. purge archived rows after 2 days
      res.archivedPurged = Number(d.prepare('DELETE FROM episodes WHERE archived=1 AND archived_t<=?').run(now - 2 * DAY_S).changes);
      // 3. decay unrecalled, never core/habit-identity; prune the faded
      if (elapsed > 0) {
        // per-row elapsed = time since max(previous pass, the episode's own time), so fresh episodes are not pre-aged
        const k = Math.LN2 / (DAY_S * halfLifeDays);
        res.decayed = Number(d.prepare('UPDATE episodes SET strength=strength*exp(-? * max(0, ?-max(?, coalesce(t_last,t)))) WHERE core=0 AND archived=0 AND (last_recalled IS NULL OR last_recalled<?)').run(k, now, last, since).changes);
        d.prepare('UPDATE episodes SET strength=min(1,strength+0.25) WHERE core=0 AND last_recalled>=? ').run(since);
        d.prepare('UPDATE lessons SET strength=max(CASE WHEN result=\'death\' THEN 0.5 ELSE 0 END, strength*?) WHERE last_t<?').run(Math.pow(0.5, elapsed / DAY_S / (halfLifeDays * 6)), now - DAY_S);
        d.prepare("DELETE FROM lessons WHERE strength<0.05 AND result<>'death'").run();
      }
      res.pruned = Number(d.prepare('DELETE FROM episodes WHERE core=0 AND habit=0 AND archived=0 AND strength<0.1 AND importance<0.7').run().changes);
      this._enforceCap();
      this.set('last_sleep_t', now);
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    // 4. digest for the reflection prompt, then injected LLM call
    const digest = this.buildSleepDigest(now, lastEpId);
    res.digest = digest;
    if (summarize && !digest.empty) {
      try {
        const out = await summarize(digest);
        res.applied = this.applyReflection(out, now);
        this.set('last_sleep_ep_id', d.prepare('SELECT coalesce(max(id),0) AS m FROM episodes').get().m);
      } catch (e) { res.error = String(e?.message ?? e); }
    } else if (!summarize) this.set('last_sleep_ep_id', lastEpId);
    return res;
  }

  applyReflection(out = {}, t = 0) {
    const ap = { self_summary: null, reflections: 0, facts: 0, core: 0 };
    if (out.self_summary) ap.self_summary = this.setSelfSummary(out.self_summary, t, 'self');
    for (const r of out.reflections ?? []) if (this.addReflection(r, t).added) ap.reflections++;
    for (const f of out.facts ?? []) { if (f?.subject && f?.key) { this.setFact({ ...f, t, source: 'reflection' }); ap.facts++; } }
    for (const c of out.core ?? []) if (this.addCore(c, t)) ap.core++;
    this.markReflected();
    return ap;
  }

  /** Compact material for the reflection prompt (no LLM here). */
  buildSleepDigest(now, sinceEpId = 0) {
    const d = this.db;
    const eps = d.prepare('SELECT * FROM episodes WHERE id>? AND archived=0 AND habit=0 ORDER BY importance DESC, t DESC LIMIT 12').all(sinceEpId);
    const total = d.prepare('SELECT count(*) AS n FROM episodes WHERE id>?').get(sinceEpId).n;
    const out = {
      day: dayOf(now), new_episode_count: total, empty: total === 0,
      notable: eps.map((e) => ({ t: Math.round(e.t), kind: e.kind, text: e.text.slice(0, 160), n: e.count })),
      deaths: d.prepare("SELECT text,cell FROM episodes WHERE id>? AND kind='death' LIMIT 5").all(sinceEpId),
      kinds: Object.fromEntries(d.prepare('SELECT kind, sum(count) AS n FROM episodes WHERE id>? GROUP BY kind').all(sinceEpId).map((r) => [r.kind, r.n])),
      habits: d.prepare("SELECT text,count FROM episodes WHERE habit=1 ORDER BY count DESC LIMIT 5").all(),
      lessons: d.prepare('SELECT goal_type,approach,result,cause,cell,strength FROM lessons ORDER BY last_t DESC LIMIT 6').all(),
      preference_candidates: this.preferences(true).slice(0, 5).map((p) => ({ activity: p.activity, days: p.days.length, status: p.status })),
      relationships: this.relationships().slice(0, 4).map((r) => ({ name: r.name, familiarity: +r.familiarity.toFixed(2), affinity: +r.affinity.toFixed(2) })),
      self_summary: this.getSelfSummary()?.text ?? null,
      core: this.coreMemories().slice(-5).map((c) => c.text),
    };
    return out;
  }
}
