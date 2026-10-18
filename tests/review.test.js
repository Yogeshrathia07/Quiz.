import assert from 'node:assert/strict';
import test from 'node:test';
import { answerState, initialsOf, papersWith, reviewForRegistration } from '../client/src/screens/admin/review.js';
import { automaticMarks, isRightChoice } from '../src/domain/marks.js';

test('an answer stands where its marks put it: to mark, blank, full, part or none', () => {
  assert.equal(answerState(null), 'absent');
  assert.equal(answerState({ answered: true, marks: null, maxMarks: 4 }), 'pending', 'a short answer still to mark');
  assert.equal(answerState({ answered: false, marks: null, maxMarks: 4 }), 'blank');
  assert.equal(answerState({ answered: false, marks: 0, maxMarks: 2 }), 'blank', 'left blank, scored 0');
  assert.equal(answerState({ answered: false, marks: 0, maxMarks: 2, overridden: true }), 'zero', 'a teacher\'s 0 is a mark');
  assert.equal(answerState({ answered: true, marks: 4, maxMarks: 4 }), 'full');
  assert.equal(answerState({ answered: true, marks: 1.5, maxMarks: 4 }), 'part');
  assert.equal(answerState({ answered: true, marks: 0, maxMarks: 4 }), 'zero');
});

test('by question: the papers it is on, or only those still to mark', () => {
  const papers = [
    { name: 'A', answers: [{ questionId: 1, answered: true, marks: null, maxMarks: 4 }] },
    { name: 'B', answers: [{ questionId: 1, answered: true, marks: 3, maxMarks: 4 }] },
    { name: 'C', answers: [{ questionId: 2, answered: true, marks: 1, maxMarks: 1 }] }
  ];
  assert.deepEqual(papersWith(papers, 1).map((paper) => paper.name), ['A', 'B']);
  assert.deepEqual(papersWith(papers, 1, true).map((paper) => paper.name), ['A']);
  assert.equal(initialsOf('Guest: Asha Singh'), 'AS');
});

test('a choice answer is right with exactly the right options; the automatic mark is all or none', () => {
  const question = { type: 'msq', correctOptions: ['0', '2'], marks: 3 };
  assert.equal(isRightChoice(question, { selectedOptions: ['2', '0'] }), true);
  assert.equal(isRightChoice(question, { selectedOptions: ['0'] }), false);
  assert.equal(isRightChoice(question, { selectedOptions: ['0', '1', '2'] }), false);
  assert.equal(automaticMarks({}, question, { selectedOptions: ['0', '2'] }), 3);
  assert.equal(automaticMarks({}, question, { selectedOptions: [] }), 0);
  assert.equal(automaticMarks({}, { type: 'msq', manualGrading: true }, {}), null, 'a short answer has none');
});

test('an unscoped review preserves the normal class data and its identity', () => {
  const data = { test: { code: 'TEST' }, papers: [{ registrationId: 'a', answers: [] }], questions: [{ id: 'q1' }] };
  assert.equal(reviewForRegistration(data), data);
  assert.equal(reviewForRegistration(data, null), data);
  assert.equal(reviewForRegistration(data, undefined), data);
  assert.equal(reviewForRegistration(null, 'a'), null);
});

test('a scoped review retains only the clicked paper and its question navigation without mutation', () => {
  const data = {
    test: { code: 'TEST', frozen: true },
    questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
    papers: [
      { registrationId: 'a', answers: [{ questionId: 'q1', answered: true, marks: null, maxMarks: 2 }] },
      { registrationId: 'b', answers: [{ questionId: 'q2', answered: true, marks: null, maxMarks: 2 }, { questionId: 'q3', answered: true, marks: 2, maxMarks: 2 }] }
    ]
  };
  const before = structuredClone(data);
  const scoped = reviewForRegistration(data, 'b');
  assert.deepEqual(scoped.papers.map((paper) => paper.registrationId), ['b']);
  assert.deepEqual(scoped.questions.map((question) => question.id), ['q2', 'q3']);
  assert.deepEqual(papersWith(scoped.papers, 'q2', true).map((paper) => paper.registrationId), ['b']);
  assert.deepEqual(papersWith(scoped.papers, 'q1'), []);
  assert.equal(scoped.test, data.test);
  assert.equal(scoped.papers[0], data.papers[1]);
  assert.deepEqual(data, before);
});

test('review scope compares numeric/string registration IDs and a legacy id field, including zero', () => {
  const data = {
    papers: [{ registrationId: 12, answers: [{ questionId: 4 }] }, { id: 0, answers: [{ questionId: 5 }] }],
    questions: [{ id: '4' }, { id: '5' }]
  };
  assert.equal(reviewForRegistration(data, '12').papers[0], data.papers[0]);
  assert.equal(reviewForRegistration(data, 0).papers[0], data.papers[1]);
  assert.deepEqual(reviewForRegistration(data, 0).questions, [{ id: '5' }]);
});

test('a missing or empty scoped review fails closed instead of opening the first other student', () => {
  const data = { papers: [{ registrationId: 'a', answers: [{ questionId: 'q1' }] }], questions: [{ id: 'q1' }] };
  for (const id of ['missing', '', '   ']) {
    const scoped = reviewForRegistration(data, id);
    assert.deepEqual(scoped.papers, []);
    assert.deepEqual(scoped.questions, []);
  }
});

test('a canonical review registration wins over another paper legacy alias and still scopes to one paper', () => {
  const data = {
    papers: [{ registrationId: 'other', id: 'wanted', answers: [{ questionId: 'q1' }] }, { registrationId: 'wanted', id: 'legacy', answers: [{ questionId: 'q2' }] }],
    questions: [{ id: 'q1' }, { id: 'q2' }]
  };
  assert.deepEqual(reviewForRegistration(data, 'wanted').papers, [data.papers[1]]);
  assert.deepEqual(reviewForRegistration(data, 'wanted').questions, [{ id: 'q2' }]);
});
