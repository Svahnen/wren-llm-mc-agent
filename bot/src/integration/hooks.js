// Extension points (I1) for mind/ and brain/ (no hard dependency; everything is optional and has a neutral default).
//   hooks.addCostProvider(fn)          fn({x,y,z}) -> extra cost >= 0 (Infinity = forbidden)    -> wander/explore/gather target selection, reflex danger map
//   hooks.setDrivesProvider(fn)        fn(snapshot) -> {hunger:0..1,...} levels (1 = fine), polled 1 Hz -> habits.setDrives
//   hooks.setLockoutProvider(fn)       fn(intent) -> falsy | reason string; a truthy value blocks submitIntent (status blocked)
//   hooks.events                       EventEmitter: 'tick' (1 Hz snapshot), 'death', 'status' (intent), 'dead_state', 'help_needed', 'cycle'
import { EventEmitter } from 'node:events'

export function createHooks({ trace = null } = {}) {
  const events = new EventEmitter()
  const providers = new Set()
  let drives = null, lockout = null
  const safe = (fn, ...a) => { try { return fn(...a) } catch (e) { trace?.event('hook_error', { message: String(e?.message).slice(0, 120) }); return undefined } }
  return {
    events,
    addCostProvider(fn) { providers.add(fn); return () => providers.delete(fn) },
    /** sum of providers; Infinity wins */
    costAt(p) { let c = 0; for (const f of providers) { const v = safe(f, p); if (typeof v === 'number' && !Number.isNaN(v)) c += v }; return c },
    hasCostProviders: () => providers.size > 0,
    setDrivesProvider(fn) { drives = fn },
    drives(snapshot) { return drives ? safe(drives, snapshot) : undefined },
    setLockoutProvider(fn) { lockout = fn },
    lockout(intent) { return lockout ? safe(lockout, intent) : undefined },
  }
}
