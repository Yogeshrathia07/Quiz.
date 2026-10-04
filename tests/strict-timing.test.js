import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TYPE_SECONDS, STRICT_GRACE_MS, acknowledgeShown, buildTypeSeconds, clockStartOnShown, openQuestionEndsAt, questionSeconds, resolveStrict,
  strictEstimateSeconds
} from '../src/domain/strict-timing.js';
import { attemptView } from '../src/domain/presenters.js';
import { buildTest } from '../src/domain/test-builder.js';
import { PublicTestError } from '../src/lib/errors.js';

const t0 = Date.parse('2026-09-20T10:00:00.000Z');
const quiz = {
  code: 'TEST-STRCT',
  title: 'Strict',
  strictTiming: true,
  endMode: 'manual',
  typeSeconds: { mcq: 30, msq: 60, short: 0 },
  questions: [
    { id: 1, type: 'mcq', prompt: 'One', options: ['a', 'b'], correctOptions: ['0'] },
    { id: 2, type: 'mcq', prompt: 'Two', options: ['a', 'b'], correctOptions: ['1'], timeSeconds: 90 },
    { id: 3, type: 'msq', prompt: 'Three', options: ['a', 'b'], correctOptions: ['0'], manualGrading: true }
  ]
};
const attemptAt = (index, shownAt) => ({
  id: 'a1',
  status: 'in_progress',
  startedAt: new Date(t0),
  questions: [1, 2, 3].map((questionId, questionIndex) => ({ questionIndex, questionId, optionOrder: ['0', '1'] })),
  answers: [1, 2, 3].map((questionId) => ({ questionId, selectedOptions: [], answerText: '', answeredAt: null, isCorrect: null })),
  strict: { index, shownAt: shownAt === null ? null : new Date(shownAt), log: [] }
});

test('a question takes its own time, else its type default; 0 means no limit', () => {
  assert.equal(questionSeconds(quiz, quiz.questions[0]), 30, 'type default');
  assert.equal(questionSeconds(quiz, quiz.questions[1]), 90, 'its own time wins');
  assert.equal(questionSeconds(quiz, quiz.questions[2]), 0, 'short answers have no limit here');
  assert.equal(questionSeconds({ ...quiz, typeSeconds: undefined }, quiz.questions[0]), DEFAULT_TYPE_SECONDS.mcq);
});

test('the open question stays open until its time and the grace have passed', () => {
  const attempt = attemptAt(0, t0);
  assert.equal(resolveStrict(quiz, attempt, t0 + 30_000).index, 0, 'at zero, answers in flight still count');
  const moved = resolveStrict(quiz, attempt, t0 + 30_000 + STRICT_GRACE_MS);
  assert.equal(moved.index, 1);
  assert.equal(moved.closed[0].how, 'time');
  assert.equal(moved.closed[0].closedAt.getTime(), t0 + 30_000, 'closed at its real end, not when noticed');
  assert.equal(moved.shownAt.getTime(), t0 + 30_000 + STRICT_GRACE_MS, 'the next clock starts when it is shown');
});

test('a dropped connection costs the open question only, never the ones after it', () => {
  const moved = resolveStrict(quiz, attemptAt(0, t0), t0 + 10 * 60_000);
  assert.equal(moved.index, 1, 'only one question closes, however long they were gone');
  assert.equal(moved.shownAt.getTime(), t0 + 10 * 60_000);
});

test('a question with no limit waits for the student', () => {
  const moved = resolveStrict(quiz, attemptAt(2, t0), t0 + 60 * 60_000);
  assert.equal(moved.index, 2);
  assert.equal(moved.changed, false);
  assert.equal(openQuestionEndsAt(quiz, attemptAt(2, t0)), null);
});

