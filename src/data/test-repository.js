import { registrations, tests } from '../db/index.js';
import { cachedJson, invalidateCached, serializeWrite } from '../coordination/index.js';
import { PublicTestError } from '../lib/errors.js';
import { hash, randomId } from '../lib/crypto.js';

/**
 * Where tests and their students are read and written.
 *
 * A test's settings and questions are one document in `tests`. Each student's
 * registration - with their paper, answers and log - is its own document in
 * `registrations`, keyed by { testCode, id }. The rest of the app still sees a
 * test as it always did, `test.registrations` and all: the functions here load
 * exactly the students a request needs and attach them, so a student's request
 * reads their own small document, and only the admin's views read the class.
 */

export const registrationCookie = (code) => `test_access_${code}`;
export const publicCode = () => `TEST-${randomId(5).toUpperCase()}`;

const normalizeCode = (code) => String(code || '').toUpperCase();
// A registration as the app knows it: without the collection's own bookkeeping.
const REGISTRATION_VIEW = { projection: { _id: 0, testCode: 0 } };
// A test as the app knows it. Only a test not yet moved to per-student
// documents still has the list inline; it is never read from there.
const TEST_VIEW = { projection: { registrations: 0 } };
const testCacheResource = (code) => `test-document:${normalizeCode(code)}`;

/** Shared, short-lived copy used only by high-volume student reads. */
export const cachedTestDocByCode = (code) => cachedJson(
  testCacheResource(code),
  () => tests().findOne({ code: normalizeCode(code) }, TEST_VIEW)
);

export const invalidateTestCache = (code) => invalidateCached(testCacheResource(code));

/** This test's students matching `filter`, in the order they registered. */
export const registrationsOf = (code, filter = {}) => registrations()
  .find({ testCode: normalizeCode(code), ...filter }, REGISTRATION_VIEW)
  .sort({ _id: 1 })
  .toArray();

const withRegistrations = async (test, filter) => {
  if (!test) return null;
  test.registrations = await registrationsOf(test.code, filter);
  return test;
};

/** The test with every student - what the admin's views and exports need. */
export async function testDocByCode(code, { withStudents = true } = {}) {
  const test = await tests().findOne({ code: normalizeCode(code) }, TEST_VIEW);
  return withStudents ? withRegistrations(test, {}) : test;
}

export async function requireTest(code, options) {
  const test = options?.withStudents === false
    ? await cachedTestDocByCode(code)
    : await testDocByCode(code, options);
  if (!test) throw new PublicTestError(404, 'This test link does not exist.');
  return test;
}

export const adminEmail = (req) => String(req.portalUser?.email || '').trim().toLowerCase();

/** A test is only visible in the admin portal of the account that created it. */
export async function requireOwnedTest(req, code, options) {
  const test = await testDocByCode(code, options);
  if (!test || test.ownerEmail !== adminEmail(req)) throw new PublicTestError(404, 'This test does not exist in your admin portal.');
  return test;
}

export const findRegistrationById = (test, registrationId) => (test.registrations || []).find((entry) => entry.id === registrationId);
export const findRegistrationByAttempt = (test, attemptId) => (test.registrations || []).find((entry) => entry.attempt?.id === attemptId);

/** The test (settings and questions) and one of its students. */
export async function requireOwnedRegistration(req, code, registrationId) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const [registration] = await registrationsOf(test.code, { id: String(registrationId ?? '') });
  if (!registration) throw new PublicTestError(404, 'Registration not found.');
  test.registrations = [registration];
  return { test, registration };
}

/**
 * Every test this email registered for, newest first, carrying only that
 * email's own registrations. Pass `code` to look at one test only.
 */
