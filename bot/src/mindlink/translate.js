// Brain intent (closed vocabulary of brain/contract.js) -> body skill call (bot/src/skills/skills.json). Pure, testable.
//   translate(intent, {landmarks:{get(name)}, me:{x,y,z}, hazards:[{id,kind,pos}]}) -> {goal,args,note?} | {skip:true,reason} | {fail:reason_code,reason}
// Differences between the two vocabularies are handled here.
export const NO_CAP = new Set(['eat', 'cook', 'flee', 'sleep', 'gesture', 'idle_activity', 'look_at']) // needs/safety/passive acts are never refused by repeat caps or lockouts
/** also exempt: going home / to the bed (shelter is a safety act; found by the first live run, where a capped go_to home at night was refused 5 times). */
export const capExempt = (goal, args = {}) => NO_CAP.has(goal) || (goal === 'go_to' && ['home', 'bed'].includes(args.place))

export function translate(intent, { landmarks = null, me = null, hazards = [] } = {}) {
  const { goal, args = {} } = intent
  switch (goal) {
    case 'none': return { skip: true, reason: 'none' }
    case 'pursue': return { fail: 'unknown_skill', reason: 'goal intents are handled by System 1 (s1/selector.js); no S1 available' }
    case 'idle_activity': case 'gesture': case 'move_to': case 'follow': case 'hunt': case 'eat': case 'sleep': case 'collect': case 'go_to': case 'cook': case 'fight': case 'defend':
      return { goal, args: { ...args } }
    case 'explore': return { goal, args: { ...args } }
    case 'approach':
      if (landmarks?.get?.(args.target)) return { goal: 'go_to', args: { place: args.target }, note: 'approach(place)->go_to' }
      return { goal, args: { ...args } }
    case 'flee': {
      const hz = hazards.find((h) => h.id === args.from)
      if (hz && me) { // fleeing from a hazard block: walk 14 blocks directly away from it
        const dx = me.x - hz.pos[0], dz = me.z - hz.pos[2], n = Math.hypot(dx, dz) || 1
        return { goal: 'move_to', args: { x: Math.round(me.x + (dx / n) * 14), y: Math.round(me.y), z: Math.round(me.z + (dz / n) * 14), radius: 3 }, note: 'flee(hazard)->move_to' }
      }
      return { goal, args: { ...args } }
    }
    case 'interact': {
      const { target, verb } = args
      if (verb === 'look' || verb === 'talk') return { goal: 'look_at', args: { target, hold_ms: 1500 }, note: `interact(${verb})->look_at` }
      if (landmarks?.get?.(target)) return { goal: 'go_to', args: { place: target }, note: `interact(${verb}, place)->go_to` }
      return { goal: 'approach', args: { target }, note: `interact(${verb})->approach (legacy verb: open/use are not in the vocabulary any more)` }
    }
    default: return { fail: 'unknown_skill', reason: `no body skill for "${goal}"` }
  }
}

/** mind goal descriptor: type, target (specific thing) and place (cell key) for repeat caps / lockouts / cycle detection. */
export function goalDescriptor(goal, args, cell) {
  const specific = args.target ?? args.place ?? args.item ?? (goal === 'move_to' ? `${args.x},${args.z}` : null)
  return { type: goal, target: specific ?? null, place: cell }
}
