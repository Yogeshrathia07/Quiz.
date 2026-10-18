import { config } from '../config.js';
import { hmac } from '../lib/crypto.js';
import { giveBackOutage } from './outage.js';

/**
 * Can students reach the server?
 * -------------------------------
 * Students reach this server over the internet, through a tunnel to the
 * admin's own machine. When that machine's connection drops (or the tunnel
 * does), the server runs on - its heartbeat too, so outage.js sees nothing -
 * and its clocks keep going while nobody can save an answer or move on. Left
 * alone, every timed question ran out, and every paper whose end passed was
 * handed in, for time nobody could write in.
 *
 * So while a test is running, every scheduler pass asks for the server at its
 * public address (PUBLIC_BASE_URL), as a student's device would. An answer that
 * really came from this server carries its token (reachToken); anything else -
 * no connection, or an error page from the tunnel - is a failure. A request
 * from a student through the tunnel is proof of reach as good as an answer.
 * Two failed asks in a row with nothing from outside meanwhile is an outage,
 * from the last moment anything got through: the scheduler then closes nothing
 * by time (unreachable), and the moment anything gets through again, every
 * test running then gets the time back (outage.js giveBackOutage) - before the
 * request that proved it is answered.
 *
 * An address that has never answered here - not set up, or the server cannot
 * reach itself through it - is no evidence of anything: then nothing is ever
 * held or given back, exactly as before.
 *
 * Students' screens pause by themselves meanwhile (a reply from the tunnel, not
 * the server - client/src/lib/api.js), their clocks held; so every outage
 * found is given back however short - exactly, no more.
 */

/** How often the server asks for itself while a test runs (scheduler.js). */
export const PROBE_EVERY_MS = 2_000;
const PROBE_TIMEOUT_MS = 4_000;
const FAILURES_FOR_OUTAGE = 2;
// Who gives an outage's time back: outage.js, or a stand-in in the tests.
let giveBack = giveBackOutage;

let lastContactMs = Date.now();
// Every time something got through from outside: an ask that failed while this moved was no outage.
let contacts = 0;
let probeWorks = false;
let failures = 0;
let downSince = null;
let recovering = null;
let probing = false;

/** What the server answers its own ask with: the same for every process of this deployment, unknown to anyone else. */
export const reachToken = () => hmac('reach:v1', String(config.sessionSecret)).slice(0, 32);

/** True from the moment an outage of reach is found until anything gets through again. */
export const unreachable = () => downSince !== null;

/** Whether the public address leads somewhere worth asking: set, and not this machine itself. */
function probeUrl() {
  const base = config.publicBaseUrl;
  if (!base) return null;
  try {
    const url = new URL('/api/reach', base);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Something got through from outside: the outage, if there was one, is over - give its time back. */
function reached(atMs) {
  lastContactMs = Math.max(lastContactMs, atMs);
  contacts += 1;
  failures = 0;
  if (!downSince) return null;
  const from = downSince;
  downSince = null;
  recovering = Promise.resolve(giveBack(from, new Date(atMs), 'network'))
    .then((outage) => {
      if (outage) console.log(`Students could not reach the server for ${Math.round(outage.ms / 1000)} s; ${outage.tests} running test(s) ${outage.gaveBack ? 'given the time back' : 'recorded'}.`);
      return outage;
    })
    .catch((error) => { console.error('Reach outage:', error); })
    .finally(() => { recovering = null; });
  return recovering;
}

/**
 * Every request: one that came through the tunnel (Cloudflare marks it) is a
 * student reaching the server - and if an outage was on, it is given back
 * before this request goes on, so nothing is judged by the lost time. Null at
 * once when there is nothing to wait for.
 */
export function noteRequest(req) {
  if (!req.headers['cf-ray']) return recovering;
  return reached(Date.now()) || recovering;
}

/**
 * One ask at the public address - from the scheduler's pass, only while a test
 * is running (`testsRunning`). Never throws.
 */
export async function probeReach({ testsRunning = false, fetchImpl = globalThis.fetch } = {}) {
  const url = probeUrl();
  if (!url || !testsRunning || probing || typeof fetchImpl !== 'function') return { asked: false };
  probing = true;
  const contactsBefore = contacts;
  try {
    let ok = false;
    try {
      const response = await fetchImpl(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      ok = response.ok && (await response.json().catch(() => null))?.token === reachToken();
    } catch {
      ok = false;
    }
    if (ok) {
      if (!probeWorks) console.log(`Watching that students can reach the server, at ${url}: if they cannot, every test pauses and gets the time back.`);
      probeWorks = true;
      await reached(Date.now());
      return { asked: true, ok: true };
    }
    failures += 1;
    // Down only on an address that has answered before, after two failures, with nothing from outside meanwhile.
    if (probeWorks && !downSince && failures >= FAILURES_FOR_OUTAGE && contacts === contactsBefore) {
      downSince = new Date(lastContactMs);
      console.warn(`Students cannot reach the server (nothing from outside since ${downSince.toISOString()}): no test or paper is closed by time until they can.`);
    }
    return { asked: true, ok: false, down: unreachable() };
  } finally {
    probing = false;
  }
}

/** For tests only: who gives an outage's time back (null: outage.js again). */
export function setReachGiveBack(fn) {
  giveBack = fn || giveBackOutage;
}

/** For tests only: as if the last thing from outside came at `atMs`, and the address had (`works`) answered before. */
export function resetReach(atMs = Date.now(), { works = false } = {}) {
  lastContactMs = atMs;
  contacts = 0;
  probeWorks = works;
  failures = 0;
  downSince = null;
  recovering = null;
  probing = false;
}
