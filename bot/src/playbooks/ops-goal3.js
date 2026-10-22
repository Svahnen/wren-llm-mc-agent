// GOAL3: ops kept out of ops.js. Hook: catalog.js imports this file for its side effect; it adds to the exported OPS table.

const DUSK = 12542, TPM = 1200
const timePhase = (bot) => { const t = (((bot.time?.timeOfDay ?? 1000) % 24000) + 24000) % 24000; return { ticks: t, night: t >= 12542 && t <= 23459, thunder: (bot.thunderState ?? 0) > 0.5 } }
/** night_gate: passes at night or in thunder; in daylight it ends the playbook at once instead of waiting by the bed.
 *  -> failed/not_night with detail "not night yet (dusk in N min): bed remembered" (the bed stays a known place). */
const nightGate = async (x) => {
  const bot = x.bot(), tp = timePhase(bot)
  if (tp.night || tp.thunder) return { status: 'done' }
  const left = tp.ticks < DUSK ? DUSK - tp.ticks : 24000 - tp.ticks + DUSK
  if (left <= TPM) { // within a minute of dusk: wait it out (bounded), the walk to the bed happens in the next step
    const t0 = x.now()
    while (x.now() - t0 < Math.ceil(left / 20) * 1000 + 5000) {
      if (x.aborted()) return { status: 'failed', reason: 'aborted' }
      const t = timePhase(bot); if (t.night || t.thunder) return { status: 'done' }
      await x.sleep(1000)
    }
  }
  return { status: 'failed', reason: 'not_night', detail: `not night yet (game tick ${tp.ticks}, dusk in ${Math.max(1, Math.ceil(left / TPM))} min): bed remembered; any 'Sleeping through this night' message is from an earlier night` }
}
// dynamic import: ops.js <-> s1/selector <-> engine <-> catalog form an import cycle, a static import hits the TDZ when ops.js loads first
import('./ops.js').then((m) => { m.OPS.night_gate = nightGate })
