import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Memory, isPleasant } from '../memory.js'; import { DAY_S } from '../util.js';

test('empty DB: nothing crashes', async () => {
  const m = new Memory();
  assert.deepEqual(m.retrieve('anything', 5), []); assert.deepEqual(m.retrieve('', 5), []); assert.deepEqual(m.lessonsFor('x', null), []);
  assert.equal(m.getSelfSummary(), null); assert.deepEqual(m.preferences(), []); assert.equal(m.currentFact('a', 'b'), null);
  const r = await m.sleepPass(1000, { summarize: () => { throw new Error('must not be called'); } }); assert.equal(r.digest.empty, true); assert.equal(r.error, null);
  assert.ok(m.stats().episodes === 0);
});
test('FTS retrieval ranks relevant + place; MMR avoids near-duplicates; works without embeddings', () => {
  const m = new Memory();
  m.remember({ t: 10, kind: 'discovery', text: 'found a deep cave with iron ore and lava', x: 40, z: 40 });
  m.remember({ t: 500, kind: 'routine', text: 'picked apples near the farm', x: 10, z: 10, activity: 'food' });
  m.remember({ t: 600, kind: 'routine', text: 'picked apples near the farm again', x: 10, z: 11, activity: 'food' });
  m.remember({ t: 700, kind: 'social', text: 'Alex said hello at home', x: 8, z: 8 });
  const r = m.retrieve('iron cave', 2, { now: 800 }); assert.match(r[0].text, /iron/);
  const apples = m.retrieve('apples farm', 2, { now: 800, touch: false }); assert.equal(apples.filter((a) => /apples/.test(a.text)).length >= 1, true);
  assert.ok(m.retrieve('apples farm', 3, { now: 800 }).length <= 3);
  const rec = m.db.prepare('SELECT recall_count FROM episodes WHERE id=?').get(r[0].id); assert.ok(rec.recall_count >= 1);
});
test('near-identical consecutive events are counted, not duplicated', () => {
  const m = new Memory(); for (let i = 0; i < 20; i++) m.remember({ t: i, kind: 'routine', text: 'walked' });
  assert.equal(m.stats().episodes, 1); assert.equal(m.db.prepare('SELECT count FROM episodes').get().count, 20);
});
test('facts: supersede on change, verify confirms, history kept', () => {
  const m = new Memory(); const a = m.setFact({ subject: 'world', key: 'farm', value: 'at 12,8', t: 0 }); assert.equal(a.status, 'new');
  assert.equal(m.verifyFact('world', 'farm', 'at 12,8', 50).status, 'confirmed');
  const c = m.verifyFact('world', 'farm', 'gone', 100); assert.equal(c.status, 'superseded');
  assert.equal(m.currentFact('world', 'farm').value, 'gone'); const old = m.db.prepare('SELECT * FROM facts WHERE id=?').get(a.id); assert.equal(old.superseded_by, c.id); assert.equal(old.valid_to, 100);
  assert.equal(m.staleFacts(10 * DAY_S).length, 1);
});
test('lessons: upsert strengthens, lessonsFor filters by goal and nearby place', () => {
  const m = new Memory(); m.recordLesson({ goal_type: 'mine_iron', x: 31, y: 12, z: 31, result: 'death', cause: 'lava', t: 1 }); m.recordLesson({ goal_type: 'mine_iron', x: 31, y: 12, z: 31, result: 'death', cause: 'lava', t: 2 });
  assert.equal(m.allLessons().length, 1); assert.ok(m.allLessons()[0].strength > 1.5);
  assert.equal(m.lessonsFor('mine_iron', { x: 30, z: 30 }).length, 1); assert.equal(m.lessonsFor('mine_iron', { x: 300, z: 300 }).length, 0); assert.equal(m.lessonsFor('fish', { x: 30, z: 30 }).length, 0);
});
test('preferences need pleasant episodes on 3+ separate days; "pleasant" is code-defined', () => {
  const m = new Memory(); const ev = (day, act, extra = {}) => ({ t: day * DAY_S + 5, kind: 'routine', text: `${act} day ${day}`, activity: act, satisfied: ['curiosity'], pad: { p: 0.2, a: 0, d: 0 }, ...extra });
  for (const d of [0, 0, 0, 1]) m.remember(ev(d, 'fishing', { text: 'fishing x' + Math.random() })); assert.deepEqual(m.preferences(), []);
  m.remember(ev(2, 'fishing')); assert.equal(m.preferences().length, 1);
  for (const d of [0, 1, 2, 3]) m.remember(ev(d, 'mining', { damage: 5, text: 'mining ' + d })); // hurt -> not pleasant
  assert.equal(m.preferences(true).some((p) => p.activity === 'mining'), false);
  assert.equal(isPleasant({ kind: 'death', satisfied: ['x'] }), false); assert.equal(isPleasant({ kind: 'routine' }), false);
});
test('self summary versioned, core never decays, reflection dedupe, injected sleep callback', async () => {
  const m = new Memory(); m.addCore('My name is Wren and I am an AI with a body.', 0); m.setFact({ subject: 'self', key: 'name', value: 'Wren', identity: true });
  for (let i = 0; i < 30; i++) m.remember({ t: i * 200, kind: 'routine', text: 'wander ' + i, activity: 'wander', importance: 0.1, x: i * 40, z: 0 });
  let calls = 0; const sum = (d) => { calls++; return { self_summary: 'I walk a lot.', reflections: ['I walk a lot of days'] }; };
  const r1 = await m.sleepPass(10 * DAY_S, { summarize: sum }); assert.equal(calls, 1); assert.equal(m.getSelfSummary().version, 1);
  await m.sleepPass(11 * DAY_S, { summarize: () => ({ self_summary: 'I walk a lot.', reflections: ['I walk a lot of days!'] }) }); assert.equal(m.getSelfSummary().version, 1, 'same text -> no new version');
  m.remember({ t: 12 * DAY_S, kind: 'social', text: 'someone arrived' }); await m.sleepPass(40 * DAY_S, { summarize: () => ({ reflections: ['I walk a lot of days'] }) });
  assert.equal(m.reflections(10).length, 1, 'duplicate reflection dropped'); assert.equal(m.coreMemories().length, 1); assert.equal(m.currentFact('self', 'name').value, 'Wren');
  m.remember({ t: 49 * DAY_S, kind: 'social', text: 'fresh event for failing callback' });
  const failing = await m.sleepPass(50 * DAY_S, { summarize: () => { throw new Error('llm down'); } }); assert.match(failing.error, /llm down/); assert.equal(m.stats().episodes > 0, true);
});
test('sleepPass is idempotent, merges repeats into a habit, keeps DB bounded', async () => {
  const m = new Memory(':memory:', { maxEpisodes: 200 });
  for (let i = 0; i < 60; i++) m.remember({ t: i * 130, kind: 'routine', text: 'ate bread ' + i, activity: 'eat', x: 12, z: 8, outcome: 'done', importance: 0.1 });
  m.remember({ t: 8000, kind: 'death', text: 'fell into lava', x: 31, z: 31 });
  const a = await m.sleepPass(9000), s1 = m.stats(); const b = await m.sleepPass(9000), s2 = m.stats();
  assert.ok(a.merged >= 60 && s1.habits === 1); assert.equal(b.merged, 0); assert.equal(b.pruned, 0); assert.equal(b.decayed >= 0, true);
  const strength = () => m.db.prepare('SELECT sum(strength) AS s FROM episodes').get().s; const before = strength(); await m.sleepPass(9000); assert.equal(strength(), before);
  assert.deepEqual({ ...s1, bytes: 0 }, { ...s2, bytes: 0 });
  assert.equal(m.retrieve('lava', 1, { now: 9000 })[0].kind, 'death');
  // growth: 40 days x 80 events with nightly passes stays under the cap
  for (let day = 1; day <= 40; day++) { for (let i = 0; i < 80; i++) m.remember({ t: day * DAY_S + i * 10, kind: i % 9 === 0 ? 'discovery' : 'routine', text: `thing ${day}-${i} ${(i * 7919) % 97}`, activity: 'a' + (i % 5), x: (i * 13) % 200, z: (i * 29) % 200 }); await m.sleepPass(day * DAY_S + 1100); }
  const st = m.stats(); assert.ok(st.episodes + st.habits <= 300, 'episodes ' + st.episodes); assert.ok(st.bytes < 2_000_000, 'bytes ' + st.bytes);
});
test('persists to file and reopens; read-only handle works', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mind-')), 'm.sqlite'); const a = new Memory(p); a.remember({ t: 1, kind: 'routine', text: 'hello cave' }); a.close();
  const b = new Memory(p, { readOnly: true }); assert.equal(b.retrieve('cave', 1, { touch: false }).length, 1); b.close(); fs.rmSync(path.dirname(p), { recursive: true });
});
test('optional embedder: off by default, usable when provided', async () => {
  const m = new Memory(); assert.equal(await m.embedPending(), 0);
  const e = { model: 'fake', embed: (t) => [t.includes('cave') ? 1 : 0, t.includes('farm') ? 1 : 0] }; const n = new Memory(':memory:', { embedder: e });
  n.remember({ t: 1, kind: 'routine', text: 'a cave' }); n.remember({ t: 2, kind: 'routine', text: 'a farm' }); assert.equal(await n.embedPending(), 2);
  assert.equal(n.retrieve('zzz', 1, { now: 3, queryVec: [1, 0] })[0].text, 'a cave');
});

test('Q1: retrieval rotates: an episode just handed to the prompt is down-weighted so other relevant memories surface', () => {
  const m = new Memory(':memory:');
  for (let i = 0; i < 8; i++) m.remember({ t: 100 + i, kind: 'discovery', text: `I saw zombie number ${i} near the old well`, x: 10 + i, z: 5 });
  const seen = new Set(); let t = 200;
  for (let round = 0; round < 6; round++) { for (const e of m.retrieve('zombie well', 2, { now: t += 30 })) seen.add(e.id); }
  assert.ok(seen.size >= 6, 'six rounds of 2 covered ' + seen.size + ' distinct episodes');
  const first = m.retrieve('zombie well', 2, { now: 5000, touch: false }).map((e) => e.id);
  const again = m.retrieve('zombie well', 2, { now: 5000, touch: false }).map((e) => e.id);
  assert.deepEqual(first, again, 'touch:false is a pure read');
});
