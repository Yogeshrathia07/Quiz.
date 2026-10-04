import assert from 'node:assert/strict';
import test from 'node:test';
import { lateAnswerDeadline, lateAnswerRecord, wasOfflineAt } from '../src/domain/late-answers.js';
import { STRICT_GRACE_MS } from '../src/domain/strict-timing.js';

const t0 = Date.parse('2026-10-04T09:00:00.000Z');
const LATE = 30 * 60_000;
const timed = { code: 'TEST-LATE1', endMode: 'at', endsAt: new Date(t0 + 30 * 60_000), questions: [{ id: 1, type: 'mcq', options: ['a', 'b'] }] };
const end = t0 + 30 * 60_000;
const paper = (extra = {}) => ({
  id: 'p1', status: 'in_progress', startedAt: new Date(t0),
  questions: [{ questionIndex: 0, questionId: 1, optionOrder: ['0', '1'] }],
  answers: [{ questionId: 1, selectedOptions: [], answerText: '', answeredAt: null, isCorrect: null }],
  ...extra
});

test('a paper handed in by the clock or the Close still takes an answer held offline, for a while', () => {
  const byClock = paper({ status: 'submitted', submittedBy: 'time', submittedAt: new Date(end + 90_000) });
  assert.equal(lateAnswerDeadline(timed, byClock, 1, end + 5 * 60_000, LATE), end, 'the end, not when the server got round to handing it in');
  assert.equal(lateAnswerDeadline(timed, byClock, 1, end + LATE + 1, LATE), null, 'past LATE_ANSWER_MINUTES: refused as before');
  const byClose = paper({ status: 'submitted', submittedBy: 'admin', submittedAt: new Date(end - 10 * 60_000) });
  assert.equal(lateAnswerDeadline(timed, byClose, 1, end - 5 * 60_000, LATE), end - 10 * 60_000, 'the Close is the end');
});

test('a paper the student or the teacher handed in on purpose takes nothing late', () => {
  for (const submittedBy of ['student', 'teacher']) {
    const handed = paper({ status: 'submitted', submittedBy, submittedAt: new Date(end - 60_000) });
    assert.equal(lateAnswerDeadline(timed, handed, 1, end, LATE), null, submittedBy);
  }
  assert.equal(lateAnswerDeadline(timed, paper(), 1, end + 60_000, 0), null, 'LATE_ANSWER_MINUTES=0 turns it off');
});

test('strict timing: only a question closed by its clock, or still open at the end, takes a late answer', () => {
  const strict = { ...timed, strictTiming: true, endMode: 'manual', endsAt: null, typeSeconds: { mcq: 30 } };
  const closedByClock = paper({ strict: { index: 1, shownAt: new Date(t0 + 40_000), log: [{ questionId: 1, shownAt: new Date(t0), closedAt: new Date(t0 + 30_000), how: 'time' }] } });
  assert.equal(lateAnswerDeadline(strict, closedByClock, 1, t0 + 120_000, LATE), t0 + 30_000 + STRICT_GRACE_MS);
  const movedOn = paper({ strict: { index: 1, shownAt: new Date(t0 + 20_000), log: [{ questionId: 1, shownAt: new Date(t0), closedAt: new Date(t0 + 20_000), how: 'next' }] } });
  assert.equal(lateAnswerDeadline(strict, movedOn, 1, t0 + 120_000, LATE), null, 'moved on with Next: its answer went with the move');
  const notReached = paper({
    questions: [{ questionIndex: 0, questionId: 1, optionOrder: ['0', '1'] }, { questionIndex: 1, questionId: 2, optionOrder: ['0', '1'] }],
    strict: { index: 0, shownAt: new Date(t0), log: [] }
  });
  assert.equal(lateAnswerDeadline({ ...strict, questions: [...strict.questions, { id: 2, type: 'mcq', options: ['a', 'b'] }] }, notReached, 2, t0 + 60_000, LATE), null, 'never one not reached');
});

test('the server must have been out of touch with the paper at the deadline', () => {
  assert.equal(wasOfflineAt(end, end - 40_000, []), true, 'not heard from since before the end');
  assert.equal(wasOfflineAt(end, end + 20_000, []), false, 'heard from after the end: it was online, so not held by the connection');
  const noted = [{ type: 'connection_lost', createdAt: new Date(end - 50_000), durationMs: 5 * 60_000 }];
  assert.equal(wasOfflineAt(end, end + 4 * 60_000, noted), true, 'an offline period noted across the end (a second answer after the first checked in)');
  assert.equal(wasOfflineAt(end, end + 4 * 60_000, [{ type: 'connection_lost', createdAt: new Date(end - 10 * 60_000), durationMs: 60_000 }]), false);
});

test('the record: made before the deadline by the device, which was offline across it', () => {
  const base = { deadlineMs: end, startedMs: t0, lastSeenMs: end - 60_000, events: [], atMs: end + 3 * 60_000 };
  const record = lateAnswerRecord({ ...base, madeAtMs: end - 20_000 });
  assert.equal(record.madeAt.getTime(), end - 20_000);
  assert.equal(record.arrivedAt.getTime(), end + 3 * 60_000);
  assert.equal(lateAnswerRecord({ ...base, madeAtMs: end + 1_000 }), null, 'made after its time ran out');
  assert.equal(lateAnswerRecord({ ...base, madeAtMs: t0 - 5 * 60_000 }), null, 'made before the paper began: not a real time');
  assert.equal(lateAnswerRecord({ ...base, madeAtMs: end - 20_000, lastSeenMs: end + 30_000 }), null, 'online after the end: not held by the connection');
  assert.equal(lateAnswerRecord({ ...base, madeAtMs: Number.NaN }), null, 'no time given: an old page');
});
