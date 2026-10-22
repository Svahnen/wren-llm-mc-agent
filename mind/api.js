// JSON-in / JSON-out facade: `const mind = createMind({dbPath}); await mind.handle({op:'tick', dt:1, digest:{...}})`.
// One instance = one writer process (the brain host). The bot talks to it via cli.js (JSON lines on stdin/stdout) or http.
import { Drives } from './drives.js';
import { Memory, KIND_IMPORTANCE } from './memory.js';
import { WantsBook } from './wants.js';
import { buildConstraints } from './lessons-to-constraints.js';
import { buildDigest } from './digest.js';
import { cellKey } from './util.js';

export function createMind({ dbPath = ':memory:', summarize = null, memoryOptions = {}, limits = {} } = {}) {
  const memory = new Memory(dbPath, memoryOptions);
  const saved = memory.get('state_drives'), savedBook = memory.get('state_book');
  const m = {
    memory, summarize,
    drives: saved ? Drives.fromJSON(saved) : new Drives(),
    book: savedBook ? WantsBook.fromJSON(savedBook) : new WantsBook(limits),
    constraints: null,
    refreshConstraints() { m.constraints = buildConstraints(memory.allLessons(0.05), { lockouts: m.book.activeLockouts(m.drives.t), now: m.drives.t }); return m.constraints; },
    saveState() { memory.set('state_drives', m.drives.toJSON()); memory.set('state_book', m.book.toJSON()); memory.set('now', m.drives.t); },
    async handle(req) {
      try { return { ok: true, result: await dispatch(req ?? {}) }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    },
  };
  m.refreshConstraints();

  const ev = (x, kind, text, extra = {}) => memory.remember({ t: m.drives.t, kind, text, x: x?.x, y: x?.y, z: x?.z, pad: { ...m.drives.mood }, ...extra });
  async function dispatch(r) {
    const d = m.drives, b = m.book;
    switch (r.op) {
      case 'tick': {
        const events = d.tick(r.dt ?? 1, r.digest ?? {});
        if (r.digest?.pos) { const fresh = b.noteVisit(r.digest.pos.x, r.digest.pos.z, d.t); if (fresh) { d.level.curiosity = Math.min(1, d.level.curiosity + d.cfg.curiosityPerNewCell); memory.visitPlace(r.digest.pos.x, r.digest.pos.y ?? 0, r.digest.pos.z, d.t); } }
        b.expire(d.t);
        return { events, drives: d.snapshot(), t: d.t };
      }
      case 'event': { // appraise:false = the caller already appraised this outcome (goal_finish). {type: damage|death|discovery|social|goal_done|goal_failed, magnitude, text, pos, activity, ...}
        if (r.appraise !== false) d.appraise(r.type, r.magnitude ?? 1);
        const id = r.text ? ev(r.pos, r.type, r.text, { activity: r.activity, goal_type: r.goal_type, outcome: r.outcome, damage: r.damage, hpMin: r.hpMin, satisfied: r.satisfied, novelty: r.novelty, social: r.social, importance: r.importance }) : null;
        return { episode: id, mood: d.snapshot().mood };
      }
      case 'lesson': { const id = memory.recordLesson({ ...r.lesson, t: d.t }); m.refreshConstraints(); return { id, lockouts: m.constraints.lockouts.length, zones: m.constraints.zones.length }; }
      case 'cost': return { cost: m.constraints.costAt(r.pos), forbidden: m.constraints.forbidden(r.pos) };
      case 'constraints': { const c = m.constraints; return { zones: c.zones, lockouts: c.lockouts }; }
      case 'can_start': m.refreshConstraints(); return { ...b.canStart(r.goal, d.t), penalty: m.constraints.goalPenalty(r.goal.type, r.goal.place) };
      case 'goal_start': { const out = b.startGoal(r.goal, d.t); m.refreshConstraints(); return out; }
      case 'goal_finish': { const g = b.finishGoal(r.id, r.outcome, d.t); if (g && r.outcome !== 'preempted') { d.appraise(r.outcome === 'done' ? 'goal_done' : 'goal_failed'); } return { goal: g }; }
      case 'want': return b.addWant({ ...r.want, t: d.t });
      case 'curiosity': return b.curiosityTargets(r.pos, r.opts);
      case 'examine': return { n: b.markExaminedNear(r.name, r.x, r.z, r.radius ?? 24) };
      case 'interaction': memory.noteInteraction(String(r.name).slice(0, 40), { t: d.t, affinityDelta: r.affinityDelta ?? 0.02, note: r.note ? String(r.note).slice(0, 80) : null }); return { ok: true };
      case 'people': return memory.relationships().slice(0, 12);
      case 'sighting': return b.noteSighting({ ...r.sighting, t: d.t });
      case 'digest': return buildDigest(r.raw ?? {}, { drives: d, book: b, memory, constraints: m.constraints, now: d.t, query: r.query });
      case 'retrieve': return memory.retrieve(r.query, r.k ?? 5, { now: d.t, ...(r.ctx ?? {}) });
      case 'lessons_for': return memory.lessonsFor(r.goal_type, r.place);
      case 'fact': return memory.verifyFact(r.subject, r.key, r.value, d.t);
      case 'self_summary': return memory.setSelfSummary(r.text, d.t, 'self');
      case 'sleep': { const out = await memory.sleepPass(r.now ?? d.t, { summarize: m.summarize }); m.refreshConstraints(); m.saveState(); return out; }
      case 'status': return { drives: d.snapshot(), memory: memory.stats(), lockouts: b.activeLockouts(d.t), stats: b.stats, t: d.t };
      case 'core_add': return { added: memory.addCore(String(r.text ?? '').slice(0, 200), d.t) };
      case 'goals_save': memory.set('state_goals', r.snapshot ?? {}); return { saved: true };
      case 'goals_load': return { snapshot: memory.get('state_goals', null) };
      case 'save': m.saveState(); return { saved: true };
      default: throw new Error('unknown op: ' + r.op);
    }
  }
  return m;
}
export { KIND_IMPORTANCE, cellKey };
