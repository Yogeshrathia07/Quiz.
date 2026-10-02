import { hash, hmac, randomId } from '../lib/crypto.js';
import { iso } from '../lib/time.js';

/**
 * Attendance
 * ----------
 * The admin opens a session and shows its QR. A student scans it, signs in
 * and marks themselves: the mark is PENDING. Closing the session turns every
 * pending mark into PRESENT. "Take attendance again" opens another round on
 * the same session for latecomers; a mark made in a later round is late.
 *
 * The QR changes every 2 seconds. Scanning one at most QR_ACCEPT_MS old hands
 * the phone a pass (a signed cookie) that lasts PASS_MS - long enough to sign
 * in - so a photo of the QR sent to someone outside the room stops working
 * within seconds. Each pass marks one person: marking a friend from the same
 * phone takes a fresh scan, in the room.
 */

export const QR_STEP_MS = 2_000;
/** How old a scanned code may be: the camera, the link opening and the page loading take a moment. */
export const QR_ACCEPT_MS = 12_000;
export const QR_STEPS_ACCEPTED = QR_ACCEPT_MS / QR_STEP_MS;
/** The teacher's screen is sent this many codes ahead - a minute's worth - and draws each in its turn. */
export const QR_KEYS_AHEAD = 30;
export const PASS_MS = 5 * 60_000;
export const MARK_STATUSES = ['pending', 'present', 'rejected'];

const step = (atMs) => Math.floor(atMs / QR_STEP_MS);
const keyFor = (secret, stepNumber) => hmac(`qr:${stepNumber}`, secret).slice(0, 12);

/** The code in the QR right now. */
export const currentQrKey = (secret, atMs = Date.now()) => keyFor(secret, step(atMs));

/** The codes from this second on: `from` is the step of the first. */
export function upcomingQrKeys(secret, atMs = Date.now(), count = QR_KEYS_AHEAD) {
  const from = step(atMs);
  return { from, keys: Array.from({ length: count }, (_, index) => keyFor(secret, from + index)) };
}

export function isFreshQrKey(secret, key, atMs = Date.now()) {
  if (typeof key !== 'string' || !key) return false;
  const current = step(atMs);
  for (let back = 0; back <= QR_STEPS_ACCEPTED; back += 1) {
    if (keyFor(secret, current - back) === key) return true;
  }
  return false;
}

/** The pass a fresh scan gives: an expiry and an id, signed with the session's secret. */
export function issuePass(secret, atMs = Date.now()) {
  const expiresMs = atMs + PASS_MS;
  const id = randomId(9);
  return `${expiresMs}.${id}.${hmac(`pass:${expiresMs}:${id}`, secret)}`;
}

/** The pass's id while it is genuine and unexpired; null otherwise. */
export function readPass(secret, pass, atMs = Date.now()) {
  const [expires, id, signature] = String(pass || '').split('.');
  const expiresMs = Number(expires);
  if (!Number.isFinite(expiresMs) || expiresMs <= atMs || !id) return null;
  return signature === hmac(`pass:${expiresMs}:${id}`, secret) ? id : null;
}

export const isValidPass = (secret, pass, atMs = Date.now()) => readPass(secret, pass, atMs) !== null;

export const currentRound = (session) => (session.rounds || []).at(-1) || null;
export const isOpen = (session) => Boolean(currentRound(session) && !currentRound(session).closedAt);

/**
 * Who a mark belongs to, across sessions: a college account by its email; a
 * guest (who has no lasting account) by their SAP ID, or their name without one.
 */
export function registerKey(mark) {
  if (mark.email && !mark.isGuest) return `email:${mark.email.toLowerCase()}`;
  return mark.sapId ? `guest-sap:${mark.sapId}` : `guest-name:${String(mark.name || '').trim().toLowerCase()}`;
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const whole = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : '');

/**
 * What a phone is, as far as its browser says: its model, system version,
 * screen and hardware. A private tab or a second browser on the same phone
 * reads the same - but so can two phones of one model, so a match is only
 * ever "possibly the same phone". Without a model (an iPhone's Safari keeps
 * it back, and all iPhones of a size look alike) there is nothing to go on.
 */
export function phoneFingerprint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = text(raw.model, 60);
  if (!model) return null;
  const sides = [whole(raw.screenW), whole(raw.screenH)].sort((a, b) => a - b);
  const traits = [model, text(raw.platformVersion, 20), text(raw.chPlatform, 30), ...sides,
    Number(raw.dpr) > 0 ? Math.round(Number(raw.dpr) * 100) : '', whole(raw.cores), whole(raw.memory)];
  return hash(traits.join('|')).slice(0, 24);
}

