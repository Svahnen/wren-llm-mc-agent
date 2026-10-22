// Entry point: node src/main.js   Env: VOICE_MOD_URL VOICE_HTTP_PORT VOICE_STT_URL VOICE_TTS_URL VOICE_VOICE VOICE_BOT_NAME VOICE_LOG_DIR COMPANION_API_KEY (speech servers) WRENVOICE_SECRET (mod WebSocket), both also read from voice/secrets.env
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { VoiceService } from './service.js'; import { startHttp, loadVoiceToken, loadSecret } from './http.js'; import { makeLog } from './log.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e = process.env;
const log = makeLog(e.VOICE_LOG_DIR || path.join(root, 'logs'));
const svc = new VoiceService({
  ...(e.VOICE_MOD_URL && { modUrl: e.VOICE_MOD_URL }), ...(e.VOICE_STT_URL && { sttUrl: e.VOICE_STT_URL }), ...(e.VOICE_TTS_URL && { ttsBase: e.VOICE_TTS_URL }),
  archiveDir: e.VOICE_ARCHIVE === 'off' ? null : (e.VOICE_ARCHIVE_DIR || path.join(root, 'archive')), runId: e.WREN_RUN_ID || 'dev',
  ...(e.VOICE_STT2_URL && { sttPass2Url: e.VOICE_STT2_URL }), ...(e.VOICE_PASS2 === 'off' && { pass2: false }), ...(e.VOICE_TURN_MODEL && { turnModel: e.VOICE_TURN_MODEL, turnAlpha: Number(e.VOICE_TURN_ALPHA || 0) }),
  ...(loadSecret('COMPANION_API_KEY', e) && { apiKey: loadSecret('COMPANION_API_KEY', e).split(',')[0] }), ...(loadSecret('WRENVOICE_SECRET', e) && { modSecret: loadSecret('WRENVOICE_SECRET', e) }),
  ...(e.VOICE_VOICE && { voice: e.VOICE_VOICE }), ...(e.VOICE_BOT_NAME && { botName: e.VOICE_BOT_NAME }), ...(e.VOICE_SPEAK_DISTANCE && { speakDistance: Number(e.VOICE_SPEAK_DISTANCE) }),
}, { log });
const token = loadVoiceToken(e);
if (!token) console.warn('voice service: NO VOICE_TOKEN configured, API is unauthenticated (Host + JSON checks only)');
await startHttp(svc, { port: Number(e.VOICE_HTTP_PORT || 19521), token });
svc.start(); log('service_start', { pid: process.pid, mod: svc.cfg.modUrl });
console.log(`voice service up: http 127.0.0.1:${e.VOICE_HTTP_PORT || 19521}, mod ${svc.cfg.modUrl}`);
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { log('service_stop', {}); try { await svc.stop(); } catch {} process.exit(0); });
