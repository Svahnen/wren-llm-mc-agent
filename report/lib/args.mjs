export function parseArgs(argv, flags = new Set()) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const [k, v] = a.slice(2).split('=')
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (v !== undefined) o[key] = v
    else if (flags.has(k)) o[key] = true
    else o[key] = argv[++i]
  }
  return o
}

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
/** True when this module is the process entry point (symlink-safe). */
export function isMain(metaUrl) {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl)) } catch { return false }
}