/**
 * Marks that share a phone with a mark for someone else: one student marking
 * for friends. The phone is known by the id its browser keeps and by a
 * cookie the server gave it; either matching is the same phone. Keyed by mark
 * id, each naming the others on that phone.
 */
export function sharedDevices(marks) {
  return matches(marks, (mark) => [mark.deviceId && `id:${mark.deviceId}`, mark.deviceCookie && `cookie:${mark.deviceCookie}`]);
}

/** Marks from phones that look the same (phoneFingerprint) but are not known to be. */
export function similarDevices(marks, shared = sharedDevices(marks)) {
  const similar = matches(marks, (mark) => [mark.fingerprint && `print:${mark.fingerprint}`]);
  for (const [id, names] of similar) {
    const left = names.filter((name) => !(shared.get(id) || []).includes(name));
    if (left.length) similar.set(id, left); else similar.delete(id);
  }
  return similar;
}

function matches(marks, keysOf) {
  const byKey = new Map();
  for (const mark of marks) {
    if (mark.status === 'rejected') continue;
    for (const key of keysOf(mark).filter(Boolean)) byKey.set(key, [...(byKey.get(key) || []), mark]);
  }
  const found = new Map();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const mark of group) {
      const names = new Set(found.get(mark.id) || []);
      for (const other of group) if (other.id !== mark.id) names.add(other.name);
      found.set(mark.id, [...names]);
    }
  }
  return found;
}

const roundView = (round) => ({ number: round.number, openedAt: iso(round.openedAt), closedAt: iso(round.closedAt) });

export function markView(mark, shared = new Map(), similar = new Map()) {
  return {
    id: mark.id,
    key: registerKey(mark),
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
    sameDeviceAs: shared.get(mark.id) || [],
    similarDeviceAs: similar.get(mark.id) || []
  };
}

export function sessionSummary(session) {
  const marks = session.marks || [];
  const shared = sharedDevices(marks);
  const similar = similarDevices(marks, shared);
  return {
    code: session.code,
    title: session.title,
    createdAt: iso(session.createdAt),
    isOpen: isOpen(session),
    round: currentRound(session)?.number || 0,
    presentCount: marks.filter((mark) => mark.status === 'present').length,
    pendingCount: marks.filter((mark) => mark.status === 'pending').length,
    rejectedCount: marks.filter((mark) => mark.status === 'rejected').length,
    flaggedCount: new Set([...shared.keys(), ...similar.keys()]).size
  };
}

/** `linkBase`: the address phones reach the portal at; empty for the teacher's own (the page adds it). */
export function adminSessionView(session, atMs = Date.now(), { linkBase = '' } = {}) {
  const marks = session.marks || [];
  const shared = sharedDevices(marks);
  const similar = similarDevices(marks, shared);
  const open = isOpen(session);
  return {
    ...sessionSummary(session),
    allowGuests: Boolean(session.allowGuests),
    oneMarkPerPhone: Boolean(session.oneMarkPerPhone),
    locationRequired: Boolean(session.locationRequired),
    locationRadiusMeters: session.locationRadiusMeters ?? null,
    locationLatitude: session.locationLatitude ?? null,
    locationLongitude: session.locationLongitude ?? null,
    rounds: (session.rounds || []).map(roundView),
    marks: [...marks].sort((a, b) => new Date(a.markedAt) - new Date(b.markedAt)).map((mark) => markView(mark, shared, similar)),
    // The next minute of QR codes, for the teacher's screen to draw - none once closed.
    qr: open ? {
      link: `${linkBase}/?attend=${encodeURIComponent(session.code)}&k=`,
      stepMs: QR_STEP_MS, acceptMs: QR_ACCEPT_MS, ...upcomingQrKeys(session.secret, atMs)
    } : null,
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

/**
 * Everyone seen in a class's other sessions (sessions with the same title),
 * by registerKey: how many of those sessions they were present in, and when
 * last. A removed mark is not being there.
 */
export function classRoster(sessions) {
  const people = new Map();
  for (const session of sessions) {
    const seenHere = new Set();
    for (const mark of session.marks || []) {
      if (mark.status === 'rejected') continue;
      const key = registerKey(mark);
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const person = people.get(key) || { key, name: mark.name, sapId: null, email: null, isGuest: Boolean(mark.isGuest), seen: 0, lastSeenAt: null };
      person.seen += 1;
      if (!person.lastSeenAt || new Date(session.createdAt) > new Date(person.lastSeenAt)) {
        // The latest session's details win: a corrected name carries through.
        person.lastSeenAt = iso(session.createdAt);
        person.name = mark.name || person.name;
      }
      person.sapId = mark.sapId || person.sapId;
      if (!mark.isGuest && mark.email) person.email = mark.email;
      people.set(key, person);
    }
  }
  return { sessionCount: sessions.length, people: [...people.values()] };
}
