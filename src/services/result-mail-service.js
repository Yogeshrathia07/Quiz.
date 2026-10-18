import { config } from '../config.js';
import { registrations, resultMailSends } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { iso, now } from '../lib/time.js';
import { mailConfigured, sendMail } from '../lib/mailer.js';
import { isGuestAccount } from '../auth/portal-auth.js';
import { adminEmail, requireOwnedTest, testDocByCode } from '../data/test-repository.js';
import { mailAllowance } from '../data/mail-allowance.js';
import { studentResponseData, timeTakenSeconds } from '../domain/presenters.js';
import { buildResultMail, resultMailOptions } from '../domain/result-mail.js';
import { resultAnalysisImageFor } from '../domain/result-mail-image.js';
import { responsesAvailable, resultSummary } from './attempt-service.js';
import { classStats, standingIn } from './overview-service.js';
import { paperMarks, paperScore } from '../domain/marks.js';

/**
 * Results by email, once the marks are out: the teacher picks the students
 * (Email results on the dashboard) and each gets their own marks - and, as
 * chosen, their answers, the correct answers and how the class did
 * (domain/result-mail.js).
 *
 * A student can be emailed only when they can already see these marks
 * themselves: the test closed, the marks released to them (with short answers
 * marked, unless the teacher showed marks before marking was done), and an
 * email to send to - a guest has none.
 *
 * Each registration keeps its email's state in `resultMail`: queued, sending,
 * sent or failed, when, and what went wrong. Queued emails count against the
 * day's allowance at once (data/mail-allowance.js), so a class never takes
 * more than its share, and sign-in codes keep theirs; who did not fit today
 * stays "not emailed" for another day. They go out one at a time in the
 * background (drainResultMails), each claimed by one write so two servers
 * never send the same email; one cut off mid-send by a restart is marked
 * failed, not sent again blindly - the teacher sends it again if it did not
 * arrive. The scheduler starts the sending again after a restart.
 */

const MAX_PER_REQUEST = 1000;
const INTERRUPTED_MS = 10 * 60_000;
const PENDING = ['queued', 'sending'];

const optionsFrom = resultMailOptions;

/** Whether the test's marks are out to students: why not, or null. */
function testProblem(test) {
  if (!test.isClosed) return 'Close the test first: results go out once it is over and the marks are released.';
  if (test.resultReleaseMode === 'admin' && !test.resultsReleasedAt) return 'Release the marks first: students must be able to see them.';
  return null;
}

/** Whether this student can be emailed their results now: why not, or null. */
function studentProblem(test, registration) {
  const attempt = registration.attempt;
  if (attempt?.status !== 'submitted') return 'No paper handed in';
  if (registration.accountType === 'guest' || isGuestAccount(registration.collegeEmail)) return 'Guest - no email';
  if (!responsesAvailable(test, attempt)) return 'Marks not out yet';
  if (!resultSummary(test, attempt).released) return 'Still to be marked';
  return null;
}

const mailState = (registration) => (registration.resultMail ? {
  status: registration.resultMail.status,
  at: iso(registration.resultMail.sentAt || registration.resultMail.failedAt || registration.resultMail.queuedAt),
  error: registration.resultMail.error || null
} : null);

/** The class, for the Email results dialog: each paper handed in, its marks, and its email so far. */
export async function resultMailList(req, code) {
  const test = await requireOwnedTest(req, code);
  const rows = (test.registrations || [])
    .filter((registration) => registration.attempt?.status === 'submitted')
    .map((registration) => {
      const summary = resultSummary(test, registration.attempt);
      const problem = studentProblem(test, registration);
      return {
        id: registration.id,
        name: registration.fullName,
        email: problem === 'Guest - no email' ? null : registration.collegeEmail,
        sapId: registration.sapId || null,
        score: summary.score ?? null,
        totalMarks: summary.totalMarks ?? null,
        percent: summary.totalMarks > 0 ? Math.round((summary.score / summary.totalMarks) * 100) : null,
        canEmail: !problem,
        reason: problem,
        mail: mailState(registration)
      };
    });
  return {
    test: { code: test.code, title: test.title },
    problem: testProblem(test),
    allowance: await mailAllowance(),
    // 'ready': Brevo sends them; 'log': no Brevo key on a development server - printed to its log
    // instead (lib/mailer.js); 'off': no key in production - nothing can be sent.
    mail: mailConfigured() ? 'ready' : process.env.NODE_ENV === 'production' ? 'off' : 'log',
    students: rows
  };
}

