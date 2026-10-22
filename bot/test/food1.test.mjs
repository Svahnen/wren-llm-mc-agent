import test from 'node:test'
import assert from 'node:assert/strict'
import { RAW_RE, COOKED_OF, COOKED_RE } from '../src/skills/cook.js'
import { lowHpSeconds } from '../src/mindlink/digest.js'
test('cook knows kelp -> dried_kelp and potato -> baked_potato', () => {
  assert.ok(RAW_RE.test('kelp')); assert.equal(COOKED_OF.kelp, 'dried_kelp'); assert.ok(COOKED_RE.test('dried_kelp'))
  assert.ok(RAW_RE.test('potato')); assert.equal(COOKED_OF.potato, 'baked_potato'); assert.ok(!RAW_RE.test('kelp_block'))
})
test('lowHpSeconds counts from the first low-hp digest and resets on recovery', () => {
  const b = { health: 3 }
  assert.equal(lowHpSeconds(b, 1000), 0); assert.equal(lowHpSeconds(b, 131000), 130)
  b.health = 12; assert.equal(lowHpSeconds(b, 140000), 0); b.health = 4; assert.equal(lowHpSeconds(b, 150000), 0)
})