test('the student sees only the open question, with its own deadline', () => {
  const view = attemptView(quiz, attemptAt(1, t0), t0 + 1_000);
  assert.equal(view.questions.length, 1);
  assert.equal(view.questions[0].id, 2);
  assert.equal(view.questions[0].prompt, 'Two');
  assert.equal(view.strict.index, 1);
  assert.equal(view.strict.total, 3);
  assert.equal(view.strict.questionEndsAt, new Date(t0 + 90_000).toISOString());
  assert.equal(JSON.stringify(view).includes('Three'), false, 'questions ahead are never sent');
});

test('a question opened by the server is sent now, and its clock waits for the device', () => {
  const moved = resolveStrict(quiz, attemptAt(0, t0), t0 + 30_000 + STRICT_GRACE_MS);
  assert.equal(moved.sentAt.getTime(), moved.shownAt.getTime(), 'sent when it opened; its clock runs from then until the device says otherwise');
  const kept = resolveStrict(quiz, { ...attemptAt(1, t0), strict: { index: 1, shownAt: new Date(t0), sentAt: null, log: [] } }, t0 + 5_000);
  assert.equal(kept.sentAt, null, 'nothing new opened: nothing waits');
});

test('the clock starts when the device shows the question, but never more than the grace after it was sent', () => {
  const grace = 10_000;
  assert.equal(clockStartOnShown(t0, t0, t0 + 1_200, grace), t0 + 1_200, 'a quick device: from when it was shown');
  assert.equal(clockStartOnShown(t0, t0, t0 + 30_000, grace), t0 + grace, 'a reply stuck for 30 s: 10 s given back, no more');
  assert.equal(clockStartOnShown(t0, t0 + 20_000, t0 + 30_000, grace), null, 'never earlier than it already starts: this only gives time back');
  assert.equal(clockStartOnShown(t0, t0, t0 + 30_000, 0), null, 'a grace of 0 turns it off');
});

test('saying a question is on screen moves its clock once, and a pause never adds to the grace', () => {
  const grace = 10_000;
  const state = { index: 0, shownAt: new Date(t0), sentAt: new Date(t0), log: [] };
  const shown = acknowledgeShown(state, t0 + 4_000, grace);
  assert.equal(shown.shownAt.getTime(), t0 + 4_000);
  assert.equal(shown.sentAt, null, 'answered once: a second one finds nothing waiting');
  assert.equal(acknowledgeShown({ ...state, ...shown }, t0 + 6_000, grace), null);
  // Away for 6 s right after it was sent: that time is already given back by the pause.
  const paused = { ...state, pausedSince: new Date(t0) };
  const afterPause = acknowledgeShown(paused, t0 + 30_000, grace);
  assert.equal(afterPause.shownAt.getTime(), t0, 'the pause already moved its start past the grace: nothing more');
  // The question's time then runs from the new start.
  const attempt = { ...attemptAt(0, t0), strict: { ...state, ...shown } };
  assert.equal(openQuestionEndsAt(quiz, attempt, t0 + 5_000).getTime(), t0 + 4_000 + 30_000);
});

test('the paper asks the device to say it is on screen only within the grace', () => {
  const attempt = { ...attemptAt(1, t0), strict: { index: 1, shownAt: new Date(t0), sentAt: new Date(t0), log: [] } };
  assert.equal(attemptView(quiz, attempt, t0 + 2_000).strict.shownPending, true);
  assert.equal(attemptView(quiz, attempt, t0 + 60_000).strict.shownPending, false, 'too late to move the clock: not asked');
  assert.equal(attemptView(quiz, { ...attempt, strict: { ...attempt.strict, sentAt: null } }, t0 + 2_000).strict.shownPending, false);
});

