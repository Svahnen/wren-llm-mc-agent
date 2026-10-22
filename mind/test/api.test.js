import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { createMind } from '../api.js';
test('JSON API: tick, event, lesson->cost, goal lifecycle, digest, sleep, bad ops', async () => {
  const m = createMind({ summarize: () => ({ self_summary: 'I like caves.' }) });
  let r = await m.handle({ op: 'tick', dt: 1, digest: { food: 3, hp: 20, pos: { x: 1, z: 1 } } }); assert.ok(r.ok); assert.ok(r.result.drives.levels.hunger < 0.2); assert.ok(r.result.events.some((e) => e.drive === 'hunger'));
  r = await m.handle({ op: 'event', type: 'discovery', text: 'found a ravine', pos: { x: 5, y: 60, z: 5 } }); assert.ok(r.result.episode);
  r = await m.handle({ op: 'lesson', lesson: { goal_type: 'mine', x: 31, y: 12, z: 31, result: 'death', cause: 'lava', extent: 3 } }); assert.equal(r.result.zones, 1);
  r = await m.handle({ op: 'cost', pos: { x: 31, y: 12, z: 31 } }); assert.equal(r.result.forbidden, true);
  r = await m.handle({ op: 'goal_start', goal: { type: 'explore', target: '1,1', place: '0,0' } }); const id = r.result.goal.id;
  assert.equal((await m.handle({ op: 'can_start', goal: { type: 'explore', target: '1,1', place: '0,0' } })).result.ok, true);
  assert.ok((await m.handle({ op: 'goal_finish', id, outcome: 'done' })).ok);
  r = await m.handle({ op: 'digest', raw: { pos: { x: 1, y: 1, z: 1 }, hp: 20, food: 3 } }); assert.ok(r.result._tokens < 1200); assert.ok(r.result.lessons.length === 1);
  r = await m.handle({ op: 'sleep' }); assert.ok(r.ok); assert.equal(m.memory.getSelfSummary().text, 'I like caves.');
  assert.equal((await m.handle({ op: 'nope' })).ok, false); assert.equal((await m.handle(null)).ok, false);
});
test('state persists across restart (single writer reopens the file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-api-')), db = path.join(dir, 'm.sqlite');
  const a = createMind({ dbPath: db }); await a.handle({ op: 'lesson', lesson: { goal_type: 'x', x: 1, y: 1, z: 1, result: 'death', cause: 'lava' } }); await a.handle({ op: 'tick', dt: 100, digest: { food: 5 } }); a.saveState(); a.memory.close();
  const b = createMind({ dbPath: db }); assert.equal(b.constraints.zones.length, 1); assert.ok(b.drives.t > 99); b.memory.close(); fs.rmSync(dir, { recursive: true });
});
test('cli.js speaks JSON lines', () => {
  const r = spawnSync('node', [path.join(import.meta.dirname, '../cli.js')], { input: '{"op":"status","id":1}\nnot json\n', encoding: 'utf8', timeout: 20000 });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l)); assert.equal(lines[0].ok, true); assert.equal(lines[0].id, 1); assert.equal(lines[1].ok, false);
});
test('PVP1: "X hit me" is stored as a relationship note + an episode, with NO affinity change and no drive appraisal', async () => {
  const m = createMind({ summarize: () => ({}) });
  const before = JSON.stringify(m.drives.snapshot().levels);
  await m.handle({ op: 'interaction', name: 'Alex', affinityDelta: 0, note: 'hit me 3 times (-7 hp) near home' });
  const e = await m.handle({ op: 'event', type: 'social', appraise: false, text: 'Alex hit me 3 times (-7 hp) near home', pos: { x: 3, y: 64, z: 3 }, importance: 0.7, damage: 7 });
  assert.ok(e.ok && e.result.episode);
  const rel = (await m.handle({ op: 'people' })).result.find((r) => r.name === 'Alex');
  assert.equal(rel.affinity, 0); assert.match(rel.notes[0], /hit me 3 times/);
  assert.equal(JSON.stringify(m.drives.snapshot().levels), before);
  m.memory.close();
});
