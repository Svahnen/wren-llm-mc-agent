// Simulation harness: runs N game days of the real mind modules against the tiny world with a deterministic FAKE S2.
//   memory:false = ablation (no lessons, no episodes), same caps/budgets/drives, same world RNG.
import { Drives } from '../drives.js';
import { Memory } from '../memory.js';
import { WantsBook } from '../wants.js';
import { buildConstraints } from '../lessons-to-constraints.js';
import { DAY_S, dayOf, cellKey, rng, hashStr } from '../util.js';
import { N, HOME, FARM, FOREST, ORE, isLava, isNight, humanPresent, ticksOf, findPath, LAVA } from './world.js';

const TARGETS = { eat: FARM, sleep: HOME, mine_iron: ORE, gather_wood: FOREST, socialize: HOME };
const lakeExtent = (p) => { let m = 0; for (const k of LAVA) { const [x, z] = k.split(',').map(Number); const d = Math.hypot(x - p.x, z - p.z); if (d <= 10) m = Math.max(m, d); } return m; };

export async function runSim({ seed = 1, days = 10, memory = true, policy = 'normal', scriptedDeath = true, dbPath = ':memory:', limits = {}, onDay = null } = {}) {
  const world = rng(seed * 7919 + 13), pol = rng(seed * 104729 + 7);
  const drives = new Drives(), book = new WantsBook(limits), mem = memory ? new Memory(dbPath) : null;
  let cons = buildConstraints([]);
  const refresh = () => { cons = buildConstraints(mem ? mem.allLessons(0.05) : [], { lockouts: book.activeLockouts(drives.t), now: drives.t }); };
  const S = { x: HOME.x, z: HOME.z, hp: 20, food: 20 };
  const M = { deaths: { lava: [], mob: [], starve: [] }, lavaDeathsByDay: Array(days).fill(0), goals: {}, perDay: new Map(), cycles: 0, capRefusals: 0, ticks: 0, dbSamples: [], sleepCalls: 0, lessonsUsed: 0, driveSamples: [], newCells: 0 };
  let goal = null, scriptedUsed = false, sleepTicks = 0, mood = [];
  const fakeSummarize = (digest) => ({ self_summary: `Day ${digest.day}: I have explored ${digest.kinds.routine ?? 0} routine things; I remember ${digest.deaths.length} deaths.`, reflections: [`day ${digest.day} reflection: ${Object.keys(digest.kinds).join(',')}`] });

  function die(cause, t) {
    M.deaths[cause].push(t); if (cause === 'lava') M.lavaDeathsByDay[Math.min(days - 1, dayOf(t))]++;
    drives.appraise('death');
    if (mem) {
      mem.remember({ t, kind: 'death', text: `died to ${cause} near ${Math.round(S.x)},${Math.round(S.z)} while ${goal?.type}`, x: S.x, y: 12, z: S.z, pad: { ...drives.mood }, goal_type: goal?.type });
      mem.recordLesson({ goal_type: goal?.type ?? 'unknown', x: S.x, y: 12, z: S.z, approach: goal?.type === 'mine_iron' ? 'direct_route' : '', result: 'death', cause, extent: cause === 'lava' ? lakeExtent(S) : 0, t });
      refresh();
    }
    if (goal) { book.finishGoal(goal.id, 'died', t); }
    goal = null; S.x = HOME.x; S.z = HOME.z; S.hp = 20; S.food = 14;
  }

  function choose(t) {
    const u = drives.urgencies(), night = isNight(t), cands = [];
    const add = (type, score, target = TARGETS[type], extra = {}) => cands.push({ type, score, target, place: cellKey(target.x, target.z), ...extra });
    if (policy === 'same') add('mine_iron', 5);
    else if (policy === 'alternate') { const ph = book.starts.length % 2; add('explore', 5, ph ? { x: 56, z: 56 } : { x: 56, z: 8 }); }
    else {
      add('eat', u.hunger > 0.2 ? u.hunger + 0.4 : 0);
      add('sleep', night ? 0.5 + u.energy : u.energy > 0.5 ? u.energy : 0);
      if (humanPresent(t)) add('socialize', u.social + 0.25);
      add('mine_iron', 0.5 + pol() * 0.1); add('gather_wood', 0.3 + pol() * 0.1);
      const cur = book.curiosityTargets(S, { max: 3, radius: 60 });
      cur.forEach((c, i) => add('explore', u.curiosity + 0.25 + 0.1 * c.score + pol() * 0.05, { x: Math.min(N - 1, Math.max(0, Math.round(c.x))), z: Math.min(N - 1, Math.max(0, Math.round(c.z))) }));
      add('wander', 0.1 + pol() * 0.05, { x: Math.round(Math.max(0, Math.min(N - 1, S.x + (pol() - 0.5) * 24))), z: Math.round(Math.max(0, Math.min(N - 1, S.z + (pol() - 0.5) * 24))) });
    }
    for (const c of cands) c.score -= cons.goalPenalty(c.type, c.place);
    cands.sort((a, b) => b.score - a.score);
    let fallback = null;
    for (const c of cands) {
      if (c.score <= 0) continue;
      const ok = book.canStart({ type: c.type, target: `${c.target.x},${c.target.z}`, place: c.place }, t);
      if (ok.ok) return c; if (!fallback) fallback = ok.reason;
    }
    // habit layer: stale/refused intent degrades to plausible life (random wander; habits obey the repeat cap too)
    for (let k = 0; k < 8; k++) {
      const target = { x: Math.round(Math.max(0, Math.min(N - 1, S.x + (pol() - 0.5) * 16))), z: Math.round(Math.max(0, Math.min(N - 1, S.z + (pol() - 0.5) * 16))) };
      const place = cellKey(target.x, target.z);
      if (book.canStart({ type: 'wander', target: `${target.x},${target.z}`, place }, t).ok) return { type: 'wander', score: 0, target, habit: true, place };
    }
    return { type: 'wander', score: 0, target: { x: S.x, z: S.z }, habit: true, place: cellKey(S.x, S.z), idle: true };
  }

  function begin(c, t) {
    const tgt = `${c.target.x},${c.target.z}`;
    const place = c.habit ? cellKey(c.target.x, c.target.z) : c.place;
    const { goal: g, cycle } = book.startGoal({ type: c.type, target: tgt, place }, t);
    if (cycle) M.cycles++;
    const k = `${dayOf(t)}|${c.type}|${tgt}`; M.perDay.set(k, (M.perDay.get(k) ?? 0) + 1);
    M.goals[c.type] = (M.goals[c.type] ?? 0) + 1;
    if (mem && c.type === 'mine_iron') for (const l of mem.lessonsFor('mine_iron', null)) { if (cons.lessonIdsNear({ x: 30, y: 12, z: 30 }, 'mine_iron').includes(l.id)) { mem.markLessonUsed(l.id, true); M.lessonsUsed++; } }
    const known = new Set(); // lava she noticed this trip
    const plan = () => findPath(S, c.target, (x, z) => (known.has(x + ',' + z) ? Infinity : cons.forbidden({ x, y: 12, z }) ? Infinity : cons.costAt({ x, y: 12, z })));
    goal = { id: g.id, type: c.type, c, plan, known, path: plan() ?? [], t0: t };
    if (!goal.path.length && (S.x !== c.target.x || S.z !== c.target.z)) { fail(t, 'unreachable'); }
  }
  function fail(t, why) { if (!goal) return; book.finishGoal(goal.id, 'failed', t); drives.appraise('goal_failed'); if (mem) mem.remember({ t, kind: 'goal_failed', text: `${goal.type} failed (${why})`, x: S.x, y: 12, z: S.z, goal_type: goal.type, outcome: 'failed', pad: { ...drives.mood } }); goal = null; }
  function done(t) {
    const g = goal, c = g.c; goal = null; book.finishGoal(g.id, 'done', t); drives.appraise('goal_done', 0.5);
    if (c.type === 'eat') { S.food = 20; }
    if (c.type === 'mine_iron') { drives.satisfy('curiosity', 0.3); drives.appraise('discovery', 0.5); }
    if (c.type === 'sleep') { sleepTicks = 150; }
    if (c.type === 'socialize') { sleepTicks = 0; }
    if (mem) mem.remember({ t, kind: c.type === 'mine_iron' ? 'goal_done' : 'routine', text: `${c.type} at ${c.target.x},${c.target.z}`, x: S.x, y: 12, z: S.z, activity: c.type, goal_type: c.type, outcome: 'done', pad: { ...drives.mood }, satisfied: ['eat', 'sleep', 'socialize'].includes(c.type) ? [c.type] : [], novelty: c.type === 'explore' ? 1 : 0, social: c.type === 'socialize' ? 1 : 0, damage: 0, hpMin: S.hp });
  }

  const total = days * DAY_S;
  for (let t = 1; t <= total; t++) {
    M.ticks++;
    const night = isNight(t), awayAtNight = night && Math.hypot(S.x - HOME.x, S.z - HOME.z) > 8;
    S.food = Math.max(0, S.food - 1 / 70);
    if (S.food <= 0) { S.hp -= 0.1; if (S.hp <= 0) { die('starve', t); continue; } }
    else if (S.food >= 18 && S.hp < 20) S.hp = Math.min(20, S.hp + 0.1);
    if (awayAtNight && world() < 0.004) { S.hp -= 4; drives.appraise('damage', 0.5); if (S.hp <= 0) { die('mob', t); continue; } }
    const sleeping = sleepTicks > 0; if (sleeping) sleepTicks--;
    const human = humanPresent(t) && Math.hypot(S.x - HOME.x, S.z - HOME.z) < 6;
    const evs = drives.tick(1, { food: S.food, hp: S.hp, tps: 20, threats: awayAtNight ? 1 : 0, humansNearby: human ? 1 : 0, sleeping });
    if (human) { /* social contact */ }
    for (const e of evs) if (e.type === 'drive_threshold' && mem) { /* wants */ book.addWant({ text: `relieve ${e.drive}`, drive: e.drive, strength: e.kind === 'critical' ? 0.9 : 0.5, t }); }
    book.expire(t);
    if (t % 60 === 0) M.driveSamples.push({ t, ...drives.level });
    if (!sleeping) {
      if (!goal) { const c = choose(t); if (c.idle) { sleepTicks = 20; M.idleRests = (M.idleRests ?? 0) + 1; } else begin(c, t); }
      if (goal) {
        if (goal.type === 'socialize' && !humanPresent(t) && goal.path.length === 0) { fail(t, 'human left'); }
        else if (goal.path.length === 0) done(t);
        else {
          const nxt = goal.path[0];
          if (isLava(nxt.x, nxt.z)) {
            const scripted = scriptedDeath && !scriptedUsed && goal.type === 'mine_iron';
            if (scripted || world() >= 0.4) { if (scripted) scriptedUsed = true; die('lava', t); goal = null; continue; }
            goal.known.add(nxt.x + ',' + nxt.z); goal.path = goal.plan() ?? []; if (!goal.path.length) fail(t, 'lava blocks route');
          } else {
            goal.path.shift(); S.x = nxt.x; S.z = nxt.z;
            if (book.noteVisit(S.x, S.z, t)) { drives.level.curiosity = Math.min(1, drives.level.curiosity + 0.08); M.newCells++; }
            if (mem && t % 20 === 0) mem.visitPlace(S.x, 12, S.z, t);
          }
        }
      }
    }
    if (t % DAY_S === 0) { // dawn: sleep pass
      M.sleepCalls++;
      if (mem) { await mem.sleepPass(t, { summarize: fakeSummarize }); mem.set('now', t); M.dbSamples.push({ day: dayOf(t), ...mem.stats() }); refresh(); }
      onDay?.({ day: dayOf(t), book, drives, mem });
    }
  }
  let maxRepeat = 0; for (const v of M.perDay.values()) maxRepeat = Math.max(maxRepeat, v);
  M.repeatKeys = [...M.perDay].filter(([, v]) => v > 2).map(([k]) => k);
  M.maxRepeatPerDay = maxRepeat; M.cycles = book.stats.cycles; M.capRefusals = book.stats.capRefusals;
  M.lockouts = book.stats.lockoutRefusals; M.visitedCells = book.visited.size;
  M.lavaDeathsTotal = M.deaths.lava.length; M.lavaDeathsAfterFirst = Math.max(0, M.lavaDeathsTotal - (scriptedDeath ? 1 : 0));
  M.dbFinal = mem?.stats() ?? null; M.mem = mem; M.book = book; M.drives = drives;
  return M;
}