test('buildTest: strict timing forces one question at a time and prices the paper by its times', () => {
  const built = buildTest({
    title: 'Strict build', strictTiming: true, questionLayout: 'all', typeSeconds: { mcq: 45, msq: 60, short: 120 },
    questionMix: { mcq: 2, msq: 0, short: 0 },
    questions: [
      { prompt: 'One?', type: 'mcq', options: ['a', 'b'], correctOptions: ['0'] },
      { prompt: 'Two?', type: 'mcq', options: ['a', 'b'], correctOptions: ['0'], timeSeconds: 100 },
      { prompt: 'Three?', type: 'mcq', options: ['a', 'b'], correctOptions: ['0'], timeSeconds: 0 }
    ]
  });
  assert.equal(built.questionLayout, 'one');
  assert.deepEqual(built.typeSeconds, { mcq: 45, msq: 60, short: 120 });
  assert.equal(built.questions[1].timeSeconds, 100);
  assert.equal(built.questions[2].timeSeconds, 0);
  // The two longest MCQs a student could draw: 100s and 60s (no limit counts at its 60s estimate).
  assert.equal(built.estimatedSeconds, 160);
});

test('question times must be between 0 and an hour', () => {
  assert.throws(() => buildTypeSeconds({ mcq: -1 }), PublicTestError);
  assert.throws(() => buildTypeSeconds({ mcq: 3601 }), PublicTestError);
  assert.deepEqual(buildTypeSeconds({}), DEFAULT_TYPE_SECONDS);
  assert.equal(strictEstimateSeconds(quiz, null, {}), null);
});

test('one way only with no timer anywhere is told apart from one with timers', async () => {
  const { publicTest } = await import('../src/domain/presenters.js');
  const questions = [{ id: 1, type: 'mcq', prompt: 'Q', options: ['a', 'b'], correctOptions: ['0'] }];
  const untimed = { code: 'TEST-ONEWAY', title: 'One way', strictTiming: true, typeSeconds: { mcq: 0, msq: 0, short: 0 }, questions };
  assert.equal(publicTest(untimed).strictTimed, false, 'no Previous, and no timers');
  assert.equal(publicTest({ ...untimed, questions: [{ ...questions[0], timeSeconds: 30 }] }).strictTimed, true, 'a question with its own time');
  assert.equal(publicTest({ ...untimed, typeSeconds: { mcq: 60, msq: 0, short: 0 } }).strictTimed, true, 'a type with a time');
  assert.equal(publicTest({ ...untimed, strictTiming: false }).strictTimed, false, 'free movement has no timers');
});

test('the form says whether all, some or none of the questions a paper can draw have a timer', async () => {
  const { timerCoverage } = await import('../client/src/lib/quiz.js');
  const questions = [{ type: 'mcq' }, { type: 'mcq', timeSeconds: 0 }, { type: 'short' }];
  const noTimers = { mcq: 0, msq: 0, short: 0 };
  assert.equal(timerCoverage(questions, { mcq: 2, short: 1 }, noTimers), 'none');
  assert.equal(timerCoverage(questions, { mcq: 2, short: 1 }, { ...noTimers, short: 120 }), 'some');
  assert.equal(timerCoverage(questions, { mcq: 2 }, { ...noTimers, mcq: 60 }), 'some', 'one MCQ has no limit of its own');
  assert.equal(timerCoverage(questions, { short: 1 }, { ...noTimers, short: 120 }), 'all', 'only short answers are drawn');
  assert.equal(timerCoverage(questions, {}, { mcq: 60, msq: 60, short: 120 }), 'none', 'nothing drawn');
});

test('a one-way paper has question timers when any type, or any question of its own, has a time', async () => {
  const { hasQuestionTimers, NO_TYPE_SECONDS } = await import('../client/src/lib/quiz.js');
  assert.equal(hasQuestionTimers(NO_TYPE_SECONDS, [{ type: 'mcq' }, { type: 'mcq', timeSeconds: 0 }]), false);
  assert.equal(hasQuestionTimers({ ...NO_TYPE_SECONDS, short: 120 }, []), true);
  assert.equal(hasQuestionTimers(NO_TYPE_SECONDS, [{ type: 'mcq', timeSeconds: 45 }]), true, 'one question with its own time');
  assert.equal(hasQuestionTimers(undefined), false);
});
