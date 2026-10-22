#!/usr/bin/env node
// Builds ONE self-contained static HTML report from the bot trace, runtime JSON, mind DB and brain logs.
// Usage: node report/build-report.mjs [--out report/out/report.html] [--logs-dir D] [--runtime-dir D] [--brain-dir D]
//        [--mind-db FILE] [--journal-dir docs/journal]
// Read-only on all inputs. Missing inputs give empty sections, never a crash.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAll, loadMind, ROOT } from './lib/data.mjs'
import { analyze } from './lib/analyze.mjs'
import { renderReport } from './lib/render.mjs'
import { parseArgs, isMain } from './lib/args.mjs'
import { loadVoice, buildConversation, buildGoals, buildDeaths } from './lib/convo.mjs'

export async function buildReport(opts = {}) {
  const L = loadAll({ root: opts.root ?? ROOT, logsDir: opts.logsDir, runtimeDir: opts.runtimeDir, brainDir: opts.brainDir, mindDb: opts.mindDb })
  const mind = await loadMind(L.mindFile)
  const now = opts.now ?? Date.now()
  const model = analyze({ events: L.trace.events, metrics: L.metrics, heat: L.heat, landmarks: L.landmarks, brain: L.brain, mind, now })
  let journalMd = null, journalName = null
  const jdir = opts.journalDir ?? path.join(L.root, 'docs', 'journal')
  try {
    const f = fs.readdirSync(jdir).filter((x) => /^\d{4}-\d\d-\d\d\.md$/.test(x)).sort().pop()
    if (f) { journalMd = fs.readFileSync(path.join(jdir, f), 'utf8'); journalName = f.replace('.md', '') }
  } catch { /* no journal yet */ }
  // R2: conversation / thoughts / goals / deaths from the voice run archive
  const V = loadVoice({ root: L.root, archiveRoot: opts.archiveRoot, runId: opts.runId, logsDir: L.logsDir })
  let copied = false
  if (opts.copyArchiveTo && V.runDir) {
    try { const d = path.join(opts.copyArchiveTo, V.runId); fs.mkdirSync(d, { recursive: true }); for (const f of V.files) fs.copyFileSync(f.path, path.join(d, f.name)); copied = true } catch { /* links simply not offered */ }
  }
  const voice = { V, C: buildConversation(V), G: buildGoals(V, mind), D: buildDeaths(V, L.trace.events, mind), copied }
  return { html: renderReport(model, { journalMd, journalName, generated: new Date(now), voice }), model }
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2))
  const out = path.resolve(a.out ?? path.join(ROOT, 'report', 'out', 'report.html'))
  const { html, model } = await buildReport({ logsDir: a.logsDir, runtimeDir: a.runtimeDir, brainDir: a.brainDir, mindDb: a.mindDb, journalDir: a.journalDir, archiveRoot: a.archiveRoot, runId: a.runId, copyArchiveTo: a.copyArchiveTo ?? path.join(path.dirname(out), 'archive') })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tmp = out + '.tmp'
  fs.writeFileSync(tmp, html); fs.renameSync(tmp, out) // atomic: the server never serves a half-written file
  console.log(`report: ${out} (${html.length} bytes, ${model.nEvents} trace events, ${model.sessions.length} sessions)`)
}
