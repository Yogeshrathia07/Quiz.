import { config } from '../config.js';
import { registrations, serverState, tests } from '../db/index.js';
import { END_GRACE_MS } from '../domain/attempt-rules.js';
import { invalidateTestCache, serializeTestWrite } from '../data/test-repository.js';

/**
 * When the server itself goes down mid-test (it runs on the admin's own
 * machine), nobody can save an answer - but the clock kept going, and every
 * paper stopped checking in. Left alone, the restart would count the gap as
 * every student leaving the test, and could close a test whose time ran out
 * while nobody could write.
 *
 * So the server leaves a heartbeat every few seconds. On start - and on every
 * tick, which catches a machine that slept without restarting - the gap since
 * the last one is the outage. Every test that was running then gets that time
 * back: its end time moves later by the outage, each open strict question's
 * clock with it, and no paper is charged with leaving. A very long outage
 * (past OUTAGE_EXTEND_MAX_MINUTES) is recorded but not given back - the admin
 * decides what to do about a test interrupted for hours.
 *
 * The other kind of outage - the machine's internet down while the server
 * runs on - is found by reachability.js and given back the same way
 * (giveBackOutage).
 */

const HEARTBEAT_ID = 'heartbeat';
/** Shorter gaps are a quick restart, not an outage. */
export const MIN_OUTAGE_MS = 20_000;

// When this process last wrote its heartbeat (null until the scheduler has
// run once). A laptop that sleeps pauses the server without restarting it, so
// on waking this is far in the past.
let lastBeatMs = null;

export function recordHeartbeat(at = new Date()) {
  lastBeatMs = at.getTime();
  return serverState().updateOne({ _id: HEARTBEAT_ID }, { $set: { at } }, { upsert: true });
}

/**
 * True in the moments after the server wakes from a pause (the machine slept)
 * and before the scheduler has given the lost time back: papers checking in
 * then must not be charged with leaving for the pause.
 */
export const justWokeUp = () => lastBeatMs !== null && Date.now() - lastBeatMs > MIN_OUTAGE_MS;

/** Adds \`ms\` to a date field that may be missing or null. */
const later = (field, ms) => ({ $cond: [{ $ifNull: [field, false] }, { $add: [field, ms] }, field] });

export async function compensateForOutage(nowMs = Date.now()) {
  // Read the last heartbeat and write this one in a single step: whichever
  // check gets here first claims the outage, so it is never given back twice.
  const beat = await serverState().findOneAndUpdate(
    { _id: HEARTBEAT_ID }, { $set: { at: new Date(nowMs) } }, { upsert: true, returnDocument: 'before' }
  );
  lastBeatMs = nowMs;
  if (!beat?.at) return null;
  const downSince = new Date(beat.at);
  if (nowMs - downSince.getTime() < MIN_OUTAGE_MS) return null;
  return giveBackOutage(downSince, new Date(nowMs), 'server');
}

// The outage being given back right now, for requests to wait on (settleOutage).
let settling = null;

/**
 * Before a paper is read or written: an outage of the server itself, not yet
 * given back - the first moments after a restart, or after the machine woke
 * from sleep, before the scheduler's first pass - is given back first. Without
 * this, a student whose request arrived first had their question closed, or
 * their paper handed in, by the time the outage took. Nothing to wait for (the
 * usual case): null at once.
 */
export function settleOutage() {
  if (lastBeatMs !== null && !justWokeUp()) return null;
  settling ??= compensateForOutage().catch((error) => { console.error('Outage:', error); }).finally(() => { settling = null; });
  return settling;
}

/**
 * Gives the time from `downSince` to `now` back to every test running then:
 * its end later by that much, each open strict question's clock with it, no
 * paper charged with leaving - and the outage recorded on the test, with its
 * `cause`: 'server' (it was down) or 'network' (it ran, but nobody could reach
 * it). Past OUTAGE_EXTEND_MAX_MINUTES it is recorded only.
 */
export async function giveBackOutage(downSince, now, cause = 'server') {
  const outageMs = now.getTime() - downSince.getTime();
  const giveBack = outageMs <= (Number(config.outageExtendMaxMinutes) || 30) * 60_000;
  // Every clock moves on by exactly the outage: each question carries on with the time it had when it began.
  const shiftMs = outageMs;

  // Running when the server went down: started before it, not closed.
  const running = await tests().find(
    { isStarted: true, isClosed: { $ne: true }, startedAt: { $lte: downSince } },
    { projection: { code: 1, endsAt: 1, untimed: 1, endMode: 1, durationMinutes: 1 } }
  ).toArray();

  for (const test of running) {
    // Each student's own time: no shared end - each paper still running gets the outage back itself.
    const ownTimes = test.endMode === 'each' && Number(test.durationMinutes) > 0;
    // Only an end time that had not already passed (with its grace) is moved.
    const hasEnd = ownTimes || (test.untimed !== true && test.endsAt && new Date(test.endsAt).getTime() + END_GRACE_MS > downSince.getTime());
    const extend = giveBack && Boolean(hasEnd);
    const extra = { $ifNull: ['$attempt.extraMs', 0] };
    // A paper whose own time (and grace) had already run out before the outage gets nothing back.
    const ownTimeLeft = { $gt: [{ $add: ['$attempt.startedAt', Number(test.durationMinutes) * 60_000 + END_GRACE_MS, extra] }, downSince] };
    await serializeTestWrite(test.code, () => tests().updateOne({ code: test.code }, [{
      $set: {
        ...(extend && !ownTimes ? { endsAt: { $add: ['$endsAt', shiftMs] } } : {}),
        outages: {
          $concatArrays: [{ $ifNull: ['$outages', []] }, [{ from: downSince, to: now, ms: outageMs, extended: extend, cause }]]
        }
      }
    }]));
    await invalidateTestCache(test.code);
    // Every paper still being written, in one update: heard from now (the
    // outage is not the student leaving), and its clocks moved by the outage.
    await registrations().updateMany({ testCode: test.code, 'attempt.status': 'in_progress' }, [{
      $set: {
        'attempt.lastSeenAt': now,
        'attempt.awaySince': later('$attempt.awaySince', outageMs),
        ...(extend && ownTimes ? { 'attempt.extraMs': { $cond: [ownTimeLeft, { $add: [extra, shiftMs] }, extra] } } : {}),
        'attempt.strict': {
          $cond: [
            { $ifNull: ['$attempt.strict', false] },
            // A question paused while its student was away moves its pause on too, or
            // coming back would give the outage back a second time.
            { $mergeObjects: ['$attempt.strict', giveBack
              ? { shownAt: later('$attempt.strict.shownAt', shiftMs), pausedSince: later('$attempt.strict.pausedSince', shiftMs) }
              : {}] },
            '$$REMOVE'
          ]
        }
      }
    }]);
  }
  return { from: downSince, ms: outageMs, tests: running.length, gaveBack: giveBack, cause };
}
