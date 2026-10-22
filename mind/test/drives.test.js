import test from 'node:test'; import assert from 'node:assert/strict';
import { Drives, DRIVE_NAMES } from '../drives.js'; import { DAY_S } from '../util.js';

test('urgency is (1-level)^2 and all drives have equal weight', () => {
  const d = new Drives(); d.level.hunger = 0.5; d.level.energy = 0.5;
  assert.equal(d.urgency('hunger'), 0.25); assert.equal(d.urgency('hunger'), d.urgency('energy'));
  assert.equal(DRIVE_NAMES.length, 5);
});
test('drives fall when unmet and rise when met', () => {
  const d = new Drives(); for (let i = 0; i < 600; i++) d.tick(1, { food: 20 - i / 60, hp: 20 });
  assert.ok(d.level.energy < 0.9 && d.level.curiosity < 0.9 && d.level.social < 0.9 && d.level.hunger < 0.9);
  const e0 = d.level.energy; for (let i = 0; i < 100; i++) d.tick(1, { food: 20, sleeping: true }); assert.ok(d.level.energy > e0);
  const s0 = d.level.social; for (let i = 0; i < 20; i++) d.tick(1, { humansNearby: 1 }); assert.ok(d.level.social > s0);
  const c0 = d.level.curiosity; d.tick(1, { newCells: 3 }); assert.ok(d.level.curiosity > c0);
});
test('threshold events fire once, respect hysteresis and cooldown', () => {
  const d = new Drives(); const evs = [];
  for (let i = 0; i < 3000; i++) evs.push(...d.tick(1, { food: 20 }).filter((e) => e.type === 'drive_threshold' && e.drive === 'energy'));
  assert.equal(evs.filter((e) => e.kind === 'low').length, 1); assert.equal(evs.filter((e) => e.kind === 'critical').length, 1);
  // flicker around the line must not spam
  const f = new Drives(); f.level.hunger = 0.5; let n = 0;
  for (let i = 0; i < 200; i++) n += f.tick(1, { food: i % 2 ? 7.9 : 8.1 }).filter((e) => e.type === 'drive_threshold').length;
  assert.ok(n <= 1, 'flicker events: ' + n);
});
test('TPS-aware: half TPS means half the decay', () => {
  const a = new Drives(), b = new Drives(); for (let i = 0; i < 1000; i++) { a.tick(1, { tps: 20 }); b.tick(1, { tps: 10 }); }
  assert.ok(Math.abs((0.9 - b.level.energy) * 2 - (0.9 - a.level.energy)) < 1e-6); assert.ok(Math.abs(b.t - 500) < 1e-9);
});
test('satisfaction signal when a deficit is relieved; frustration lowers mood', () => {
  const d = new Drives(); d.tick(1, { food: 4 }); const evs = d.tick(1, { food: 20 });
  assert.ok(evs.some((e) => e.type === 'satisfaction' && e.drive === 'hunger')); assert.ok(d.mood.p > 0);
  const m = d.mood.p; d.frustrate('curiosity', 0.5); assert.ok(d.mood.p < m); assert.ok(d.frustration.curiosity > 0);
});
test('PAD mood appraisals and decay to neutral (no baseline)', () => {
  const d = new Drives(); d.appraise('death'); assert.ok(d.mood.p < -0.5);
  d.appraise('discovery'); d.appraise('social'); assert.ok(d.mood.p > -0.8);
  for (let i = 0; i < 20000; i++) d.tick(1, {}); assert.ok(Math.hypot(d.mood.p, d.mood.a, d.mood.d) < 0.01); assert.equal(d.moodLabel(), 'neutral');
  for (let i = 0; i < 100; i++) d.appraise('death'); assert.ok(Math.abs(d.mood.p) <= 1);
});
test('offline coarse decay and serialisation round-trip', () => {
  const d = new Drives(); d.offlineDecay(DAY_S); assert.ok(d.level.hunger < 0.5 && d.level.energy < 0.5);
  const j = JSON.parse(JSON.stringify(d.toJSON())); const e = Drives.fromJSON(j); assert.deepEqual(e.level, d.level);
});