export async function testsForEmail(email, code = null) {
  const filter = { collegeEmail: email, ...(code ? { testCode: normalizeCode(code) } : {}) };
  const own = await registrations().find(filter, { projection: { _id: 0 } }).sort({ _id: 1 }).toArray();
  if (!own.length) return [];
  const codes = [...new Set(own.map((entry) => entry.testCode))];
  const docs = await tests().find({ code: { $in: codes } }, TEST_VIEW).sort({ createdAt: -1 }).toArray();
  return docs.map((test) => ({
    ...test,
    registrations: own.filter((entry) => entry.testCode === test.code).map(({ testCode: _code, ...entry }) => entry)
  }));
}

/** The latest submitted paper this email has on one test, or null. */
export async function submittedRegistrationFor(email, code) {
  const [test] = await testsForEmail(email, code);
  const registration = (test?.registrations || [])
    .filter((entry) => entry.attempt?.status === 'submitted')
    .sort((a, b) => new Date(b.attempt.submittedAt) - new Date(a.attempt.submittedAt))[0];
  return registration ? { test, registration } : null;
}

/** An attempt, its student and its test - read as two small documents. */
// Which test each attempt belongs to - that never changes - so the paper's
// every request (answers, moving on, the poll) can read the student's record
// and the test side by side instead of one after the other. Only a hint: the
// record read says which test it really is, and a wrong guess is read again.
const attemptTests = new Map();
const ATTEMPT_TESTS_MAX = 50_000;

export async function attemptContext(attemptId) {
  const id = String(attemptId || '');
  if (!id) return null;
  const guess = attemptTests.get(id);
  const [found, guessed] = await Promise.all([
    registrations().findOne({ 'attempt.id': id }, { projection: { _id: 0 } }),
    guess ? cachedTestDocByCode(guess) : null
  ]);
  if (!found?.attempt) return null;
  const { testCode, ...registration } = found;
  if (attemptTests.size >= ATTEMPT_TESTS_MAX) attemptTests.clear();
  attemptTests.set(id, testCode);
  const test = guessed && guessed.code === testCode ? guessed : await cachedTestDocByCode(testCode);
  if (!test) return null;
  test.registrations = [registration];
  return { test, registration, attempt: registration.attempt };
}

export const hasRegistrationCookie = (req, code) => Boolean(tokenFrom(req, code));
/** The seat this device's signed cookie names for a test ({ id, token }), or null. */
export const seatTokenFrom = (req, code) => tokenFrom(req, normalizeCode(code));

function tokenFrom(req, code) {
  const value = req.signedCookies?.[registrationCookie(code)];
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.id && parsed?.token ? parsed : null;
  } catch { return null; }
}

/**
 * A student reaches their own registration only with both halves: the signed
 * device cookie issued at registration and the matching signed-in session.
 */
export function registrationFor(req, test) {
  const token = tokenFrom(req, test.code);
  if (!token || !req.portalUser?.email) return null;
  const registration = (test.registrations || []).find((entry) => entry.id === token.id && entry.accessTokenHash === hash(token.token));
  return registration?.collegeEmail === String(req.portalUser.email).toLowerCase() ? registration : null;
}

/**
 * The test as one student's request needs it: everything about the test, but
 * only this device's own registration. `registrationFor` still does the full
 * token and account check on what comes back.
 */
export async function requireTestForStudent(req, code) {
  const normalized = normalizeCode(code);
  const token = tokenFrom(req, normalized);
  const [test, own] = await Promise.all([
    cachedTestDocByCode(normalized),
    token?.id ? registrationsOf(normalized, { id: String(token.id) }) : []
  ]);
  if (!test) throw new PublicTestError(404, 'This test link does not exist.');
  test.registrations = own;
  return test;
}

export function requireRegistration(req, test, mustBeApproved = false) {
  const registration = registrationFor(req, test);
  if (!registration) throw new PublicTestError(401, 'Register on this device before joining the test.');
  if (mustBeApproved && registration.status === 'rejected') {
    throw new PublicTestError(403, 'Your teacher has rejected your registration for this test, so you cannot continue it. Speak to them if this is wrong.', 'REJECTED');
  }
  if (mustBeApproved && registration.status !== 'approved') throw new PublicTestError(403, 'Your registration has not been approved yet.');
  return registration;
}

