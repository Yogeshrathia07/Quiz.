import test from 'node:test';
import assert from 'node:assert/strict';
import { answerState, questionResponse } from '../src/domain/question-statistics.js';
import { questionStatisticsOf } from '../client/src/screens/admin/question-statistics.js';

const question = { id: 'q1', type: 'mcq', options: ['First', 'Second', 'Third'], correctOptions: ['0'], worth: 2 };
const answer = (patch = {}) => ({ questionId: 'q1', answeredAt: '2026-10-17T00:00:00Z', isCorrect: 2, selectedOptions: ['0'], ...patch });
const registration = (answers = [answer()], patch = {}) => ({ id: 's1', fullName: 'PRIVATE NAME', collegeEmail: 'private@example.test',
  attempt: { status: 'submitted', questions: [{ questionId: 'q1' }], answers, ...patch } });
const row = (id, state, picks = []) => ({ id, state, picks });

test('question outcome states match matrix marking, keeping blank, partial and pending separate', () => {
  assert.equal(answerState(2, true, 2), 'O');
  assert.equal(answerState(0, true, 2), 'W');
  assert.equal(answerState(1, true, 2), 'P');
  assert.equal(answerState(null, true, 2), 'Q');
  assert.equal(answerState(null, false, 2), 'B');
  assert.equal(answerState(2, false, 2), 'B');
});

test('question responses include only submitted papers that received the question', () => {
  assert.equal(questionResponse(question, registration([], { status: 'in_progress' }), 2), null);
  assert.equal(questionResponse(question, { id: 'absent' }, 2), null);
  assert.equal(questionResponse(question, registration([], { questions: [{ questionId: 'other' }] }), 2), null);
  assert.deepEqual(questionResponse(question, registration([]), 2), row('s1', 'B'));
});

test('the final legacy answer wins, including its selected options', () => {
  const reg = registration([answer(), answer({ isCorrect: 0, selectedOptions: ['1'] })]);
  assert.deepEqual(questionResponse(question, reg, 2), row('s1', 'W', [1]));
});

test('teacher-given marks drive outcomes while option selections still show the actual choice', () => {
  const response = questionResponse(question, registration([answer({ selectedOptions: ['1'] })]), 2);
  const stats = questionStatisticsOf(question, [response]);
  assert.equal(stats.outcomes.find(({ id }) => id === 'O').count, 1);
  assert.deepEqual(stats.options.map(({ count, correct }) => [count, correct]), [[0, true], [1, false], [0, false]]);
});

test('option choices are unique valid indexes; cleared or unsubmitted picks never count', () => {
  const reg = registration([answer({ selectedOptions: ['2', 0, '0', '02', '-1', '3', '1.5', null, 'bad'] })]);
  assert.deepEqual(questionResponse(question, reg, 2).picks, [0, 2]);
  assert.deepEqual(questionResponse(question, registration([answer({ answeredAt: null })]), 2), row('s1', 'B'));
});

test('short answers expose neither their text nor selectable options', () => {
  const short = { ...question, manualGrading: true };
  const reg = registration([answer({ isCorrect: null, answerText: 'PRIVATE WRITTEN ANSWER' })]);
  const snapshot = JSON.stringify(reg);
  const response = questionResponse(short, reg, 2);
  assert.deepEqual(response, row('s1', 'Q'));
  assert.equal(/PRIVATE|private@example/.test(JSON.stringify(response)), false);
  assert.equal(JSON.stringify(reg), snapshot, 'source data is not mutated');
});

test('MCQ counts and percentages include blanks in the question denominator', () => {
  const stats = questionStatisticsOf(question, [row('a', 'O', [0]), row('b', 'O', [0]), row('c', 'W', [1]), row('d', 'B')]);
  assert.equal(stats.total, 4); assert.equal(stats.answered, 3);
  assert.deepEqual(stats.outcomes.map(({ id, count, percent }) => [id, count, percent]), [['O', 2, 50], ['W', 1, 25], ['P', 0, 0], ['B', 1, 25], ['Q', 0, 0]]);
  assert.deepEqual(stats.options.map(({ count, percent, correct }) => [count, percent, correct]), [[2, 50, true], [1, 25, false], [0, 0, false]]);
});

test('MSQ students count once for each selected option; totals may exceed 100%', () => {
  const multi = { ...question, type: 'msq', correctOptions: ['0', '2'] };
  const stats = questionStatisticsOf(multi, [row('a', 'O', [0, 2]), row('b', 'W', [0, 1, 1]), row('c', 'P', [2])]);
  assert.deepEqual(stats.options.map(({ count, percent }) => [count, percent]), [[2, 66.7], [1, 33.3], [2, 66.7]]);
  assert.deepEqual(stats.options.map(({ correct }) => correct), [true, false, true]);
  assert.equal(stats.outcomes.find(({ id }) => id === 'P').count, 1);
});

test('statistics follow the current student filters and omit papers without this question', () => {
  const responses = [row('a', 'O', [0]), row('b', 'W', [1]), row('c', 'B')];
  const stats = questionStatisticsOf(question, responses, new Set(['a', 'c', 'not-on-this-question']));
  assert.equal(stats.total, 2);
  assert.equal(stats.outcomes.find(({ id }) => id === 'O').percent, 50);
  assert.deepEqual(stats.options.map(({ count }) => count), [1, 0, 0]);
});

test('empty filters give no fabricated percentages, and pending never counts as incorrect', () => {
  const empty = questionStatisticsOf(question, [row('a', 'O', [0])], []);
  assert.equal(empty.total, 0);
  assert.ok(empty.outcomes.every(({ count, percent }) => count === 0 && percent === null));
  assert.ok(empty.options.every(({ count, percent }) => count === 0 && percent === null));
  const pending = questionStatisticsOf(question, [row('a', 'Q', [0])]);
  assert.equal(pending.outcomes.find(({ id }) => id === 'W').count, 0);
  assert.equal(pending.outcomes.find(({ id }) => id === 'Q').percent, 100);
});

test('response IDs are deduplicated, invalid picks ignored and inputs remain unchanged', () => {
  const responses = [row(1, 'W', [1]), row('1', 'O', [0, 0, -1, 3, 1.5]), row('missing', '.', [1]), row(null, 'O', [0])];
  const snapshot = JSON.stringify(responses);
  const stats = questionStatisticsOf(question, responses, new Set([1, 'missing']));
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.options.map(({ count }) => count), [1, 0, 0]);
  assert.equal(JSON.stringify(responses), snapshot);
});