/** One student's email as it would go out - the dialog's preview. */
export async function resultMailPreview(req, code, raw = {}) {
  const test = await requireOwnedTest(req, code);
  const registration = (test.registrations || []).find((entry) => entry.id === String(raw.registrationId || ''));
  if (!registration) throw new PublicTestError(404, 'That student is not on this test.');
  if (registration.attempt?.status !== 'submitted') throw new PublicTestError(409, 'This student has not handed in a paper.');
  const mail = await composeMail(test, registration, optionsFrom(raw.options), req.portalUser?.displayName || '');
  return { to: studentProblem(test, registration) === 'Guest - no email' ? null : registration.collegeEmail, ...mail };
}

/**
 * Queues the email for the students chosen (`registrationIds`), with the
 * dialog's `options`. Only those who can be emailed now, and are not already
 * waiting, are queued - as many as today's allowance has room for.
 */
export async function queueResultMails(req, code, raw = {}) {
  const ids = Array.isArray(raw.registrationIds) ? [...new Set(raw.registrationIds.map(String))] : [];
  if (!ids.length) throw new PublicTestError(400, 'Choose the students to email.');
  if (ids.length > MAX_PER_REQUEST) throw new PublicTestError(400, `Choose at most ${MAX_PER_REQUEST} students at a time.`);
  const test = await requireOwnedTest(req, code);
  const problem = testProblem(test);
  if (problem) throw new PublicTestError(409, problem);
  const chosen = new Set(ids);
  const ready = (test.registrations || []).filter((registration) => chosen.has(registration.id)
    && !studentProblem(test, registration) && !PENDING.includes(registration.resultMail?.status));
  const allowance = await mailAllowance();
  if (ready.length && !allowance.left) {
    throw new PublicTestError(429, 'Today\'s emails are used up. Try again tomorrow - nobody was emailed twice.');
  }
  const options = optionsFrom(raw.options);
  const teacher = String(req.portalUser?.displayName || '').slice(0, 120);
  let queued = 0;
  for (const registration of ready.slice(0, allowance.left)) {
    const result = await registrations().updateOne(
      { testCode: test.code, id: registration.id, 'resultMail.status': { $nin: PENDING } },
      { $set: { resultMail: { status: 'queued', queuedAt: now(), by: adminEmail(req), teacher, options } } }
    );
    queued += result.modifiedCount;
  }
  if (queued) kickResultMails();
  return {
    queued,
    // Chosen and ready, but past today's allowance: still "not emailed", for another day.
    overLimit: Math.max(0, ready.length - allowance.left),
    // Chosen but not emailable now (a guest, marks not out, already on its way).
    skipped: ids.length - ready.length,
    allowance: await mailAllowance()
  };
}

