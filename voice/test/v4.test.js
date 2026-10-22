// V4: she never got a word in. Held lines (human speaking), auto-resume, importance, turn fairness, out-of-range transcripts.
import test from 'node:test'; import assert from 'node:assert/strict';
import { VoiceService } from '../src/service.js';
import { TurnScorer, features, FINISH, TRAIL, NOW } from '../src/turnscore.js';


function rig() {
  const log = []; const svc = new VoiceService({ archive: false, pass2: false }, { log: (e, d) => log.push({ e, ...d }) });
  let clock = 1e6, wall = 1.7e12; svc.now = () => clock; svc.speaker.now = () => clock; svc.botOnline = true; svc.connected = true;
  const enq = []; svc.speaker.enqueue = (b) => { enq.push(b); return b.id ?? 'x'; };
  const realNow = Date.now; Date.now = () => wall;
  const talk = (uuid, name, dist, silenceMs = 0, extra = {}) => { const l = { uuid, name, dist, inUtt: true, voicedMs: 800, inRange: true, effectiveSilenceMs: () => silenceMs, lastEvalAt: 0, ...extra }; svc.listeners.set(uuid, l); return l; };
  return { svc, log, enq, talk, adv: (ms) => { clock += ms; wall += ms; }, done: () => { Date.now = realNow; } };
}

test('a line started while a human speaks is HELD, not started into his speech, and redelivered at the next gap with the same utt id', () => {
  const r = rig(); try {
    const l = r.talk('j', 'Alex', 11);
    const id = r.svc.speak({ text: "Alex, I'm actually starving right now - my food is at zero.", in_reply_to: 17 });
    assert.match(id, /^u\d+$/); assert.equal(r.enq.length, 0); assert.equal(r.svc.status().held.utt_id, id);
    r.svc._heldTick(); r.adv(400); r.svc._heldTick(); assert.equal(r.enq.length, 0, 'still talking');
    l.inUtt = false; r.svc._heldTick(); r.adv(300); r.svc._heldTick(); assert.equal(r.enq.length, 0, 'gap too short');
    r.adv(300); r.svc._heldTick();
    assert.equal(r.enq.length, 1); assert.equal(r.enq[0].id, id); assert.equal(r.enq[0].inReplyTo ?? r.enq[0].in_reply_to, 17);
    assert.ok(r.log.some((x) => x.e === 'speak_held') && r.log.some((x) => x.e === 'held_redelivered' && x.utt_id === id));
    assert.equal(r.svc.status().held, null);
  } finally { r.done(); }
});

test('a newer S2 line replaces the held one; a stale held line (> 20 s) is dropped and logged', () => {
  const r = rig(); try {
    const l = r.talk('j', 'J', 5);
    r.svc.speak({ text: 'First thought.' }); const id2 = r.svc.speak({ text: 'Newer thought.' });
    assert.ok(r.log.some((x) => x.e === 'held_dropped_replaced' && x.text === 'First thought.'));
    assert.equal(r.svc.held.id, id2);
    r.adv(21000); r.svc._heldTick();
    assert.equal(r.svc.held, null); assert.ok(r.log.some((x) => x.e === 'held_dropped_stale')); assert.equal(r.enq.length, 0);
    l.inUtt = false;
  } finally { r.done(); }
});

test('warning / urgent lines and lines with nobody talking are not held', () => {
  const r = rig(); try {
    r.talk('j', 'J', 5);
    r.svc.speak({ text: 'Creeper behind you!', priority: 'urgent' }); r.svc.speak({ text: 'Lava ahead.', kind: 'warning' }); r.svc.speak({ text: 'Dying.', importance: 0.9 });
    assert.equal(r.enq.length, 3); assert.equal(r.svc.held, null);
    r.svc.listeners.clear(); r.svc.speak({ text: 'Hello.' }); assert.equal(r.enq.length, 4);
  } finally { r.done(); }
});

test('out-of-range talkers neither hold her line nor trigger barge-in', () => {
  const r = rig(); try {
    const l = r.talk('far', 'Farley', 70, 0, { inRange: false });
    r.svc.speak({ text: 'Hello there.' }); assert.equal(r.enq.length, 1);
    r.svc.speaker.cur = { id: 'u1', sentences: ['a b c.'], spans: [], sentMs: 0, priority: 'normal' };
    assert.equal(r.svc._evalOverlap(l, 'stop it please'), null);
  } finally { r.done(); }
});

test('a cut before a whole sentence was said is offered for auto-resume (whole line); a short remainder too; a long one, stop and danger are not', () => {
  const r = rig(); try {
    const u = { id: 'u17', inReplyTo: 17, kind: 'answer', importance: 0.5 };
    r.svc._offerResume({ utt_id: 'u17', text: 'I am starving right now.', spoken: '' }, u, 'yield_trail_off');
    assert.equal(r.svc.held.why, 'cut_before_sentence'); assert.equal(r.svc.held.body.text, 'I am starving right now.'); r.svc.held = null;
    const un = { text: 'And that is why.', spoken: 'I am heading home.' }; r.svc._offerResume(un, u, 'yield_trail_off');
    assert.equal(r.svc.held.why, 'resume_remainder'); assert.equal(un.auto_resume, true); r.svc.held = null;
    r.svc._offerResume({ text: Array(30).fill('word').join(' ') + '.', spoken: 'Done.' }, u, 'yield_trail_off'); assert.equal(r.svc.held, null);
    // explicit stop: flush happens, nothing is resumed
    r.svc.speaker.cur = u; Object.assign(u, { sentences: ['Something long enough.'], spans: [], sentMs: 100, t0: 0, idx: 0 });
    r.svc.speaker.flush = () => ({ text: 'Something long enough.', spoken: '' });
    r.svc._apply('yield_now', u, { uuid: 'j' }, 'stop', { source: 'rule:stop' }); assert.equal(r.svc.held, null);
    r.svc._apply('yield_now', u, { uuid: 'j' }, 'hold on', { source: 'score' }); assert.equal(r.svc.held?.why, 'cut_before_sentence');
  } finally { r.done(); }
});

