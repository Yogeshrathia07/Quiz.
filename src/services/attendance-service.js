import { accounts, attendanceSessions, studentProfiles } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { asInteger, randomId } from '../lib/crypto.js';
import { cookieIsSecure } from '../lib/security.js';
import { now } from '../lib/time.js';
import { cleanText, coordinate, isSapId, normalizeSapId } from '../domain/test-builder.js';
import {
  PASS_MS, adminSessionView, classRoster, currentRound, isFreshQrKey, isOpen, issuePass, phoneFingerprint, readPass,
  registerKey, sessionSummary, studentSessionView
} from '../domain/attendance.js';
import { isGuestAccount, normalizeEmail } from '../auth/portal-auth.js';
import { adminEmail } from '../data/test-repository.js';
import { config } from '../config.js';
import { classifyLocationCheck } from './attempt-service.js';
import { issueGuestSession, sapIdForStudent } from './registration-service.js';

const publicCode = () => `ATT-${randomId(5).toUpperCase().replace(/[-_]/g, 'X')}`;
const passCookie = (code) => `attend_pass_${code}`;
/** A second id for the phone, kept by the server's own cookie rather than the page's storage. */
const DEVICE_COOKIE = 'attend_device';
const DEVICE_COOKIE_MS = 365 * 24 * 60 * 60_000;
const adminView = (session) => adminSessionView(session, Date.now(), { linkBase: config.publicBaseUrl });
const sessionByCode = (code) => attendanceSessions().findOne({ code: String(code || '').toUpperCase() });

async function requireSession(code) {
  const session = await sessionByCode(code);
  if (!session) throw new PublicTestError(404, 'This attendance session does not exist.');
  return session;
}

/** A session is only visible to the admin who created it. */
async function requireOwnedSession(req, code) {
  const session = await requireSession(code);
  if (session.ownerEmail !== adminEmail(req)) throw new PublicTestError(404, 'This attendance session does not exist.');
  return session;
}

/** The venue rule, checked the same way as a test's. */
function readVenue(raw) {
  const locationRequired = raw.locationRequired === true;
  if (!locationRequired) return { locationRequired, locationRadiusMeters: null, locationLatitude: null, locationLongitude: null };
  const venue = {
    locationRequired,
    locationRadiusMeters: asInteger(Number(raw.locationRadiusMeters), 10, 100_000),
    locationLatitude: coordinate(raw.locationLatitude, -90, 90),
    locationLongitude: coordinate(raw.locationLongitude, -180, 180)
  };
  if (venue.locationRadiusMeters === null || venue.locationLatitude === null || venue.locationLongitude === null) {
    throw new PublicTestError(400, 'Set the classroom location and an allowed distance between 10 and 100000 metres.');
  }
  return venue;
}

/* ---------------------------------------------------------------- admin */

export async function listAttendance(req) {
  const sessions = await attendanceSessions().find({ ownerEmail: adminEmail(req) }).sort({ createdAt: -1 }).toArray();
  // A new session starts with the distance check on, at the last classroom used.
  const venue = sessions.find((session) => session.locationRequired);
  return {
    sessions: sessions.map(sessionSummary),
    lastVenue: venue ? {
      locationRadiusMeters: venue.locationRadiusMeters, locationLatitude: venue.locationLatitude, locationLongitude: venue.locationLongitude
    } : null
  };
}

/** Creating a session opens its first round at once: the QR is live. */
export async function createAttendance(req, raw = {}) {
  const openedAt = now();
  const doc = {
    code: publicCode(),
    title: cleanText(raw.title, 'Title', 2, 120),
    ownerEmail: adminEmail(req),
    createdAt: openedAt,
    allowGuests: raw.allowGuests === true,
    oneMarkPerPhone: raw.oneMarkPerPhone === true,
    ...readVenue(raw),
    secret: randomId(24),
    rounds: [{ number: 1, openedAt, closedAt: null }],
    marks: []
  };
  while (await sessionByCode(doc.code)) doc.code = publicCode();
  await attendanceSessions().insertOne(doc);
  return { session: adminView(doc) };
}

export async function attendanceForAdmin(req, code) {
  return { session: adminView(await requireOwnedSession(req, code)) };
}