async function composeMail(test, registration, options, teacher) {
  const data = studentResponseData(test, registration);
  const summary = resultSummary(test, registration.attempt);
  // The class, for the rank (always) and the average and highest mark (as chosen) - as on
  // the student's own result page (registration-service myResponseView): numbers only.
  const stats = await classStats(test).catch((error) => {
    // Never quietly: without the class, the email goes out with no rank and no class line.
    console.error('Class figures for a results email failed:', test.code, error?.message);
    return null;
  });
  const worth = paperMarks(test, registration.attempt);
  const standing = stats && stats.papers >= 1
    ? standingIn(stats, worth ? (paperScore(registration.attempt) / worth) * 100 : 0, timeTakenSeconds(registration.attempt)) : null;
  // Full class loaded above; one cached image per class-statistics snapshot,
  // never one render per recipient. An opted-in image must not silently vanish.
  const analysisImage = options.analysisImage ? await resultAnalysisImageFor(test, stats) : null;
  return buildResultMail({
    paper: { title: test.title, code: test.code },
    student: { name: registration.fullName },
    marks: { score: summary.score ?? data.summary.score, totalMarks: summary.totalMarks ?? data.summary.totalMarks, pendingMarks: summary.pendingMarks || 0, pendingManual: summary.pendingManual || 0 },
    answers: data.answers,
    rank: standing ? { rank: standing.rank, papers: standing.papers } : null,
    classStats: options.classStats ? stats : null,
    analysisImage,
    options,
    teacher,
    // The faculty member who owns the test: students can write to them.
    teacherEmail: test.ownerEmail || '',
    link: config.publicBaseUrl ? `${config.publicBaseUrl}/?result=${encodeURIComponent(test.code)}` : '',
    submittedAt: registration.attempt?.submittedAt,
    takenSeconds: timeTakenSeconds(registration.attempt)
  });
}

/** Sends one claimed email, and records how it went. */
async function sendClaimed(claimed) {
  const key = { testCode: claimed.testCode, id: claimed.id, 'resultMail.status': 'sending' };
  const fail = (error) => registrations().updateOne(key, { $set: { 'resultMail.status': 'failed', 'resultMail.failedAt': now(), 'resultMail.error': error } });
  try {
    const test = await testDocByCode(claimed.testCode);
    const registration = test?.registrations?.find((entry) => entry.id === claimed.id);
    if (!test || !registration) return await fail('The test or the student is no longer there.');
    // Checked again now: the marks may have been taken back since it was queued.
    const problem = testProblem(test) || studentProblem(test, registration);
    if (problem) return await fail(`Not sent: ${problem.toLowerCase()}.`);
    const mail = await composeMail(test, registration, optionsFrom(claimed.resultMail?.options), claimed.resultMail?.teacher || '');
    await sendMail({ to: registration.collegeEmail, ...mail });
    await resultMailSends().insertOne({ testCode: test.code, registrationId: registration.id, createdAt: now() });
    await registrations().updateOne(key, { $set: { 'resultMail.status': 'sent', 'resultMail.sentAt': now(), 'resultMail.error': null } });
  } catch (error) {
    console.error('Results email failed:', claimed.testCode, claimed.id, error?.message);
    await fail('Could not be sent. Try again in a little while.').catch(() => {});
  }
  return null;
}

let draining = null;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Sends every queued email, one at a time; resolves when none is left. */
export async function drainResultMails({ gapMs = config.resultMail.gapMs } = {}) {
  // Cut off mid-send (a restart): it may have gone out, so it is never sent again on its own.
  await registrations().updateMany(
    { 'resultMail.status': 'sending', 'resultMail.claimedAt': { $lt: new Date(Date.now() - INTERRUPTED_MS) } },
    { $set: { 'resultMail.status': 'failed', 'resultMail.failedAt': now(), 'resultMail.error': 'Interrupted while sending. Send it again if it did not arrive.' } }
  );
  let sent = 0;
  for (;;) {
    const claimed = await registrations().findOneAndUpdate(
      { 'resultMail.status': 'queued' },
      { $set: { 'resultMail.status': 'sending', 'resultMail.claimedAt': now() } },
      { sort: { 'resultMail.queuedAt': 1 }, returnDocument: 'after', projection: { _id: 0, testCode: 1, id: 1, resultMail: 1 } }
    );
    if (!claimed) return sent;
    await sendClaimed(claimed);
    sent += 1;
    if (gapMs > 0) await pause(gapMs);
  }
}

/** Starts sending in the background, unless this server is already at it. */
export function kickResultMails() {
  if (!draining) {
    draining = drainResultMails().catch((error) => console.error('Results emails stopped:', error?.message)).finally(() => { draining = null; });
  }
  return draining;
}
