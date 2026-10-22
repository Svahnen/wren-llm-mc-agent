import test from 'node:test'; import assert from 'node:assert/strict';
import { buildConstraints } from '../lessons-to-constraints.js';
const lava = { id: 1, goal_type: 'mine_iron', x: 31, y: 12, z: 31, result: 'death', cause: 'lava', strength: 1.5, extent: 4, cell: '1,1' };
test('death by lava -> forbidden core, falling cost, nothing far away', () => {
  const c = buildConstraints([lava]);
  assert.equal(c.forbidden({ x: 31, y: 12, z: 31 }), true); assert.equal(c.forbidden({ x: 34, y: 12, z: 31 }), true); assert.equal(c.forbidden({ x: 60, y: 12, z: 60 }), false);
  assert.ok(c.costAt({ x: 31, y: 12, z: 31 }) > c.costAt({ x: 36, y: 12, z: 31 })); assert.ok(c.costAt({ x: 36, y: 12, z: 31 }) > 0); assert.equal(c.costAt({ x: 100, y: 12, z: 100 }), 0);
});
test('weak lessons cost but do not forbid; goalPenalty is bounded; lockouts pass through and expire', () => {
  const c = buildConstraints([{ ...lava, strength: 0.4, extent: 0 }, { id: 2, goal_type: 'fish', result: 'fail', cause: '', strength: 0.6, cell: '3,3' }], { lockouts: [{ token: 'fish@3,3', until: 500 }, { token: 'x@y', until: 10 }], now: 100 });
  assert.equal(c.forbidden({ x: 31, y: 12, z: 31 }), false); assert.ok(c.costAt({ x: 31, y: 12, z: 31 }) > 0);
  assert.ok(c.goalPenalty('fish', '3,3') > 0 && c.goalPenalty('fish', '3,3') <= 0.8); assert.equal(c.goalPenalty('fish', '9,9'), 0);
  assert.equal(c.lockouts.length, 1); assert.equal(c.isLockedOut('fish', '3,3', 100), true); assert.equal(c.isLockedOut('fish', '3,3', 600), false);
  const empty = buildConstraints([]); assert.equal(empty.costAt({ x: 1, y: 1, z: 1 }), 0);
});
