// Which body need does a chosen goal serve? (Q1) Used to tag her wants with a drive. Before this the tag was "the most urgent need",
// which on a server with nobody online is always `social` (urgency 1.0): 22 of her 48 wants said "social" for fleeing zombies.
// Pure; the mapping is about what the SKILL does to the body, not about taste.
const SOCIAL_TARGET = /^(player|human)/i
export function goalDrive(goal, args = {}) {
  switch (goal) {
    case 'eat': case 'hunt': return 'hunger'
    case 'sleep': return 'energy'
    case 'idle_activity': return args.kind === 'rest' || args.kind === 'sit' ? 'energy' : null
    case 'flee': case 'take_cover': return 'safety'
    case 'go_to': return /^(home|bed)/.test(String(args.place ?? '')) ? 'energy' : null
    case 'follow': return 'social'
    case 'explore': case 'look_at': return 'curiosity'
    case 'approach': case 'interact': return args.target && (SOCIAL_TARGET.test(String(args.target)) || args.verb === 'talk') ? 'social' : 'curiosity'
    default: return null
  }
}
/** {drive, strength} for a want: the drive the goal serves; else the most urgent drive that can be acted on (social only with a human around). */
export function wantDriveOf(goal, args, urgencies = {}, { humansOnline = false } = {}) {
  const direct = goalDrive(goal, args)
  const u = (d) => urgencies[d] ?? 0
  if (direct) return { drive: direct, strength: Math.min(1, 0.3 + u(direct)) }
  const top = Object.entries(urgencies).filter(([d]) => humansOnline || d !== 'social').sort((a, b) => b[1] - a[1])[0]
  return top ? { drive: top[0], strength: Math.min(1, 0.3 + top[1]) } : { drive: null, strength: 0.4 }
}
