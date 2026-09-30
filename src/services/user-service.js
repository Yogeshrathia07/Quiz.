import { accounts, attendanceSessions, blockedEmails, otpCodes, portalSessions, registrations, studentProfiles } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { iso, now } from '../lib/time.js';
import { isAllowedEmail, normalizeEmail, revokeSessionsFor, roleForEmail } from '../auth/portal-auth.js';
import { cleanText, normalizeSapId } from '../domain/test-builder.js';
import { studentResponseData, timeTakenSeconds } from '../domain/presenters.js';
import { integrityRecord } from '../domain/integrity.js';
import { STUDENT_SEATS, serializeTestWrite, testsForEmail } from '../data/test-repository.js';
import { pendingManualCount, responsesAvailable } from './attempt-service.js';

/**
 * The Users page: every account, plus the blocked list, which is kept apart
 * from accounts so deleting an account never lifts a block.
 * Deleting or blocking never touches test records: marks already earned stay
 * on the tests they belong to.
 */
export async function listUsers() {
  const [accountDocs, blockedDocs] = await Promise.all([
    accounts().find().sort({ createdAt: -1 }).toArray(),
    blockedEmails().find().sort({ blockedAt: -1 }).toArray()
  ]);
  const emails = accountDocs.map((account) => account._id);
  const profiles = new Map((await studentProfiles().find({ email: { $in: emails } }).toArray()).map((profile) => [profile.email, profile]));
  const blocked = new Set(blockedDocs.map((entry) => entry._id));
  return {
    accounts: accountDocs.map((account) => ({
      email: account._id,
      name: account.displayName,
      role: account.role === 'admin' ? 'faculty' : 'student',
      sapId: profiles.get(account._id)?.sapId || null,
      createdAt: iso(account.createdAt),
      lastSignInAt: iso(account.lastSignInAt),
      hasPassword: Boolean(account.passwordHash),
      blocked: blocked.has(account._id)
    })),
    blocked: blockedDocs.map((entry) => ({
      email: entry._id, reason: entry.reason || '', blockedAt: iso(entry.blockedAt), blockedBy: entry.blockedBy
    }))
  };
}

function targetEmail(req, raw) {
  const email = normalizeEmail(raw);
  if (!isAllowedEmail(email)) throw new PublicTestError(400, 'Enter a valid college email address.');
  if (email === normalizeEmail(req.portalUser?.email)) throw new PublicTestError(409, 'You cannot do this to your own account.');
  return email;
}

/**
 * Removes the account and its password, signs it out everywhere, and clears
 * the saved SAP ID so a mistyped one can be entered again. The person can
 * create a new account unless blocked.
 */
export async function deleteUser(req, rawEmail) {
  const email = targetEmail(req, rawEmail);
  await Promise.all([
    accounts().deleteOne({ _id: email }),
    studentProfiles().deleteOne({ email }),
    otpCodes().deleteOne({ _id: email }),
    revokeSessionsFor(email)
  ]);
  return listUsers();
}

/**
 * Signs the person out and refuses every login, code and Microsoft sign-in
 * until unblocked. The account itself is kept, so unblocking restores it.
 */
export async function blockUser(req, rawEmail, raw = {}) {
  const email = targetEmail(req, rawEmail);
  const reason = String(raw.reason ?? '').trim().slice(0, 200);
  await blockedEmails().updateOne(
    { _id: email },
    { $set: { reason, blockedAt: now(), blockedBy: normalizeEmail(req.portalUser?.email) } },
    { upsert: true }
  );
  await Promise.all([otpCodes().deleteOne({ _id: email }), revokeSessionsFor(email)]);
  return listUsers();
}

export async function unblockUser(req, rawEmail) {
  await blockedEmails().deleteOne({ _id: normalizeEmail(rawEmail) });
  return listUsers();
}

/**
 * One person as the Users page opens them: their account, SAP ID, and every
 * test they have sat - whoever's test it was - with the raw mark whether or
 * not it has been released to them yet.
 */
