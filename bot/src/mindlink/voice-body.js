// VINT: body language for a voice conversation. No LLM, cheap, never blocks a safety reflex:
//  - gaze: an addressed human speaking within 12 blocks (or anyone talking within 6) -> look_at toward them right away
//  - nod: at a reported pause of 250..900 ms inside their speech (listeners[].silence_ms from the voice service)
//  - stance: for 20 s after the last voice exchange with a human within 6 blocks `conversing()` is true; the habit layer then stays put
// All body actions run as owner 's1' (below reflex priority: a reflex preempts them), and only when the body is idle or busy with an idle skill.
const IDLE = new Set(['idle_activity', 'gesture', 'look_at'])

export function createVoiceBody({ getBot, runner, arbiter, now = Date.now, log = () => {}, convoMs = 45000, gazeEveryMs = 1200, nodEveryMs = 5000 } = {}) {
  const conv = { name: null, dist: Infinity, at: 0 }
  const last = { gaze: 0, nod: 0 }
  const stats = { gaze: 0, nod: 0, skipped_busy: 0 }

  const realDist = (name) => {
    const b = getBot(); const e = b?.players?.[name]?.entity
    return e && b.entity ? e.position.distanceTo(b.entity.position) : null
  }
  const bodyFree = () => {
    if (!arbiter.busy) return true
    const lab = arbiter.holder?.label
    return !arbiter.transition && arbiter.holder?.owner !== 'reflex' && IDLE.has(lab)
  }
  async function act(kind, name, skill, args) {
    if (!getBot()?.entity) return false
    if (!bodyFree()) { stats.skipped_busy++; return false }
    if (arbiter.busy) await runner.abort('voice_conversation') // an idle gesture/look in progress: make room
    stats[kind]++; last[kind] = now(); if (kind === 'gaze') last.target = name
    runner.run(skill, args, { owner: 's1', intent_id: `voice-${kind}-${stats[kind]}` }).catch(() => {})
    log('voice_body', { kind, name })
    return true
  }

  return {
    stats, conv, realDist,
    /** Active conversation with a human within 6 blocks (also extended by the caller while she speaks). */
    conversing(t = now()) {
      if (!conv.name || t - conv.at > convoMs) return false
      const d = realDist(conv.name) ?? conv.dist
      return d <= 8
    },
    who() { return this.conversing() ? conv.name : null },
    /** Keep the conversation alive (called when she speaks to them, or they speak). */
    touch(name, dist, t = now()) { conv.name = name; if (Number.isFinite(dist)) conv.dist = dist; conv.at = t },
    /** Face the person she is answering (throttled). */
    async face(name, dist) { this.touch(name, dist); if (name !== last.target || now() - last.gaze > 800) await act('gaze', name, 'look_at', { target: name, hold_ms: 1500 }) },
    /** An addressed final transcript from `name` at `dist` blocks. */
    async onAddressed(name, dist) {
      const d = realDist(name) ?? dist
      if (d <= 12) { this.touch(name, d); if (now() - last.gaze > 300) await act('gaze', name, 'look_at', { target: name, hold_ms: 1500 }) }
    },
    /** Status poll: listeners = [{name, dist, in_utt, silence_ms?}]. */
    async onStatus(listeners = []) {
      const t = now()
      for (const l of listeners) {
        if (!l.in_utt) continue
        const d = realDist(l.name) ?? l.dist
        if (!(d <= 12)) continue
        const mine = conv.name === l.name && t - conv.at <= convoMs
        if (d <= 6 || mine) { // within 6 blocks everything said counts as addressed (voice service rule); farther only inside a running conversation
          this.touch(l.name, d, t)
          if (t - last.gaze > gazeEveryMs) await act('gaze', l.name, 'look_at', { target: l.name, hold_ms: 1500 })
          if (Number.isFinite(l.silence_ms) && l.silence_ms >= 250 && l.silence_ms <= 900 && t - last.nod > nodEveryMs) await act('nod', l.name, 'gesture', { kind: 'nod' })
        }
      }
    },
  }
}
