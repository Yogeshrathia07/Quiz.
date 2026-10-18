import assert from 'node:assert/strict';
import test from 'node:test';
import { answerFilterResponses, dashboardAnswerFilter, ANSWER_FILTER_REGISTRATION_PROJECTION, MAX_ANSWER_FILTER_MATCHES } from '../src/services/dashboard-answer-filter.js';
import { paginateDashboard } from '../src/domain/dashboard-view.js';

const exam = {
  code: 'TEST-ANSWER-FILTER',
  questions: [
    { id: 1, type: 'msq', marks: 2, options: ['One', 'Two', 'Three'], correctOptions: ['0', '1'] },
    { id: 2, type: 'short', manualGrading: true, marks: 3, options: [] }
  ]
};
const answeredAt = '2026-10-17T08:00:00.000Z';
const paper = (id, answers = [], questions = [1, 2], status = 'submitted') => ({
  id, attempt: { status, questions: questions.map((questionId) => ({ questionId })), answers }
});
const filterFor = (extra = {}) => ({
  mode: 'all', questions: [{ id: '1', optionMatch: 'all', options: { 0: 'selected' }, states: [], ...extra }]
});
const fakeCollection = (rows) => {
  const calls = [];
  let closed = 0;
  return {
    calls,
    get closed() { return closed; },
    find(match, options) {
      calls.push({ match, options });
      return {
        batchSize(size) { calls.at(-1).batchSize = size; return this; },
        async close() { closed += 1; },
        async *[Symbol.asyncIterator]() { for (const row of rows) yield row; }
      };
    }
  };
};

test('dashboard answer cohorts are optional and empty ignored controls do not query the class', async () => {
  const collection = fakeCollection([]);
  assert.equal(await dashboardAnswerFilter(collection, exam, undefined), null);
  assert.equal(await dashboardAnswerFilter(collection, exam, { mode: 'all', questions: [] }), null);
  assert.equal(collection.calls.length, 0);
});

test('a cohort considers submitted students beyond every normal dashboard page', async () => {
  const rows = Array.from({ length: 620 }, (_unused, index) => paper(`r${index}`, [{
    questionId: 1, answeredAt, isCorrect: index % 2 ? 0 : 2, selectedOptions: index >= 401 ? ['0', '1'] : ['2']
  }]));
  rows.push(paper('still-writing', [{ questionId: 1, answeredAt, isCorrect: 2, selectedOptions: ['0'] }], [1], 'in_progress'));
  const collection = fakeCollection(rows);
  const result = await dashboardAnswerFilter(collection, exam, JSON.stringify(filterFor()));
  assert.equal(result.metadata.matched, 219);
  assert.equal(result.metadata.totalSubmitted, 620);
  assert.equal(result.match.id.$in[0], 'r401');
  assert.equal(result.match.id.$in.at(-1), 'r619');
  assert.equal(result.match['attempt.status'], 'submitted');
  assert.equal(collection.calls[0].match.testCode, exam.code);
  assert.equal(collection.calls[0].match['attempt.status'], 'submitted');
  assert.deepEqual(collection.calls[0].options.projection, ANSWER_FILTER_REGISTRATION_PROJECTION);
  assert.equal(collection.calls[0].batchSize, 500);
  assert.equal(collection.closed, 1);
  assert.ok(!('attempt.answers.answerText' in ANSWER_FILTER_REGISTRATION_PROJECTION));
  assert.ok(!('fullName' in ANSWER_FILTER_REGISTRATION_PROJECTION));

  // These are the same IDs fed into Mongo before search/sort/skip/limit.
  // Both list sections must paginate the cohort, not filter a page of 200.
  const matched = new Set(result.match.id.$in);
  const all = rows.filter((row) => matched.has(row.id)).map((row) => ({
    id: row.id, name: row.id === 'r619' ? 'Needle student' : row.id,
    attemptStatus: row.attempt.status, status: 'approved', manualTotal: 0, manualGraded: 0
  }));
  for (const section of ['students', 'responses']) {
    const page = paginateDashboard({ test: exam, registrations: all }, { section, pageSize: 200, page: 2 });
    assert.equal(page.pagination.total, 219);
    assert.equal(page.pagination.pages, 2);
    assert.equal(page.registrations.length, 19);
    assert.equal(page.counts.submitted, 219);
    const searched = paginateDashboard({ test: exam, registrations: all }, { section, pageSize: 200, search: 'Needle' });
    assert.deepEqual(searched.registrations.map((row) => row.id), ['r619']);
  }
});

