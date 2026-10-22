// Grounded world digest for S2. Small (<1200 tokens), stable-prefix friendly: slow-changing parts first
// (self_summary, core memories, established preferences), volatile parts last (nearby, retrieved episodes) so the LLM prompt cache survives.
import { estimateTokens, dayOf, DAY_S, CELL } from './util.js';

export const DIGEST_VERSION = 1;
export const TOKEN_BUDGET = 1200;

function timeOfDay(ticks) {
  if (!Number.isFinite(ticks)) return null;
  const t = ((ticks % 24000) + 24000) % 24000;
  return { ticks: t, phase: t < 1000 ? 'dawn' : t < 12000 ? 'day' : t < 13000 ? 'dusk' : 'night' };
}
function summarizeInventory(inv = []) {
  const m = new Map(); for (const i of inv) m.set(i.name, (m.get(i.name) || 0) + (i.count ?? 1));
  return [...m].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}x${c}`);
}
/** SURV1: relative age, e.g. '4 h ago' (t in the mind's seconds) */
export function agoText(s) {
  if (!Number.isFinite(s) || s < 0) return null;
  return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 360) / 10} h ago` : `${Math.round(s / 8640) / 10} days ago`;
}
const cellCentre = (cell) => { if (typeof cell !== 'string') return null; const [a, b] = cell.split(',').map(Number); return Number.isFinite(a) && Number.isFinite(b) ? { x: a * CELL + CELL / 2, z: b * CELL + CELL / 2 } : null; };
/** '(4 h ago, 700 m away) ' prefix for a memory at world point `at` ({x,z}) made at game time t */
export function recency(t, at, now, pos) {
  const ago = agoText(now - t), d = at && pos ? Math.round(Math.hypot(at.x - pos.x, at.z - pos.z)) : null;
  const parts = [ago, d != null ? `${d} m away` : null].filter(Boolean);
  return parts.length ? `(${parts.join(', ')}) ` : '';
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

/** raw: {pos:{x,y,z}, hp, food, dayTime (ticks), gameTime (gs), inventory:[{name,count}], entities:[{type,name,dist,hostile}], blocks:[{name,dist,dir}], humans:[{name,dist}], freeSlots}
 *  ctx: {drives, mood?, book, memory, constraints, now, query?} -> JSON object with `_tokens` estimate. */
export function buildDigest(raw, ctx) {
  const { drives, book, memory, constraints } = ctx, now = ctx.now ?? raw.gameTime ?? drives?.t ?? 0, pos = raw.pos ?? { x: 0, y: 0, z: 0 };
  const sum = memory?.getSelfSummary?.();
  // SURV1: `at` used to be the 16-block CELL index ("-52,16"), which S2 read as world coordinates; now world x,z of the spot + age + distance from here
  const lessons = (memory?.lessonsFor(null, null) ?? []).slice(0, 5).map((l) => {
    const c = Number.isFinite(l.x) ? { x: l.x, z: l.z } : cellCentre(l.cell);
    return { goal: l.goal_type, what: l.result + (l.cause ? ':' + l.cause : ''), at: c ? [Math.round(c.x), Math.round(c.z)] : null, ago: agoText(now - (l.last_t ?? l.created_t)), dist: c ? Math.round(Math.hypot(c.x - pos.x, c.z - pos.z)) : null, s: +l.strength.toFixed(1) };
  });
  const goal = book?.goals.filter((g) => g.status === 'active').slice(-1)[0];
  const snap = drives?.snapshot();
  const query = ctx.query ?? [goal?.type, ...(raw.entities ?? []).slice(0, 3).map((e) => e.name ?? e.type)].filter(Boolean).join(' ');
  const eps = memory ? memory.retrieve(query, 4, { now, x: pos.x, z: pos.z }) : [];
  const d = {
    v: DIGEST_VERSION,
    // ---- stable prefix
    self_summary: trunc(sum?.text ?? null, 900), self_summary_version: sum?.version ?? 0, self_summary_age_s: sum && Number.isFinite(sum.t) ? Math.max(0, Math.round(now - sum.t)) : null,
    core: (memory?.coreMemories?.() ?? []).slice(-4).map((c) => trunc(c.text, 160)),
    preferences: (memory?.preferences?.() ?? []).slice(0, 4).map((p) => `${p.activity} (${p.days.length}d)`),
    // ---- slow
    day: dayOf(now), time: timeOfDay(raw.dayTime),
    confined: trunc(raw.confined ?? null, 220), // L2: set only while stuck on a column (the body's ground truth), null otherwise
    // ---- volatile
    body: { pos: [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)], hp: raw.hp, food: raw.food, free_slots: raw.freeSlots, inv: summarizeInventory(raw.inventory).slice(0, 12) },
    needs: snap ? { ...snap.urgencies } : null, mood: snap?.mood ?? null,
    goal: goal ? { type: goal.type, target: goal.target, since_s: Math.round(now - goal.started_t) } : null,
    wants: (book?.wants ?? []).filter((w) => w.status === 'open').sort((a, b) => b.strength - a.strength).slice(0, 3).map((w) => trunc(`${Number.isFinite(w.created_t) ? '(' + agoText(now - w.created_t) + ') ' : ''}${w.text}`, 120)),
    lockouts: (constraints?.lockouts ?? book?.activeLockouts?.(now) ?? []).slice(0, 4).map((l) => l.token ?? `${l.type}@${l.place}`),
    lessons,
    curiosity: (book?.curiosityTargets(pos, { max: 3 }) ?? []).map((c) => ({ what: trunc(c.text, 60), at: [Math.round(c.x), Math.round(c.z)], dist: c.dist })),
    nearby: { entities: (raw.entities ?? []).slice(0, 6).map((e) => `${e.name ?? e.type}${e.hostile ? '!' : ''}@${Math.round(e.dist)}`), blocks: (raw.blocks ?? []).slice(0, 5).map((b) => `${b.name}@${Math.round(b.dist)}${b.dir ?? ''}`), humans: (raw.humans ?? []).map((h) => `${h.name}@${Math.round(h.dist)}`) },
    episodes: eps.map((e) => trunc(`${recency(e.t, cellCentre(e.cell), now, pos)}${e.habit ? '[habit] ' : ''}${e.text}`, 170)),
  };
  // trim volatile/long parts until it fits (never touch the stable prefix except truncating the self summary last)
  const steps = [
    () => { d.episodes = d.episodes.slice(0, 2); }, () => { d.nearby.entities = d.nearby.entities.slice(0, 3); d.nearby.blocks = d.nearby.blocks.slice(0, 2); },
    () => { d.curiosity = d.curiosity.slice(0, 2); d.lessons = d.lessons.slice(0, 3); }, () => { d.body.inv = d.body.inv.slice(0, 6); d.wants = d.wants.slice(0, 1); },
    () => { d.episodes = []; d.preferences = []; }, () => { d.core = d.core.slice(-2); },
    () => { d.self_summary = trunc(d.self_summary, 400); }, () => { d.self_summary = trunc(d.self_summary, 200); d.lessons = d.lessons.slice(0, 1); },
  ];
  let i = 0; while (estimateTokens(d) > TOKEN_BUDGET && i < steps.length) steps[i++]();
  d._tokens = estimateTokens(d);
  return d;
}
