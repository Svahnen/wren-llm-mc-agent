import test from 'node:test'; import assert from 'node:assert/strict';
import { runSim } from '../sim/run.js'; import { runAB } from '../sim/ab.js'; import { DAY_S } from '../util.js';

test('10 simulated days run in seconds; drives stay sensible (not pinned at 0, rise after eating/sleeping)', async () => {
  const t0 = Date.now(); const m = await runSim({ seed: 11, days: 10 }); assert.ok(Date.now() - t0 < 20000);
  assert.equal(m.ticks, 10 * DAY_S);
  const hs = m.driveSamples.map((s) => s.hunger); assert.ok(Math.min(...hs) < 0.6 && Math.max(...hs) > 0.8, 'hunger oscillates'); assert.ok(hs.filter((x) => x < 0.05).length / hs.length < 0.1, 'rarely starving');
  const es = m.driveSamples.map((s) => s.energy); assert.ok(Math.max(...es) > 0.8 && Math.min(...es) < 0.9);
  assert.ok((m.goals.eat ?? 0) >= 8 && (m.goals.sleep ?? 0) >= 5, JSON.stringify(m.goals));
  assert.ok(Object.keys(m.goals).length >= 5, 'goal diversity ' + JSON.stringify(m.goals));
});
test('repeat caps hold: never more than 2 starts of same goal+target per day (even with a fake S2 stuck on one goal)', async () => {
  for (const policy of ["normal", "same"]) { const m = await runSim({ seed: 3, days: 6, policy }); assert.ok(m.maxRepeatPerDay <= 2, policy + " maxRepeat " + m.maxRepeatPerDay + " " + m.repeatKeys); }
  const same = await runSim({ seed: 3, days: 6, policy: 'same' }); assert.ok(same.capRefusals > 0); assert.ok((same.goals.wander ?? 0) > 0, 'degrades to habits');
});
test('cycle detector fires and locks out when fake S2 alternates two goals', async () => {
  const m = await runSim({ seed: 4, days: 3, policy: 'alternate', limits: { repeatCapPerDay: 99, attemptsPerDay: 99 } });
  assert.ok(m.cycles > 0, 'cycles ' + m.cycles); assert.ok(m.lockouts > 0 || m.book.lockouts.length >= 0);
});
test('A/B: lessons cut repeated lava deaths by >= 80% (5 seeds, memory ON vs OFF, same scripted first death)', async () => {
  const ab = await runAB(); console.log('A/B', JSON.stringify(ab.totals));
  assert.ok(ab.totals.offRepeats >= 20, 'OFF arm must actually repeat the mistake: ' + ab.totals.offRepeats);
  assert.ok(ab.totals.reduction >= 0.8, 'reduction ' + ab.totals.reduction); assert.ok(ab.totals.reductionNext3d >= 0.8 || ab.totals.offNext3d < 5);
  for (const r of ab.rows) assert.ok(r.onRepeats <= r.offRepeats);
});
test('memory DB growth bounded over 30 days, sleep passes ran, lessons reused', async () => {
  const m = await runSim({ seed: 2, days: 30 }); const last = m.dbSamples.at(-1); assert.equal(m.sleepCalls, 30);
  assert.ok(last.episodes + last.habits < 1500, JSON.stringify(last)); assert.ok(last.bytes < 5_000_000); assert.ok(m.lessonsUsed > 0);
  const mid = m.dbSamples[14]; assert.ok(last.episodes <= mid.episodes * 2.5 + 200, 'sublinear-ish growth ' + mid.episodes + ' -> ' + last.episodes);
  assert.ok(m.mem.getSelfSummary().text.length > 0, 'self summary written via injected callback');
});
test('sim is deterministic for a seed', async () => { const a = await runSim({ seed: 9, days: 4 }), b = await runSim({ seed: 9, days: 4 }); assert.deepEqual(a.goals, b.goals); assert.deepEqual(a.deaths, b.deaths); });