test('response adapter preserves recorded marks, final duplicate precedence, blanks and not-on-paper', () => {
  const registration = paper('r1', [
    { questionId: 1, answeredAt, isCorrect: 0, selectedOptions: ['0'] },
    { questionId: 1, answeredAt, isCorrect: 2, selectedOptions: ['2', '2', '99'] },
    { questionId: 2, answeredAt, isCorrect: null, answerText: 'Never returned' }
  ]);
  const filter = { mode: 'all', questions: [{ id: '1' }, { id: '2' }] };
  const responses = answerFilterResponses(exam, registration, filter);
  assert.equal(responses.get('1').state, 'O', 'a teacher-given full mark remains Correct');
  assert.deepEqual(responses.get('1').picks, [2]);
  assert.equal(responses.get('2').state, 'Q');
  assert.deepEqual(responses.get('2').picks, []);
  assert.equal(responses.get('2').answerText, undefined);
  assert.equal(answerFilterResponses(exam, paper('blank', [], [1]), filter).get('1').state, 'B');
  assert.equal(answerFilterResponses(exam, paper('blank', [], [1]), filter).get('2').state, 'N');
  assert.equal(answerFilterResponses(exam, paper('writing', [], [1], 'in_progress'), filter), null);
});

test('not-selected is distinct from a question the submitted student never received', async () => {
  const collection = fakeCollection([
    paper('different-option', [{ questionId: 1, answeredAt, isCorrect: 0, selectedOptions: ['1'] }], [1]),
    paper('blank-assigned', [], [1]), paper('not-on-paper', [], [2])
  ]);
  const result = await dashboardAnswerFilter(collection, exam, filterFor({ options: { 0: 'not-selected' } }));
  assert.deepEqual(result.match.id.$in, ['different-option', 'blank-assigned']);
  const absent = await dashboardAnswerFilter(collection, exam, filterFor({ options: {}, states: ['N'] }));
  assert.deepEqual(absent.match.id.$in, ['not-on-paper']);
});

test('invalid answer filters reject as explicit 400s before reading registrations', async () => {
  const collection = fakeCollection([]);
  for (const invalid of [
    '{not-json',
    'null', 'false', '[]',
    [JSON.stringify(filterFor())],
    filterFor({ id: 'unknown' }),
    filterFor({ options: { 9: 'selected' } }),
    filterFor({ options: { 0: 'maybe' } }),
    filterFor({ states: ['X'] }),
    filterFor({ states: ['any', 'X'] }),
    filterFor({ optionMatch: 'or' }),
    filterFor({ unknownCondition: 'O' }),
    { ...filterFor(), mode: 'or' },
    { ...filterFor(), unknownSetting: true }
  ]) {
    await assert.rejects(dashboardAnswerFilter(collection, exam, invalid), (error) => error.status === 400 && error.code === 'ANSWER_FILTER_INVALID');
  }
  assert.equal(collection.calls.length, 0);
});

test('an empty matching cohort stays empty instead of falling back to the whole class', async () => {
  const collection = fakeCollection([paper('r1', [{ questionId: 1, answeredAt, isCorrect: 0, selectedOptions: ['2'] }])]);
  const result = await dashboardAnswerFilter(collection, exam, filterFor());
  assert.deepEqual(result.match.id.$in, []);
  assert.equal(result.metadata.matched, 0);
  assert.equal(result.metadata.totalSubmitted, 1);
});

test('an exceptionally broad cohort rejects explicitly rather than truncating matching IDs', async () => {
  function* rows() {
    for (let index = 0; index <= MAX_ANSWER_FILTER_MATCHES; index += 1) {
      yield paper(`r${index}`, [{ questionId: 1, answeredAt, isCorrect: 2, selectedOptions: ['0'] }]);
    }
  }
  const collection = fakeCollection(rows());
  await assert.rejects(dashboardAnswerFilter(collection, exam, filterFor()), (error) => error.status === 400 && error.code === 'ANSWER_FILTER_TOO_BROAD');
  assert.equal(collection.closed, 1, 'the stream is closed on failure too');
});
