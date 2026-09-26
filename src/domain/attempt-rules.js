import { dateMs } from '../lib/time.js';

/**
 * Start and end policy
 * --------------------
 * A test STARTS in one of two ways (`startMode`):
 *   manual     - when the admin presses Start.
 *   scheduled  - by itself at `opensAt` (the admin may still start it early).
 *
 * It ENDS in one of three ways (`endMode`):
 *   manual     - when the admin presses Close. No clock for students.
 *   at         - at the wall-clock time `endsAt`.
 *   duration   - `durationMinutes` after it actually starts; `endsAt` is
 *                written at that moment, so from then on it behaves like `at`.
 *
 * `endsAt` is the one deadline for everybody, however late they began. The
 * admin can move it while the test runs. When it passes, answers stop being
 * accepted and every paper is submitted: the student's own page submits at
 * zero, and the scheduler closes the test once END_GRACE_MS has passed - the
 * grace lets answers still queued on a weak connection arrive first.
 */

export const START_MODES = ['manual', 'scheduled'];
export const END_MODES = ['manual', 'at', 'duration'];

/** Answers already on their way when time runs out get this long to arrive. */
export const END_GRACE_MS = 90_000;

/** Tests saved before start modes existed were started by hand. */
export const startModeOf = (test) => (test?.startMode === 'scheduled' ? 'scheduled' : 'manual');

/** Tests saved before end modes existed: untimed ones are closed by hand, the rest end at `endsAt`. */
export const endModeOf = (test) => (END_MODES.includes(test?.endMode) ? test.endMode : test?.untimed === true ? 'manual' : 'at');

/** No clock at all: the admin's Close ends it. */
export const isUntimed = (test) => endModeOf(test) === 'manual';

/**
 * The deadline every attempt on this test shares. A duration test that has
 * not started yet has no deadline until it does.
 */
export function testDeadlineMs(test) {
  if (isUntimed(test)) return Infinity;
  const end = test.endsAt ?? test.closesAt;
  return end ? dateMs(end) : Infinity;
}

export const isTimeOver = (test, atMs = Date.now()) => atMs >= testDeadlineMs(test);

/** Answers are taken until the deadline, plus the grace for ones already sent. */
export const acceptsAnswers = (test, atMs = Date.now()) => atMs < testDeadlineMs(test) + END_GRACE_MS;

/**
 * One student's own deadline: the test's, plus every minute their teacher
 * had them paused - including a pause still going on, so a paused student's
 * time does not run.
 */
export function attemptDeadlineMs(test, attempt, atMs = Date.now()) {
  const shared = testDeadlineMs(test);
  if (!Number.isFinite(shared)) return shared;
  const pausing = attempt?.pausedAt ? Math.max(0, atMs - dateMs(attempt.pausedAt)) : 0;
  return shared + (Number(attempt?.extraMs) || 0) + pausing;
}

export const isAttemptTimeOver = (test, attempt, atMs = Date.now()) => atMs >= attemptDeadlineMs(test, attempt, atMs);
export const acceptsAttemptAnswers = (test, attempt, atMs = Date.now()) => atMs < attemptDeadlineMs(test, attempt, atMs) + END_GRACE_MS;

/** A scheduled test whose start time has come, but which has not been started yet. */
export const isStartDue = (test, atMs = Date.now()) => startModeOf(test) === 'scheduled'
  && !test.isStarted && !test.isClosed && Boolean(test.opensAt) && dateMs(test.opensAt) <= atMs;

export const isAnswered = (answer) => Boolean(answer?.answeredAt);

/** The message a student sees when an answer arrives after the test time. */
export const TIME_OVER_MESSAGE = 'The test time is over, so answers can no longer be changed. Your paper is submitted automatically.';
