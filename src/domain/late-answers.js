import { dateMs } from '../lib/time.js';
import { attemptDeadlineMs } from './attempt-rules.js';
import { STRICT_GRACE_MS, isStrict, openQuestionEndsAt, strictPaper } from './strict-timing.js';

/**
 * Answers that arrive late
 * ------------------------
 * A phone that loses its connection keeps every answer on the device and
 * sends it once it is back (client/src/lib/offline-answers.js). If the time -
 * the paper's, or under strict timing the question's - ran out meanwhile, the
 * answer would normally be refused, and a student who answered in time would
 * lose it to their Wi-Fi.
 *
 * So such an answer is still taken, for a while (LATE_ANSWER_MINUTES), when
 * all of these hold:
 *  - the device says it was made before that time ran out (`madeAt`, on the
 *    server's clock as the device estimated it);
 *  - the server really had not heard from the paper across that moment - it
 *    was offline, not merely slow to send;
 *  - the paper is still open, or was handed in by the clock or the test's
 *    Close, never by the student or the teacher on purpose.
 *
 * The device's word cannot be checked, so every answer taken this way is
 * marked "arrived late" with both times, for the teacher to judge alongside
 * the offline periods in the activity log. It is a record, not a verdict.
 */

/** Handed in by the clock or the test's Close: answers held offline may still come. */
const AUTOMATIC_SUBMITS = new Set(['time', 'admin']);
/** A device's clock estimate a little ahead of the server's is not a lie. */
const MADE_AHEAD_MS = 5_000;

/**
 * When an answer to this question had to be made by, if one held back by a
 * lost connection may still be taken at `atMs`; null when it may not.
 */
export function lateAnswerDeadline(test, attempt, questionId, atMs, lateMs) {
  if (!(lateMs > 0) || !attempt) return null;
  let paperEndMs;
  if (attempt.status === 'submitted') {
    if (!AUTOMATIC_SUBMITS.has(attempt.submittedBy)) return null;
    const submittedMs = dateMs(attempt.submittedAt);
    const deadline = attemptDeadlineMs(test, attempt, submittedMs);
    paperEndMs = attempt.submittedBy === 'admin' || !Number.isFinite(deadline) ? submittedMs : Math.min(deadline, submittedMs);
  } else if (attempt.status === 'in_progress') {
    paperEndMs = attemptDeadlineMs(test, attempt, atMs);
  } else {
    return null;
  }

  let questionEndMs = Infinity;
  if (isStrict(test)) {
    const open = strictPaper(test, attempt)[attempt.strict?.index ?? 0];
    if (open && open.questionId === questionId) {
      // Still the open one (when the paper was handed in, say).
      if (!attempt.strict?.shownAt) return null;
      const endsAt = openQuestionEndsAt(test, attempt, atMs);
      if (endsAt) questionEndMs = endsAt.getTime() + STRICT_GRACE_MS;
    } else {
      // Its last visit - one, or several where the test lets students go back.
      // Left with Next or Previous: the answer went with the move, or there was
      // none. Never one not reached.
      const last = (attempt.strict?.log || []).findLast((entry) => entry.questionId === questionId);
      if (!last || last.how !== 'time') return null;
      questionEndMs = dateMs(last.closedAt) + STRICT_GRACE_MS;
    }
  }

  const deadlineMs = Math.min(paperEndMs, questionEndMs);
  if (!Number.isFinite(deadlineMs) || atMs > deadlineMs + lateMs) return null;
  return deadlineMs;
}

/**
 * Whether the server was out of touch with the paper at `deadlineMs`: it had
 * not heard from it since before then, or an offline period it noted (see
 * checkIn in attempt-service.js) spans that moment.
 */
export function wasOfflineAt(deadlineMs, lastSeenMs, events = []) {
  if (Number.isFinite(lastSeenMs) && lastSeenMs <= deadlineMs) return true;
  return events.some((event) => {
    if (event.type !== 'connection_lost') return false;
    const fromMs = dateMs(event.createdAt);
    return fromMs <= deadlineMs && fromMs + (Number(event.durationMs) || 0) >= deadlineMs;
  });
}

/**
 * The late answer's record, or null when it may not be taken: made (by the
 * device's account) between the paper's start and the deadline, and the paper
 * offline across the deadline.
 */
export function lateAnswerRecord({ deadlineMs, madeAtMs, startedMs, lastSeenMs, events, atMs }) {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(madeAtMs)) return null;
  if (madeAtMs > deadlineMs || madeAtMs > atMs + MADE_AHEAD_MS) return null;
  if (Number.isFinite(startedMs) && madeAtMs < startedMs - 60_000) return null;
  if (!wasOfflineAt(deadlineMs, lastSeenMs, events)) return null;
  return { madeAt: new Date(madeAtMs), arrivedAt: new Date(atMs), deadline: new Date(deadlineMs) };
}
