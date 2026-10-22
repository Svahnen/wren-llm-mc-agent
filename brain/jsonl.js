// Append-only JSONL logger (one file per UTC day). Never throws.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs')

export function makeLogger(prefix, dir = process.env.BRAIN_LOG_DIR || DEFAULT_LOG_DIR) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return (rec) => {
    try {
      const d = new Date()
      appendFileSync(join(dir, `${prefix}-${d.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: d.toISOString(), ...rec }) + '\n')
    } catch { /* logging must never break the brain */ }
  }
}
