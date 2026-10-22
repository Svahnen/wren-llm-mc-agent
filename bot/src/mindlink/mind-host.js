#!/usr/bin/env node
// Mind host (M3): the ONLY process that opens the SQLite memory read-write (single-writer rule). The bot talks to it with JSON lines
// on stdin/stdout (mind-client.js). Like mind/cli.js but with the sleep-pass `summarize` callback wired to S2 (her reflection writes the
// self-summary; it is never authored by us). Isolated process: node:sqlite calls and LLM streaming never touch the bot's 50 ms tick.
//   node mind-host.js --db /path/mind.sqlite
import readline from 'node:readline'
import { createMind } from '../../../mind/api.js'
import { LlmClient } from '../../../brain/llm.js'
import { reflectOnce, deterministicDaySummary } from '../../../mind/reflection.js'
import { GoalStore, reviewGoals } from '../../../mind/goals.js'

const i = process.argv.indexOf('--db')
const dbPath = i > 0 ? process.argv[i + 1] : ':memory:'
const name = process.env.BOT_NAME || 'Wren'
const llm = new LlmClient({ baseUrl: process.env.S2_BASE_URL || 'http://127.0.0.1:19400/v1', timeoutMs: 100000 })

/** sleepPass callback: digest (from memory.buildSleepDigest) -> {self_summary, reflections?}. Throws when S2 is down (DB stays consistent). */
async function summarize(d) {
  const eps = []
  for (const n of d.notable ?? []) eps.push(`${n.text}${n.n > 1 ? ` (x${n.n})` : ''}`)
  for (const x of d.deaths ?? []) eps.push(`I died: ${x.text}`)
  for (const l of d.lessons ?? []) eps.push(`Lesson: ${l.goal_type ?? 'something'} ${l.result}${l.cause ? ' (' + l.cause + ')' : ''}${Number.isFinite(l.x) ? ` near ${Math.round(l.x)},${Math.round(l.z)}` : l.cell ? ' near ' + l.cell.split(',').map((v) => Number(v) * 16 + 8).join(',') : ''}`)
  for (const h of d.habits ?? []) eps.push(`Habit: ${h.text} (x${h.count})`)
  for (const p of d.preference_candidates ?? []) eps.push(`Something I seem to like: ${p.activity} (${p.days} separate days)`)
  const sys = `You are ${name}, an AI that has been given a body to explore a Minecraft world. Nobody has assigned you a task or a personality; you write about yourself only from what actually happened to you.`
  const ask = 'Write a new description of yourself in the first person, 5 to 8 sentences (about 100 to 180 words): what you have done, where you have been, what happened to you, what you notice you like or dislike, what you want. Use only what is true from the events above; it may differ from last time. Plain text, no header, no list.'
  const user = (d.self_summary ? `What you wrote about yourself last time:\n${d.self_summary}\n\n` : '') + `What has happened since:\n${eps.slice(0, 24).map((e) => '- ' + e).join('\n')}\n\n${ask}`
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: user }]
  // R1: validated, one nudged retry, deterministic fallback; self_summary only returned when it passed the quality gate
  const out = await reflectOnce(d, async (retry) => {
    const m = retry ? [...msgs, { role: 'assistant', content: String(retry.previous ?? '').slice(0, 400) || '(no answer)' }, { role: 'user', content: retry.nudge }] : msgs
    const r = await llm.complete({ messages: m, slot: 1, kind: retry ? 'sleep_reflection_retry' : 'sleep_reflection', max_tokens: 450, timeoutMs: 100000 })
    return r.text
  })
  process.stderr.write(`[mind-host] sleep reflection source=${out.source}${out.problem ? ' problem=' + out.problem : ''}\n`)
  await reviewLongTermGoals(d)
  return out
}

/** G2: the nightly reflection also reviews her long-term goals (keep / drop / reorder); the LLM decides, code applies and stores. Never throws. */
async function reviewLongTermGoals(d) {
  try {
    const snap = mind.memory.get('state_goals', null)
    if (!snap?.goals?.some((g) => g.status === 'active')) return
    const store = GoalStore.fromJSON(snap)
    const r = await reviewGoals(store, async (messages) => (await llm.complete({ messages, slot: 1, kind: 'goal_review', max_tokens: 300, timeoutMs: 60000 })).text, { name, summary: deterministicDaySummary(d) })
    if (r?.result) { mind.memory.set('state_goals', store.snapshot()); process.stderr.write(`[mind-host] goal review kept=${r.result.kept} dropped=${r.result.dropped} ordered=${r.result.ordered}\n`) }
    else process.stderr.write(`[mind-host] goal review: no usable answer\n`)
  } catch (e) { process.stderr.write(`[mind-host] goal review failed: ${String(e?.message).slice(0, 120)}\n`) }
}

const mind = createMind({ dbPath, summarize })
const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
// requests run in order, except `sleep` (long, LLM) which must not block ticks: it runs on the side but is the only writer-op allowed to overlap;
// node:sqlite calls are synchronous so interleaving between awaits is safe.
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); return }
  const run = async () => {
    const res = await mind.handle(req)
    if (req.id !== undefined) res.id = req.id
    process.stdout.write(JSON.stringify(res) + '\n')
  }
  if (req.op === 'sleep') run().catch(() => {})
  else chain = chain.then(run).catch(() => {})
})
rl.on('close', () => chain.then(() => { try { mind.saveState(); mind.memory.close() } catch { /* ignore */ } process.exit(0) }))
process.on('SIGTERM', () => { try { mind.saveState(); mind.memory.close() } catch { /* ignore */ } process.exit(0) })
