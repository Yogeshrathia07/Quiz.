import { hmac } from '../lib/crypto.js';
import { iso } from '../lib/time.js';

/**
 * Attendance
 * ----------
 * The admin opens a session and shows its QR. A student scans it, signs in
 * and marks themselves: the mark is PENDING. Closing the session turns every
 * pending mark into PRESENT. "Take attendance again" opens another round on
 * the same session for latecomers; a mark made in a later round is late.
 *
 * The QR changes every QR_STEP_MS. Scanning a fresh one hands the phone a
 * pass (a signed cookie) that lasts PASS_MS - long enough to sign in - so a
 * photo of the QR sent to someone outside the room stops working within
 * 30-40 seconds.
 */

export const QR_STEP_MS = 10_000;
/** A code this many steps old is still taken: scanning and loading take a moment. */
export const QR_STEPS_ACCEPTED = 3;
export const PASS_MS = 15 * 60_000;
export const MARK_STATUSES = ['pending', 'present', 'rejected'];

const step = (atMs) => Math.floor(atMs / QR_STEP_MS);
const keyFor = (secret, stepNumber) => hmac(`qr:${stepNumber}`, secret).slice(0, 12);

/** The code in the QR right now. */
export const currentQrKey = (secret, atMs = Date.now()) => keyFor(secret, step(atMs));

/** When the QR shown now is replaced. */
export const nextQrChangeMs = (atMs = Date.now()) => (step(atMs) + 1) * QR_STEP_MS;

export function isFreshQrKey(secret, key, atMs = Date.now()) {
  if (typeof key !== 'string' || !key) return false;
  const current = step(atMs);
  for (let back = 0; back <= QR_STEPS_ACCEPTED; back += 1) {
    if (keyFor(secret, current - back) === key) return true;
  }
  return false;
}

/** The pass a fresh scan gives: an expiry, signed with the session's secret. */
export function issuePass(secret, atMs = Date.now()) {
  const expiresMs = atMs + PASS_MS;
  return `${expiresMs}.${hmac(`pass:${expiresMs}`, secret)}`;
}

export function isValidPass(secret, pass, atMs = Date.now()) {
  const [expires, signature] = String(pass || '').split('.');
  const expiresMs = Number(expires);
  return Number.isFinite(expiresMs) && expiresMs > atMs && signature === hmac(`pass:${expiresMs}`, secret);
}

export const currentRound = (session) => (session.rounds || []).at(-1) || null;
export const isOpen = (session) => Boolean(currentRound(session) && !currentRound(session).closedAt);

/**
 * Marks that share a phone with a mark for someone else: one student marking
 * for friends. Keyed by mark id, each naming the others on that phone.
 */
export function sharedDevices(marks) {
  const byDevice = new Map();
  for (const mark of marks) {
    if (!mark.deviceId || mark.status === 'rejected') continue;
    byDevice.set(mark.deviceId, [...(byDevice.get(mark.deviceId) || []), mark]);
  }
  const shared = new Map();
  for (const group of byDevice.values()) {
    if (group.length < 2) continue;
    for (const mark of group) shared.set(mark.id, group.filter((other) => other.id !== mark.id).map((other) => other.name));
  }
  return shared;
}

const roundView = (round) => ({ number: round.number, openedAt: iso(round.openedAt), closedAt: iso(round.closedAt) });

export function markView(mark, shared = new Map()) {
  return {
    id: mark.id,
    name: mark.name,
    sapId: mark.sapId || null,
    email: mark.isGuest ? null : mark.email,
    isGuest: Boolean(mark.isGuest),
    status: mark.status,
    round: mark.round,
    late: mark.round > 1,
    markedAt: iso(mark.markedAt),
    confirmedAt: iso(mark.confirmedAt),
    rejectedAt: iso(mark.rejectedAt),
    location: mark.location || null,
    addedByTeacher: Boolean(mark.addedByTeacher),
    sameDeviceAs: shared.get(mark.id) || []
  };
}

export function sessionSummary(session) {
  const marks = session.marks || [];
  return {
    code: session.code,
    title: session.title,
    createdAt: iso(session.createdAt),
    isOpen: isOpen(session),
    round: currentRound(session)?.number || 0,
    presentCount: marks.filter((mark) => mark.status === 'present').length,
    pendingCount: marks.filter((mark) => mark.status === 'pending').length
  };
}

export function adminSessionView(session, atMs = Date.now()) {
  const marks = session.marks || [];
  const shared = sharedDevices(marks);
  return {
    ...sessionSummary(session),
    allowGuests: Boolean(session.allowGuests),
    locationRequired: Boolean(session.locationRequired),
    locationRadiusMeters: session.locationRadiusMeters ?? null,
    locationLatitude: session.locationLatitude ?? null,
    locationLongitude: session.locationLongitude ?? null,
    rounds: (session.rounds || []).map(roundView),
    rejectedCount: marks.filter((mark) => mark.status === 'rejected').length,
    marks: [...marks].sort((a, b) => new Date(a.markedAt) - new Date(b.markedAt)).map((mark) => markView(mark, shared)),
    qrChangesAt: new Date(nextQrChangeMs(atMs)).toISOString(),
    qrStepMs: QR_STEP_MS,
    serverTime: new Date(atMs).toISOString()
  };
}

/** What a student sees: the session, and their own mark only. */
export function studentSessionView(session, mark, { hasPass }) {
  return {
    code: session.code,
    title: session.title,
    isOpen: isOpen(session),
    round: currentRound(session)?.number || 0,
    allowGuests: Boolean(session.allowGuests),
    locationRequired: Boolean(session.locationRequired),
    hasPass,
    myMark: mark ? {
      status: mark.status,
      round: mark.round,
      late: mark.round > 1,
      markedAt: iso(mark.markedAt),
      confirmedAt: iso(mark.confirmedAt)
    } : null
  };
}
