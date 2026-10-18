import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRICT_GRACE_MS, firstOpen, hasQuestionTimers, nextOpenAfter, openBefore, openQuestionEndsAt, reachedOf, resolveStrict, strictProgress
} from '../src/domain/strict-timing.js';
import { attemptView } from '../src/domain/presenters.js';
import { lateAnswerDeadline } from '../src/domain/late-answers.js';
import { buildTest } from '../src/domain/test-builder.js';
import { navigationProblem } from '../src/services/test-service.js';

const t0 = Date.parse('2026-10-15T09:00:00.000Z');
const at = (seconds) => new Date(t0 + seconds * 1000);
// Four questions of 30 s each; going back allowed.
const quiz = {
  code: 'TEST-PREV1',
  title: 'Going back',
  strictTiming: true,
  strictPrevious: true,
  strictNext: true,
  endMode: 'manual',
  typeSeconds: { mcq: 30, msq: 60, short: 0 },
  questions: [1, 2, 3, 4].map((id) => ({ id, type: 'mcq', prompt: `Q${id}`, options: ['a', 'b'], correctOptions: ['0'] }))
};
const oneWay = { ...quiz, strictPrevious: false };
const paper = (strict, answered = []) => ({
  id: 'p1',
  status: 'in_progress',
  startedAt: new Date(t0),
  questions: [1, 2, 3, 4].map((questionId, questionIndex) => ({ questionIndex, questionId, optionOrder: ['0', '1'] })),
  answers: [1, 2, 3, 4].map((questionId) => ({
    questionId, selectedOptions: answered.includes(questionId) ? ['0'] : [], answerText: '',
    answeredAt: answered.includes(questionId) ? at(1) : null, isCorrect: null
  })),
  strict
});
// Q1 left with Next after 10 s (20 s left); Q2 ran out; Q3 open since 40 s - the furthest reached.
const log = [
  { questionId: 1, shownAt: at(0), closedAt: at(10), how: 'next' },
  { questionId: 2, shownAt: at(10), closedAt: at(40), how: 'time' }
];
const onQ3 = (extra = {}) => paper({ index: 2, shownAt: at(40), sentAt: null, reached: 3, log, ...extra }, [1]);

test('going back: a question left early keeps the time it did not use; one that ran out is closed', () => {
  const progress = strictProgress(quiz, onQ3());
  assert.equal(progress.isFinal(0), false, 'left with Next, 20 s still on it');
  assert.equal(progress.leftMs(0), 20_000);
  assert.equal(progress.isFinal(1), true, 'its time ran out');
  assert.equal(progress.isFinal(3), false, 'not reached yet');
  const noBack = strictProgress(oneWay, onQ3());
  assert.equal(noBack.isFinal(0), true, 'without going back, leaving a question closes it, as before');
});

test('where Next and Previous lead', () => {
  const progress = strictProgress(quiz, onQ3());
  assert.equal(openBefore(progress, 2), 0, 'Previous skips the question that ran out');
  assert.equal(nextOpenAfter(progress, 2, 3), 3, 'from the furthest, Next opens a new question');
  assert.equal(nextOpenAfter(progress, 0, 3), 2, 'from one gone back to, Next goes to the next seen one with time');
  assert.equal(nextOpenAfter(progress, 2, 4), 3);
  assert.equal(nextOpenAfter(strictProgress(quiz, onQ3()), 3, 4), null, 'nothing after the last: Next hands the paper in');
  assert.equal(openBefore(strictProgress(oneWay, onQ3()), 2), null, 'no going back on this paper');
  assert.equal(firstOpen(progress, 3), 0);
  assert.equal(reachedOf({ index: 1 }, 4), 2, 'papers from before going back existed: the open one is the furthest');
});

test('a question opened again runs out when what it had left runs out', () => {
  // Back to Q1 at 50 s: Q3 left with 20 s; Q1 has 20 s.
  const back = paper({
    index: 0, shownAt: at(50), sentAt: null, reached: 3,
    log: [...log, { questionId: 3, shownAt: at(40), closedAt: at(50), how: 'back' }]
  }, [1]);
  assert.equal(openQuestionEndsAt(quiz, back, t0 + 55_000).getTime(), t0 + 70_000);
  assert.equal(resolveStrict(quiz, back, t0 + 70_000).index, 0, 'still open within the grace');
  const moved = resolveStrict(quiz, back, t0 + 70_000 + STRICT_GRACE_MS);
  assert.equal(moved.closed[0].how, 'time');
  assert.equal(moved.closed[0].closedAt.getTime(), t0 + 70_000);
  assert.equal(moved.index, 2, 'on to the next question with time - Q3, where the student was - not a new one');
  assert.equal(moved.reached, 3);
  assert.equal(strictProgress(quiz, { ...back, strict: { ...back.strict, log: [...back.strict.log, ...moved.closed] } }).isFinal(0), true, 'Q1 is used up now');
});

