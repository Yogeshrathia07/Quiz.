import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMix, mixWithAdded, poolCounts } from '../client/src/lib/quiz.js';

test('a question added to a type every student gets all of reaches the papers', () => {
  const pool = { mcq: 3, msq: 0, short: 0 };
  assert.deepEqual(mixWithAdded({ mcq: 3, msq: 0, short: 0 }, pool, 'mcq'), { mcq: 4, msq: 0, short: 0 });
  assert.deepEqual(mixWithAdded({ mcq: 3, msq: 0, short: 0 }, pool, 'short'), { mcq: 3, msq: 0, short: 1 }, 'the first of its type');
});

test('a count chosen below the bank stays as chosen', () => {
  const mix = { mcq: 3, msq: 0, short: 0 };
  assert.equal(mixWithAdded(mix, { mcq: 10, msq: 0, short: 0 }, 'mcq'), mix, '3 of 10 stays 3 of 11');
  assert.equal(mixWithAdded(mix, { mcq: 3, msq: 0, short: 2 }, 'short'), mix, 'none of 2 short answers stays none');
});

test('added as an MCQ, then changed to a short answer: on the papers as a short answer', () => {
  // The editor's steps: + Add question (an MCQ), then its type changed.
  let questions = [{ type: 'mcq' }, { type: 'mcq' }, { type: 'mcq' }];
  let mix = { mcq: 3, msq: 0, short: 0 };
  mix = mixWithAdded(mix, poolCounts(questions), 'mcq');
  questions = [...questions, { type: 'mcq' }];
  mix = clampMix(mix, poolCounts(questions));
  assert.deepEqual(mix, { mcq: 4, msq: 0, short: 0 });
  mix = mixWithAdded(mix, poolCounts(questions), 'short');
  questions = [...questions.slice(0, 3), { type: 'short' }];
  mix = clampMix(mix, poolCounts(questions));
  assert.deepEqual(mix, { mcq: 3, msq: 0, short: 1 });
});
