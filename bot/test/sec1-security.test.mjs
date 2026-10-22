// SEC1: chat sanitising (no slash commands from model text) + voice link sends the shared token / JSON content-type.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeChatOut, chatLines } from '../src/mindlink/chatchan.js'
import { VoiceLink, voiceHeaders, loadVoiceToken } from '../src/mindlink/voice-link.js'

test('sanitizeChatOut: leading / and other command prefixes never reach bot.chat', () => {
  for (const [inp, out] of [['/op Wren', 'op Wren'], ['  //give @a diamond 64', 'give @a diamond 64'], ['\n/stop', 'stop'], ['​/kill @e', 'kill @e'],
    ['!baritone goto', 'baritone goto'], ['.say hi', 'say hi'], ['#mine', 'mine'], ['\\/tp', 'tp'], ['/', ''], ['///', ''], ['', ''], [null, ''], ['hello /not a command', 'hello /not a command'],
    ['a\u0000b\u0007c §4red', 'a b c 4red']]) assert.equal(sanitizeChatOut(inp), out, JSON.stringify(inp))
  assert.equal(sanitizeChatOut('x'.repeat(500)).length, 240)
  assert.equal(sanitizeChatOut('hello there'), 'hello there')
  assert.deepEqual(chatLines('/op me'), [])
})

test('voiceHeaders / VoiceLink: token on every call, JSON content-type on POST, no header without a token', async () => {
  assert.deepEqual(voiceHeaders('t1', true), { 'x-voice-token': 't1', 'content-type': 'application/json' })
  assert.deepEqual(voiceHeaders('t1'), { 'x-voice-token': 't1' }); assert.deepEqual(voiceHeaders('', true), { 'content-type': 'application/json' })
  const seen = []
  const fetchFn = async (u, o) => { seen.push({ u, h: o.headers, m: o.method }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const l = new VoiceLink({ url: 'http://127.0.0.1:1', fetchFn, token: 'tok-9' })
  await l.refresh(); await l.flush?.()
  assert.ok(seen.length >= 1 && seen.every((s) => s.h['x-voice-token'] === 'tok-9'))
  assert.ok(seen.filter((s) => s.m === 'POST').every((s) => s.h['content-type'] === 'application/json'))
  assert.ok(!JSON.stringify(l).includes('tok-9'))
  assert.equal(loadVoiceToken({ VOICE_TOKEN: 'e1' }), 'e1'); assert.equal(loadVoiceToken({}, '/nonexistent/secrets.env'), '')
})

import { cleanEnv } from '../src/mindlink/cleanenv.js'
import { execFileSync } from 'node:child_process'
test('cleanEnv drops session/secret vars, keeps the allowlist', () => {
  const o = cleanEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 'x', CLAUDE_PID: '1', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', WREN_RUN_ID: 'r', MINDLINK_CHAT: 'on', NODE_OPTIONS: '--x', S2_BASE_URL: 'u', BRAIN_PORT: '1' })
  assert.deepEqual(Object.keys(o).sort(), ['BRAIN_PORT', 'HOME', 'MINDLINK_CHAT', 'NODE_OPTIONS', 'PATH', 'S2_BASE_URL', 'WREN_RUN_ID'])
})
test('supervisor env -i recipe: the same regex in bash drops CLAUDE_CODE_MESSAGING_TOKEN', () => {
  const sh = `eval "$(grep -m1 "^CLEAN_RE=" ${new URL('../src/mindlink/supervise-mind.sh', import.meta.url).pathname})"; eval "$(grep -m1 '^clean_env()' ${new URL('../src/mindlink/supervise-mind.sh', import.meta.url).pathname})"; clean_env; env -i "\${CLEAN[@]}" env`
  const out = execFileSync('bash', ['-c', sh], { env: { PATH: process.env.PATH, HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 'SECRETX', WREN_RUN_ID: 'r1' }, encoding: 'utf8' })
  assert.ok(!out.includes('SECRETX') && !out.includes('CLAUDE')); assert.ok(out.includes('WREN_RUN_ID=r1') && out.includes('HOME=/h'))
})
