import assert from 'node:assert/strict';
import test from 'node:test';
import { answerState, initialsOf, papersWith } from '../client/src/screens/admin/review.js';
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
