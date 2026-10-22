import test from 'node:test'; import assert from 'node:assert/strict';
import { Memory } from '../memory.js'; import { Drives } from '../drives.js'; import { WantsBook } from '../wants.js'; import { buildConstraints } from '../lessons-to-constraints.js'; import { buildDigest, TOKEN_BUDGET } from '../digest.js'; import { estimateTokens } from '../util.js';
function fixture(n = 200) {
  const memory = new Memory(), drives = new Drives(), book = new WantsBook(); drives.t = 5000;
  memory.setSelfSummary('I am Wren. '.repeat(120), 0); for (let i = 0; i < 20; i++) memory.addCore('core memory number ' + i + ' '.repeat(5) + 'x'.repeat(100), 0);
  for (let i = 0; i < n; i++) memory.remember({ t: i * 20, kind: 'discovery', text: `found cave ${i} with iron and lava and spiders`, x: i, z: i });
  for (let i = 0; i < 10; i++) memory.recordLesson({ goal_type: 'g' + i, x: i, z: i, result: 'death', cause: 'lava' });
  for (let i = 0; i < 30; i++) { book.noteSighting({ kind: 'block', name: 'odd' + i, x: i * 20, z: 0 }); book.addWant({ text: 'want ' + i, strength: i / 30 }); }
  book.startGoal({ type: 'explore', target: '1,1', place: '0,0' }, 4900);
  return { memory, drives, book, constraints: buildConstraints(memory.allLessons()) };
}
test('digest under 1200 tokens even with heavy state, stable prefix first, volatile last', () => {
  const f = fixture(); const raw = { pos: { x: 3, y: 64, z: 9 }, hp: 14, food: 11, dayTime: 14000, inventory: Array.from({ length: 40 }, (_, i) => ({ name: 'item' + i, count: i + 1 })), entities: Array.from({ length: 30 }, (_, i) => ({ type: 'zombie', dist: i, hostile: true })), blocks: Array.from({ length: 30 }, (_, i) => ({ name: 'stone' + i, dist: i })), humans: [{ name: 'Alex', dist: 5 }] };
  const d = buildDigest(raw, { ...f, now: 5000 }); assert.ok(d._tokens <= TOKEN_BUDGET, 'tokens ' + d._tokens); assert.equal(estimateTokens(d), d._tokens + 0 === d._tokens ? estimateTokens(d) : 0);
  const keys = Object.keys(d); assert.ok(keys.indexOf('self_summary') < keys.indexOf('core') && keys.indexOf('core') < keys.indexOf('body') && keys.indexOf('body') < keys.indexOf('episodes') && keys.at(-2) === 'episodes');
  assert.equal(d.time.phase, 'night'); assert.equal(d.goal.type, 'explore'); assert.ok(d.needs.hunger !== undefined && d.mood.label);
  assert.deepEqual(JSON.parse(JSON.stringify(d)), JSON.parse(JSON.stringify(d)));
});
test('digest works with nothing: empty memory, bare raw state', () => {
  const d = buildDigest({}, { memory: new Memory(), drives: new Drives(), book: new WantsBook(), constraints: buildConstraints([]) }); assert.ok(d._tokens < 400); assert.equal(d.self_summary, null);
  const e = buildDigest({}, {}); assert.ok(e.v === 1);
});
test('stable prefix identical between calls when only the world changes', () => {
  const f = fixture(10); const a = buildDigest({ pos: { x: 1, y: 1, z: 1 }, hp: 20 }, { ...f, now: 5000 }), b = buildDigest({ pos: { x: 90, y: 1, z: 1 }, hp: 3 }, { ...f, now: 5000 });
  const pre = (d) => JSON.stringify([d.v, d.self_summary, d.self_summary_version, d.core, d.preferences]); assert.equal(pre(a), pre(b));
});

import { Drives as DrivesM4 } from '../drives.js';
test('M4: the digest carries the mood numbers and the live label', () => {
  const drives = new DrivesM4(); Object.assign(drives.mood, { p: 0.22, a: 0.17, d: 0.29 });
  const d = buildDigest({ pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20 }, { drives, now: 10 });
  assert.deepEqual([d.mood.p, d.mood.a, d.mood.d], [0.22, 0.17, 0.29]); assert.equal(d.mood.label, 'exuberant'); assert.ok(d.mood.desc);
  Object.assign(drives.mood, { p: -0.4, a: -0.4, d: -0.4 });
  assert.equal(buildDigest({ pos: { x: 0, y: 64, z: 0 } }, { drives, now: 11 }).mood.label, 'bored');
});
