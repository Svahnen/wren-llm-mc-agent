// Put the body into a neutral state: no keys held, no dig, no path goal.
// Every call is guarded, because the bot may be half-dead (disconnected, not yet spawned).
export function stopBody(bot) {
  if (!bot) return
  // pathfinder.stop() only ARMS a latch (stopPathing) that the next resetPath consumes; setGoal(null) right
  // after consumes it at once. Calling stop() last would leave it armed and the next goto() would die
  // immediately with PathStopped (found live in T1: every leg after the first failed in 1 ms).
  try { bot.pathfinder?.stop?.() } catch { /* ignore */ }
  try { bot.pathfinder?.setGoal(null) } catch { /* ignore */ }
  try { bot.stopDigging?.() } catch { /* ignore */ }
  try { bot.deactivateItem?.() } catch { /* ignore */ }
  try { bot.clearControlStates?.() } catch { /* ignore */ }
}