test('Q1: routine successes habituate, so mood does not pin at its ceiling', () => {
  const d = new Drives(); d.appraise('goal_done', 0.6); const first = d.mood.p;
  for (let i = 0; i < 25; i++) { for (let k = 0; k < 40; k++) d.tick(1, { hp: 20, food: 20 }); d.appraise('goal_done', 0.6); } // one every 40 s for 17 min
  assert.ok(d.mood.p < 0.4 && d.mood.p < 2 * first, 'p=' + d.mood.p + ' first=' + first); assert.ok(first > 0.15);
  const e = new Drives(); for (let i = 0; i < 13; i++) e.appraise('discovery', 0.5); // 13 first sightings in half a minute at spawn
  const f = new Drives(); f.appraise('discovery', 0.5); assert.ok(e.mood.p < 3 * f.mood.p, `burst p=${e.mood.p} single=${f.mood.p}`);
  const r = Drives.fromJSON(JSON.parse(JSON.stringify(d.toJSON()))); assert.deepEqual(r.hab, d.hab);
});
test('Q1: an unmet need and nearby threats move the mood while they last, and relief lets it recover', () => {
  const d = new Drives(); d.level.energy = 0.05;
  for (let s = 0; s < 600; s++) { d.tick(1, { hp: 19, food: 15, threats: s > 300 ? 2 : 0, resting: false }); if (s % 45 === 0) d.appraise('goal_done', 0.6); }
  assert.ok(d.mood.p < 0.1, 'tired + threatened + routine successes must not be pleasant: p=' + d.mood.p);
  assert.ok(d.mood.a > 0.3, 'threat raises arousal: a=' + d.mood.a);
  assert.notEqual(d.moodLabel(), 'exuberant');
  const calm = new Drives(); calm.level.energy = 0.9;
  for (let s = 0; s < 600; s++) { calm.tick(1, { hp: 20, food: 20 }); calm.level.energy = 0.9; if (s % 45 === 0) calm.appraise('goal_done', 0.6); }
  assert.ok(calm.mood.p > d.mood.p + 0.3, `calm p=${calm.mood.p} vs distressed p=${d.mood.p}`);
  const hurt = new Drives(); hurt.appraise('damage', 0.8); assert.ok(hurt.mood.p < -0.1 && hurt.mood.a > 0.1);
});
test('Q1: a digest without body data (offline catch-up) adds no deprivation mood', () => {
  const d = new Drives(); d.level.energy = 0; for (let i = 0; i < 300; i++) d.tick(1, {}); assert.ok(Math.hypot(d.mood.p, d.mood.a, d.mood.d) < 0.01);
});

test('Q1: a few rests restore real energy (the old calibration made 8 s of rest worth 1%)', () => {
  const d = new Drives(); d.level.energy = 0.05
  for (let r = 0; r < 6; r++) for (let s = 0; s < 20; s++) d.tick(1, { hp: 20, food: 20, resting: true }) // six 20 s rests
  assert.ok(d.level.energy > 0.5, 'energy=' + d.level.energy)
  const awake = new Drives(); awake.level.energy = 1; for (let s = 0; s < 600; s++) awake.tick(1, { hp: 20, food: 20 })
  assert.ok(awake.level.energy > 0.6 && awake.level.energy < 0.7, 'ten awake minutes cost about a third: ' + awake.level.energy)
})

test('M4: mood is PAD in [-1,1] with 0 neutral; label uses octants with a neutral deadband and a plain-language desc', () => {
  const at = (p, a, d) => { const x = new Drives(); Object.assign(x.mood, { p, a, d }); return x };
  // the two live readings (raw scale, 0 = neutral): mildly positive on all axes, and clearly positive
  assert.equal(at(0.22, 0.17, 0.29).moodLabel(), 'exuberant'); assert.match(at(0.22, 0.17, 0.29).moodDesc(), /^mildly happy, alert/);
  assert.equal(at(0.51, 0.51, 0.53).moodLabel(), 'exuberant'); assert.match(at(0.51, 0.51, 0.53).moodDesc(), /^fairly/);
  // low pleasure/arousal/dominance would be NEGATIVE numbers
  assert.equal(at(-0.3, -0.3, -0.3).moodLabel(), 'bored'); assert.match(at(-0.3, -0.3, -0.3).moodDesc(), /tired and subdued/);
  const octants = { exuberant: [1, 1, 1], relaxed: [1, -1, 1], dependent: [1, 1, -1], docile: [1, -1, -1], hostile: [-1, 1, 1], anxious: [-1, 1, -1], disdainful: [-1, -1, 1], bored: [-1, -1, -1] };
  for (const [name, [p, a, d]] of Object.entries(octants)) assert.equal(at(0.4 * p, 0.4 * a, 0.4 * d).moodLabel(), name);
  // deadband: tiny and mild states are neutral, whatever the signs
  assert.equal(at(0.1, 0.1, 0.1).moodLabel(), 'neutral'); assert.equal(at(-0.1, 0.12, -0.05).moodLabel(), 'neutral'); assert.equal(at(0, 0, 0).moodLabel(), 'neutral');
});
test('M4: snapshot carries numbers and the LIVE label (recomputed on every call, never cached)', () => {
  const d = new Drives(); assert.equal(d.snapshot().mood.label, 'neutral');
  d.appraise('death'); const s1 = d.snapshot().mood; assert.ok(typeof s1.p === 'number' && typeof s1.a === 'number' && typeof s1.d === 'number'); assert.ok(s1.p < 0); assert.notEqual(s1.label, 'neutral');
  Object.assign(d.mood, { p: 0.5, a: 0.5, d: 0.5 }); assert.equal(d.snapshot().mood.label, 'exuberant');
  Object.assign(d.mood, { p: -0.4, a: -0.4, d: -0.4 }); const s2 = d.snapshot().mood; assert.equal(s2.label, 'bored'); assert.equal(s2.p, -0.4); assert.ok(s2.scale && s2.desc);
});
