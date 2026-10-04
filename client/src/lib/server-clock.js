/**
 * The server's clock, as this device best knows it.
 *
 * Every API reply carries X-Server-Time, stamped as it left the server
 * (api-router.js). The server's time when the reply arrives is that stamp
 * plus somewhere between none and all of the round trip, so the middle is the
 * estimate - out by at most half the trip. The sample with the shortest trip
 * is the most exact, so that is the one used: one slow reply (a weak
 * connection, a request stuck for half a minute) can never drag the exam's
 * timers away from the server's, the way taking the latest reply's time did.
 *
 * Kept for a while only, and dropped at once if this device's own clock jumps
 * (set by hand, or synced mid-test) - every sample then reads wrong by the jump.
 */
const KEEP_MS = 10 * 60_000;
const MAX_SAMPLES = 30;
// Two honest samples never disagree by more than their margins plus this.
const JUMP_SLACK_MS = 2_000;

let samples = [];

const best = () => samples.reduce((chosen, sample) => (!chosen || sample.rtt < chosen.rtt ? sample : chosen), null);

/** One reply: the server's stamp, and this device's clock when it was sent and when it came. */
export function recordServerTime(serverMs, sentAt, receivedAt) {
  const rtt = receivedAt - sentAt;
  if (!Number.isFinite(serverMs) || serverMs <= 0 || !Number.isFinite(rtt) || rtt < 0) return;
  const sample = { offset: serverMs + rtt / 2 - receivedAt, rtt, at: receivedAt };
  const chosen = best();
  if (chosen && Math.abs(sample.offset - chosen.offset) > (sample.rtt + chosen.rtt) / 2 + JUMP_SLACK_MS) samples = [];
  samples = [...samples.filter((entry) => receivedAt - entry.at <= KEEP_MS), sample].slice(-MAX_SAMPLES);
}

/** Server time minus this device's time, or null before any reply has come. */
export function serverOffset() {
  return best()?.offset ?? null;
}

/** The server's time now, in milliseconds; `fallbackOffset` before any reply has come. */
export function serverNow(fallbackOffset = 0) {
  return Date.now() + (serverOffset() ?? fallbackOffset);
}

/** For tests only. */
export function resetServerClock() {
  samples = [];
}
