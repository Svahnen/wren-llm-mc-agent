// Skill pack for the body. Usage (own wiring, main.js is T1's):
//   const pack = registerSkills(runner, { heatmap, rng, runtimeDir })
//   pack.start(() => body.bot)   // breadcrumb sampling
//   pack.env.costAt = (p) => ...  // mind/ danger-zone cost, optional
import path from 'node:path'
import { Heatmap } from '../heatmap.js'
import { makeRng } from '../util.js'
import { Landmarks, Trail } from './landmarks.js'
import { makeWander, makeExplore } from './wander.js'
import { makeMoveSkills } from './move.js'
import { makeGatherSkills } from './gather.js'
import { makeCraft } from './craft.js'
import { makeCook } from './cook.js'
import { makeFight } from './fight.js'
import { makeDefend } from './defend.js'
import { makeEat, makeSleep, makePlaceTorch } from './survival.js'
import { makeDropJunk, makeStoreInChest } from './inventory.js'
import { makeBodySkills } from './body.js'
import { makeEscapeSkills } from '../escape/skills.js'
import { makeShelter, makeTakeCover, makeDigIn, openDoor, leaveHut, explainNoPath, allowPitDig } from './shelter.js'
import { makeBuild } from './build.js'
import { makeInteractSkills } from './interact.js'
import { makeActivitySkills } from './activities.js'   // PB4
import { makeFarm1Skills } from './farm1.js'   // FARM1
import { makeRoamSkills } from './roam.js'   // ROAM1
import { makeSeedSkills } from './seeds.js'   // RS3
import { makeRs3Skills } from './rs3.js'   // RS3
import { SKILL_NAMES } from './schema.js'

export function registerSkills(runner, ctx = {}) {
  const rng = ctx.rng ?? makeRng(ctx.seed)
  const env = {
    rng,
    heatmap: ctx.heatmap ?? new Heatmap({ cell: 8, rng }),
    landmarks: ctx.landmarks ?? new Landmarks({ file: ctx.runtimeDir ? path.join(ctx.runtimeDir, 'landmarks.json') : null }),
    trail: ctx.trail ?? new Trail({ step: ctx.trailStep ?? 8 }),
    costAt: ctx.costAt ?? null, // (point)=>extra cost >= 0; mind/ lessons
    radius: ctx.radius ?? 28,
  }
  const skills = [makeWander(env), makeExplore(env), ...makeMoveSkills(env), ...makeGatherSkills(env), makeCraft(env), makeCook(env), makeFight(env), makeDefend(env), makeEat(env), makeSleep(env), makePlaceTorch(env), makeDropJunk(env), makeStoreInChest(env), makeBuild(env), ...makeInteractSkills(), ...makeBodySkills(env), makeShelter(env), makeTakeCover(env), makeDigIn(env), ...makeActivitySkills(env), ...makeFarm1Skills(env), ...makeRoamSkills(env), ...makeSeedSkills(env), ...makeRs3Skills(env), makeEscapeSkills({}).find((x) => x.name === 'dig_stairs_up')]
  for (const s of skills) runner.register(s)
  runner.onNoPath = async (bot) => (await openDoor(bot, env)) || (await leaveHut(bot, env)) || allowPitDig(bot) // NoPath while sealed in our own pillbox / hut: open a door, retry once; in a pit: dig for the retry
  runner.explainNoPath = (bot) => explainNoPath(bot)
  const names = skills.map((s) => s.name)
  const missing = SKILL_NAMES.filter((n) => !names.includes(n)), extra = names.filter((n) => !SKILL_NAMES.includes(n))
  if (missing.length || extra.length) throw new Error(`skills.json out of sync: missing impl ${missing}, unregistered ${extra}`)
  let stop = null
  return {
    env, names,
    start(getBot) { stop?.(); stop = env.trail.attach(getBot); return this },
    stop() { stop?.(); stop = null },
  }
}
export { SKILL_NAMES, validateArgs, SKILLS } from './schema.js'
