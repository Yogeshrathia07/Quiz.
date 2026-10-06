import { registrations, studentProfiles, tests } from '../db/index.js';
import { config } from '../config.js';
import { PublicTestError } from '../lib/errors.js';
import { hash, randomId } from '../lib/crypto.js';
import { iso, now } from '../lib/time.js';
import { cleanText, isSapId, normalizeSapId } from '../domain/test-builder.js';
import { publicTest, studentResponseData, timeTakenSeconds } from '../domain/presenters.js';
import { integrityRecord } from '../domain/integrity.js';
import {
  adminEmail, insertRegistrationUnless, registrationCookie, registrationFor, registrationsOf, requireTest, requireTestForStudent, seatTokenFrom,
  submittedRegistrationFor, testsForEmail, updateRegistration, updateRegistrationFields
, GUEST_SEATS, STUDENT_SEATS
} from '../data/test-repository.js';
import {
  GUEST_EMAIL_DOMAIN, hasLiveSession, isGuestAccount, issueSession, normalizeEmail, roleForEmail
} from '../auth/portal-auth.js';
import { finalizeAttempt, responsesAvailable, resultSummary } from './attempt-service.js';
import { startIfDue } from './test-lifecycle.js';

const isDuplicateKey = (error) => error?.code === 11000;

/**
 * A registration as its student sees it. A pending one says when it expires
 * if nobody approves it (the scheduler's expireStaleRequests takes it then).
 */
function studentRegistration(registration, name = registration.fullName) {
  const minutes = Number(config.pendingRequestMinutes);
  const pendingUntil = registration.status === 'pending' && Number.isFinite(minutes) && minutes > 0 && registration.requestedAt
    ? new Date(new Date(registration.requestedAt).getTime() + minutes * 60_000)
    : null;
  return { name, status: registration.status, requestedAt: iso(registration.requestedAt), expiresAt: iso(pendingUntil) };
}

/** 'student', 'faculty' or 'guest' - who is sitting this test, as the dashboard shows it. */
export function accountTypeOf(user) {
  if (isGuestAccount(user?.email)) return 'guest';
  return user?.role === 'admin' ? 'faculty' : 'student';
}

/**
 * A SAP ID is written once per student account and then reused for every test,
 * so a student can never sit two tests under two different IDs. A profile saved
 * before SAP IDs became nine digits long is treated as unset and replaced.
 */
export async function sapIdForStudent(email, displayName, rawSapId) {
  const profile = await studentProfiles().findOne({ email });
  if (isSapId(profile?.sapId)) return profile.sapId;
  const sapId = normalizeSapId(rawSapId);
  try {
    if (profile) {
      await studentProfiles().updateOne({ email }, { $set: { sapId, displayName, updatedAt: now() } });
    } else {
      await studentProfiles().insertOne({ email, displayName, sapId, createdAt: now(), updatedAt: now() });
    }
    return sapId;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const current = await studentProfiles().findOne({ email });
    if (isSapId(current?.sapId)) return current.sapId;
    throw new PublicTestError(409, 'This SAP ID is already linked to another student account.');
  }
}

/**
 * Issues a temporary guest session, but only for a test whose admin allowed
 * guests. The admin's per-test toggle is the only gate: a guest session is
 * never handed out "in general", only for the test in front of the visitor.
 */
export async function beginGuestSession(res, raw = {}) {
  const test = await requireTest(raw.testCode, { withStudents: false });
  if (!test.allowGuests) throw new PublicTestError(403, 'This test accepts only college accounts. Sign in with your college email to continue.');
  if (test.isClosed) throw new PublicTestError(403, 'This test has been completed and is no longer accepting registrations.');
  return issueGuestSession(res, raw.name);
}

