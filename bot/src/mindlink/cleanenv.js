// SEC1 (LOW 14): child processes (mind host) get an allowlisted environment, not the whole parent env (no CLAUDE_CODE_* / session tokens).
// Keep in sync with CLEAN_RE in supervise-mind.sh and brain/supervise.sh.
export const CLEAN_RE = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_RUNTIME_DIR|NODE_[A-Z_]+|WREN_[A-Z0-9_]+|MINDLINK_[A-Z0-9_]+|BOT_[A-Z0-9_]+|TRACE_ECHO|BRAIN_[A-Z0-9_]+|S2_[A-Z0-9_]+|MIND_[A-Z0-9_]+|VOICE_[A-Z0-9_]+|H1_DEBUG)$/
export function cleanEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (CLEAN_RE.test(k) && v !== undefined) out[k] = v
  return out
}
