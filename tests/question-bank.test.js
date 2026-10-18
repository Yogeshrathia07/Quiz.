import assert from 'node:assert/strict';
import test from 'node:test';
import { hmac, stableSort } from '../src/lib/crypto.js';
import { ESTIMATE_SECONDS, estimateSeconds, selectedAttemptQuestions } from '../src/domain/question-bank.js';

const poolTest = {
  questionCount: 4,
  questionMix: { mcq: 2, msq: 1, short: 1 },
  shuffleQuestions: true,
  questions: [
    { id: 1, type: 'mcq' }, { id: 2, type: 'mcq' }, { id: 3, type: 'mcq' },
    { id: 4, type: 'msq' }, { id: 5, type: 'msq' },
    { id: 6, type: 'msq', manualGrading: true }, { id: 7, type: 'msq', manualGrading: true }
  ]
};

test('question pools keep each requested question type while randomizing the selected questions', () => {
  const first = selectedAttemptQuestions(poolTest, 'student-a');
  const repeated = selectedAttemptQuestions(poolTest, 'student-a');
  const count = (type) => first.filter((question) => (question.manualGrading ? 'short' : question.type) === type).length;

  assert.deepEqual(first.map((question) => question.id), repeated.map((question) => question.id));
  assert.equal(first.length, 4);
  assert.equal(new Set(first.map((question) => question.id)).size, 4);
  assert.equal(count('mcq'), 2);
  assert.equal(count('msq'), 1);
  assert.equal(count('short'), 1);
});

test('the shuffle gives every paper the order it always had, so a paper begun before keeps its order', () => {
  // As it was first written: an HMAC on both sides of every comparison.
  const original = (items, seed, key = (item) => item.id) => [...items].sort((a, b) => hmac(`${seed}:${key(a)}`, seed).localeCompare(hmac(`${seed}:${key(b)}`, seed)));
  const bank = Array.from({ length: 90 }, (_unused, index) => ({ id: index + 1 }));
  for (const seed of ['student-a', 'TEST-AB12CD:592001234', 'a'.repeat(64)]) {
    assert.deepEqual(stableSort(bank, seed), original(bank, seed));
    const options = ['0', '1', '2', '3'];
    assert.deepEqual(stableSort(options, `${seed}:7`, (id) => id), original(options, `${seed}:7`, (id) => id));
  }
  assert.deepEqual(stableSort([], 'seed'), []);
});

test('the estimate prices each question type, short answers costing more', () => {
  assert.equal(estimateSeconds({ mcq: 2, msq: 1, short: 1 }), 60 + 60 + 60 + 120);
  assert.equal(estimateSeconds({ mcq: 0, msq: 0, short: 0 }), 0);
  assert.ok(ESTIMATE_SECONDS.short > ESTIMATE_SECONDS.mcq, 'writing takes longer than choosing');
});

test('without a mix the estimate falls back to the question count', () => {
  assert.equal(estimateSeconds(null, 3), 3 * ESTIMATE_SECONDS.mcq);
  assert.equal(estimateSeconds(null, 0), 0);
});