/** The guest account itself; each caller decides first whether guests are allowed. */
export async function issueGuestSession(res, rawName) {
  const name = cleanText(rawName, 'Guest name', 2, 100);
  const account = {
    email: `guest-${randomId(10).toLowerCase()}@${GUEST_EMAIL_DOMAIN}`,
    name: `Guest: ${name}`,
    // Guests get student-level test access only; the admin role is never
    // issued here, and their registration still needs approval.
    role: 'student'
  };
  await issueSession(res, account);
  return { user: { email: account.email, name: account.name, role: account.role, isGuest: true } };
}

/**
 * A guest's seat ends when they leave: whatever they answered is submitted -
 * so the admin still has it, with its start and finish times - and the SAP ID
 * is free again. Coming back as a guest with the same SAP ID starts a new
 * paper from the beginning, recorded alongside the old one.
 */
async function endGuestRegistration(test, registration) {
  if (registration.exitedAt) return;
  if (registration.attempt?.status === 'in_progress') await finalizeAttempt(test, registration);
  await updateRegistrationFields(test.code, registration.id, { exitedAt: now() });
}

/** Called when a guest signs out: ends every seat they still hold. */
export async function endGuestVisit(email) {
  const address = normalizeEmail(email);
  if (!isGuestAccount(address)) return;
  const seats = await registrations().find({ collegeEmail: address, exitedAt: null }, { projection: { _id: 0 } }).toArray();
  for (const { testCode, ...registration } of seats) {
    const test = await tests().findOne({ code: testCode }, { projection: { registrations: 0 } });
    if (test) await endGuestRegistration(test, registration);
  }
}

/**
 * A guest who closed the browser never signs out, and their seat would hold
 * the SAP ID for good. Once their session is gone - it lasts 12 hours, or ends
 * at sign-out - that seat is ended the same way, and the ID is free.
 */
async function releaseAbandonedGuestSeats(test, sapId) {
  const holders = (await registrationsOf(test.code, { sapId, exitedAt: null })).filter((entry) => isGuestAccount(entry.collegeEmail));
  for (const registration of holders) {
    if (!(await hasLiveSession(registration.collegeEmail))) await endGuestRegistration(test, registration);
  }
}

export async function studentProfile(req) {
  const email = normalizeEmail(req.portalUser?.email);
  const profile = email && !isGuestAccount(email) ? await studentProfiles().findOne({ email }) : null;
  return { profile: profile && isSapId(profile.sapId) ? { sapId: profile.sapId } : null };
}

/**
 * A student with no SAP ID on file sets it here, once. After that it is
 * fixed for them: only an administrator can change it (see the admin and
 * user services), so a student can never swap identities between tests.
 */
export async function setMySapId(req, raw = {}) {
  const email = normalizeEmail(req.portalUser?.email);
  if (req.portalUser?.role !== 'student' || isGuestAccount(email)) {
    throw new PublicTestError(403, 'Only student accounts have a SAP ID.');
  }
  if (isSapId((await studentProfiles().findOne({ email }))?.sapId)) {
    throw new PublicTestError(409, 'Your SAP ID is already saved. Only an administrator can change it.');
  }
  const displayName = cleanText(req.portalUser?.displayName || email, 'Account name', 2, 120);
  return { profile: { sapId: await sapIdForStudent(email, displayName, raw.sapId) } };
}

/** The public view of a test link, plus this device's own registration if any. */
export async function getTest(req, code) {
  // Polled by every waiting student until the test starts. The page asks
  // again the moment a scheduled countdown ends, so it may start the test.
  let test = await requireTestForStudent(req, code);
  if (await startIfDue(test)) test = await requireTestForStudent(req, code);
  const registration = registrationFor(req, test);
  return {
    // The countdowns run on the server's clock, not the phone's.
    serverTime: new Date().toISOString(),
    test: {
      ...publicTest(test),
      locationLatitude: test.locationLatitude ?? null,
      locationLongitude: test.locationLongitude ?? null,
      // The test's own creator may preview it from any window; everyone else
      // who sits it - students, guests and other faculty - follows its rules.
      isOwner: Boolean(test.ownerEmail) && test.ownerEmail === adminEmail(req)
    },
    registration: registration
      ? studentRegistration(registration)
      : null,
    attemptId: registration?.attempt?.id || null
  };
}