test('turn fairness: after 2 consecutive yields to the same person within 30 s a held line takes a SHORT gap inside his speech; others and old yields do not count', () => {
  const r = rig(); try {
    const l = r.talk('j', 'J', 6, 300);
    r.svc.speak({ text: 'A line.' });                                   // 1st deferral
    assert.equal(r.svc._owed('j'), false); r.svc._heldTick(); assert.equal(r.enq.length, 0, 'not owed: waits for the end of his utterance');
    r.svc._noteYield('j'); assert.equal(r.svc._owed('j'), true);
    r.svc._heldTick(); assert.equal(r.enq.length, 1, 'owed: takes the 300 ms pause'); assert.ok(r.log.some((x) => x.gap === 'fairness_short_gap'));
    r.svc._noteYield('other'); assert.equal(r.svc._owed('j'), false, 'interleaved');
    r.svc._noteYield('j'); r.svc._noteYield('j'); r.adv(31000); assert.equal(r.svc._owed('j'), false, 'window');
    void l;
  } finally { r.done(); }
});

test('importance: an own-state line (starving) is finished, not trailed off, on a short overlap; a plain answer still trails; owed favours finishing', () => {
  const sc = new TurnScorer();
  const base = { text: 'and you should write', voicedMs: 1400, overlapMs: 1300, addressed: true, dist: 11, u: { sentences: ["Alex, I'm actually starving right now - my food is at zero."], sentMs: 3000, spans: [], priority: 'normal', kind: 'answer' }, playedMs: 1000 };
  const act = (extra, imp) => sc.score(features({ ...base, ...extra, u: { ...base.u, importance: imp } })).action;
  assert.equal(act({}, 0.5), TRAIL); assert.equal(act({}, 0.8), FINISH);
  assert.notEqual(act({ overlapMs: 4500 }, 0.8), FINISH, 'a long overlap still yields');
  assert.equal(act({ owed: true }, 0.5), FINISH);
  assert.equal(act({ text: 'stop', overlapMs: 900 }, 0.8), NOW, 'explicit stop is untouched');
});

test('out-of-range speech is transcribed and archived with in_range:false but never reaches /heard; in range is archived with in_range:true', async () => {
  const r = rig(); try {
    const arch = []; r.svc.archive.heard = (x) => arch.push(x);
    const mk = (uuid, dist, inRange) => ({ uuid, name: uuid, dist, inRange, endpoint: async () => ({ text: 'hello wren how are you', endpoint_ms: 10, stt_ms: 10, voiced_ms: 900, rec: {}, final_ms: 1 }) });
    await r.svc._finish(mk('far', 70, false)); await r.svc._finish(mk('near', 5, true));
    assert.equal(r.svc.heard.length, 1); assert.equal(r.svc.heard[0].uuid, 'near');
    assert.deepEqual(arch.map((a) => a.in_range), [false, true]); assert.match(arch[0].text, /hello wren how are you/i);
    assert.equal(arch[0].addressed, false);
  } finally { r.done(); }
});

// ---- synthetic sequence: a talker speaks through several utterances, each of her lines arrives while he is mid-utterance
test('held lines: the newest wins, older ones are replaced, delivery waits for the gap and yields never starve her twice', () => {
  const r = rig(); try {
    const j = r.talk('j', 'Alex', 11.5);
    const ids = []; for (const t of ["Alex, I've got the bed but I'm starving and can barely stand.", "Alex, I'm actually starving right now - my food is at zero."]) { ids.push(r.svc.speak({ text: t })); r.adv(500); }
    assert.equal(r.svc.held.body.text.includes('food is at zero'), true, 'newest line wins, older one logged as replaced');
    assert.ok(r.log.some((x) => x.e === 'held_dropped_replaced'));
    r.adv(5000); j.inUtt = false; r.svc._heldTick(); r.adv(600); r.svc._heldTick();
    assert.equal(r.enq.length, 1); assert.match(r.enq[0].text, /food is at zero/); assert.equal(r.enq[0].id, ids[1]);
  } finally { r.done(); }
});

test('VAL2: kind ack is spoken when nobody talks, suppressed (never held) while a human talks or she speaks, and keeps its kind for the archive', () => {
  const r = rig(); try {
    r.svc.speak({ text: 'Hm, let me think.', kind: 'ack', importance: 0.2 });
    assert.equal(r.enq.length, 1); assert.equal(r.enq[0].kind, 'ack');
    r.svc.speaker.queue.push({}); assert.equal(r.svc.speak({ text: 'One sec.', kind: 'ack' }), 'suppressed'); r.svc.speaker.queue.length = 0
    r.talk('j', 'J', 5); assert.equal(r.svc.speak({ text: 'Mm?', kind: 'ack' }), 'suppressed'); assert.equal(r.svc.held, null); assert.equal(r.enq.length, 1);
  } finally { r.done(); }
});
