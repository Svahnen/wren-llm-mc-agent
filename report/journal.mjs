#!/usr/bin/env node
// Generates docs/journal/YYYY-MM-DD.md (third person, deterministic) from trace + mind + brain logs.
// Usage: node report/journal.mjs [--date YYYY-MM-DD | --all] [--out-dir docs/journal] [--copy-to report/out/journal]
//        [--logs-dir D] [--runtime-dir D] [--brain-dir D] [--mind-db FILE]
//        [--llm-endpoint URL [--llm-model NAME]]   OPTIONAL hook, OFF by default (see below)
// Default: every day that has data. Files are only rewritten when their content changed (no git churn).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAll, loadMind, ROOT } from './lib/data.mjs'
import { buildJournal, journalDays } from './lib/journal-text.mjs'
import { loadVoice } from './lib/convo.mjs'
import { parseArgs, isMain } from './lib/args.mjs'
import { ymd } from './lib/util.mjs'

/**
 * OPTIONAL LLM HOOK (disabled unless --llm-endpoint is given). POSTs the deterministic entry to an OpenAI-compatible
 * /v1/chat/completions endpoint and appends ONE clearly marked paragraph. The deterministic text is never changed.
 * Intended for a later, explicit decision (it would use your model server), so nothing in watch.sh passes this flag.
 */
export async function llmParagraph(md, endpoint, model = 'default', fetchImpl = fetch) {
  const url = endpoint.replace(/\/$/, '').endsWith('/chat/completions') ? endpoint : endpoint.replace(/\/$/, '') + '/v1/chat/completions'
  const r = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model, max_tokens: 300, temperature: 0.4, messages: [
      { role: 'system', content: 'You summarise a log-derived diary of a Minecraft AI named Wren in third person. Use only facts present in the text. One paragraph, at most 120 words.' },
      { role: 'user', content: md.slice(0, 12000) }] }),
  })
  if (!r.ok) throw new Error(`LLM endpoint HTTP ${r.status}`)
  const j = await r.json()
  const t = j?.choices?.[0]?.message?.content
  if (typeof t !== 'string' || !t.trim()) throw new Error('empty LLM reply')
  return `\n## Optional model paragraph (LLM-written, not verified against the logs)\n\n${t.trim()}\n`
}

export async function writeJournals(opts = {}) {
  const L = loadAll({ root: opts.root ?? ROOT, logsDir: opts.logsDir, runtimeDir: opts.runtimeDir, brainDir: opts.brainDir, mindDb: opts.mindDb })
  const mind = await loadMind(L.mindFile)
  const voice = loadVoice({ root: L.root, archiveRoot: opts.archiveRoot, runId: opts.runId, logsDir: L.logsDir })
  const outDir = path.resolve(opts.outDir ?? path.join(L.root, 'docs', 'journal'))
  const days = opts.date ? [opts.date] : journalDays(L.trace.events)
  if (!opts.date && !days.length) days.push(ymd(Date.now())) // nothing logged yet: still produce today's "no data" entry
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  for (const day of days) {
    let md = buildJournal({ events: L.trace.events, brain: L.brain, mind, landmarks: L.landmarks, day, voice })
    if (opts.llmEndpoint) {
      try { md += await (opts.llmFn ?? llmParagraph)(md, opts.llmEndpoint, opts.llmModel) } catch (e) { console.error(`journal: LLM hook failed (${e.message}); deterministic entry kept`) }
    }
    md = md.replace(/\n+$/, '\n')
    for (const dir of [outDir, opts.copyTo && path.resolve(opts.copyTo)].filter(Boolean)) {
      fs.mkdirSync(dir, { recursive: true })
      const f = path.join(dir, `${day}.md`)
      let old = null; try { old = fs.readFileSync(f, 'utf8') } catch { /* new */ }
      if (old !== md) { fs.writeFileSync(f, md); if (dir === outDir) written.push(f) }
    }
  }
  return { days, written }
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2), new Set(['all']))
  const r = await writeJournals({ date: a.all ? null : a.date, outDir: a.outDir, copyTo: a.copyTo, logsDir: a.logsDir, runtimeDir: a.runtimeDir, brainDir: a.brainDir, mindDb: a.mindDb, archiveRoot: a.archiveRoot, runId: a.runId, llmEndpoint: a.llmEndpoint, llmModel: a.llmModel })
  console.log(`journal: ${r.days.length} day(s) [${r.days.join(', ')}], ${r.written.length} file(s) changed`)
}