export async function userDetail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const [account, profile, blocked, docs] = await Promise.all([
    accounts().findOne({ _id: email }),
    studentProfiles().findOne({ email }),
    blockedEmails().findOne({ _id: email }),
    testsForEmail(email)
  ]);
  if (!account && !docs.length) throw new PublicTestError(404, 'No account or test record was found for this email.');
  const role = roleForEmail(email) === 'student' ? 'student' : 'faculty';
  return {
    user: {
      email,
      name: account?.displayName || docs[0]?.registrations?.[0]?.fullName || email,
      role,
      sapId: profile?.sapId || null,
      createdAt: iso(account?.createdAt),
      lastSignInAt: iso(account?.lastSignInAt),
      hasPassword: Boolean(account?.passwordHash),
      hasAccount: Boolean(account),
      blocked: Boolean(blocked)
    },
    results: docs.flatMap((test) => (test.registrations || []).map((registration) => {
      const attempt = registration.attempt;
      const submitted = attempt?.status === 'submitted';
      return {
        code: test.code,
        title: test.title,
        ownerEmail: test.ownerEmail,
        registrationId: registration.id,
        // Prefer the time the test actually began. A scheduled test that has
        // not begun yet still has its planned date, and an older test falls
        // back to when it was created so every row remains searchable.
        testDate: iso(test.startedAt || test.opensAt || test.createdAt),
        testEndsAt: iso(test.endsAt || test.closesAt),
        sapId: registration.sapId || null,
        registrationStatus: registration.status,
        attemptStatus: attempt?.status || null,
        startedAt: iso(attempt?.startedAt),
        submittedAt: iso(attempt?.submittedAt),
        timeTakenSeconds: timeTakenSeconds(attempt),
        timesLeft: attempt ? integrityRecord(attempt).leaveCount : 0,
        totalQuestions: attempt?.questions?.length || 0,
        answered: (attempt?.answers || []).filter((answer) => answer.answeredAt).length,
        score: submitted ? (attempt.answers || []).reduce((total, answer) => total + (Number(answer.isCorrect) || 0), 0) : null,
        pendingManual: submitted ? pendingManualCount(test, attempt) : 0,
        testClosed: Boolean(test.isClosed),
        visibleToStudent: submitted && responsesAvailable(test, attempt)
      };
    }))
  };
}

/**
 * An administrator sets or corrects a student's SAP ID. It is saved to their
 * profile - where the student can no longer change it themselves - and
 * written onto every test registration they hold, so exports stay in step.
 */
export async function setUserSapId(req, rawEmail, raw = {}) {
  const email = normalizeEmail(rawEmail);
  if (roleForEmail(email) !== 'student') throw new PublicTestError(409, 'Only student accounts have a SAP ID.');
  const sapId = normalizeSapId(raw.sapId);
  const clash = await registrations().findOne(
    { sapId, collegeEmail: { $ne: email }, exitedAt: null, ...STUDENT_SEATS },
    { projection: { testCode: 1 } }
  );
  if (clash) throw new PublicTestError(409, `Another student already uses this SAP ID on test ${clash.testCode}.`);
  const displayName = (await accounts().findOne({ _id: email }))?.displayName || email;
  try {
    await studentProfiles().updateOne(
      { email },
      { $set: { sapId, displayName, updatedAt: now(), updatedBy: normalizeEmail(req.portalUser?.email) }, $setOnInsert: { createdAt: now() } },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code === 11000) throw new PublicTestError(409, 'This SAP ID is already linked to another student account.');
    throw error;
  }
  // Written onto every registration this person holds, test by test in each
  // test's queue - where seats are taken - so no one registers with it meanwhile.
  const codes = await registrations().distinct('testCode', { collegeEmail: email });
  for (const code of codes) {
    await serializeTestWrite(code, () => registrations().updateMany({ testCode: code, collegeEmail: email }, { $set: { sapId } }));
  }
  return userDetail(email);
}

/**
 * An administrator corrects someone's name. It changes everywhere the name is
 * shown - the account and profile, their signed-in sessions, every test they
 * are registered for, every attendance mark they made - so lists and exports
 * agree. From then on it is theirs to keep: signing in with Microsoft no
 * longer overwrites it with the name Microsoft has (see signInAccount).
 */
export async function setUserName(req, rawEmail, raw = {}) {
  const email = normalizeEmail(rawEmail);
  const name = cleanText(raw.name, 'Name', 2, 120);
  if (!(await accounts().findOne({ _id: email }, { projection: { _id: 1 } }))) {
    throw new PublicTestError(404, 'There is no account with this email.');
  }
  const changedAt = now();
  const by = normalizeEmail(req.portalUser?.email);
  await accounts().updateOne({ _id: email }, { $set: { displayName: name, nameSetBy: by, nameSetAt: changedAt } });
  await studentProfiles().updateOne({ email }, { $set: { displayName: name, updatedAt: changedAt, updatedBy: by } });
  await portalSessions().updateMany({ email }, { $set: { displayName: name } });
  const codes = await registrations().distinct('testCode', { collegeEmail: email });
  for (const code of codes) {
    await serializeTestWrite(code, () => registrations().updateMany({ testCode: code, collegeEmail: email }, { $set: { fullName: name } }));
  }
  await attendanceSessions().updateMany({ 'marks.email': email }, { $set: { 'marks.$[mark].name': name } }, { arrayFilters: [{ 'mark.email': email }] });
  return userDetail(email);
}

/**
 * A user manager's export for one exact submitted registration. The optional
 * ID keeps the export tied to the row the manager clicked, even if an older
 * test happens to contain more than one attempt for the same account.
 */
export async function userResponseData(rawEmail, code, registrationId = null) {
  const email = normalizeEmail(rawEmail);
  const [test] = await testsForEmail(email, code);
  const submitted = (test?.registrations || []).filter((entry) => entry.attempt?.status === 'submitted');
  const registration = registrationId
    ? submitted.find((entry) => entry.id === String(registrationId))
    : submitted.sort((left, right) => new Date(right.attempt.submittedAt) - new Date(left.attempt.submittedAt))[0];
  if (!registration) throw new PublicTestError(404, 'This person has no submitted attempt for this test.');
  return studentResponseData(test, registration);
}
