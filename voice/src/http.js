// Local HTTP API on 127.0.0.1:19521 (bot-side mindlink): POST /speak, POST /flush, GET /heard, GET /status, POST /speak_distance.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** SEC1: shared secret for the voice API. Env VOICE_TOKEN wins; else a line VOICE_TOKEN=... in `file` (voice/secrets.env, mode 600, gitignored); '' = none. */
export function loadVoiceToken(env = process.env, file = env.VOICE_SECRETS_FILE || new URL('../secrets.env', import.meta.url).pathname) {
  if (env.VOICE_TOKEN) return env.VOICE_TOKEN.trim();
  try { const m = fs.readFileSync(file, 'utf8').match(/^VOICE_TOKEN=(.*)$/m); return m ? m[1].trim() : ''; } catch { return ''; }
}
/** Generic secret lookup: env var `name` wins, else a line NAME=... in the secrets file; '' = none. */
export function loadSecret(name, env = process.env, file = env.VOICE_SECRETS_FILE || new URL('../secrets.env', import.meta.url).pathname) {
  if (env[name]) return env[name].trim();
  try { const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + name + '=(.*)$', 'm')); return m ? m[1].trim() : ''; } catch { return ''; }
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function startHttp(svc, { port = 19521, host = '127.0.0.1', token = '' } = {}) {
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 20000) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } }); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    // SEC1 guards (same as brain/server.js): DNS-rebinding Host check, shared-secret header, JSON-only POST (no CORS-simple cross-site form posts).
    const hostName = (req.headers.host || '').replace(/:\d+$/, '');
    if (hostName !== '127.0.0.1' && hostName !== 'localhost') return json(res, 403, { error: 'host' });
    if (token && !same(req.headers['x-voice-token'] ?? '', token)) return json(res, 401, { error: 'token' });
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'content-type must be application/json' });
    try {
      if (req.method === 'GET' && u.pathname === '/status') return json(res, 200, svc.status());
      if (req.method === 'GET' && u.pathname === '/heard') {
        const since = Number(u.searchParams.get('since') || 0), wait = Math.min(Number(u.searchParams.get('wait') || 0), 55);
        const ac = new AbortController(); req.on('close', () => ac.abort());
        const items = await svc.heardSince(since, wait); return json(res, 200, items);
      }
      if (req.method === 'POST' && u.pathname === '/speak') {
        const b = await body(req); if (!b || typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text required' });
        if (b.priority && !['normal', 'urgent'].includes(b.priority)) return json(res, 400, { error: 'priority must be normal|urgent' });
        if (b.kind !== undefined && !['warning', 'answer', 'chatter', 'story', 'ack'].includes(b.kind)) return json(res, 400, { error: 'kind must be warning|answer|chatter|story|ack' });
        if (b.importance !== undefined && !(typeof b.importance === 'number' && b.importance >= 0 && b.importance <= 1)) return json(res, 400, { error: 'importance must be a number 0..1' });
        const id = svc.speak(b); if (id === 'suppressed') return json(res, 200, { utt_id: null, suppressed: true }); return id ? json(res, 200, { utt_id: id }) : json(res, 400, { error: 'no speakable text' });
      }
      if (req.method === 'POST' && u.pathname === '/flush') { svc.dropHeld?.('flush'); const r = svc.speaker.flush('*', 'api_flush'); return json(res, 200, { flushed: true, interrupted: r }); }
      if (req.method === 'POST' && u.pathname === '/speak_distance') {
        const b = await body(req); if (!b || !(b.d > 0)) return json(res, 400, { error: 'd > 0 required' });
        svc.cfg.speakDistance = b.d; svc._send(JSON.stringify({ type: 'speak_distance', d: b.d })); return json(res, 200, { d: b.d });
      }
      if (req.method === 'POST' && u.pathname === '/familiarity') {       // optional: mindlink pushes people.js familiarity so barge-in scoring knows who is a friend
        const b = await body(req); if (!b || typeof b.name !== 'string' || !(b.familiarity >= 0 && b.familiarity <= 1)) return json(res, 400, { error: 'name and familiarity 0..1 required' });
        svc.fam.set(b.name, b.familiarity); return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: String(e) }); }
  });
  return new Promise((resolve) => srv.listen(port, host, () => resolve(srv)));
}