export async function registerForTest(req, res, code, raw) {
  const test = await requireTest(code, { withStudents: false });
  const collegeEmail = normalizeEmail(req.portalUser?.email);
  // Only the students this request is about: this device's seat, and any
  // seat this account already holds on the test.
  const seatId = seatTokenFrom(req, test.code)?.id;
  test.registrations = await registrationsOf(test.code, { $or: [{ collegeEmail }, ...(seatId ? [{ id: String(seatId) }] : [])] });
  if (test.isClosed) throw new PublicTestError(403, 'This test has been completed and is no longer accepting registrations.');
  if (registrationFor(req, test)) return getTest(req, code);

  const fullName = cleanText(req.portalUser?.displayName, 'Account name', 2, 120);
  const accountType = accountTypeOf(req.portalUser);
  // Who may register is the admin's per-test choice: verified UPES accounts
  // always, plus guests when that test allows them.
  if (accountType === 'guest') {
    if (!test.allowGuests) throw new PublicTestError(403, 'Guest registrations are disabled for this test. Sign in with your college email instead.');
  } else if (!roleForEmail(collegeEmail)) {
    throw new PublicTestError(403, 'Only college accounts can register for a test.');
  }

  const existing = (test.registrations || []).find((entry) => entry.collegeEmail === collegeEmail);
  if (existing) {
    // A private window forgets this device's seat when it closes. The same
    // signed-in student may move their seat here; the old browser loses it.
    if (raw.continueHere === true && accountType !== 'guest') return moveSeatHere(res, test, existing);
    throw new PublicTestError(409, 'You are already registered for this test in another browser or device.', 'OTHER_DEVICE');
  }

  // Faculty have no SAP ID. A student's is kept on their profile. A guest's is
  // typed each time and never saved. Each is compared only with its own kind
  // (see GUEST_SEATS): a guest may use a SAP ID a registered student has.
  let sapId = null;
  let taken = { collegeEmail };
  if (accountType === 'student') {
    sapId = await sapIdForStudent(collegeEmail, fullName, raw.sapId);
    taken = { $or: [{ collegeEmail }, { sapId, exitedAt: null, ...STUDENT_SEATS }] };
  } else if (accountType === 'guest') {
    sapId = normalizeSapId(raw.sapId);
    await releaseAbandonedGuestSeats(test, sapId);
    taken = { $or: [{ collegeEmail }, { sapId, exitedAt: null, ...GUEST_SEATS }] };
  }

  const token = randomId();
  const registration = {
    id: randomId(18),
    fullName,
    collegeEmail,
    sapId,
    accountType,
    status: 'pending',
    accessTokenHash: hash(token),
    requestedAt: now(),
    decidedAt: null,
    exitedAt: null,
    locationVerifiedAt: null,
    locationDistanceMeters: null,
    locationOverride: false,
    attempt: null
  };
  if (!(await insertRegistrationUnless(test.code, taken, registration))) {
    throw new PublicTestError(409, 'Someone is already sitting this test with that SAP ID.');
  }

  setSeatCookie(res, test.code, registration.id, token);
  return {
    test: publicTest(test),
    registration: studentRegistration({ ...registration, status: 'pending' }, fullName),
    attemptId: null
  };
}

const setSeatCookie = (res, code, id, token) => res.cookie(registrationCookie(code), JSON.stringify({ id, token }), {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  signed: true,
  maxAge: 14 * 24 * 60 * 60 * 1000
});

/**
 * Moves a student's existing seat to this browser: a new device token, so
 * the old browser can no longer open the paper. Every move is counted and,
 * once the paper has started, written to its activity log.
 */
