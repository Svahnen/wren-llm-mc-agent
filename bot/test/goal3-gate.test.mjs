import test from 'node:test'
import assert from 'node:assert/strict'
import '../src/playbooks/catalog.js'
import { OPS } from '../src/playbooks/ops.js'
const mk = (ticks, thunder = 0) => ({ bot: () => ({ time: { timeOfDay: ticks, age: 1 }, thunderState: thunder }), now: Date.now, sleep: async () => {}, aborted: () => false })
await new Promise((r) => setTimeout(r, 20))
test('night_gate: daylight ends at once with a RESULT detail; night passes', async () => {
  const r = await OPS.night_gate(mk(6542)); assert.equal(r.status, 'failed'); assert.equal(r.reason, 'not_night'); assert.match(r.detail, /not night yet \(game tick 6542, dusk in 5 min\): bed remembered/)
  assert.equal((await OPS.night_gate(mk(14000))).status, 'done')
  assert.equal((await OPS.night_gate(mk(3000, 1))).status, 'done')
})
