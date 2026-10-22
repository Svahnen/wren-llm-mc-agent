// V3: conversation continuity for the addressee label (perception), plus filler endpointing.
import test from 'node:test'; import assert from 'node:assert/strict';
import { VoiceService } from '../src/service.js';
import { CONVO_MS } from '../src/addressee.js';
import { eotRequiredMs } from '../src/turntake.js';

test('continuity is per speaker and expires; a stranger beyond 6 m without her name stays ambient', () => {
  const svc = new VoiceService({ archive: false, pass2: false }, { log: () => {} }); svc.botOnline = true;
  const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
  try {
    svc.near = [{ uuid: 'j', name: 'Sam', dist: 9 }, { uuid: 'a', name: 'Anna', dist: 10 }];
    svc.convoAt.set('j', clock);
    assert.equal(svc._addressed({ uuid: 'j', dist: 9 }, 'where are you going'), true);
    assert.equal(svc._addressed({ uuid: 'a', dist: 10 }, 'look at that cow'), false);     // another person, no conversation with her
    assert.equal(svc._addressed({ uuid: 'j', dist: 60 }, 'where are you going'), false);   // out of hearing range (FAR 48)
    clock += CONVO_MS + 1; assert.equal(svc._addressed({ uuid: 'j', dist: 9 }, 'where are you going'), false);
    // only one human in range and she just spoke to someone: addressed
    svc.near = [{ uuid: 'j', name: 'Sam', dist: 9 }]; svc.lastBotSpeakAt = clock - 1000; svc.convoAt.set('x', clock - 1000);
    assert.equal(svc._addressed({ uuid: 'j', dist: 9 }, 'where are you going'), true);
  } finally { Date.now = realNow; }
});

test('fillers inside a sentence ("way back to um uh the starting location") hold the endpoint at 1000 ms: one utterance, not two', () => {
  assert.equal(eotRequiredMs('ah i think i know the way back to um'), 1000);
  assert.equal(eotRequiredMs('ah i think i know the way back to um uh'), 1000);
  assert.equal(eotRequiredMs('ah i think i know the way back to um uh the starting location'), 500);
});
