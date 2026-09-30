import { registrations, tests } from '../db/index.js';
import { config } from '../config.js';
import { runAsLeader } from '../coordination/index.js';
import { END_GRACE_MS, isTimeOver } from '../domain/attempt-rules.js';
import { beginTest } from './test-lifecycle.js';
import { finishTest } from './admin-service.js';
import { compensateForOutage, recordHeartbeat } from './outage.js';

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
  return { started: due.length, ended: ending.length, expired };
}

/**
 * Runs the clock every few seconds for as long as the server is up. The first
 * thing it does is give running tests back any time lost while the server was
 * down (see outage.js) - before anything could close them for it.
 */
export function startScheduler(intervalMs = TICK_MS) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAsLeader('test-scheduler', async () => {
        // A machine that slept wakes up here: give the time back before anything is closed for it.
        const outage = await compensateForOutage();
        if (outage) console.log(`Server was paused for ${Math.round(outage.ms / 1000)} s; ${outage.tests} running test(s) ${outage.gaveBack ? 'given the time back' : 'recorded'}.`);
        await recordHeartbeat();
        await runScheduleOnce();
      }, Math.max(30_000, intervalMs * 4));
    } catch (error) { console.error('Test scheduler:', error); } finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
