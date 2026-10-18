import { registrations, tests } from '../db/index.js';
import { config } from '../config.js';
import { runAsLeader } from '../coordination/index.js';
import { END_GRACE_MS, isTimeOver } from '../domain/attempt-rules.js';
import { beginTest } from './test-lifecycle.js';
import { finishOwnTimes, finishTest } from './admin-service.js';
import { compensateForOutage, recordHeartbeat } from './outage.js';
import { kickResultMails } from './result-mail-service.js';
import { PROBE_EVERY_MS, probeReach, unreachable } from './reachability.js';

const TICK_MS = 5_000;

/**
 * Registration requests nobody has approved within config.pendingRequestMinutes
 * (an hour by default) are taken away, so no test keeps a list of old pending
 * requests. The student simply asks again. A request only ever waits here -
 * no paper is begun until it is approved - so nothing else goes with it.
 */
export async function expireStaleRequests(atMs = Date.now()) {
  const minutes = Number(config.pendingRequestMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const { deletedCount } = await registrations().deleteMany({
    status: 'pending', attempt: null, requestedAt: { $lte: new Date(atMs - minutes * 60_000) }
  });
  return deletedCount;
}

/**
 * One pass of the clock: start every scheduled test whose time has come, and
 * end every test whose end time (plus the grace for answers still arriving)
 * has passed - which submits every paper on it - and let go of requests
 * nobody approved in time. Everything it needs is in the database, so a
 * restart simply picks up where the last pass left off.
 */
export async function runScheduleOnce(atMs = Date.now()) {
  const expired = await expireStaleRequests(atMs);
  const at = new Date(atMs);
  const due = await tests().find(
    { startMode: 'scheduled', isStarted: { $ne: true }, isClosed: { $ne: true }, opensAt: { $lte: at } },
    { projection: { registrations: 0, questions: 0 } }
  ).toArray();
  for (const test of due) {
    // Down past the whole window (a long outage): there is nothing to sit.
    if (isTimeOver(test, atMs)) await finishTest(await tests().findOne({ code: test.code }), { automatic: true });
    else await beginTest(test);
  }

  const ending = await tests().find(
    { isStarted: true, isClosed: { $ne: true }, untimed: { $ne: true }, endsAt: { $ne: null, $lte: new Date(atMs - END_GRACE_MS) } },
    { projection: { code: 1 } }
  ).toArray();
  for (const { code } of ending) {
    // Read whole and fresh: an extension may have landed since the query.
    const test = await tests().findOne({ code });
    if (test && !test.isClosed && isTimeOver(test, atMs - END_GRACE_MS)) await finishTest(test, { automatic: true });
  }

  // Each student's own time: hand in every paper whose own time is up. The
  // test itself stays open until the admin closes it.
  const ownTimed = await tests().find(
    { endMode: 'each', isStarted: true, isClosed: { $ne: true } },
    { projection: { registrations: 0, questions: 0 } }
  ).toArray();
  let handedIn = 0;
  for (const test of ownTimed) handedIn += await finishOwnTimes(test, atMs);

  // Results emails still waiting - after a restart, say: sent on in the background.
  if (await registrations().countDocuments({ 'resultMail.status': 'queued' }, { limit: 1 })) kickResultMails();
  return { started: due.length, ended: ending.length, expired, handedIn };
}

/**
 * Runs the clock every few seconds for as long as the server is up. The first
 * thing it does is give running tests back any time lost while the server was
 * down (see outage.js) - before anything could close them for it.
 */
export function startScheduler(intervalMs = TICK_MS) {
  let running = false;
  // Whether a test is running, as the last pass found: the server asks for itself every PROBE_EVERY_MS meanwhile.
  let testRunning = false;
  const probe = setInterval(() => { void probeReach({ testsRunning: testRunning }); }, PROBE_EVERY_MS);
  probe.unref?.();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAsLeader('test-scheduler', async () => {
        // A machine that slept wakes up here: give the time back before anything is closed for it.
        const outage = await compensateForOutage();
        if (outage) console.log(`Server was paused for ${Math.round(outage.ms / 1000)} s; ${outage.tests} running test(s) ${outage.gaveBack ? 'given the time back' : 'recorded'}.`);
        await recordHeartbeat();
        // Can students reach the server? Asked while a test runs (never waited on here). While they cannot,
        // nothing is closed by time: the time is given back the moment they can (reachability.js).
        testRunning = Boolean(await tests().findOne({ isStarted: true, isClosed: { $ne: true } }, { projection: { _id: 1 } }));
        if (unreachable()) return;
        await runScheduleOnce();
      }, Math.max(30_000, intervalMs * 4));
    } catch (error) { console.error('Test scheduler:', error); } finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => { clearInterval(timer); clearInterval(probe); };
}
