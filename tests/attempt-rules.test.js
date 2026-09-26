import assert from 'node:assert/strict';
import test from 'node:test';
import {
  END_GRACE_MS, acceptsAnswers, endModeOf, isStartDue, isTimeOver, isUntimed, startModeOf, testDeadlineMs
} from '../src/domain/attempt-rules.js';
import { attemptView } from '../src/domain/presenters.js';
import { buildSchedule } from '../src/domain/test-builder.js';
import { PublicTestError } from '../src/lib/errors.js';

const deadline = Date.parse('2026-09-20T10:30:00.000Z');
const beforeDeadline = deadline - 60_000;
const afterDeadline = deadline + 60_000;

const answered = { questionId: 1, selectedOptions: ['0'], answerText: '', answeredAt: new Date(beforeDeadline) };
const blank = { questionId: 2, selectedOptions: [], answerText: '', answeredAt: null };
const attempt = {
  id: 'attempt-1',
  status: 'in_progress',
  startedAt: new Date(deadline - 600_000),
  submittedAt: null,
  isLocked: false,
  questions: [
    { questionIndex: 0, questionId: 1, optionOrder: ['0', '1'] },
    { questionIndex: 1, questionId: 2, optionOrder: ['0', '1'] }
  ],
  answers: [answered, blank]
};
const quiz = {
  code: 'TEST-ABCDE',
  title: 'Data Structures',
  endsAt: new Date(deadline),
  questionCount: 2,
  questions: [
    { id: 1, type: 'mcq', prompt: 'Which structure is FIFO?', options: ['Stack', 'Queue'], correctOptions: ['1'] },
    { id: 2, type: 'mcq', prompt: 'Which structure is LIFO?', options: ['Stack', 'Queue'], correctOptions: ['0'] }
  ]
};

/* ------------------------------------------------------------- the deadline */

test('the end time is the instant time is over', () => {
  assert.equal(isTimeOver(quiz, deadline - 1), false);
  assert.equal(isTimeOver(quiz, deadline), true);
});

test('answers are accepted until the end time plus the grace, then refused', () => {
  assert.equal(acceptsAnswers(quiz, beforeDeadline), true);
  assert.equal(acceptsAnswers(quiz, deadline + END_GRACE_MS - 1), true);
  assert.equal(acceptsAnswers(quiz, deadline + END_GRACE_MS), false);
});

test('once time is over every question on the paper is locked, answered or not', () => {
  const open = attemptView(quiz, attempt, beforeDeadline);
  assert.equal(open.timeOver, false);
  assert.deepEqual(open.questions.map((question) => question.locked), [false, false]);
  const over = attemptView(quiz, attempt, afterDeadline);
  assert.equal(over.timeOver, true);
  assert.deepEqual(over.questions.map((question) => question.locked), [true, true]);
});

test('extending the end time reopens the paper', () => {
  const extended = { ...quiz, endsAt: new Date(afterDeadline + 60_000) };
  assert.equal(attemptView(extended, attempt, afterDeadline).timeOver, false);
  assert.equal(acceptsAnswers(extended, afterDeadline), true);
});

test('the deadline is the test end time, no matter when the student started', () => {
  const lateStarter = { ...attempt, startedAt: new Date(deadline - 30_000) };
  assert.equal(attemptView(quiz, lateStarter, beforeDeadline).deadlineAt, new Date(deadline).toISOString());
});

test('a test stored before end times had a name still reads its deadline', () => {
  const legacy = { ...quiz, endsAt: undefined, closesAt: new Date(deadline) };
  assert.equal(isTimeOver(legacy, beforeDeadline), false);
  assert.equal(isTimeOver(legacy, afterDeadline), true);
});

test('a submitted or locked attempt never returns question text', () => {
  assert.equal(attemptView(quiz, { ...attempt, status: 'submitted' }, afterDeadline).questions, undefined);
  assert.equal(attemptView(quiz, { ...attempt, isLocked: true }, beforeDeadline).questions, undefined);
});

