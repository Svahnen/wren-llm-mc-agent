import test from 'node:test'
import assert from 'node:assert/strict'
import { goalDrive, wantDriveOf } from '../src/mindlink/drive-link.js'
import { WantsBook } from '../../mind/wants.js'

test('Q1: wants are tagged with the drive the goal serves, never with an unactionable `social` when nobody is online', () => {
  const u = { hunger: 0.06, energy: 0.9, safety: 0, curiosity: 0.3, social: 1 }
  assert.equal(wantDriveOf('flee', { from: 'zombie_1' }, u).drive, 'safety')
  assert.equal(wantDriveOf('explore', { direction: 'south' }, u).drive, 'curiosity')
  assert.equal(wantDriveOf('hunt', { target: 'cow_1' }, u).drive, 'hunger')
  assert.equal(wantDriveOf('go_to', { place: 'home' }, u).drive, 'energy')
  assert.equal(wantDriveOf('interact', { target: 'sheep_1', verb: 'look' }, u).drive, 'curiosity')
  assert.equal(wantDriveOf('interact', { target: 'player_Sam', verb: 'talk' }, u).drive, 'social')
  const none = wantDriveOf('collect', { resource: 'dirt' }, u)   // no direct drive: most urgent actionable one
  assert.equal(none.drive, 'energy'); assert.ok(none.strength <= 1)
  assert.equal(wantDriveOf('collect', {}, u, { humansOnline: true }).drive, 'social')
  assert.equal(goalDrive('wave', {}), null)
})

test('Q1: examined sightings leave the curiosity list; three sheep are one target', () => {
  const b = new WantsBook()
  for (const [x, z] of [[100, 100], [96, 88], [92, 105]]) b.noteSighting({ kind: 'mob', name: 'sheep', x: x + (x === 96 ? 20 : 0), z: z + (z === 88 ? 30 : 0), t: 1 })
  b.noteSighting({ kind: 'mob', name: 'cow', x: 132, z: 97, t: 2 })
  const t = b.curiosityTargets({ x: 100, z: 100 }, { max: 9 }).filter((c) => c.kind === 'sighting')
  assert.deepEqual(t.map((c) => c.text).sort(), ['unexamined mob "cow"', 'unexamined mob "sheep"'])
  assert.equal(b.markExaminedNear('sheep', 100, 100, 100), 3)
  const after = b.curiosityTargets({ x: 100, z: 100 }, { max: 9 }).filter((c) => c.kind === 'sighting').map((c) => c.text)
  assert.ok(!after.some((x) => x.includes('"sheep"')))
  assert.ok(after.includes('unexamined mob "cow"'))
})

import { fitSpeech } from '../src/mindlink/speech.js'
test('Q1: long lines are cut at a sentence or word boundary, short ones untouched', () => {
  assert.equal(fitSpeech('  Short   line. '), 'Short line.')
  const long = 'My energy is nearly gone and I feel completely alone out here. ' + 'I am just going to take a breath and see if the world offers me something safe to look at before I try to move again, because that seems wise right now and nothing else is pressing.'
  const f = fitSpeech(long, 240)
  assert.ok(f.length <= 240); assert.equal(f, 'My energy is nearly gone and I feel completely alone out here.')
  const noStop = fitSpeech('word '.repeat(80), 100); assert.ok(noStop.length <= 101 && noStop.endsWith('…') && !/ …$/.test(noStop))
})

import { hazardExtent } from '../src/mindlink/digest.js'
test('Q1: hazardExtent hands mineflayer a Vec3 (a plain object threw in point.floored() and every death lesson got extent 0)', () => {
  const bot = { registry: { blocksByName: { lava: { id: 5 } } },
    findBlocks: ({ point }) => { point.floored(); return [{ x: 103, y: 64, z: 100 }, { x: 100, y: 64, z: 96 }] } }
  assert.equal(hazardExtent(bot, { x: 100, y: 64, z: 100 }, 'lava'), 4)
  assert.equal(hazardExtent({ registry: { blocksByName: {} } }, { x: 0, y: 0, z: 0 }, 'lava'), 0)
})