test('the last question running out goes back to one with time where students may go back; otherwise the paper is done', () => {
  const last = (test) => resolveStrict(test, paper({
    index: 3, shownAt: at(40), sentAt: null, reached: 4,
    log: [log[0], log[1], { questionId: 3, shownAt: at(10), closedAt: at(40), how: 'time' }]
  }), t0 + 70_000 + STRICT_GRACE_MS);
  assert.equal(last(quiz).index, 0, 'Q1 still had 20 s');
  assert.equal(last(quiz).done, false);
  assert.equal(last(oneWay).done, true, 'one way only: the paper is handed in');
});

test('the student sees each question opened so far as answered or not, and which can open again', () => {
  const view = attemptView(quiz, onQ3(), t0 + 45_000);
  assert.deepEqual(view.strict.track, [
    { answered: true, final: false, timedOut: false },
    { answered: false, final: true, timedOut: true },
    { answered: false, final: false, timedOut: false }
  ]);
  assert.equal(view.strict.reached, 3);
  assert.equal(view.strict.backTo, 0);
  assert.equal(view.strict.forwardTo, 3);
  assert.equal(view.strict.previous, true);
  assert.equal(view.strict.laterSeconds, 20 + 30, 'Q1\'s 20 s left and Q4\'s 30 s');
  assert.equal(JSON.stringify(view).includes('Q4'), false, 'questions not reached are still never sent');
  const answeredByClock = attemptView(oneWay, paper({ index: 2, shownAt: at(40), sentAt: null, log }, [1, 2]), t0 + 45_000);
  assert.deepEqual(answeredByClock.strict.track.map((dot) => dot.answered), [true, true, false], 'an answered question is answered, however it closed');
  assert.equal(answeredByClock.strict.backTo, null);
});

test('without Next, the newest question stays for its time - one gone back to may still be left for the next', () => {
  const noNext = { ...quiz, strictNext: false };
  assert.equal(attemptView(noNext, onQ3(), t0 + 45_000).strict.canMoveOn, false, 'the furthest question');
  const back = paper({
    index: 0, shownAt: at(50), sentAt: null, reached: 3,
    log: [...log, { questionId: 3, shownAt: at(40), closedAt: at(50), how: 'back' }]
  }, [1]);
  assert.equal(attemptView(noNext, back, t0 + 52_000).strict.canMoveOn, true);
});

test('a late answer is judged by the question\'s last visit', () => {
  const late = 30 * 60_000;
  const twice = paper({
    index: 2, shownAt: at(80), sentAt: null, reached: 3,
    log: [...log, { questionId: 3, shownAt: at(40), closedAt: at(50), how: 'back' }, { questionId: 1, shownAt: at(50), closedAt: at(70), how: 'time' }]
  });
  assert.equal(lateAnswerDeadline(quiz, twice, 1, t0 + 120_000, late), t0 + 70_000 + STRICT_GRACE_MS, 'its second visit ran out at 70 s');
  assert.equal(lateAnswerDeadline(quiz, twice, 3, t0 + 85_000, late), t0 + 80_000 + 20_000 + STRICT_GRACE_MS, 'open again: until what it has left runs out');
});

test('going back is only for a one-way paper with no timer, and once a test runs it is never turned off', () => {
  const questions = [{ prompt: 'One?', type: 'mcq', options: ['a', 'b'], correctOptions: ['0'] }];
  const noTimers = { mcq: 0, msq: 0, short: 0 };
  assert.equal(buildTest({ title: 'Untimed', strictTiming: true, strictPrevious: true, typeSeconds: noTimers, questionCount: 1, questions }).strictPrevious, true);
  assert.equal(buildTest({ title: 'Clocked', strictTiming: true, strictPrevious: true, questionCount: 1, questions }).strictPrevious, false,
    'a timer on each question: forward only');
  assert.equal(buildTest({ title: 'One timed', strictTiming: true, strictPrevious: true, typeSeconds: noTimers, questionCount: 1,
    questions: [{ ...questions[0], timeSeconds: 30 }] }).strictPrevious, false, 'one question with its own timer is enough');
  assert.equal(buildTest({ title: 'Running', strictTiming: true, strictPrevious: true, questionCount: 1, questions }, { keepPrevious: true }).strictPrevious, true,
    'a running test that has it keeps it');
  assert.equal(buildTest({ title: 'Free paper', strictTiming: false, strictPrevious: true, questionCount: 1, questions }).strictPrevious, false, 'a free paper already goes back');
  assert.equal(hasQuestionTimers({ strictTiming: true, typeSeconds: noTimers, questions: [{ ...questions[0], timeSeconds: 20, retired: true }] }), false,
    'a retired question\'s timer does not count');
  assert.equal(hasQuestionTimers({ strictTiming: false, questions }), false, 'a free paper has none');
  assert.match(navigationProblem({ isStarted: true, strictPrevious: true }, { previous: false }), /cannot be turned off/);
  assert.equal(navigationProblem({ isStarted: true, strictPrevious: false }, { previous: true }), null, 'turned on mid-test');
  assert.equal(navigationProblem({ isStarted: false, strictPrevious: true }, { previous: false }), null, 'before the start, anything goes');
  assert.equal(navigationProblem({ isStarted: true, strictPrevious: true }, {}), null, 'not asked about');
});