/* ---------------------------------------------------------- start and end modes */

test('tests saved before the modes existed keep their behaviour', () => {
  assert.equal(startModeOf(quiz), 'manual');
  assert.equal(endModeOf(quiz), 'at');
  assert.equal(endModeOf({ untimed: true }), 'manual');
  assert.equal(isUntimed({ untimed: true }), true);
});

test('a test the admin closes, or a duration not yet started, has no deadline', () => {
  assert.equal(testDeadlineMs({ endMode: 'manual', endsAt: new Date(deadline) }), Infinity);
  assert.equal(testDeadlineMs({ endMode: 'duration', endsAt: null, durationMinutes: 30 }), Infinity);
  assert.equal(isTimeOver({ endMode: 'duration', endsAt: null }, afterDeadline), false);
});

test('a scheduled test is due at its start time, and only once', () => {
  const scheduled = { startMode: 'scheduled', opensAt: new Date(deadline), isStarted: false, isClosed: false };
  assert.equal(isStartDue(scheduled, deadline - 1), false);
  assert.equal(isStartDue(scheduled, deadline), true);
  assert.equal(isStartDue({ ...scheduled, isStarted: true }, afterDeadline), false);
  assert.equal(isStartDue({ ...scheduled, startMode: 'manual' }, afterDeadline), false);
});

test('buildSchedule: every start mode goes with every end mode', () => {
  const opensAt = new Date(deadline).toISOString();
  const endsAt = new Date(deadline + 3_600_000).toISOString();
  const cases = [
    [{ startMode: 'manual', endMode: 'manual' }, { endsAtMs: null }],
    [{ startMode: 'manual', endMode: 'at', endsAt }, { endsAtMs: Date.parse(endsAt) }],
    [{ startMode: 'manual', endMode: 'duration', durationMinutes: 45 }, { endsAtMs: null, durationMinutes: 45 }],
    [{ startMode: 'scheduled', opensAt, endMode: 'manual' }, { opensAtMs: deadline, endsAtMs: null }],
    [{ startMode: 'scheduled', opensAt, endMode: 'at', endsAt }, { opensAtMs: deadline, endsAtMs: Date.parse(endsAt) }],
    [{ startMode: 'scheduled', opensAt, endMode: 'duration', durationMinutes: 45 }, { opensAtMs: deadline, endsAtMs: deadline + 45 * 60_000 }]
  ];
  for (const [raw, expected] of cases) {
    const schedule = buildSchedule(raw, 600);
    assert.equal(schedule.startMode, raw.startMode);
    assert.equal(schedule.endMode, raw.endMode);
    for (const [key, value] of Object.entries(expected)) assert.equal(schedule[key], value, `${raw.startMode}/${raw.endMode} ${key}`);
  }
});

test('buildSchedule refuses a scheduled start without a time, a bad duration, and an end before the start', () => {
  assert.throws(() => buildSchedule({ startMode: 'scheduled', endMode: 'manual' }, 600), PublicTestError);
  assert.throws(() => buildSchedule({ endMode: 'duration', durationMinutes: 0 }, 600), PublicTestError);
  assert.throws(() => buildSchedule({ endMode: 'duration', durationMinutes: 24 * 60 + 1 }, 600), PublicTestError);
  assert.throws(() => buildSchedule({
    startMode: 'scheduled', opensAt: new Date(deadline).toISOString(), endMode: 'at', endsAt: new Date(deadline - 1).toISOString()
  }, 600), PublicTestError);
});

test('buildSchedule reads an older payload as a manual start that ends at endsAt', () => {
  const schedule = buildSchedule({ opensAt: new Date(deadline).toISOString(), endsAt: new Date(afterDeadline).toISOString() }, 600);
  assert.equal(schedule.startMode, 'manual');
  assert.equal(schedule.endMode, 'at');
  assert.equal(schedule.endsAtMs, afterDeadline);
  assert.equal(buildSchedule({ untimed: true }, 600).endMode, 'manual');
});
