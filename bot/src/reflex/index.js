// Reflex layer entry point.
//   const reflex = installReflexes(body, arbiter, trace, metrics, { cfg?, reflexes?, danger?, autoStart? })
//   reflex.danger        DangerMap (addProvider / forbid) for mind/ to feed
//   reflex.pause(...)    let a long action own a behaviour; reflex.paused = true/false for the simple flag
//   reflex.drainEvents() "your action X was interrupted by Y" events for the digest
//   reflex.stats         per-reflex counters, reflex.stop()
import { ReflexEngine } from './engine.js'
import { DangerMap } from './danger.js'
import { ALL_REFLEXES } from './reflexes.js'

export { DangerMap, HARD } from './danger.js'
export { ReflexEngine } from './engine.js'
export { ALL_REFLEXES } from './reflexes.js'
export { DEFAULTS } from './defaults.js'

export function installReflexes(body, arbiter, trace = null, metrics = null, { cfg = {}, reflexes = ALL_REFLEXES, danger = null, autoStart = true, rng, now } = {}) {
  const dm = danger ?? new DangerMap(() => body.bot, { now })
  const engine = new ReflexEngine({ body, arbiter, trace, metrics, reflexes, danger: dm, cfg, rng, now })
  if (autoStart) engine.start()
  return engine
}
