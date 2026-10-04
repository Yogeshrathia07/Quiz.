import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTypeMarks, marksField, paperMarks, paperScore, questionMarks } from '../src/domain/marks.js';
import { DEFAULT_TYPE_MARKS, followTypeDefault, questionMarksFor } from '../client/src/lib/quiz.js';
import { normalizeImport } from '../client/src/screens/creator/import-quiz.js';

test('a question is worth its own marks, else its type\'s, else 1', () => {
  const test_ = { typeMarks: { mcq: 2, msq: 3, short: 5 } };
  assert.equal(questionMarks(test_, { type: 'mcq' }), 2);
  assert.equal(questionMarks(test_, { type: 'msq', manualGrading: true }), 5, 'a short answer is stored as msq with manual grading');
  assert.equal(questionMarks(test_, { type: 'mcq', marks: 4 }), 4);
  assert.equal(questionMarks({}, { type: 'mcq' }), 1, 'a test from before marks: every question worth 1');
  assert.equal(questionMarksFor({ type: 'short' }, { short: 5 }), 5);
  assert.equal(questionMarksFor({ type: 'short', marks: 2.5 }, { short: 5 }), 2.5);
  assert.equal(questionMarksFor({ type: 'msq' }), DEFAULT_TYPE_MARKS.msq);
});

test('a paper is worth its questions together, and scores what its answers earned', () => {
  const doc = { typeMarks: { mcq: 2, msq: 1, short: 4 }, questions: [{ id: 1, type: 'mcq' }, { id: 2, type: 'msq', marks: 3 }, { id: 3, type: 'msq', manualGrading: true }] };
  const attempt = { questions: [{ questionId: 1 }, { questionId: 2 }, { questionId: 3 }], answers: [{ isCorrect: 2 }, { isCorrect: 0 }, { isCorrect: 2.5 }] };
  assert.equal(paperMarks(doc, attempt), 9);
  assert.equal(paperScore(attempt), 4.5);
  assert.equal(paperScore({ answers: [{ isCorrect: 1 }, { isCorrect: null }] }), 1, 'an unmarked answer counts nothing yet');
});

test('marks must be more than 0 and at most 100; none given follows the type', () => {
  assert.equal(marksField('', 'Marks'), null);
  assert.equal(marksField(2.25, 'Marks'), 2.25);
  assert.throws(() => marksField(0, 'Marks'));
  assert.throws(() => marksField(101, 'Marks'));
  assert.deepEqual(buildTypeMarks({ short: 5 }), { mcq: 1, msq: 1, short: 5 });
});

test('a new default reaches every question that held the old one, and only those', () => {
  const questions = [
    { type: 'mcq', timeSeconds: 60 }, // the old default, as its own: follows the new one
    { type: 'mcq', timeSeconds: 45 }, // set apart: kept
    { type: 'mcq', timeSeconds: null }, // already following
    { type: 'short', timeSeconds: 60 } // another type: untouched
  ];
  assert.deepEqual(followTypeDefault(questions, 'timeSeconds', 'mcq', 60).map((question) => question.timeSeconds), [null, 45, null, 60]);
  assert.deepEqual(followTypeDefault([{ type: 'short', marks: 1 }, { type: 'short', marks: 2 }], 'marks', 'short', 1).map((question) => question.marks), [null, 2]);
});

test('an imported quiz brings its marks; a value equal to its type\'s default follows that default', () => {
  const imported = normalizeImport({
    typeSeconds: { mcq: 30 },
    typeMarks: { mcq: 1, msq: 2, short: 5 },
    questions: [
      { prompt: 'Which is FIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['1'], timeSeconds: 30, marks: 1 },
      { prompt: 'Which is LIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['0'], timeSeconds: 45, marks: 2 },
      { prompt: 'Explain a queue.', type: 'short' }
    ]
  }, { startMode: 'manual', endMode: 'duration', opensAt: '', endsAt: '', durationMinutes: null, questionDraw: 'spread' });
  assert.deepEqual(imported.details.typeMarks, { mcq: 1, msq: 2, short: 5 });
  assert.deepEqual(imported.questions.map((question) => [question.timeSeconds, question.marks]), [[null, null], [45, 2], [null, null]]);
});
