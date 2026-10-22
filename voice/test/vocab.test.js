import test from 'node:test'; import assert from 'node:assert/strict';
import { mergeHeard, agree, fixup, phon, wer } from '../src/vocab.js';
const M = (stream, final, names = ['Steve', 'Marcus']) => mergeHeard({ stream, final, names, botName: 'Wren' });

test('Wren: vocative run/ren/rain become Wren; a real "run" stays', () => {
  assert.equal(M('hey run can you show me', 'Hey Run, can you show me?').text, 'Hey Wren, can you show me?');
  assert.equal(M('hey ren', 'Hey Ren, hi').text, 'Hey Wren, hi');
  assert.equal(M('thanks run', 'Thanks, run.').text, 'Thanks, Wren.');
  assert.equal(M('run away from the creeper', 'Run away from the creeper!').text, 'Run away from the creeper!');
  assert.equal(M('i will run to the village', 'I will run to the village.').corrected, false);
  assert.equal(M('hey rain', 'Hey rain, come here').text, 'Hey Wren, come here');
});
test('Minecraft terms and player names by phonetic/edit match', () => {
  assert.equal(M('where is the pick axe', 'Where is the pick axe?').text, 'Where is the pickaxe?');
  assert.equal(M('an end a man', 'An ender man.').text, 'An enderman.');
  assert.equal(M('a creaper', 'A creaper!').text, 'A creeper!');
  assert.equal(M('stev look', 'Stev, look at this').text, 'Steve, look at this');
  assert.equal(M('hello marcos', 'Hello Marcos').text, 'Hello Marcus');
  assert.equal(M('the farm is over there', 'The farm is over there.').corrected, false);
});
test('agreement score and uncertain words', () => {
  assert.equal(agree('the farm is over there', 'The farm is over there.').agreement, 1);
  const m = M('hey wren show me the vilage', 'Hey Wren, show me the village.'); assert.ok(m.confidence < 1 && m.confidence >= 0.6);
  const d = M('i want to see the cave', 'I want to see the cage.'); assert.deepEqual(d.uncertain_words, ['cage']); assert.ok(d.confidence < 0.9);
  assert.equal(M('', 'Hello there').confidence, 0.5); assert.equal(M('hello there', '').second_pass, false);
});
test('alternatives and fields', () => {
  const m = M('hey run', 'Hey Ren.'); assert.equal(m.text_stream, 'hey run'); assert.equal(m.text_final, 'Hey Ren.'); assert.ok(m.alternatives.some((a) => a.src === 'stream'));
  assert.ok(phon('wren') === phon('ren') && phon('creeper') === phon('creaper')); assert.equal(wer('a b c', 'a b d'), 1 / 3);
});