async function moveSeatHere(res, test, registration) {
  const token = randomId();
  const movedAt = now();
  const update = { $set: { accessTokenHash: hash(token) }, $inc: { deviceSwitches: 1 } };
  if (registration.attempt) {
    update.$push = { 'attempt.events': { $each: [{ type: 'device_changed', createdAt: movedAt, durationMs: null, detail: null }], $slice: -200 } };
  }
  await updateRegistration(test.code, registration.id, update);
  setSeatCookie(res, test.code, registration.id, token);
  return {
    test: publicTest(test),
    registration: studentRegistration(registration),
    attemptId: registration.attempt?.id || null,
    moved: true
  };
}

/**
 * Every test this account has registered for, newest first, with the marks
 * wherever that test's release policy allows them to be shown. A test its
 * teacher has archived is left out, whatever stage it reached.
 */
export async function myResults(req) {
  const email = normalizeEmail(req.portalUser?.email);
  const docs = (await testsForEmail(email)).filter((test) => !test.archivedAt);
  return {
    results: docs.flatMap((test) => (test.registrations || []).map((registration) => {
      const attempt = registration.attempt;
      const summary = attempt?.status === 'submitted' ? resultSummary(test, attempt) : null;
      return {
        code: test.code,
        title: test.title,
        registrationStatus: registration.status,
        attemptStatus: attempt?.status || null,
        // Ended with no paper begun: missed, not "not started".
        testClosed: Boolean(test.isClosed),
        startedAt: iso(attempt?.startedAt),
        submittedAt: iso(attempt?.submittedAt),
        timeTakenSeconds: timeTakenSeconds(attempt),
        timesLeft: attempt ? integrityRecord(attempt).leaveCount : 0,
        totalQuestions: attempt?.questions?.length || 0,
        released: Boolean(summary?.released),
        score: summary?.released ? summary.score : null,
        // Out of the paper's full marks, which can differ from its number of questions.
        totalMarks: summary?.released ? summary.totalMarks : null,
        message: summary && !summary.released ? summary.message : '',
        // Why the marks are not shown yet: 'admin' (waiting for release),
        // 'after_quiz' (shown when the test ends) or 'manual' (being marked).
        waitingFor: summary && !summary.released ? summary.releaseMode : null,
        pendingManual: summary?.pendingManual || 0,
        canDownload: Boolean(summary?.canDownload)
      };
    }))
  };
}

/**
 * The signed-in student's own answers on one test, for the Excel download.
 * Built fresh on each request, so a sheet downloaded while short answers were
 * still unmarked shows their marks when downloaded again.
 */
export async function myResponseData(req, code) {
  const found = await submittedRegistrationFor(normalizeEmail(req.portalUser?.email), code);
  if (!found) throw new PublicTestError(404, 'You have no submitted attempt for this test.');
  if (!responsesAvailable(found.test, found.registration.attempt)) {
    throw new PublicTestError(403, 'Your responses can be downloaded once the test is closed and results are released.');
  }
  return studentResponseData(found.test, found.registration);
}

/**
 * The same paper to read on the page rather than download: each question with
 * their answer, the key and the mark - under the same rule as the download
 * (the test closed and its marks released), and nothing else of the record.
 */
export async function myResponseView(req, code) {
  const data = await myResponseData(req, code);
  return {
    test: { code: data.test.code, title: data.test.title },
    summary: data.summary,
    answers: data.answers.map((answer) => ({
      questionNumber: answer.questionNumber,
      type: answer.type,
      prompt: answer.prompt,
      image: answer.image,
      selectedAnswer: answer.selectedAnswer,
      correctAnswer: answer.correctAnswer,
      answered: answer.answered,
      marks: answer.marks,
      maxMarks: answer.maxMarks,
      isCorrect: answer.isCorrect,
      partial: answer.partial,
      manualGrading: answer.manualGrading
    }))
  };
}