/**
 * Changes to one test that must not interleave run here one after another:
 * the test document's own writes, and the few checks across its students
 * that no single-document write can make atomic - "is this SAP ID free?"
 * before a seat is taken, for instance. Students' own writes (answers,
 * check-ins, submits) never queue here: each is an atomic update on that
 * student's document. The coordination layer uses a local queue in
 * development and Redis across multiple production processes.
 */
export const serializeTestWrite = (code, run) => serializeWrite(`test:${normalizeCode(code)}`, run);

/**
 * One student's paper: saving an answer and the admin's edit rewriting that
 * paper take turns. The rewrite is a compare-and-set over the whole paper,
 * and a student saving again and again could otherwise land a new answer in
 * every gap between its read and its write, until it gave up.
 */
export const serializePaperWrite = (code, registrationId, run) => serializeWrite(`paper:${normalizeCode(code)}:${registrationId}`, run);

/** A write to the test document itself (settings, start, end, questions). */
export const updateTest = (code, update) => serializeTestWrite(code, async () => {
  const result = await tests().updateOne({ code }, update);
  await invalidateTestCache(code);
  return result;
});

const registrationKey = (code, registrationId) => ({ testCode: normalizeCode(code), id: registrationId });

/** A plain update on one student's document; paths are relative to the registration. */
export const updateRegistration = (code, registrationId, update, options = {}) => registrations()
  .updateOne(registrationKey(code, registrationId), update, options);

export const updateRegistrationFields = (code, registrationId, fields) => updateRegistration(code, registrationId, { $set: fields });

const prefixKeys = (object, prefix) => Object.fromEntries(Object.entries(object).map(([key, value]) => [`${prefix}${key}`, value]));

export const updateAttemptFields = (code, registrationId, fields) => updateRegistrationFields(code, registrationId, prefixKeys(fields, 'attempt.'));

/**
 * A compare-and-set on one attempt: the update lands only while the attempt
 * still matches `expect` (paths relative to the attempt, e.g. `{ status:
 * 'in_progress' }`). A submit racing an answer, or two presence events racing
 * each other, must never overwrite one another. Resolves to whether it applied.
 *
 * `update` is a normal MongoDB update whose paths are relative to the attempt,
 * e.g. `{ $inc: { fullscreenExitCount: 1 } }`.
 */
export async function updateAttemptWhere(code, registrationId, expect, update, options = {}) {
  const operations = Object.fromEntries(Object.entries(update).map(([operator, fields]) => [operator, prefixKeys(fields, 'attempt.')]));
  const result = await registrations().updateOne(
    { ...registrationKey(code, registrationId), ...prefixKeys(expect, 'attempt.') },
    operations,
    options
  );
  return result.matchedCount === 1;
}

/** One update across many of a test's students; `filter` and paths relative to the registration. */
export const updateRegistrationsWhere = (code, filter, update, options = {}) => registrations()
  .updateMany({ testCode: normalizeCode(code), ...filter }, update, options);

/**
 * Takes a seat - a new registration - only if nobody on this test matches
 * `taken` (e.g. the same email, or an active seat with the same SAP ID).
 * The check and the insert run in this test's queue, so two students racing
 * for the same SAP ID cannot both get it; the unique index on the email is
 * the database's own guarantee on top. Resolves to whether the seat was taken.
 */
export function insertRegistrationUnless(code, taken, registration) {
  const testCode = normalizeCode(code);
  return serializeTestWrite(testCode, async () => {
    if (await registrations().findOne({ testCode, ...taken }, { projection: { _id: 1 } })) return false;
    try {
      await registrations().insertOne({ testCode, ...registration });
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  });
}

/** Every student of a test goes with it. */
export const deleteRegistrationsOf = (code) => registrations().deleteMany({ testCode: normalizeCode(code) });