export async function attendanceSettings(req, code, raw = {}) {
  const session = await requireOwnedSession(req, code);
  const set = {};
  if (raw.title !== undefined) set.title = cleanText(raw.title, 'Title', 2, 120);
  if (raw.allowGuests !== undefined) set.allowGuests = raw.allowGuests === true;
  if (raw.oneMarkPerPhone !== undefined) set.oneMarkPerPhone = raw.oneMarkPerPhone === true;
  if (raw.locationRequired !== undefined) Object.assign(set, readVenue(raw));
  if (Object.keys(set).length) await attendanceSessions().updateOne({ code: session.code }, { $set: set });
  return attendanceForAdmin(req, session.code);
}

/** Every pending mark of the open round becomes present, stamped with this moment. */
export async function closeAttendance(req, code) {
  const session = await requireOwnedSession(req, code);
  const round = currentRound(session);
  if (!isOpen(session)) throw new PublicTestError(409, 'Attendance is already closed.');
  const closedAt = now();
  await attendanceSessions().updateOne(
    { code: session.code, rounds: { $elemMatch: { number: round.number, closedAt: null } } },
    { $set: { 'rounds.$[round].closedAt': closedAt, 'marks.$[mark].status': 'present', 'marks.$[mark].confirmedAt': closedAt } },
    { arrayFilters: [{ 'round.number': round.number }, { 'mark.status': 'pending' }] }
  );
  return attendanceForAdmin(req, session.code);
}

/** Another round for latecomers. Those already marked stay as they are. */
export async function reopenAttendance(req, code) {
  const session = await requireOwnedSession(req, code);
  if (isOpen(session)) throw new PublicTestError(409, 'Attendance is still open.');
  const number = (currentRound(session)?.number || 0) + 1;
  await attendanceSessions().updateOne(
    // A double click adds one round, not two.
    { code: session.code, 'rounds.number': { $ne: number } },
    { $push: { rounds: { number, openedAt: now(), closedAt: null } } }
  );
  return attendanceForAdmin(req, session.code);
}

/**
 * Removing marks (a proxy, a wrong person) and putting them back - one, or
 * several at once. A mark put back is present if its round has closed, and
 * pending while it is open - except one the teacher added by hand, which was
 * present from the start.
 */
export async function setMarkStatuses(req, code, rawIds, action) {
  const session = await requireOwnedSession(req, code);
  if (!['reject', 'restore'].includes(action)) throw new PublicTestError(404, 'Unknown action.');
  const ids = new Set((Array.isArray(rawIds) ? rawIds : []).filter((id) => typeof id === 'string').slice(0, 2_000));
  const marks = (session.marks || []).filter((mark) => ids.has(mark.id));
  if (!marks.length) throw new PublicTestError(404, ids.size > 1 ? 'Those marks no longer exist.' : 'That mark no longer exists.');
  const at = now();
  const operations = marks.flatMap((mark) => {
    let set;
    if (action === 'reject') {
      if (mark.status === 'rejected') return [];
      set = { 'marks.$.status': 'rejected', 'marks.$.rejectedAt': at };
    } else {
      if (mark.status !== 'rejected') return [];
      const roundClosed = Boolean((session.rounds || []).find((round) => round.number === mark.round)?.closedAt);
      set = roundClosed || mark.addedByTeacher
        ? { 'marks.$.status': 'present', 'marks.$.confirmedAt': mark.confirmedAt || at, 'marks.$.rejectedAt': null }
        : { 'marks.$.status': 'pending', 'marks.$.rejectedAt': null };
    }
    return [{ updateOne: { filter: { code: session.code, 'marks.id': mark.id }, update: { $set: set } } }];
  });
  if (operations.length) await attendanceSessions().bulkWrite(operations, { ordered: false });
  return { ...(await attendanceForAdmin(req, session.code)), changed: operations.length };
}

export const setMarkStatus = (req, code, markId, action) => setMarkStatuses(req, code, [markId], action);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * People with a portal account whose name, SAP ID or email contains what the
 * teacher typed - for picking someone to add by hand. A few at most, the
 * closest first, each saying whether they are already on this session.
 */
