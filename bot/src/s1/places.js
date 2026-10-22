// S1G: apply LLM-authored place notes (remember / forget / rename) to the Landmarks store. S2 decides WHAT to remember; this only writes it.
// remember: saves her CURRENT coordinates (x,y,z) under the name she chose + her note. home/bed are ordinary names she may also move or rename.
export function applyPlaceOps(landmarks, ops, pos) {
  const done = []
  for (const o of ops ?? []) {
    if (o.op === 'remember') {
      if (!pos) { done.push({ ...o, ok: false, why: 'no_position' }); continue }
      const old = landmarks.get(o.name)
      const rec = landmarks.set(o.name, pos, old?.kind ?? 'place')
      rec.note = o.note || old?.note || ''; landmarks.save?.()
      done.push({ ...o, ok: true, at: [rec.x, rec.y, rec.z], moved: !!old })
    } else if (o.op === 'forget') {
      const had = !!landmarks.get(o.name)
      if (had) landmarks.forget(o.name)
      done.push({ ...o, ok: had, why: had ? undefined : 'unknown' })
    } else if (o.op === 'rename') {
      const rec = landmarks.get(o.name)
      if (!rec || landmarks.get(o.to)) { done.push({ ...o, ok: false, why: rec ? 'exists' : 'unknown' }); continue }
      landmarks.places[o.to] = { ...rec }; delete landmarks.places[o.name]; landmarks.save?.()
      done.push({ ...o, ok: true })
    }
  }
  return done
}
