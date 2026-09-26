import { tests } from '../db/index.js';
import { now } from '../lib/time.js';
import { endModeOf, isStartDue } from '../domain/attempt-rules.js';
import { invalidateTestCache, serializeTestWrite } from '../data/test-repository.js';

/**
 * The end time a test that has not started yet is planned to have: a fixed
 * end time stays; a duration counts from the scheduled start, or from the
 * moment the admin presses Start when there is none.
 */
export function plannedEndsAt(test) {
  const mode = endModeOf(test);
  if (mode === 'manual') return null;
  if (mode === 'duration') {
    return test.startMode === 'scheduled' && test.opensAt
      ? new Date(new Date(test.opensAt).getTime() + test.durationMinutes * 60_000)
      : null;
  }
  return test.endsAt ?? test.closesAt ?? null;
}

/**
 * Starts a test, once - the admin's Start, a scheduled start, or a student's
 * page arriving just as the countdown ends all go through here, and only the
 * first one lands. A duration test's end time is fixed now, from the real
 * start, so starting late never costs anyone time.
 */
export async function beginTest(test) {
  const startedAt = now();
  const set = { isStarted: true, startedAt };
  if (endModeOf(test) === 'duration') {
    set.endsAt = new Date(startedAt.getTime() + test.durationMinutes * 60_000);
    set.windowSeconds = test.durationMinutes * 60;
  }
  const result = await serializeTestWrite(test.code, () => tests().updateOne(
    { code: test.code, isStarted: { $ne: true }, isClosed: { $ne: true } },
    { $set: set }
  ));
  if (result.modifiedCount) await invalidateTestCache(test.code);
  return result.modifiedCount === 1;
}

/**
 * The scheduler checks every few seconds, but a student's countdown can reach
 * zero between two checks. Pages that could be waiting on a scheduled start
 * call this, so pressing Begin at 00:00 never finds the test "not started".
 * Returns whether it started the test just now.
 */
export async function startIfDue(test) {
  if (!isStartDue(test)) return false;
  await beginTest(test);
  return true;
}
