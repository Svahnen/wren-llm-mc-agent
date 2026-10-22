// Bot configuration: environment with defaults, manually validated (no dependency).
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

export function loadConfig(env = process.env) {
  const errors = []
  const num = (key, def, { min = -Infinity, max = Infinity, int = false } = {}) => {
    const raw = env[key]
    if (raw === undefined || raw === '') return def
    const v = Number(raw)
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) { errors.push(`${key}=${raw} invalid (${int ? 'integer ' : ''}${min}..${max})`); return def }
    return v
  }
  const str = (key, def, re, hint) => {
    const v = env[key] ?? def
    if (!re.test(v)) { errors.push(`${key}=${v} invalid (${hint})`); return def }
    return v
  }

  const cfg = {
    host: str('MC_HOST', '127.0.0.1', /^[A-Za-z0-9._:-]{1,253}$/, 'hostname or IP'),
    port: num('MC_PORT', 25566, { min: 1, max: 65535, int: true }),
    username: str('BOT_NAME', 'Wren', /^[A-Za-z0-9_]{3,16}$/, '3-16 chars [A-Za-z0-9_]'),
    version: str('MC_VERSION', '1.21.1', /^\d+\.\d+(\.\d+)?$/, 'x.y[.z]'),
    auth: 'offline',
    seed: num('SEED', undefined, { int: true, min: 0 }),
    logDir: env.BOT_LOG_DIR ?? path.join(ROOT, 'logs'),
    runtimeDir: env.BOT_RUNTIME_DIR ?? path.join(ROOT, 'runtime'),
    trace: { maxBytes: num('TRACE_MAX_BYTES', 5 * 1024 * 1024, { min: 1024, int: true }), echo: env.TRACE_ECHO === '1' },
    reconnect: {
      baseMs: num('RECONNECT_BASE_MS', 1000, { min: 10, int: true }),
      maxMs: num('RECONNECT_MAX_MS', 60000, { min: 10, int: true }),
      factor: 2,
      jitter: 0.2,
    },
    connectTimeoutMs: num('CONNECT_TIMEOUT_MS', 30000, { min: 1000, int: true }),
    metricsIntervalMs: num('METRICS_INTERVAL_MS', 30000, { min: 500, int: true }),
    pathfinder: { thinkTimeout: 5000, tickTimeout: 30, canDig: false },
    wander: { radius: 28, cell: 8 },
    protectedFile: env.PROTECTED_FILE ?? path.join(ROOT, 'config', 'protected.json'),
    enforceLockouts: env.ENFORCE_LOCKOUTS === '1',
  }
  // Safety guard: refuse the default Minecraft port unless explicitly allowed, so the bot is never pointed at a main server by accident.
  if (cfg.port === 25565 && env.ALLOW_PORT_25565 !== 'I_KNOW') errors.push('MC_PORT=25565 is the default Minecraft port; refused (set ALLOW_PORT_25565=I_KNOW to allow)')
  if (errors.length) throw new Error(`invalid bot config: ${errors.join('; ')}`)
  return Object.freeze(cfg)
}
