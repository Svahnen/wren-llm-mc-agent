import { EventEmitter } from 'node:events'
import { Trace } from '../src/trace.js'
import { Arbiter } from '../src/arbiter.js'
import { SkillRunner } from '../src/skills/runner.js'
import { Metrics } from '../src/metrics.js'

/** A bot double that records what stopBody() does to it. */
export function fakeBot() {
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.health = 20
  bot.calls = { clear: 0, stopDig: 0, setGoalNull: 0, stop: 0, goto: 0 }
  bot.clearControlStates = () => { bot.calls.clear++ }
  bot.stopDigging = () => { bot.calls.stopDig++ }
  bot.deactivateItem = () => {}
  bot.pathfinder = {
    stop: () => { bot.calls.stop++ },
    setGoal: (g) => { if (g === null) { bot.calls.setGoalNull++; bot.pathfinder._reject?.(Object.assign(new Error('stopped'), { name: 'PathStopped' })) } },
    goto: (goal) => { bot.calls.goto++; return new Promise((res, rej) => { bot.pathfinder._reject = rej; bot.pathfinder._resolve = res }) },
  }
  bot.quit = () => setImmediate(() => bot.emit('end', 'quit'))
  bot.end = (r) => setImmediate(() => bot.emit('end', r))
  return bot
}

export function makeRig(opts = {}) {
  const bot = fakeBot()
  const trace = new Trace({ keepLast: 1000 })
  const metrics = new Metrics()
  const arbiter = new Arbiter({ getBot: () => bot, trace, metrics, preemptTimeoutMs: opts.preemptTimeoutMs ?? 300 })
  const runner = new SkillRunner({ arbiter, getBot: () => bot, trace, metrics, tickMs: 20, abortGraceMs: opts.abortGraceMs ?? 200 })
  return { bot, trace, metrics, arbiter, runner }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const types = (trace) => trace.last().map((r) => r.type)
