// Tunable numbers of the reflex layer in one place.
export const DEFAULTS = Object.freeze({
  tickMs: 100,
  cooldownJitter: 0.25, // +-25 % on every cooldown
  fleeHealth: 8, // hp (half hearts) at or below which we disengage
  coverHealth: 6, // SURV2: hp at or below which low_hp_cover seals her in when something hostile is in range
  fleeBudget: { max: 3, windowMs: 120000 }, // disengage attempts per window, then shelter / last stand
  drownAir: 12, // oxygenLevel (0..20) below which we surface (head under water)
  eatBelow: 14, // food level at or below which we eat
  eatUrgent: 10, // between eatUrgent and eatBelow eating waits for a gap between skills instead of cutting a running skill short
  eatStarving: 6, // eat even with enemies near
  threatRadius: 12,
  fightRadius: 8,
  creeperRadius: 6,
  creeperSafe: 9,
  edgeDrop: 5, // blocks of free fall that count as a cliff
  shelterHealTo: 16,
  shelterMaxMs: 60000,
})