export async function searchPeople(req, code, rawQuery) {
  const session = await requireOwnedSession(req, code);
  const query = String(rawQuery ?? '').trim().slice(0, 80);
  if (query.length < 2) return { people: [] };
  // What was typed, escaped and matched as plain text, ignoring case.
  const pattern = { $regex: escapeRegex(query), $options: 'i' };
  const [profiles, accountList] = await Promise.all([
    studentProfiles().find({ $or: [{ displayName: pattern }, { sapId: pattern }, { email: pattern }] })
      .project({ email: 1, displayName: 1, sapId: 1 }).limit(20).toArray(),
    accounts().find({ $or: [{ displayName: pattern }, { _id: pattern }] })
      .project({ displayName: 1 }).limit(20).toArray()
  ]);
  const found = new Map();
  for (const account of accountList) found.set(account._id, { email: account._id, name: account.displayName, sapId: null });
  // A name matched on the account: its SAP ID lives on the profile.
  const missing = accountList.map((account) => account._id).filter((email) => !profiles.some((profile) => profile.email === email));
  const extra = missing.length ? await studentProfiles().find({ email: { $in: missing } }).project({ email: 1, displayName: 1, sapId: 1 }).toArray() : [];
  for (const profile of [...profiles, ...extra]) {
    found.set(profile.email, {
      email: profile.email,
      name: profile.displayName || found.get(profile.email)?.name || '',
      sapId: isSapId(profile.sapId) ? profile.sapId : null
    });
  }
  const onSession = new Set((session.marks || []).map((mark) => mark.email).filter(Boolean));
  const lower = query.toLowerCase();
  const rank = (person) => (person.sapId === query || person.email === lower ? 0 : person.name.toLowerCase().startsWith(lower) ? 1 : 2);
  const people = [...found.values()]
    .filter((person) => !isGuestAccount(person.email))
    .map((person) => ({ ...person, name: String(person.name || '').trim() || person.email, marked: onSession.has(person.email) }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 8);
  return { people };
}

/** Someone with a portal account, found by their SAP ID or college email. */
async function collegeStudent(rawLookup) {
  const lookup = String(rawLookup ?? '').trim();
  if (!lookup) throw new PublicTestError(400, 'Enter the student\'s SAP ID or college email.');
  if (lookup.includes('@')) {
    const email = normalizeEmail(lookup);
    const [profile, account] = await Promise.all([studentProfiles().findOne({ email }), accounts().findOne({ _id: email })]);
    if (!profile && !account) {
      throw new PublicTestError(404, `Nobody has signed in as ${email} yet. Add them as a guest instead.`, 'NOT_REGISTERED');
    }
    const name = String(profile?.displayName || account?.displayName || '').trim() || email;
    return { email, name, sapId: isSapId(profile?.sapId) ? profile.sapId : null, isGuest: false };
  }
  const sapId = normalizeSapId(lookup);
  const profile = await studentProfiles().findOne({ sapId });
  if (!profile) throw new PublicTestError(404, `No registered student has SAP ID ${sapId}. Add them as a guest instead.`, 'NOT_REGISTERED');
  const account = profile.displayName ? null : await accounts().findOne({ _id: profile.email });
  const name = String(profile.displayName || account?.displayName || '').trim() || profile.email;
  return { email: profile.email, name, sapId, isGuest: false };
}

/*
 * A SAP ID is compared only within its own kind: a guest's with other
 * guests' marks, a college student's with other college students'. A guest
 * may give a SAP ID a registered student has - it is never checked against
 * accounts - and a guest's mark never stops that student marking.
 */
const sameSapId = (mark, sapId, isGuest) => Boolean(sapId) && mark.sapId === sapId && Boolean(mark.isGuest) === Boolean(isGuest);
/** For the write itself: no mark of the same kind with this SAP ID arrived meanwhile. */
const noSapIdClash = (sapId, isGuest) => (sapId
  ? { marks: { $not: { $elemMatch: { sapId, isGuest: isGuest ? true : { $ne: true } } } } }
  : {});
/** For a session allowing one mark per phone: no mark still standing from this phone arrived meanwhile. */
function noPhoneClash(deviceId, deviceCookie) {
  const ids = [deviceId && { deviceId }, deviceCookie && { deviceCookie }].filter(Boolean);
  return ids.length ? { marks: { $not: { $elemMatch: { status: { $ne: 'rejected' }, $or: ids } } } } : {};
}

/** Anyone else, by name and SAP ID - just as they would mark themselves as a guest. */
async function guestStudent(raw) {
  const name = cleanText(raw.name, 'Name', 2, 120);
  const sapId = normalizeSapId(raw.sapId);
  return { email: null, name, sapId, isGuest: true };
}

/**
 * The teacher adds someone by hand: a phone that would not scan, or no phone
 * at all - as a college student with a portal account, or as a guest. A
 * college student's mark is theirs exactly as if they had scanned: they see
 * it too. The teacher's word is final, so it is present at once.
 */
export async function addManualMark(req, code, raw = {}) {
  const session = await requireOwnedSession(req, code);
  const { name, isGuest } = await pushManualMark(session, raw);
  return { ...(await attendanceForAdmin(req, session.code)), added: { name, isGuest } };
}

/**
 * Several at once - the absent list's "Mark present". Each is added as
 * addManualMark would; anyone who cannot be (marked meanwhile, no longer
 * registered) is skipped and named.
 */
export async function addManualMarks(req, code, rawPeople) {
  const session = await requireOwnedSession(req, code);
  const people = (Array.isArray(rawPeople) ? rawPeople : []).slice(0, 500);
  if (!people.length) throw new PublicTestError(400, 'Choose who to mark present.');
  let added = 0;
  const skipped = [];
  for (const person of people) {
    try {
      // Each against the session as it now is: the one before has just landed.
      await pushManualMark(await requireSession(session.code), person);
      added += 1;
    } catch (error) {
      if (!(error instanceof PublicTestError)) throw error;
      skipped.push({ name: String(person?.name || person?.lookup || '').slice(0, 120), reason: error.message });
    }
  }
  return { ...(await attendanceForAdmin(req, session.code)), added, skipped };
}

async function pushManualMark(session, raw = {}) {
  const { email, name, sapId, isGuest } = raw.as === 'guest' ? await guestStudent(raw) : await collegeStudent(raw.lookup);
  const clash = (session.marks || []).find((mark) => sameSapId(mark, sapId, isGuest) || (email && mark.email === email));
  if (clash) {
    throw new PublicTestError(409, clash.status === 'rejected'
      ? `${clash.name} was removed from this class. Use Restore on their row instead.`
      : `${clash.name} is already marked.`);
  }
  const markedAt = now();
  const mark = {
    id: randomId(12),
    email,
    name,
    sapId,
    isGuest,
    status: 'present',
    round: currentRound(session)?.number || 1,
    markedAt,
    confirmedAt: markedAt,
    rejectedAt: null,
    location: null,
    deviceId: null,
    addedByTeacher: true
  };
  // The student may scan at this very moment: only one of the two lands.
  const { modifiedCount } = await attendanceSessions().updateOne(
    { code: session.code, ...noSapIdClash(sapId, isGuest), ...(email ? { 'marks.email': { $ne: email } } : {}) },
    { $push: { marks: mark } }
  );
  if (!modifiedCount) throw new PublicTestError(409, `${name} has just marked themselves.`);
  return { name, isGuest };
}

export async function deleteAttendance(req, code) {
  const session = await requireOwnedSession(req, code);
  await attendanceSessions().deleteOne({ code: session.code });
  return { deleted: session.code };
}

/**
 * Several of this teacher's sessions for one register (export/attendance-sheet.js):
 * the ones named in `codes` (comma-separated), or all of them. Only their own.
 * `min` is the attendance, a percentage, under which a student is short.
 */
export async function attendanceRegisterData(req, raw = {}) {
  const codes = [...new Set(String(raw.codes || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))].slice(0, 1000);
  const sessions = await attendanceSessions()
    .find({ ownerEmail: adminEmail(req), ...(codes.length ? { code: { $in: codes } } : {}) })
    .sort({ createdAt: 1 })
    .toArray();
  if (!sessions.length) throw new PublicTestError(404, 'There is no attendance to download.');
  const min = asInteger(Number(raw.min ?? 75), 1, 100) ?? 75;
  return { exportedAt: now().toISOString(), minShare: min / 100, sessions: sessions.map((session) => adminSessionView(session)) };
}

/**
 * The class this session belongs to - this teacher's other sessions with the
 * same title - as a roster: everyone seen in them. Whoever is on it but on
 * none of this session's marks is absent from it.
 */
export async function attendanceRoster(req, code) {
  return classRosterFor(await requireOwnedSession(req, code));
}

async function classRosterFor(session) {
  const others = await attendanceSessions()
    .find({ ownerEmail: session.ownerEmail, title: session.title, code: { $ne: session.code } })
    .project({ createdAt: 1, 'marks.name': 1, 'marks.email': 1, 'marks.sapId': 1, 'marks.isGuest': 1, 'marks.status': 1 })
    .toArray();
  return classRoster(others);
}

/**
 * One session for its workbook: every mark and everyone absent - or, given
 * `pick`, just the rows the teacher had on screen, in that order (`ids` of
 * marks, `absent` roster keys), and a line saying how they were chosen.
 */
export async function attendanceExportData(req, code, pick = null) {
  const session = await requireOwnedSession(req, code);
  const view = adminSessionView(session);
  const roster = await classRosterFor(session);
  const here = new Set((session.marks || []).map(registerKey));
  const absent = roster.people.filter((person) => !here.has(person.key));
  if (!pick) return { ...view, classSessions: roster.sessionCount, absent };
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').slice(0, 5_000) : []);
  const marksById = new Map(view.marks.map((mark) => [mark.id, mark]));
  const absentByKey = new Map(absent.map((person) => [person.key, person]));
  const marks = list(pick.ids).map((id) => marksById.get(id)).filter(Boolean);
  const absentPicked = list(pick.absent).map((key) => absentByKey.get(key)).filter(Boolean);
  if (!marks.length && !absentPicked.length) throw new PublicTestError(400, 'Nothing to download: no rows are shown.');
  return {
    ...view, marks, absent: absentPicked, classSessions: roster.sessionCount,
    note: typeof pick.note === 'string' ? pick.note.trim().slice(0, 300) : ''
  };
}

/* -------------------------------------------------------------- student */

const passOf = (req, session) => readPass(session.secret, req.signedCookies?.[passCookie(session.code)]);
const myMark = (session, email) => (email ? (session.marks || []).find((mark) => mark.email === email) : null) || null;
/** A pass is spent once a mark has been made with it. */
const usablePass = (req, session) => {
  const id = passOf(req, session);
  return id && !(session.marks || []).some((mark) => mark.passId === id) ? id : null;
};

/**
 * Opening the scanned link. A fresh QR code hands this phone a new pass for
 * the next few minutes - time to sign in - and the student marks with that.
 * The phone is also given a lasting id of its own, if it has none.
 */
export async function attendanceForStudent(req, res, code, key) {
  const session = await requireSession(code);
  let passed = Boolean(usablePass(req, session));
  if (isOpen(session) && isFreshQrKey(session.secret, key)) {
    res.cookie(passCookie(session.code), issuePass(session.secret), {
      httpOnly: true, sameSite: 'lax', secure: cookieIsSecure(req), signed: true, maxAge: PASS_MS
    });
    passed = true;
  }
  if (!req.signedCookies?.[DEVICE_COOKIE]) {
    res.cookie(DEVICE_COOKIE, randomId(12), {
      httpOnly: true, sameSite: 'lax', secure: cookieIsSecure(req), signed: true, maxAge: DEVICE_COOKIE_MS
    });
  }
  const email = normalizeEmail(req.portalUser?.email);
  return { session: studentSessionView(session, myMark(session, email), { hasPass: passed }) };
}

// req.portalUser is the stored session, which keeps the name as `displayName`.
const displayName = (user) => String(user?.displayName || '').replace(/^Guest:\s*/, '').trim() || 'Student';

export async function markAttendance(req, code, raw = {}) {
  const session = await requireSession(code);
  const user = req.portalUser;
  const email = normalizeEmail(user?.email);
  const isGuest = isGuestAccount(email);
  const view = (latest) => ({ session: studentSessionView(latest, myMark(latest, email), { hasPass: true }) });

  const existing = myMark(session, email);
  if (existing?.status === 'rejected') {
    throw new PublicTestError(409, 'Your teacher removed your attendance for this class. Speak to them if this is wrong.');
  }
  if (existing) return view(session);
  if (!isOpen(session)) throw new PublicTestError(409, 'Attendance is closed. Ask your teacher to take attendance again.', 'ATTENDANCE_CLOSED');
  const passId = passOf(req, session);
  if (!passId) throw new PublicTestError(403, 'This link has expired. Scan the QR code on the screen again.', 'SCAN_AGAIN');
  if ((session.marks || []).some((mark) => mark.passId === passId)) {
    throw new PublicTestError(403, 'This scan has already marked someone. Scan the QR code on the screen again.', 'SCAN_AGAIN');
  }
  if (isGuest && !session.allowGuests) {
    throw new PublicTestError(403, 'This class accepts only college accounts. Sign in with your college email.');
  }

  // Faculty trying their own session have no SAP ID; everyone else needs one.
  let sapId = null;
  if (isGuest) {
    sapId = normalizeSapId(raw.sapId);
  } else if (user.role === 'student') {
    sapId = await sapIdForStudent(email, displayName(user), raw.sapId);
  }
  if ((session.marks || []).some((mark) => sameSapId(mark, sapId, isGuest))) {
    throw new PublicTestError(409, 'Attendance has already been marked for this SAP ID.');
  }

  let location = null;
  if (session.locationRequired) {
    const reading = classifyLocationCheck(session, raw);
    if (reading.distanceMeters === null) {
      throw new PublicTestError(403, 'Allow location access so your attendance can be checked against the classroom.', 'LOCATION_NEEDED');
    }
    if (reading.status === 'outOfRange') {
      throw new PublicTestError(403, `You are ${Math.round(reading.distanceMeters)} m from the classroom (allowed: ${session.locationRadiusMeters} m). Attendance can only be marked in class.`, 'OUT_OF_RANGE');
    }
    location = {
      status: reading.status === 'inRange' ? 'inside' : 'uncertain',
      distanceMeters: Math.round(reading.distanceMeters),
      accuracyMeters: Math.round(reading.accuracyMeters)
    };
  }

  const deviceId = typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId.slice(0, 64) : null;
  const deviceCookie = typeof req.signedCookies?.[DEVICE_COOKIE] === 'string' ? req.signedCookies[DEVICE_COOKIE] : null;
  const samePhone = (mark) => mark.status !== 'rejected'
    && ((deviceId && mark.deviceId === deviceId) || (deviceCookie && mark.deviceCookie === deviceCookie));
  const phoneUsed = () => new PublicTestError(409, 'This phone has already marked attendance for another student. Ask your teacher to add you.', 'PHONE_USED');
  if (session.oneMarkPerPhone && (session.marks || []).some(samePhone)) throw phoneUsed();

  const round = currentRound(session);
  const mark = {
    id: randomId(12),
    email,
    name: displayName(user),
    sapId,
    isGuest,
    status: 'pending',
    round: round.number,
    markedAt: now(),
    confirmedAt: null,
    rejectedAt: null,
    location,
    deviceId,
    deviceCookie,
    fingerprint: phoneFingerprint(raw.phone),
    passId
  };
  // Lands only while this round is still open, and nobody has marked this
  // account or SAP ID - or used this pass - in the meantime.
  const { modifiedCount } = await attendanceSessions().updateOne(
    {
      code: session.code,
      rounds: { $elemMatch: { number: round.number, closedAt: null } },
      'marks.email': { $ne: email },
      'marks.passId': { $ne: passId },
      $and: [noSapIdClash(sapId, isGuest), session.oneMarkPerPhone ? noPhoneClash(deviceId, deviceCookie) : {}]
    },
    { $push: { marks: mark } }
  );
  const latest = await requireSession(session.code);
  if (!modifiedCount && !myMark(latest, email)) {
    if (!isOpen(latest)) throw new PublicTestError(409, 'Attendance closed just before your mark arrived. Ask your teacher to take attendance again.', 'ATTENDANCE_CLOSED');
    if ((latest.marks || []).some((entry) => entry.passId === passId)) {
      throw new PublicTestError(403, 'This scan has already marked someone. Scan the QR code on the screen again.', 'SCAN_AGAIN');
    }
    if (latest.oneMarkPerPhone && (latest.marks || []).some(samePhone)) throw phoneUsed();
    throw new PublicTestError(409, 'Attendance has already been marked for this SAP ID.');
  }
  return view(latest);
}

/** A guest session, only for an open attendance session whose admin allows guests. */
export async function beginAttendanceGuest(res, raw = {}) {
  const session = await requireSession(raw.attendanceCode);
  if (!session.allowGuests) throw new PublicTestError(403, 'This class accepts only college accounts. Sign in with your college email to continue.');
  if (!isOpen(session)) throw new PublicTestError(403, 'Attendance for this class is closed.');
  return issueGuestSession(res, raw.name);
}
