import test from 'node:test'; import assert from 'node:assert/strict';
import { WantsBook } from '../wants.js'; import { DAY_S } from '../util.js';

const G = (type, place, target) => ({ type, place, target: target ?? place });
test('repeat cap: same goal+target at most 2x per game day, resets next day', () => {
  const b = new WantsBook(); const g = G('mine_iron', '2,2', '46,46');
  for (let i = 0; i < 2; i++) { assert.ok(b.canStart(g, 100 + i * 50).ok); b.startGoal(g, 100 + i * 50); }
  assert.deepEqual(b.canStart(g, 300), { ok: false, reason: 'repeat_cap' });
  assert.ok(b.canStart({ ...g, target: '47,47' }, 300).ok, 'different target is fine'); assert.ok(b.canStart(g, DAY_S + 5).ok);
});
test('attempt budget per (type, place) and failure budget block exhausted places', () => {
  const b = new WantsBook(); for (let i = 0; i < 4; i++) b.startGoal(G('chop', '1,1', `t${i}`), 10 + i);
  assert.equal(b.canStart(G('chop', '1,1', 'new'), 50).reason, 'attempt_budget'); assert.ok(b.canStart(G('chop', '3,3', 'new'), 50).ok, 'other place unaffected');
  const c = new WantsBook(); for (let i = 0; i < 3; i++) { const { goal } = c.startGoal(G('dig', '5,5', 'x' + i), 10 * i); c.finishGoal(goal.id, 'failed', 10 * i + 5); }
  assert.equal(c.canStart(G('dig', '5,5', 'y'), 100).reason, 'fail_budget'); assert.ok(c.canStart(G('dig', '5,5', 'y'), 100 + DAY_S).ok, 'unblocks later');
});
test('cycle detector: periods 2..6 within 30 min -> lockouts; single-token repeats and slow sequences are not cycles', () => {
  for (const p of [2, 3, 4, 5, 6]) {
    const b = new WantsBook({ repeatCapPerDay: 99, attemptsPerDay: 99 }); let hit = null;
    for (let i = 0; i < p * 2; i++) { const r = b.startGoal(G('g' + (i % p), 'c' + (i % p)), 10 * i); if (r.cycle) hit = r.cycle; }
    assert.ok(hit, 'period ' + p); assert.equal(hit.period, p); assert.equal(b.activeLockouts(100).length, p);
    assert.equal(b.canStart(G('g0', 'c0'), 120).reason, 'locked_out'); assert.ok(b.canStart(G('g0', 'c0'), 120 + 1801).ok, 'lockout expires after 30 min');
  }
  const same = new WantsBook({ repeatCapPerDay: 99, attemptsPerDay: 99 }); for (let i = 0; i < 8; i++) assert.equal(same.startGoal(G('a', 'x'), i).cycle, null);
  const slow = new WantsBook({ repeatCapPerDay: 99, attemptsPerDay: 99 }); for (let i = 0; i < 6; i++) assert.equal(slow.startGoal(G('g' + (i % 2), 'c' + (i % 2)), i * 1000).cycle, null, 'outside 30 min window');
  const varied = new WantsBook(); ['a', 'b', 'c', 'd', 'e', 'f'].forEach((x, i) => assert.equal(varied.startGoal(G(x, x), i).cycle, null));
});
test('novelty and curiosity targets come from her own knowledge map', () => {
  const b = new WantsBook(); assert.equal(b.noteVisit(8, 8, 0), true); assert.equal(b.noteVisit(9, 9, 1), false);
  assert.equal(b.noveltyAt(8, 8), 1 / 3); assert.equal(b.noveltyAt(500, 500), 1);
  b.noteSighting({ kind: 'structure', name: 'village', x: 120, z: 40, t: 5 }); b.noteSighting({ kind: 'block', name: 'crying_obsidian', x: 20, z: 20 });
  const t = b.curiosityTargets({ x: 8, z: 8 }, { max: 20 }); assert.ok(t.some((x) => x.kind === 'sighting' && /village/.test(x.text))); assert.ok(t.some((x) => x.kind === 'frontier'));
  b.markExamined(t.find((x) => /village/.test(x.text)).id); assert.ok(!b.curiosityTargets({ x: 8, z: 8 }, { max: 20 }).some((x) => /village/.test(x.text) && x.kind === 'sighting'));
  assert.equal(new WantsBook().curiosityTargets({ x: 0, z: 0 }).length, 0);
});
test('wants, projects, expiry, JSON round trip', () => {
  const b = new WantsBook(); const w = b.addWant({ text: 'see the coast', reason: 'bored', strength: 0.7, t: 0 }); assert.equal(b.addWant({ text: 'see the coast', strength: 0.9 }).id, w.id);
  const p = b.addProject({ name: 'coast map', milestones: ['reach coast', 'walk it'] }); b.milestoneDone(p.id, 0); b.milestoneDone(p.id, 1); assert.equal(p.status, 'done');
  b.expire(3 * DAY_S); assert.equal(w.status, 'expired');
  const r = WantsBook.fromJSON(JSON.parse(JSON.stringify(b))); assert.equal(r.wants.length, 1); assert.ok(r.visited instanceof Map);
});
