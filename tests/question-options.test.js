import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTest } from '../src/domain/test-builder.js';
import { PublicTestError } from '../src/lib/errors.js';
import { MAX_OPTIONS, MIN_OPTIONS, withOptionAdded, withOptionRemoved } from '../client/src/lib/quiz.js';

const choice = (count, correctOptions = ['0']) => ({
  prompt: 'Which one?', type: 'mcq', options: Array.from({ length: count }, (_value, index) => `Option ${index + 1}`), correctOptions
});

test('a choice question has 2 to 10 options, on both sides', async () => {
  const server = await import('../src/domain/test-builder.js');
  assert.equal(MIN_OPTIONS, 2);
  assert.equal(MAX_OPTIONS, 10);
  assert.equal(server.MIN_OPTIONS, MIN_OPTIONS, 'the editor and the server agree');
  assert.equal(server.MAX_OPTIONS, MAX_OPTIONS, 'the editor and the server agree');
});

test('Add option stops at 10, and removing one stops at 2', () => {
  let question = choice(2);
  for (let step = 0; step < 12; step += 1) question = withOptionAdded(question);
  assert.equal(question.options.length, MAX_OPTIONS);
  assert.equal(question.options.at(-1), '', 'a new option starts empty');
  assert.equal(withOptionAdded(question), question, 'nothing past the limit');

  const two = choice(2, ['1']);
  assert.equal(withOptionRemoved(two, 0), two, 'never fewer than 2');
});

test('removing an option keeps the right answers pointing at the same options', () => {
  const question = { ...choice(5, ['0', '2', '4']), type: 'msq' };
  const removed = withOptionRemoved(question, 2);
  assert.deepEqual(removed.options, ['Option 1', 'Option 2', 'Option 4', 'Option 5']);
  assert.deepEqual(removed.correctOptions, ['0', '3'], 'the removed right answer goes; the one after it moves up');

  const first = withOptionRemoved(question, 0);
  assert.deepEqual(first.options, ['Option 2', 'Option 3', 'Option 4', 'Option 5']);
  assert.deepEqual(first.correctOptions, ['1', '3']);
});

test('a test is saved with 10 options and refused with 1 or 11', () => {
  const mix = { mcq: 1, msq: 0, short: 0 };
  const built = buildTest({ title: 'Ten options', questionMix: mix, questions: [choice(10, ['9'])] });
  assert.equal(built.questions[0].options.length, 10);
  assert.deepEqual(built.questions[0].correctOptions, ['9']);
  assert.throws(() => buildTest({ title: 'Eleven', questionMix: mix, questions: [choice(11)] }), PublicTestError);
  assert.throws(() => buildTest({ title: 'Eleven', questionMix: mix, questions: [choice(11)] }), /needs 2 to 10 answer options/);
  assert.throws(() => buildTest({ title: 'One', questionMix: mix, questions: [choice(1)] }), /needs 2 to 10 answer options/);
});

test('an imported question may have 2 to 10 options, and the list shows its words on one line', async () => {
  const { normalizeImport } = await import('../client/src/screens/creator/import-quiz.js');
  const { promptPreview } = await import('../client/src/lib/text-format.js');
  const defaults = { startMode: 'manual', opensAt: '', endMode: 'duration', endsAt: '', durationMinutes: null, questionDraw: 'spread' };
  const imported = normalizeImport({
    title: 'Imported', strictTiming: true, strictPrevious: true,
    questions: [
      { ...choice(10), prompt: 'Which is **first**?', correctOptions: [9] },
      { prompt: 'Explain it.', type: 'short' }
    ]
  }, defaults);
  assert.equal(imported.questions[0].options.length, 10);
  assert.deepEqual(imported.questions[0].correctOptions, ['9']);
  assert.equal(imported.details.strictPrevious, true);
  assert.equal('difficulty' in imported.questions[0], false, 'no difficulty any more');
  assert.equal('difficultyMix' in imported.details, false);

  assert.throws(() => normalizeImport({ title: 'Too many', questions: [choice(11)] }, defaults), /11 options; 10 at most/);
  assert.throws(() => normalizeImport({ title: 'Too few', questions: [choice(1)] }, defaults), /at least 2 options/);
  assert.equal(promptPreview('Which data structure uses **FIFO**?\n- one\n2. two'), 'Which data structure uses FIFO? one two');
});
