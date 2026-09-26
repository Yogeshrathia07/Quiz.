import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedAttemptQuestions } from '../src/domain/question-bank.js';

const bank = (count, type = 'mcq', from = 1) => Array.from({ length: count }, (_unused, index) => ({
  id: from + index, type, prompt: `Q${from + index}`, options: ['a', 'b'], correctOptions: ['0']
}));
const quiz = (extra = {}) => ({
  code: 'TEST-DRAW1', questions: bank(12), questionMix: { mcq: 3, msq: 0, short: 0 }, questionCount: 3,
  shuffleQuestions: true, questionDraw: 'spread', ...extra
});
const ids = (questions) => questions.map((question) => question.id).sort((a, b) => a - b);

test('spread: students who begin one after another share no question until the bank runs out', () => {
  const papers = [0, 1, 2, 3].map((slot) => ids(selectedAttemptQuestions(quiz(), `seed-${slot}`, slot)));
  const all = papers.flat();
  assert.equal(new Set(all).size, 12, 'four papers of 3 cover all 12 questions exactly once');
});

test('spread: once the bank is used up it wraps round, and every question is used equally', () => {
  const uses = new Map();
  for (let slot = 0; slot < 8; slot += 1) {
    for (const id of ids(selectedAttemptQuestions(quiz(), `s${slot}`, slot))) uses.set(id, (uses.get(id) || 0) + 1);
  }
  assert.deepEqual([...new Set(uses.values())], [2], '8 papers × 3 = 24 = every question twice');
});

test('spread: when the bank is not a multiple of the paper, neighbours still differ', () => {
  const odd = quiz({ questions: bank(7), questionMix: { mcq: 3, msq: 0, short: 0 } });
  const [first, second] = [0, 1].map((slot) => ids(selectedAttemptQuestions(odd, 'x', slot)));
  assert.equal(first.filter((id) => second.includes(id)).length, 0);
});

test('spread: each type is spread on its own', () => {
  const mixed = quiz({
    questions: [...bank(6, 'mcq', 1), ...bank(4, 'msq', 101)],
    questionMix: { mcq: 2, msq: 2, short: 0 }, questionCount: 4
  });
  const [a, b] = [0, 1].map((slot) => ids(selectedAttemptQuestions(mixed, 'x', slot)));
  assert.equal(a.filter((id) => b.includes(id)).length, 0, 'two MCQs and two MSQs each, all different');
  assert.equal(a.filter((id) => id > 100).length, 2);
});

test('spread: the same slot always gives the same questions', () => {
  assert.deepEqual(ids(selectedAttemptQuestions(quiz(), 'a', 5)), ids(selectedAttemptQuestions(quiz(), 'b', 5)));
});

test('random draw, and older tests without a slot, keep the per-student random pick', () => {
  const random = quiz({ questionDraw: 'random' });
  assert.deepEqual(ids(selectedAttemptQuestions(random, 'seed-1', 0)), ids(selectedAttemptQuestions(random, 'seed-1', 7)), 'slot is ignored');
  assert.equal(selectedAttemptQuestions(quiz(), 'seed-1').length, 3, 'no slot falls back to the random pick');
});
