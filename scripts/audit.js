/**
 * Deep audit: every branch of the rules that decide who may write what, and
 * when. Unlike `regression-check.js`, which walks one happy path end to end,
 * this drives each edge case on purpose - expired windows, extensions, wrong
 * students, wrong admins, locked and submitted attempts, malformed answers -
 * and reports every failure rather than stopping at the first.
 *
 * Run with `npm run audit` against the MongoDB in MONGODB_URI.
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { closeDatabase, initializeDatabase, portalSessions, registrations, studentProfiles, tests } from '../src/db/index.js';
import { attemptContext, testDocByCode } from '../src/data/test-repository.js';
import { PublicTestError } from '../src/lib/errors.js';
import { config } from '../src/config.js';
import { END_GRACE_MS, isTimeOver } from '../src/domain/attempt-rules.js';
import { extendedEndMs } from '../client/src/lib/quiz.js';
import { createTest, testQrSvg, updateTestSettings } from '../src/services/test-service.js';
import { beginGuestSession, getTest, registerForTest, studentProfile } from '../src/services/registration-service.js';
import {
  attemptResult, getAttempt, recordFullscreenEvent, saveAnswer, startAttempt, submitAttemptForStudent
} from '../src/services/attempt-service.js';
import {
  adminDashboard, adminExportData, adminTests, bulkDecision, closeTest, csvForAdmin, decideRegistration,
  deleteTest, gradeManualAnswer, manualReview, registrationAnalysis, releaseResults, resetTest,
  restartAllAttempts, restartAttempt, resumeAttempt, setLocationOverride, setTestEndTime, startTest,
  updateStudentSapId
} from '../src/services/admin-service.js';
import {
  authStatus, portalSessionMiddleware, requireAdmin, requireTestTaker
} from '../src/auth/portal-auth.js';
import { buildTestSpreadsheet } from '../src/export/spreadsheet.js';

// These checks cover the lock rules, which are off by default (LOCK_ON_EXIT).
config.lockOnExit = true;
// The audit deliberately time-travels by editing MongoDB directly. Those
// fixture-only writes do not publish the invalidation a real service write
// does, so bypass caching for this process.
config.redis.testCacheMs = 0;

/* ----------------------------------------------------------------- harness */

const run = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const results = [];
const createdCodes = [];
const profileEmails = [];
let sapCounter = 100_000_000 + (Date.now() % 800_000_000);
const nextSapId = () => String(sapCounter++);

let group = 'general';
const section = (name) => { group = name; };

async function check(name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
  } catch (error) {
    results.push({ group, name, ok: false, error: error.message });
  }
}

/** Asserts the action rejects with a PublicTestError carrying `status`. */
async function rejects(action, status) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof PublicTestError, `expected PublicTestError, got ${error.name}: ${error.message}`);
    assert.equal(error.status, status, `expected HTTP ${status}, got ${error.status}: ${error.message}`);
    return true;
  });
}

const minutes = (n) => n * 60_000;
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function cookieJar() {
  const cookies = new Map();
  return { cookies, cookie(name, value) { cookies.set(name, value); }, clearCookie(name) { cookies.delete(name); } };
}

const admin = (suffix = '') => ({
  portalUser: { email: `audit-admin-${suffix || 'a'}-${run}@ddn.${config.allowedDomain}`, displayName: 'Audit Admin', role: 'admin' }
});
const student = (suffix) => {
  const email = `audit-${suffix}-${run}@${config.studentDomain}`;
  profileEmails.push(email);
  return { portalUser: { email, displayName: `Audit Student ${suffix}`, role: 'student' } };
};

const ADMIN = admin();
const OTHER_ADMIN = admin('other');

function testPayload(overrides = {}) {
  const { questions, ...rest } = overrides;
  return {
    title: `Audit ${run}`,
    instructions: 'Audit coverage.',
    opensAt: at(0),
    questionMix: { mcq: 2, msq: 0, short: 0 },
    fullscreenExitLimit: 0,
    fullscreenAbsenceLimitSeconds: 0,
    shuffleQuestions: true,
    allowGuests: false,
    locationRequired: false,
    resultReleaseMode: 'instant',
    questions: questions || [
      { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['1'] },
      { prompt: 'Which structure is LIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['0'] },
      { prompt: 'Pick the HTTP methods.', type: 'msq', options: ['GET', 'POST', 'FETCH'], correctOptions: ['0', '1'] },
      { prompt: 'Explain a queue.', type: 'short' }
    ],
    ...rest
  };
}

async function newTest(overrides = {}, owner = ADMIN) {
  const created = await createTest(owner, testPayload(overrides));
  createdCodes.push(created.test.code);
  return created.test;
}

/** Registers a student on a test and returns a request carrying their cookie. */
async function enrol(code, who, { approve = true } = {}) {
  const jar = cookieJar();
  await registerForTest(who, jar, code, { sapId: nextSapId() });
  const doc = await testDocByCode(code);
  const registration = doc.registrations.find((entry) => entry.collegeEmail === who.portalUser.email);
  if (approve) await decideRegistration(ADMIN, code, registration.id, 'approve');
  return {
    registration,
    req: { ...who, signedCookies: { [`test_access_${code}`]: jar.cookies.get(`test_access_${code}`) } }
  };
}

/** A test that is already started, with one approved student mid-attempt. */
async function liveTest(overrides = {}, who = student(`s${sapCounter}`)) {
  const test = await newTest(overrides);
  const seat = await enrol(test.code, who);
  await startTest(ADMIN, test.code);
  const attempt = await startAttempt(seat.req, test.code);
  return { test, seat, attempt };
}

const answerFirst = (attempt, optionIndex = 0) => ({
  questionId: attempt.questions[0].id,
  selectedOptions: [attempt.questions[0].options[optionIndex].id]
});

/* ------------------------------------------------------------------ audit */

await initializeDatabase();
try {
  /* ============================================ 1. the end-time policy ==== */
  section('end time');

  await check('an attempt that outlives the end time reports timeOver, unsubmitted', async () => {
    const { seat, test } = await liveTest({ opensAt: at(-minutes(60)), endsAt: at(minutes(60)) });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 1_000) } });
    const attempt = await getAttempt(seat.req, test.code);
    assert.equal(attempt.timeOver, true);
    assert.equal(attempt.status, 'in_progress', 'an expired window must not auto-submit');
  });

  await check('a test whose window already lapsed cannot be started', async () => {
    // Otherwise Start "succeeds" and leaves a test nobody can sit.
    const test = await newTest({ opensAt: at(-minutes(120)), endsAt: at(minutes(60)) });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - minutes(60)) } });
    await rejects(() => startTest(ADMIN, test.code), 409);
    assert.equal((await adminDashboard(ADMIN, test.code)).test.isStarted, false, 'and it really did not start');

    await setTestEndTime(ADMIN, test.code, { addMinutes: 30 });
    assert.equal((await startTest(ADMIN, test.code)).test.isStarted, true, 'extending makes it startable');
  });

  await check('a reset test with a lapsed window is caught at Start, not silently', async () => {
    const { test } = await liveTest({ opensAt: at(-minutes(120)), endsAt: at(minutes(60)) });
    await closeTest(ADMIN, test.code);
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - 1_000) } });

    const reset = await resetTest(ADMIN, test.code);
    assert.equal(reset.test.isStarted, false);
    await rejects(() => startTest(ADMIN, test.code), 409);
  });

  await check('a student who never started cannot pick up a fresh paper after the end time', async () => {
    // Every question would be blank, so without this they would receive a whole
    // test at one shot per question, long after everyone else had finished.
    const test = await newTest({ opensAt: at(-minutes(120)), endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`late${sapCounter}`));
    await startTest(ADMIN, test.code);
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - 1_000) } });

    await rejects(() => startAttempt(seat.req, test.code), 403);

    // Extending the time is how an admin lets a latecomer in.
    await setTestEndTime(ADMIN, test.code, { addMinutes: 10 });
    assert.equal((await startAttempt(seat.req, test.code)).status, 'in_progress');
  });

  await check('a student already sitting the test is untouched by that rule', async () => {
    const { seat, test, attempt } = await liveTest({ endsAt: at(minutes(60)) });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - 1_000) } });
    // startAttempt is what the student's page calls on reload; it must keep
    // returning their paper rather than refusing them.
    const again = await startAttempt(seat.req, test.code);
    assert.equal(again.id, attempt.id);
    assert.equal(again.status, 'in_progress');
    assert.equal(again.timeOver, true);
  });

  await check('before the end time any answer can be rewritten repeatedly', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    let view = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    view = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] });
    assert.deepEqual(view.questions[0].selectedOptions, [question.options[1].id]);
    assert.equal(view.questions[0].locked, false);
    assert.equal((await getAttempt(seat.req, test.code)).timeOver, false);
  });

  await check('clearing an answer before the end time makes it blank again', async () => {
    const { seat, attempt } = await liveTest({ endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    const view = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [] });
    assert.equal(view.questions[0].answered, false);
    assert.equal(view.answeredQuestionCount, 0);
  });

  await check('a cleared answer is still answerable after the end time', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [] });
    await setTestEndTime(ADMIN, test.code, { endsAt: at(-1_000) }).catch(() => undefined);
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - 1_000) } });
    const view = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] });
    assert.deepEqual(view.questions[0].selectedOptions, [question.options[1].id]);
  });

  await check('after the end time the UI locks, while queued answers still land during grace', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    const [first, second] = attempt.questions;
    await saveAnswer(seat.req, attempt.id, { questionId: first.id, selectedOptions: [first.options[0].id] });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - 1_000) } });

    const view = await getAttempt(seat.req, test.code);
    assert.equal(view.questions.find((q) => q.id === first.id).locked, true);
    assert.equal(view.questions.every((q) => q.locked), true);

    await saveAnswer(seat.req, attempt.id, { questionId: first.id, selectedOptions: [first.options[1].id] });
    await saveAnswer(seat.req, attempt.id, { questionId: second.id, selectedOptions: [second.options[0].id] });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 1_000) } });
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: second.id, selectedOptions: [second.options[1].id] }), 409);
  });

  await check('a student may still submit after the end time', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    await saveAnswer(seat.req, attempt.id, answerFirst(attempt));
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 1_000) } });
    const submitted = await submitAttemptForStudent(seat.req, attempt.id);
    assert.equal(submitted.status, 'submitted');
  });

  await check('the deadline is shared: a late starter inherits it, not a fresh clock', async () => {
    const test = await newTest({ endsAt: at(minutes(3)) });
    const early = await enrol(test.code, student(`early${sapCounter}`));
    const late = await enrol(test.code, student(`late${sapCounter}`));
    await startTest(ADMIN, test.code);
    const a = await startAttempt(early.req, test.code);
    const b = await startAttempt(late.req, test.code);
    assert.equal(a.deadlineAt, b.deadlineAt, 'both students stop at the same instant');
    assert.ok(Date.parse(a.deadlineAt) - Date.now() <= minutes(3) + 5_000);
  });

  /* ============================================ 2. extending the time ==== */
  section('extend');

  await check('extending thaws every answer the freeze had made final', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 1_000) } });
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] }), 409);

    await setTestEndTime(ADMIN, test.code, { addMinutes: 30 });
    const view = await getAttempt(seat.req, test.code);
    assert.equal(view.timeOver, false);
    assert.equal(view.questions.every((q) => !q.locked), true);
    const rewritten = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] });
    assert.deepEqual(rewritten.questions[0].selectedOptions, [question.options[1].id]);
  });

  await check('addMinutes counts from now when the window has already lapsed', async () => {
    const test = await newTest({ opensAt: at(-minutes(120)), endsAt: at(minutes(60)) });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - minutes(60)) } });
    const before = Date.now();
    const updated = await setTestEndTime(ADMIN, test.code, { addMinutes: 10 });
    const end = Date.parse(updated.test.endsAt);
    assert.ok(end >= before + minutes(10) - 2_000, `expected ~10 minutes from now, got ${new Date(end).toISOString()}`);
    assert.ok(end <= before + minutes(10) + 5_000);
  });

  await check('addMinutes extends from the current end when it is still ahead', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const original = Date.parse(test.endsAt);
    const updated = await setTestEndTime(ADMIN, test.code, { addMinutes: 15 });
    assert.equal(Date.parse(updated.test.endsAt), original + minutes(15));
  });

  await check('an explicit end time is stored exactly, including milliseconds', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const target = new Date(Date.now() + minutes(42) + 123);
    const updated = await setTestEndTime(ADMIN, test.code, { endsAt: target.toISOString() });
    assert.equal(Date.parse(updated.test.endsAt), target.getTime());
  });

  await check('the end time can be pulled in, which re-freezes the paper', async () => {
    const { seat, attempt, test } = await liveTest({ opensAt: at(-minutes(30)), endsAt: at(minutes(60)) });
    await saveAnswer(seat.req, attempt.id, answerFirst(attempt));
    await setTestEndTime(ADMIN, test.code, { endsAt: at(100) });
    await wait(150);
    const view = await getAttempt(seat.req, test.code);
    assert.equal(view.timeOver, true);
    assert.equal(view.questions[0].locked, true);
  });

  await check('extending works before the test is started', async () => {
    const test = await newTest({ endsAt: at(minutes(30)) });
    const updated = await setTestEndTime(ADMIN, test.code, { addMinutes: 10 });
    assert.equal(updated.test.isStarted, false);
    assert.equal(Date.parse(updated.test.endsAt), Date.parse(test.endsAt) + minutes(10));
  });

  await check('a closed test cannot be extended', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(60)) });
    await closeTest(ADMIN, test.code);
    await rejects(() => setTestEndTime(ADMIN, test.code, { addMinutes: 10 }), 409);
  });

  await check('invalid extensions are refused', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await rejects(() => setTestEndTime(ADMIN, test.code, { addMinutes: 0 }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, { addMinutes: -5 }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, { addMinutes: 1441 }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, { addMinutes: 1.5 }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, { endsAt: 'tomorrow' }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, { endsAt: at(-minutes(600)) }), 400);
    await rejects(() => setTestEndTime(ADMIN, test.code, {}), 400);
  });

  await check('only the owning admin can move the end time', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await rejects(() => setTestEndTime(OTHER_ADMIN, test.code, { addMinutes: 10 }), 404);
  });

  /* ================================================ 3. window validation == */
  section('window');

  await check('creating a test with an end time before the start is refused', async () => {
    await rejects(() => createTest(ADMIN, testPayload({ opensAt: at(minutes(10)), endsAt: at(0) })), 400);
    await rejects(() => createTest(ADMIN, testPayload({ opensAt: at(0), endsAt: at(0) })), 400);
  });

  await check('a window longer than 30 days is refused', async () => {
    await rejects(() => createTest(ADMIN, testPayload({ opensAt: at(0), endsAt: at(31 * 24 * 60 * minutes(1)) })), 400);
  });

  await check('with no end time given the window falls back to the estimate', async () => {
    const test = await newTest({ opensAt: at(0), endsAt: undefined, questionMix: { mcq: 1, msq: 0, short: 1 } });
    assert.equal(test.estimatedSeconds, 60 + 120);
    assert.equal(Date.parse(test.endsAt) - Date.parse(test.opensAt), test.estimatedSeconds * 1000);
  });

  await check('a window shorter than the estimate is allowed', async () => {
    // One clock reading for both ends: two separate `at()` calls can straddle a millisecond.
    const base = Date.now();
    const test = await newTest({
      opensAt: new Date(base).toISOString(), endsAt: new Date(base + minutes(1)).toISOString(), questionMix: { mcq: 2, msq: 1, short: 1 }
    });
    assert.ok(test.estimatedSeconds > 60, 'the estimate really is longer than the window');
    assert.equal(Date.parse(test.endsAt) - Date.parse(test.opensAt), minutes(1));
  });

  await check('editing an unrelated setting keeps the chosen end time', async () => {
    const chosen = at(minutes(90));
    const test = await newTest({ endsAt: chosen });
    const updated = await updateTestSettings(ADMIN, test.code, { title: `Renamed ${run}` });
    assert.equal(Date.parse(updated.test.endsAt), Date.parse(chosen));
  });

  await check('changing the question mix keeps the chosen end time but moves the estimate', async () => {
    const chosen = at(minutes(90));
    const test = await newTest({ endsAt: chosen, questionMix: { mcq: 1, msq: 0, short: 0 } });
    const updated = await updateTestSettings(ADMIN, test.code, { questionMix: { mcq: 2, msq: 1, short: 1 } });
    assert.equal(Date.parse(updated.test.endsAt), Date.parse(chosen), 'the admin’s end time is not recalculated away');
    assert.equal(updated.test.questionCount, 4);
    assert.ok(updated.test.estimatedSeconds > test.estimatedSeconds);
  });

  await check('moving the start past the end rebuilds the window from the estimate', async () => {
    const test = await newTest({ opensAt: at(0), endsAt: at(minutes(5)) });
    const newStart = at(minutes(120));
    const updated = await updateTestSettings(ADMIN, test.code, { opensAt: newStart });
    assert.equal(Date.parse(updated.test.endsAt), Date.parse(newStart) + updated.test.estimatedSeconds * 1000);
  });

  await check('a running test still accepts the edits that cannot change a paper', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(60)) });
    const edited = await updateTestSettings(ADMIN, test.code, {
      title: `Renamed mid-test ${run}`,
      instructions: 'Read carefully.',
      fullscreenExitLimit: 5,
      fullscreenAbsenceLimitSeconds: 25,
      allowGuests: true,
      resultReleaseMode: 'admin'
    });
    assert.equal(edited.test.title, `Renamed mid-test ${run}`);
    assert.equal(edited.test.fullscreenExitLimit, 5);
    assert.equal(edited.test.fullscreenAbsenceLimitSeconds, 25);
    assert.equal(edited.test.allowGuests, true);
    assert.equal(edited.test.resultReleaseMode, 'admin');
    assert.equal(edited.test.isStarted, true, 'and it is still running');
  });

  await check('a running test refuses anything that would change a paper', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(60)) });
    await rejects(() => updateTestSettings(ADMIN, test.code, { questionMix: { mcq: 1, msq: 0, short: 0 } }), 409);
    await rejects(() => updateTestSettings(ADMIN, test.code, { questionCount: 1 }), 409);
    await rejects(() => updateTestSettings(ADMIN, test.code, { shuffleQuestions: false }), 409);
    await rejects(() => updateTestSettings(ADMIN, test.code, { opensAt: at(minutes(5)) }), 409);
    // The paper is untouched by the refusals.
    const after = await adminDashboard(ADMIN, test.code);
    assert.equal(after.test.questionCount, test.questionCount);
    assert.equal(after.test.shuffleQuestions, test.shuffleQuestions);
  });

  await check('a running test keeps its end time through an unrelated edit', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(60)) });
    const edited = await updateTestSettings(ADMIN, test.code, { title: `Kept end ${run}` });
    assert.equal(Date.parse(edited.test.endsAt), Date.parse(test.endsAt));
    const extended = await setTestEndTime(ADMIN, test.code, { addMinutes: 5 });
    assert.ok(Date.parse(extended.test.endsAt) > Date.parse(test.endsAt));
  });

  await check('a completed test refuses setup edits until it is reset', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(60)) });
    await closeTest(ADMIN, test.code);
    await rejects(() => updateTestSettings(ADMIN, test.code, { title: 'After the end' }), 409);
    await resetTest(ADMIN, test.code);
    const edited = await updateTestSettings(ADMIN, test.code, { title: `Reset then edited ${run}` });
    assert.equal(edited.test.title, `Reset then edited ${run}`);
  });

  /* ================================================== 4. questions/student = */
  section('questions per student');

  await check('the mix decides how many questions land on the paper', async () => {
    const { attempt } = await liveTest({ questionMix: { mcq: 2, msq: 1, short: 1 }, endsAt: at(minutes(60)) });
    assert.equal(attempt.questions.length, 4);
    assert.equal(attempt.totalQuestions, 4);
    const types = attempt.questions.map((q) => q.type).sort();
    assert.deepEqual(types, ['mcq', 'mcq', 'msq', 'short']);
  });

  await check('asking for more questions of a type than the bank holds is refused', async () => {
    await rejects(() => createTest(ADMIN, testPayload({ questionMix: { mcq: 3, msq: 0, short: 0 } })), 400);
    await rejects(() => createTest(ADMIN, testPayload({ questionMix: { mcq: 0, msq: 0, short: 0 } })), 400);
    await rejects(() => createTest(ADMIN, testPayload({ questionMix: { mcq: -1, msq: 0, short: 0 } })), 400);
    await rejects(() => createTest(ADMIN, testPayload({ questionMix: 'two' })), 400);
  });

  await check('the admin gets a timing pool to recalculate the estimate locally', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const dashboard = await adminDashboard(ADMIN, test.code);
    assert.deepEqual(dashboard.test.questionPool, { mcq: 2, msq: 1, short: 1 });
    assert.equal('questionTimingPool' in dashboard.test, false, 'per-question timings are gone');
  });

  await check('each student gets a reproducible paper; a restart keeps it', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 2, msq: 1, short: 1 }, endsAt: at(minutes(60)) });
    const ids = attempt.questions.map((q) => q.id);
    assert.deepEqual((await getAttempt(seat.req, test.code)).questions.map((q) => q.id), ids);
    await restartAttempt(ADMIN, test.code, seat.registration.id);
    const after = await getAttempt(seat.req, test.code);
    assert.deepEqual(after.questions.map((q) => q.id), ids);
    assert.equal(after.answeredQuestionCount, 0, 'a restart clears the answers');
  });

  await check('shuffled options stay a complete permutation of the real options', async () => {
    const { attempt } = await liveTest({ questionMix: { mcq: 2, msq: 1, short: 0 }, endsAt: at(minutes(60)) });
    for (const question of attempt.questions.filter((q) => q.type !== 'short')) {
      const ids = question.options.map((o) => o.id).sort();
      assert.deepEqual(ids, [...new Set(ids)], 'no duplicate option ids');
      assert.equal(question.options.every((o) => typeof o.text === 'string' && o.text.length > 0), true);
    }
  });

  /* ==================================================== 5. answer writing == */
  section('answers');

  await check('an MCQ refuses more than one selection', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await rejects(() => saveAnswer(seat.req, attempt.id, {
      questionId: question.id, selectedOptions: question.options.map((o) => o.id)
    }), 400);
  });

  await check('an MSQ accepts several selections', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 0, msq: 1, short: 0 }, endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    const view = await saveAnswer(seat.req, attempt.id, {
      questionId: question.id, selectedOptions: [question.options[0].id, question.options[1].id]
    });
    assert.equal(view.questions[0].selectedOptions.length, 2);
  });

  await check('an option id that is not on the question is refused', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: attempt.questions[0].id, selectedOptions: ['99'] }), 400);
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: attempt.questions[0].id, selectedOptions: 'nope' }), 400);
  });

  await check('a question that is not on this paper is refused', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: 9_999, selectedOptions: ['0'] }), 404);
    await rejects(() => saveAnswer(seat.req, attempt.id, { questionId: null, selectedOptions: ['0'] }), 404);
  });

  await check('a short answer over 4,000 characters is refused', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 0, msq: 0, short: 1 }, endsAt: at(minutes(60)) });
    await rejects(() => saveAnswer(seat.req, attempt.id, {
      questionId: attempt.questions[0].id, answerText: 'x'.repeat(4_001)
    }), 400);
    const ok = await saveAnswer(seat.req, attempt.id, { questionId: attempt.questions[0].id, answerText: 'x'.repeat(4_000) });
    assert.equal(ok.questions[0].answered, true);
  });

  await check('whitespace-only short answers count as blank', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 0, msq: 0, short: 1 }, endsAt: at(minutes(60)) });
    const view = await saveAnswer(seat.req, attempt.id, { questionId: attempt.questions[0].id, answerText: '   ' });
    assert.equal(view.questions[0].answered, false);
  });

  await check('writing to a submitted attempt changes nothing', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    await submitAttemptForStudent(seat.req, attempt.id);
    const view = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] });
    assert.equal(view.status, 'submitted');
    const stored = await attemptContext(attempt.id);
    const answer = stored.attempt.answers.find((a) => a.questionId === question.id);
    assert.deepEqual(answer.selectedOptions, [question.options[0].id], 'the submitted answer is untouched');
  });

  /* =============================================== 6. attempt integrity === */
  section('integrity');

  await check('the fullscreen exit limit locks the attempt and hides the paper', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 1, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: 'tab_switch' });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 10 });
    const locked = await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: 'tab_switch' });
    assert.equal(locked.attempt.isLocked, true);
    assert.equal(locked.attempt.questions, undefined, 'a locked attempt must not leak question text');
    await rejects(() => saveAnswer(seat.req, attempt.id, answerFirst(attempt)), 423);
    await rejects(() => submitAttemptForStudent(seat.req, attempt.id), 423);
    assert.equal((await getAttempt(seat.req, test.code)).isLocked, true);
  });

  await check('the absence limit locks on a long return', async () => {
    const { seat, attempt } = await liveTest({ fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 5, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit' });
    const back = await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 6_000 });
    assert.equal(back.attempt.isLocked, true);
  });

  await check('malformed fullscreen events are refused', async () => {
    const { seat, attempt } = await liveTest({ endsAt: at(minutes(60)) });
    await rejects(() => recordFullscreenEvent(seat.req, attempt.id, { type: 'wat' }), 400);
    await rejects(() => recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: -1 }), 400);
  });

  await check('reviving unlocks without moving the end time; restarting keeps it too', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 1, endsAt: at(minutes(60)) });
    const endBefore = (await testDocByCode(test.code)).endsAt.getTime();
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit' });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 10 });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit' });
    await resumeAttempt(ADMIN, test.code, seat.registration.id);
    assert.equal((await testDocByCode(test.code)).endsAt.getTime(), endBefore);
    const view = await getAttempt(seat.req, test.code);
    assert.equal(view.isLocked, false);
    assert.equal(view.fullscreenExitCount, 0, 'the counters are cleared');
    assert.equal(Date.parse(view.deadlineAt), endBefore, 'the deadline is untouched');

    await restartAttempt(ADMIN, test.code, seat.registration.id);
    assert.equal(Date.parse((await getAttempt(seat.req, test.code)).deadlineAt), endBefore);
  });

  await check('reviving an unlocked or submitted attempt is refused', async () => {
    const { seat, attempt, test } = await liveTest({ endsAt: at(minutes(60)) });
    await rejects(() => resumeAttempt(ADMIN, test.code, seat.registration.id), 409);
    await submitAttemptForStudent(seat.req, attempt.id);
    await rejects(() => resumeAttempt(ADMIN, test.code, seat.registration.id), 409);
  });

  const storedAttempt = async (attemptId) => (await attemptContext(attemptId)).attempt;
  const backdateAway = (code, attemptId, ms) => registrations().updateOne(
    { testCode: code, 'attempt.id': attemptId },
    { $set: { 'attempt.awaySince': new Date(Date.now() - ms) } }
  );

  await check('leaving is recorded even when the test allows unlimited leaving', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 0, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: 'tab_switch' });
    const back = await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 4_000 });
    assert.equal(back.attempt.isLocked, false);
    const row = (await adminDashboard(ADMIN, test.code)).registrations[0];
    assert.equal(row.integrity.leaveCount, 1);
    assert.equal(row.integrity.leaves.tab_switch, 1);
    assert.ok(row.integrity.awayMs >= 4_000);
  });

  await check('a second exit while already away is the same departure', async () => {
    const { seat, attempt } = await liveTest({ fullscreenExitLimit: 0, endsAt: at(minutes(60)) });
    await Promise.all(['fullscreen', 'tab_switch', 'fullscreen', 'focus_lost'].map((detail) => (
      recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail })
    )));
    const stored = await storedAttempt(attempt.id);
    assert.equal(stored.fullscreenExitCount, 1);
    assert.equal(stored.integrity.leaveCount, 1);
  });

  await check('unknown leave reasons cannot write arbitrary counter fields', async () => {
    const { seat, attempt } = await liveTest({ fullscreenExitLimit: 0, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: '$where.injected' });
    const stored = await storedAttempt(attempt.id);
    assert.deepEqual(Object.keys(stored.integrity.leaves), ['fullscreen']);
    await rejects(() => recordFullscreenEvent(seat.req, attempt.id, { type: 'flag', detail: 'constructor' }), 400);
  });

  await check('the server does not accept "away for 0 seconds" when it saw the departure', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 20, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit' });
    await backdateAway(test.code, attempt.id, 30_000);
    const back = await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 0 });
    assert.equal(back.attempt.isLocked, true, 'thirty seconds away breaks a twenty second limit');
  });

  await check('a student who leaves and never returns is locked once the away limit passes', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 10, endsAt: at(minutes(60)) });
    await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: 'tab_switch' });
    assert.equal((await getAttempt(seat.req, test.code)).isLocked, false, 'not yet');
    await backdateAway(test.code, attempt.id, 15_000);
    const view = await getAttempt(seat.req, test.code);
    assert.equal(view.isLocked, true);
    assert.equal((await storedAttempt(attempt.id)).integrity.lockCount, 1);
  });

  await check('copy and paste are recorded but never lock', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 1, endsAt: at(minutes(60)) });
    const flagged = await recordFullscreenEvent(seat.req, attempt.id, { type: 'flag', detail: 'paste' });
    assert.equal(flagged.attempt.isLocked, false);
    assert.equal((await adminDashboard(ADMIN, test.code)).registrations[0].integrity.flags.paste, 1);
  });

  await check('reviving clears the lock counters but keeps the lifetime record', async () => {
    const { seat, attempt, test } = await liveTest({ fullscreenExitLimit: 2, endsAt: at(minutes(60)) });
    for (let round = 0; round < 3; round += 1) {
      await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit', detail: 'fullscreen' });
      if (round < 2) await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 1_000 });
    }
    await resumeAttempt(ADMIN, test.code, seat.registration.id);
    assert.equal((await getAttempt(seat.req, test.code)).fullscreenExitCount, 0);
    const row = (await adminDashboard(ADMIN, test.code)).registrations[0];
    assert.equal(row.integrity.leaveCount, 3, 'every departure is still on the record');
    assert.equal(row.integrity.lockCount, 1);

    await restartAttempt(ADMIN, test.code, seat.registration.id);
    assert.equal((await adminDashboard(ADMIN, test.code)).registrations[0].integrity.leaveCount, 3, 'and survive a restart');
    const analysis = await registrationAnalysis(ADMIN, test.code, seat.registration.id);
    assert.ok(analysis.integrity.timeline.some((event) => event.type === 'attempt_locked'));
    const exported = await adminExportData(ADMIN, test.code);
    assert.ok(exported.integrityLog.length >= 5, 'every event reaches the export');
    assert.ok(csvForAdmin(exported).includes('Times left the test (total)'));
  });

  await check('the event log stays bounded while the counters keep counting', async () => {
    const { seat, attempt } = await liveTest({ fullscreenExitLimit: 0, endsAt: at(minutes(60)) });
    for (let round = 0; round < 110; round += 1) {
      await recordFullscreenEvent(seat.req, attempt.id, { type: 'exit' });
      await recordFullscreenEvent(seat.req, attempt.id, { type: 'return', durationMs: 10 });
    }
    const stored = await storedAttempt(attempt.id);
    assert.ok(stored.events.length <= 200, `log has ${stored.events.length} entries`);
    assert.equal(stored.integrity.leaveCount, 110);
  });

  /* ========================================= 6a. no end time ============= */
  section('untimed');

  await check('a test with no end time never runs out, and only Close ends it', async () => {
    const { seat, attempt, test } = await liveTest({ untimed: true, questionMix: { mcq: 1, msq: 0, short: 0 } });
    const stored = await testDocByCode(test.code);
    assert.equal(stored.untimed, true);
    assert.equal(stored.endsAt, null);
    assert.equal(attempt.untimed, true);
    assert.equal(attempt.deadlineAt, null);
    assert.equal(attempt.timeOver, false);
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    const changed = await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[1].id] });
    assert.equal(changed.questions[0].locked, false, 'answers stay editable');
    await closeTest(ADMIN, test.code);
    assert.equal((await getAttempt(seat.req, test.code)).status, 'submitted', 'Close submits the open paper');
  });

  await check('a latecomer can still start a test with no end time', async () => {
    const test = await newTest({ untimed: true, opensAt: at(-minutes(600)) });
    const seat = await enrol(test.code, student(`u${sapCounter}`));
    await startTest(ADMIN, test.code);
    const attempt = await startAttempt(seat.req, test.code);
    assert.equal(attempt.status, 'in_progress');
  });

  await check('extending a test with no end time gives it one, counted from now', async () => {
    const test = await newTest({ untimed: true });
    const before = Date.now();
    await setTestEndTime(ADMIN, test.code, { addMinutes: 10 });
    const stored = await testDocByCode(test.code);
    assert.equal(stored.untimed, false);
    assert.ok(stored.endsAt.getTime() >= before + minutes(10) - 1_000);
  });

  await check('a timed test can be switched to no end time and back in setup', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await updateTestSettings(ADMIN, test.code, { untimed: true });
    assert.equal((await testDocByCode(test.code)).endsAt, null);
    await updateTestSettings(ADMIN, test.code, { untimed: false });
    const stored = await testDocByCode(test.code);
    assert.equal(stored.untimed, false);
    assert.ok(stored.endsAt instanceof Date, 'falls back to start + estimate');
  });

  await check('the export carries the overview, answer grid and question analysis', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] });
    await submitAttemptForStudent(seat.req, attempt.id);
    const data = await adminExportData(ADMIN, test.code);
    assert.ok(data.questionBank.length > 0);
    assert.ok(data.responses.every((response) => response.registrationId && response.startedAt));
    const { buildTestSpreadsheet } = await import('../src/export/spreadsheet.js');
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildTestSpreadsheet(data));
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name),
      ['Overview', 'Results', 'Answer grid', 'Question analysis', 'Responses', 'Integrity log', 'Activity log']);
    const grid = workbook.getWorksheet('Answer grid');
    assert.equal(grid.getCell('A6').value, seat.registration.fullName);
    assert.match(String(grid.getRow(6).values.slice(4).find(Boolean)), /[✓✗]$/, 'the student’s answer carries its mark');
  });

  /* ============================================= 6b. many at once ======== */
  section('concurrency');

  await check('two simultaneous starts give the student one paper, not two', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`c${sapCounter}`));
    await startTest(ADMIN, test.code);
    const [first, second] = await Promise.all([startAttempt(seat.req, test.code), startAttempt(seat.req, test.code)]);
    assert.equal(first.id, second.id);
    const doc = await testDocByCode(test.code);
    assert.equal(doc.registrations.filter((entry) => entry.attempt).length, 1);
    assert.deepEqual(first.questions.map((q) => q.id), second.questions.map((q) => q.id), 'both requests see the same paper');
  });

  await check('an answer racing the submit is either scored or refused, never saved unscored', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
      const question = attempt.questions[0];
      await Promise.allSettled([
        saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [question.options[0].id] }),
        submitAttemptForStudent(seat.req, attempt.id)
      ]);
      const stored = await storedAttempt(attempt.id);
      assert.equal(stored.status, 'submitted');
      const answer = stored.answers[0];
      assert.equal(answer.isCorrect === null, false, 'a submitted MCQ always carries its mark');
    }
  });

  await check('a double submit finalises once', async () => {
    const { seat, attempt } = await liveTest({ endsAt: at(minutes(60)) });
    const [first, second] = await Promise.all([
      submitAttemptForStudent(seat.req, attempt.id), submitAttemptForStudent(seat.req, attempt.id)
    ]);
    assert.equal(first.status, 'submitted');
    assert.equal(second.status, 'submitted');
    assert.equal(first.submittedAt, second.submittedAt);
  });

  await check('after the grace, racing answers are both refused and the blank stays blank', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 1_000) } });
    const question = attempt.questions[0];
    const results = await Promise.allSettled(question.options.slice(0, 2).map((option) => (
      saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [option.id] })
    )));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 0);
    assert.equal(results.every((result) => result.status === 'rejected' && result.reason.status === 409), true);
    assert.equal((await attemptContext(attempt.id)).attempt.answers[0].answeredAt, null);
  });

  /* ================================================= 7. access control ==== */
  section('access');

  await check('a student cannot touch another student’s attempt', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const a = await enrol(test.code, student(`a${sapCounter}`));
    const b = await enrol(test.code, student(`b${sapCounter}`));
    await startTest(ADMIN, test.code);
    const attemptA = await startAttempt(a.req, test.code);
    await startAttempt(b.req, test.code);
    await rejects(() => saveAnswer(b.req, attemptA.id, answerFirst(attemptA)), 404);
    await rejects(() => submitAttemptForStudent(b.req, attemptA.id), 404);
    await rejects(() => attemptResult(b.req, attemptA.id), 404);
  });

  await check('a device without the registration cookie is turned away', async () => {
    const { test, attempt, seat } = await liveTest({ endsAt: at(minutes(60)) });
    const noCookie = { portalUser: seat.req.portalUser, signedCookies: {} };
    await rejects(() => getAttempt(noCookie, test.code), 401);
    await rejects(() => saveAnswer(noCookie, attempt.id, answerFirst(attempt)), 401);
  });

  await check('a forged registration cookie is rejected', async () => {
    const { test, seat } = await liveTest({ endsAt: at(minutes(60)) });
    const forged = {
      portalUser: seat.req.portalUser,
      signedCookies: { [`test_access_${test.code}`]: JSON.stringify({ id: seat.registration.id, token: 'made-up' }) }
    };
    await rejects(() => getAttempt(forged, test.code), 401);
  });

  await check('an unapproved student cannot start', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`pend${sapCounter}`), { approve: false });
    await startTest(ADMIN, test.code);
    await rejects(() => startAttempt(seat.req, test.code), 403);
  });

  await check('nobody can start before the admin presses Start, or after Close', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`gate${sapCounter}`));
    await rejects(() => startAttempt(seat.req, test.code), 403);
    await startTest(ADMIN, test.code);
    await startAttempt(seat.req, test.code);
    await closeTest(ADMIN, test.code);
    const other = await enrol(test.code, student(`gate2${sapCounter}`)).catch(() => null);
    assert.equal(other, null, 'a closed test accepts no new registrations');
  });

  await check('an admin sees only the tests they own', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await rejects(() => adminDashboard(OTHER_ADMIN, test.code), 404);
    await rejects(() => closeTest(OTHER_ADMIN, test.code), 404);
    await rejects(() => resetTest(OTHER_ADMIN, test.code), 404);
    await rejects(() => deleteTest(OTHER_ADMIN, test.code), 404);
    await rejects(() => updateTestSettings(OTHER_ADMIN, test.code, { title: 'Mine now' }), 404);
    const mine = await adminTests(OTHER_ADMIN);
    assert.equal(mine.some((entry) => entry.code === test.code), false);
  });

  await check('the role guards let only the right role through', async () => {
    const reply = () => {
      const res = { status: null, body: null };
      return {
        res: { status(code) { res.status = code; return this; }, json(body) { res.body = body; return this; } },
        seen: res
      };
    };
    let passed = false;
    requireAdmin(ADMIN, reply().res, () => { passed = true; });
    assert.equal(passed, true);

    const denied = reply();
    requireAdmin(student(`guard${sapCounter}`), denied.res, () => { throw new Error('a student reached an admin route'); });
    assert.equal(denied.seen.status, 403);

    // Faculty sit tests too, so they pass the test-taker guard.
    let facultyPassed = false;
    requireTestTaker(ADMIN, reply().res, () => { facultyPassed = true; });
    assert.equal(facultyPassed, true);

    const anonymous = reply();
    requireTestTaker({}, anonymous.res, () => { throw new Error('an anonymous request reached a test route'); });
    assert.equal(anonymous.seen.status, 403);
  });

  await check('the public test view never carries questions or answer keys', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`peek${sapCounter}`));
    const view = await getTest(seat.req, test.code);
    const serialized = JSON.stringify(view);
    assert.equal('questions' in view.test, false);
    assert.equal(serialized.includes('Which structure is FIFO?'), false);
    assert.equal(serialized.includes('correctOptions'), false);
    assert.equal(serialized.includes('accessTokenHash'), false);
    assert.equal(serialized.includes('ownerEmail'), false);
  });

  await check('a student paper never carries the answer key', async () => {
    const { attempt } = await liveTest({ endsAt: at(minutes(60)) });
    const serialized = JSON.stringify(attempt);
    assert.equal(serialized.includes('correctOptions'), false);
    assert.equal(serialized.includes('isCorrect'), false);
    assert.equal(serialized.includes('seed'), false);
  });

  /* ======================================================== 8. guests ===== */
  section('guests');

  await check('a guest session is issued only for a test that allows guests', async () => {
    const open = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const shut = await newTest({ allowGuests: false, endsAt: at(minutes(60)) });
    const jar = cookieJar();
    const session = await beginGuestSession(jar, { name: 'Walk In', testCode: open.code });
    assert.equal(session.user.isGuest, true);
    assert.equal(session.user.role, 'student');
    profileEmails.push(session.user.email);

    await rejects(() => beginGuestSession(cookieJar(), { name: 'Walk In', testCode: shut.code }), 403);
    await rejects(() => beginGuestSession(cookieJar(), { name: 'Walk In', testCode: 'TEST-NOPE1' }), 404);
    await rejects(() => beginGuestSession(cookieJar(), { name: 'X', testCode: open.code }), 400);
    await rejects(() => beginGuestSession(cookieJar(), { testCode: open.code }), 400);
  });

  await check('a guest can register, be approved, and sit the paper', async () => {
    const test = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const session = await beginGuestSession(cookieJar(), { name: 'Walk In', testCode: test.code });
    profileEmails.push(session.user.email);
    const guestReq = { portalUser: { email: session.user.email, displayName: session.user.name, role: 'student' } };
    const seat = await enrol(test.code, guestReq);
    await startTest(ADMIN, test.code);
    const attempt = await startAttempt(seat.req, test.code);
    assert.equal(attempt.status, 'in_progress');
    const dashboard = await adminDashboard(ADMIN, test.code);
    assert.equal(dashboard.registrations[0].email.endsWith('@guest.test'), true, 'the admin can tell it is a guest');
  });

  await check('turning guests off shuts the door for new sessions and registrations', async () => {
    const test = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const session = await beginGuestSession(cookieJar(), { name: 'Walk In', testCode: test.code });
    profileEmails.push(session.user.email);
    await updateTestSettings(ADMIN, test.code, { allowGuests: false });
    const guestReq = { portalUser: { email: session.user.email, displayName: session.user.name, role: 'student' } };
    await rejects(() => registerForTest(guestReq, cookieJar(), test.code, { sapId: nextSapId() }), 403);
    await rejects(() => beginGuestSession(cookieJar(), { name: 'Walk In', testCode: test.code }), 403);
  });

  await check('a guest already registered keeps their place when the toggle flips', async () => {
    const test = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const session = await beginGuestSession(cookieJar(), { name: 'Walk In', testCode: test.code });
    profileEmails.push(session.user.email);
    const guestReq = { portalUser: { email: session.user.email, displayName: session.user.name, role: 'student' } };
    const seat = await enrol(test.code, guestReq);
    await updateTestSettings(ADMIN, test.code, { allowGuests: false });
    await startTest(ADMIN, test.code);
    assert.equal((await startAttempt(seat.req, test.code)).status, 'in_progress');
  });

  await check('a guest session survives the cookie round trip through the middleware', async () => {
    const test = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const jar = cookieJar();
    const session = await beginGuestSession(jar, { name: 'Round Trip', testCode: test.code });
    profileEmails.push(session.user.email);
    const token = jar.cookies.get('test_portal_session');
    assert.ok(token, 'a session cookie was issued');

    const req = { signedCookies: { test_portal_session: token } };
    await new Promise((resolve, reject) => portalSessionMiddleware(req, {}, (error) => (error ? reject(error) : resolve())));
    assert.equal(req.portalUser?.email, session.user.email);
    assert.equal(req.portalUser?.role, 'student');
    const status = authStatus(req);
    assert.equal(status.user.isGuest, true);
    assert.equal('guestEnabled' in status, false, 'guest access is per-test, not a server flag');
  });

  await check('a non-UPES, non-guest account can never register', async () => {
    const test = await newTest({ allowGuests: true, endsAt: at(minutes(60)) });
    const outsider = { portalUser: { email: `outsider-${run}@gmail.com`, displayName: 'Outsider', role: 'student' } };
    await rejects(() => registerForTest(outsider, cookieJar(), test.code, { sapId: nextSapId() }), 403);
  });

  /* ================================================ 9. registration ====== */
  section('registration');

  await check('a SAP ID is saved once and reused for every later test', async () => {
    const who = student(`sap${sapCounter}`);
    const first = await newTest({ endsAt: at(minutes(60)) });
    const second = await newTest({ endsAt: at(minutes(60)) });
    const sapId = nextSapId();
    await registerForTest(who, cookieJar(), first.code, { sapId });
    await registerForTest(who, cookieJar(), second.code, { sapId: nextSapId() });
    const stored = await testDocByCode(second.code);
    assert.equal(stored.registrations[0].sapId, sapId, 'the saved profile wins over a retyped ID');
    assert.equal((await studentProfile(who)).profile.sapId, sapId);
  });

  await check('a malformed SAP ID is refused', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    for (const bad of ['1234', '12345678', '1234567890', 'abcdefghi', '', null]) {
      await rejects(() => registerForTest(student(`bad${sapCounter}`), cookieJar(), test.code, { sapId: bad }), 400);
    }
  });

  await check('the same student cannot register twice on one test', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const who = student(`dup${sapCounter}`);
    await registerForTest(who, cookieJar(), test.code, { sapId: nextSapId() });
    await rejects(() => registerForTest(who, cookieJar(), test.code, { sapId: nextSapId() }), 409);
  });

  await check('two students cannot share a SAP ID', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const sapId = nextSapId();
    await registerForTest(student(`sh1${sapCounter}`), cookieJar(), test.code, { sapId });
    await rejects(() => registerForTest(student(`sh2${sapCounter}`), cookieJar(), test.code, { sapId }), 409);
  });

  await check('an admin can correct a SAP ID, but not onto another student’s', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const a = await enrol(test.code, student(`fix1${sapCounter}`));
    const b = await enrol(test.code, student(`fix2${sapCounter}`));
    const fresh = nextSapId();
    const updated = await updateStudentSapId(ADMIN, test.code, a.registration.id, { sapId: fresh });
    assert.equal(updated.registrations.find((r) => r.id === a.registration.id).sapId, fresh);
    await rejects(() => updateStudentSapId(ADMIN, test.code, b.registration.id, { sapId: fresh }), 409);
    await rejects(() => updateStudentSapId(ADMIN, test.code, a.registration.id, { sapId: '12' }), 400);
  });

  await check('approve, reject and bulk approval move the right rows', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await enrol(test.code, student(`bulk1${sapCounter}`), { approve: false });
    await enrol(test.code, student(`bulk2${sapCounter}`), { approve: false });
    const rejected = await enrol(test.code, student(`bulk3${sapCounter}`), { approve: false });
    await decideRegistration(ADMIN, test.code, rejected.registration.id, 'reject');
    const after = await bulkDecision(ADMIN, test.code, 'approve');
    assert.equal(after.registrations.filter((r) => r.status === 'approved').length, 2);
    assert.equal(after.registrations.filter((r) => r.status === 'rejected').length, 1, 'bulk approve leaves rejections alone');
    await rejects(() => decideRegistration(ADMIN, test.code, rejected.registration.id, 'maybe'), 400);
    await rejects(() => decideRegistration(ADMIN, test.code, 'no-such-id', 'approve'), 404);
  });

  await check('a rejected student cannot start', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`rej${sapCounter}`), { approve: false });
    await decideRegistration(ADMIN, test.code, seat.registration.id, 'reject');
    await startTest(ADMIN, test.code);
    await rejects(() => startAttempt(seat.req, test.code), 403);
  });

  /* ===================================================== 10. venue ======== */
  section('venue');

  await check('a venue check blocks a start without coordinates and honours an exception', async () => {
    const test = await newTest({
      locationRequired: true, locationLatitude: 30.3165, locationLongitude: 78.0322, locationRadiusMeters: 250,
      endsAt: at(minutes(60))
    });
    const seat = await enrol(test.code, student(`geo${sapCounter}`));
    await startTest(ADMIN, test.code);
    await rejects(() => startAttempt(seat.req, test.code), 403);
    await rejects(() => startAttempt(seat.req, test.code, { latitude: 28.6, longitude: 77.2 }), 403);
    await setLocationOverride(ADMIN, test.code, seat.registration.id, { enabled: true });
    assert.equal((await startAttempt(seat.req, test.code)).status, 'in_progress');
  });

  await check('a venue start inside the radius is allowed', async () => {
    const test = await newTest({
      locationRequired: true, locationLatitude: 30.3165, locationLongitude: 78.0322, locationRadiusMeters: 500,
      endsAt: at(minutes(60))
    });
    const seat = await enrol(test.code, student(`geo2${sapCounter}`));
    await startTest(ADMIN, test.code);
    assert.equal((await startAttempt(seat.req, test.code, { latitude: 30.3167, longitude: 78.0324 })).status, 'in_progress');
  });

  await check('a location exception on a test without a venue check is refused', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const seat = await enrol(test.code, student(`geo3${sapCounter}`));
    await rejects(() => setLocationOverride(ADMIN, test.code, seat.registration.id, { enabled: true }), 409);
  });

  await check('a venue test without coordinates is refused at creation', async () => {
    await rejects(() => createTest(ADMIN, testPayload({ locationRequired: true, endsAt: at(minutes(60)) })), 400);
  });

  /* =============================================== 11. marks and export === */
  section('marks');

  await check('instant release shows the score as soon as it is submitted', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 2, msq: 0, short: 0 }, resultReleaseMode: 'instant', endsAt: at(minutes(60)) });
    const bank = await testDocByCode(attempt.code);
    for (const question of attempt.questions) {
      const source = bank.questions.find((q) => q.id === question.id);
      await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: source.correctOptions });
    }
    await submitAttemptForStudent(seat.req, attempt.id);
    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.released, true);
    assert.equal(result.score, 2);
    assert.equal(result.answered, 2);
  });

  await check('a wrong answer scores zero and the total still counts it', async () => {
    const { seat, attempt } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, endsAt: at(minutes(60)) });
    const bank = await testDocByCode(attempt.code);
    const source = bank.questions.find((q) => q.id === attempt.questions[0].id);
    const wrong = attempt.questions[0].options.find((o) => !source.correctOptions.includes(o.id));
    await saveAnswer(seat.req, attempt.id, { questionId: attempt.questions[0].id, selectedOptions: [wrong.id] });
    await submitAttemptForStudent(seat.req, attempt.id);
    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.score, 0);
    assert.equal(result.totalQuestions, 1);
  });

  await check('after_quiz holds marks until the test is closed', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, resultReleaseMode: 'after_quiz', endsAt: at(minutes(60)) });
    await saveAnswer(seat.req, attempt.id, answerFirst(attempt));
    await submitAttemptForStudent(seat.req, attempt.id);
    assert.equal((await attemptResult(seat.req, attempt.id)).released, false);
    await closeTest(ADMIN, test.code);
    assert.equal((await attemptResult(seat.req, attempt.id)).released, true);
  });

  await check('admin release holds marks until the button is pressed', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 0 }, resultReleaseMode: 'admin', endsAt: at(minutes(60)) });
    await saveAnswer(seat.req, attempt.id, answerFirst(attempt));
    await submitAttemptForStudent(seat.req, attempt.id);
    await closeTest(ADMIN, test.code);
    assert.equal((await attemptResult(seat.req, attempt.id)).released, false, 'closing is not releasing');
    await releaseResults(ADMIN, test.code);
    assert.equal((await attemptResult(seat.req, attempt.id)).released, true);
  });

  await check('a short answer holds the result back until it is marked', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 0, msq: 0, short: 1 }, endsAt: at(minutes(60)) });
    const question = attempt.questions[0];
    await rejects(() => manualReview(ADMIN, test.code, seat.registration.id), 409);
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, answerText: 'Items leave in arrival order.' });
    await submitAttemptForStudent(seat.req, attempt.id);

    const pending = await attemptResult(seat.req, attempt.id);
    assert.equal(pending.released, false);
    assert.equal(pending.releaseMode, 'manual');

    await rejects(() => gradeManualAnswer(ADMIN, test.code, seat.registration.id, { questionId: question.id, isCorrect: 'maybe' }), 400);
    await rejects(() => gradeManualAnswer(ADMIN, test.code, seat.registration.id, { questionId: 9_999, isCorrect: 1 }), 404);
    const marked = await gradeManualAnswer(ADMIN, test.code, seat.registration.id, { questionId: question.id, isCorrect: 1 });
    assert.equal(marked.answers[0].isCorrect, true);
    const released = await attemptResult(seat.req, attempt.id);
    assert.equal(released.released, true);
    assert.equal(released.score, 1);
  });

  await check('closing submits every paper still open', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const a = await enrol(test.code, student(`c1${sapCounter}`));
    const b = await enrol(test.code, student(`c2${sapCounter}`));
    await startTest(ADMIN, test.code);
    await startAttempt(a.req, test.code);
    await startAttempt(b.req, test.code);
    const closed = await closeTest(ADMIN, test.code);
    assert.equal(closed.completedAttemptCount, 2);
    assert.equal((await getAttempt(a.req, test.code)).status, 'submitted');
    assert.equal((await getAttempt(b.req, test.code)).status, 'submitted');
    const again = await closeTest(ADMIN, test.code);
    assert.equal(again.completedAttemptCount, 0, 'closing twice is harmless');
  });

  await check('a reset clears every attempt and reopens the test', async () => {
    const { test, seat } = await liveTest({ endsAt: at(minutes(60)) });
    const after = await resetTest(ADMIN, test.code);
    assert.equal(after.test.isStarted, false);
    assert.equal(after.test.isClosed, false);
    assert.equal(after.registrations.every((r) => r.attemptStatus === null), true);
    assert.equal(after.registrations.length, 1, 'registrations survive a reset');
    await rejects(() => getAttempt(seat.req, test.code), 404);
  });

  await check('restart-all rebuilds only the attempts that exist', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const a = await enrol(test.code, student(`ra1${sapCounter}`));
    await enrol(test.code, student(`ra2${sapCounter}`));
    await startTest(ADMIN, test.code);
    const attempt = await startAttempt(a.req, test.code);
    await saveAnswer(a.req, attempt.id, answerFirst(attempt));
    const out = await restartAllAttempts(ADMIN, test.code);
    assert.equal(out.resetCount, 1);
    assert.equal((await getAttempt(a.req, test.code)).answeredQuestionCount, 0);
  });

  await check('the exports carry the rows and the analysis sheet', async () => {
    const { seat, attempt, test } = await liveTest({ questionMix: { mcq: 1, msq: 0, short: 1 }, endsAt: at(minutes(60)) });
    for (const question of attempt.questions) {
      await saveAnswer(seat.req, attempt.id, question.type === 'short'
        ? { questionId: question.id, answerText: 'Because order matters.' }
        : { questionId: question.id, selectedOptions: [question.options[0].id] });
    }
    await submitAttemptForStudent(seat.req, attempt.id);

    const data = await adminExportData(ADMIN, test.code);
    assert.equal(data.responses.length, 2);
    assert.equal(data.registrations.length, 1);

    const csv = csvForAdmin(data);
    assert.ok(csv.startsWith('"Name","College email","SAP ID"'));
    assert.equal(csv.split('\r\n').length, 2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildTestSpreadsheet(data));
    assert.ok(workbook.getWorksheet('Results'));
    assert.ok(workbook.getWorksheet('Responses'));
    assert.equal(workbook.getWorksheet('Responses').getCell('L5').value.length > 0, true);

    const analysis = await registrationAnalysis(ADMIN, test.code, seat.registration.id);
    assert.equal(analysis.answers.length, 2);
    assert.equal(analysis.attempt.total, 2);
  });

  await check('a QR code is produced for a real test only', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const svg = await testQrSvg(test.code, `https://example.test/?test=${test.code}`);
    assert.ok(svg.startsWith('<?xml') || svg.startsWith('<svg'));
    await rejects(() => testQrSvg('TEST-NOPE1', 'https://example.test/'), 404);
  });

  await check('deleting a test removes it for good', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    await deleteTest(ADMIN, test.code);
    assert.equal(await testDocByCode(test.code), null);
    await rejects(() => adminDashboard(ADMIN, test.code), 404);
  });

  /* ======================================= 12. the two end-time paths ==== */
  section('end-time editing');

  await check('the setup form and the live extend store the same instant', async () => {
    const target = new Date(Date.now() + minutes(90) + 456);

    // Before the test starts, the dialog saves the whole setup through PATCH.
    const beforeStart = await newTest({ endsAt: at(minutes(30)) });
    const viaSetup = await updateTestSettings(ADMIN, beforeStart.code, { endsAt: target.toISOString() });

    // Once it is running, the same dialog narrows to the end time and POSTs it.
    const { test: running } = await liveTest({ endsAt: at(minutes(30)) });
    const viaExtend = await setTestEndTime(ADMIN, running.code, { endsAt: target.toISOString() });

    assert.equal(Date.parse(viaSetup.test.endsAt), target.getTime(), 'setup path');
    assert.equal(Date.parse(viaExtend.test.endsAt), target.getTime(), 'extend path');
    assert.equal(viaSetup.test.endsAt, viaExtend.test.endsAt, 'both paths agree to the millisecond');
  });

  await check('a running test takes an end time through either path, to the same instant', async () => {
    // An end time cannot change anybody's paper, so both the setup form and the
    // dedicated extend endpoint accept one while the test runs.
    const viaSetup = await liveTest({ endsAt: at(minutes(30)) });
    const viaExtend = await liveTest({ endsAt: at(minutes(30)) });
    const target = new Date(Date.now() + minutes(90) + 321);

    const a = await updateTestSettings(ADMIN, viaSetup.test.code, { endsAt: target.toISOString() });
    const b = await setTestEndTime(ADMIN, viaExtend.test.code, { endsAt: target.toISOString() });
    assert.equal(Date.parse(a.test.endsAt), target.getTime(), 'setup form');
    assert.equal(Date.parse(b.test.endsAt), target.getTime(), 'extend endpoint');
    assert.equal(a.test.endsAt, b.test.endsAt, 'both agree to the millisecond');
  });

  await check('the quick-add chips compute what the server would store', async () => {
    const { test } = await liveTest({ endsAt: at(minutes(20)) });
    const currentEndMs = Date.parse(test.endsAt);

    // What the dialog previews for a "+15 min" chip.
    const previewed = extendedEndMs(currentEndMs, 15, Date.now());
    // The dialog sends that exact instant rather than a minute count.
    const stored = await setTestEndTime(ADMIN, test.code, { endsAt: new Date(previewed).toISOString() });
    assert.equal(Date.parse(stored.test.endsAt), previewed);

    // And the server's own addMinutes lands on the same instant.
    const viaMinutes = await setTestEndTime(ADMIN, test.code, { addMinutes: 15 });
    assert.equal(Date.parse(viaMinutes.test.endsAt), extendedEndMs(previewed, 15, Date.now()));
  });

  await check('a chip press on a lapsed test grants real minutes, not past ones', async () => {
    const test = await newTest({ opensAt: at(-minutes(120)), endsAt: at(minutes(30)) });
    const lapsedEndMs = Date.now() - minutes(30);
    await tests().updateOne({ code: test.code }, { $set: { endsAt: new Date(lapsedEndMs) } });
    const previewed = extendedEndMs(lapsedEndMs, 10, Date.now());
    assert.ok(previewed > Date.now() + minutes(9), 'the preview is ten real minutes away');
    const stored = await setTestEndTime(ADMIN, test.code, { endsAt: new Date(previewed).toISOString() });
    assert.equal(Date.parse(stored.test.endsAt), previewed);
  });

  /* ==================================================== 12. question layout = */
  section('question layout');

  await check('the layout defaults to one at a time and is a per-test choice', async () => {
    const byDefault = await newTest({ endsAt: at(minutes(60)) });
    assert.equal(byDefault.questionLayout, 'one');
    const allAtOnce = await newTest({ endsAt: at(minutes(60)), questionLayout: 'all' });
    assert.equal(allAtOnce.questionLayout, 'all');
    const nonsense = await newTest({ endsAt: at(minutes(60)), questionLayout: 'sideways' });
    assert.equal(nonsense.questionLayout, 'one', 'an unknown layout falls back rather than failing');
  });

  await check('the student paper carries the layout the admin chose', async () => {
    const one = await liveTest({ endsAt: at(minutes(60)) });
    assert.equal(one.attempt.questionLayout, 'one');
    const all = await liveTest({ endsAt: at(minutes(60)), questionLayout: 'all' });
    assert.equal(all.attempt.questionLayout, 'all');
    // Either way the whole paper is delivered; only the presentation differs.
    assert.equal(all.attempt.questions.length, one.attempt.questions.length);
  });

  await check('the layout can be changed before the test starts', async () => {
    const test = await newTest({ endsAt: at(minutes(60)), questionLayout: 'one' });
    const updated = await updateTestSettings(ADMIN, test.code, { questionLayout: 'all' });
    assert.equal(updated.test.questionLayout, 'all');
    const untouched = await updateTestSettings(ADMIN, test.code, { title: `Kept layout ${run}` });
    assert.equal(untouched.test.questionLayout, 'all', 'an unrelated edit leaves it alone');
  });

  await check('ordinary questions carry no active per-question deadline', async () => {
    const test = await newTest({ endsAt: at(minutes(60)) });
    const stored = await testDocByCode(test.code);
    assert.equal(stored.questions.every((question) => question.timeSeconds === null), true);

    const { attempt } = await liveTest({ endsAt: at(minutes(60)) });
    assert.equal(attempt.questions.every((question) => question.timeSeconds === null), true);
  });

  await check('the estimate is priced from the mix, not from stored question times', async () => {
    const test = await newTest({ endsAt: at(minutes(60)), questionMix: { mcq: 1, msq: 1, short: 1 } });
    assert.equal(test.estimatedSeconds, 60 + 60 + 120);
    // A legacy document's per-question times are ignored on the next edit.
    await tests().updateOne({ code: test.code }, { $set: { 'questions.0.timeSeconds': 3000 } });
    const edited = await updateTestSettings(ADMIN, test.code, { title: `Legacy times ${run}` });
    assert.equal(edited.test.estimatedSeconds, 60 + 60 + 120);
  });

  /* ===================================================== 13. scoring ====== */
  section('scoring');

  /** The option the student sees carrying this text, whatever order it is in. */
  const optionByText = (question, text) => {
    const found = question.options.find((option) => option.text === text);
    assert.ok(found, `no option reading "${text}" on question ${question.id}`);
    return found.id;
  };

  const scoringQuestions = [
    { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue', 'Tree', 'Graph'], correctOptions: ['1'] },
    { prompt: 'Which are HTTP methods?', type: 'msq', options: ['GET', 'POST', 'FETCH', 'SEND'], correctOptions: ['0', '1'] }
  ];

  await check('a shuffled paper scores by meaning, not by position', async () => {
    // Every student gets the options in their own order, so the id the student
    // clicks must still be the id the answer key is written against.
    const { seat, attempt } = await liveTest({
      endsAt: at(minutes(60)), shuffleQuestions: true,
      questionMix: { mcq: 1, msq: 0, short: 0 }, questions: scoringQuestions
    });
    const question = attempt.questions[0];
    assert.equal(question.options.length, 4);

    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [optionByText(question, 'Queue')] });
    await submitAttemptForStudent(seat.req, attempt.id);
    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.score, 1, 'clicking the right words scores, wherever they were shown');
  });

  await check('clicking the wrong words scores zero however they were shuffled', async () => {
    const { seat, attempt } = await liveTest({
      endsAt: at(minutes(60)), shuffleQuestions: true,
      questionMix: { mcq: 1, msq: 0, short: 0 }, questions: scoringQuestions
    });
    const question = attempt.questions[0];
    await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [optionByText(question, 'Stack')] });
    await submitAttemptForStudent(seat.req, attempt.id);
    assert.equal((await attemptResult(seat.req, attempt.id)).score, 0);
  });

  await check('two students with different shuffles both score correctly', async () => {
    const test = await newTest({
      endsAt: at(minutes(60)), shuffleQuestions: true,
      questionMix: { mcq: 1, msq: 0, short: 0 }, questions: scoringQuestions
    });
    const a = await enrol(test.code, student(`sh-a${sapCounter}`));
    const b = await enrol(test.code, student(`sh-b${sapCounter}`));
    await startTest(ADMIN, test.code);

    for (const seat of [a, b]) {
      const attempt = await startAttempt(seat.req, test.code);
      const question = attempt.questions[0];
      await saveAnswer(seat.req, attempt.id, { questionId: question.id, selectedOptions: [optionByText(question, 'Queue')] });
      await submitAttemptForStudent(seat.req, attempt.id);
      assert.equal((await attemptResult(seat.req, attempt.id)).score, 1, 'each student scores on their own order');
    }
  });

  await check('MSQ needs the exact set: a subset and a superset both score zero', async () => {
    const attemptWith = async (texts) => {
      const { seat, attempt } = await liveTest({
        endsAt: at(minutes(60)), questionMix: { mcq: 0, msq: 1, short: 0 }, questions: scoringQuestions
      });
      const question = attempt.questions[0];
      await saveAnswer(seat.req, attempt.id, {
        questionId: question.id,
        selectedOptions: texts.map((text) => optionByText(question, text))
      });
      await submitAttemptForStudent(seat.req, attempt.id);
      return (await attemptResult(seat.req, attempt.id)).score;
    };
    assert.equal(await attemptWith(['GET', 'POST']), 1, 'the exact set scores');
    assert.equal(await attemptWith(['GET']), 0, 'a subset does not');
    assert.equal(await attemptWith(['GET', 'POST', 'FETCH']), 0, 'a superset does not');
    assert.equal(await attemptWith(['FETCH', 'SEND']), 0, 'the wrong set does not');
  });

  await check('an unanswered question scores zero and still counts in the total', async () => {
    const { seat, attempt } = await liveTest({
      endsAt: at(minutes(60)), questionMix: { mcq: 1, msq: 1, short: 0 }, questions: scoringQuestions
    });
    const mcq = attempt.questions.find((question) => question.type === 'mcq');
    await saveAnswer(seat.req, attempt.id, { questionId: mcq.id, selectedOptions: [optionByText(mcq, 'Queue')] });
    await submitAttemptForStudent(seat.req, attempt.id);

    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.score, 1);
    assert.equal(result.totalQuestions, 2, 'the blank question is still out of two');
    assert.equal(result.answered, 1, 'and is not counted as answered');
  });

  await check('answeredCount tracks answers, not visits', async () => {
    const { seat, attempt, test } = await liveTest({
      endsAt: at(minutes(60)), questionMix: { mcq: 1, msq: 1, short: 0 }, questions: scoringQuestions
    });
    assert.equal(attempt.answeredQuestionCount, 0);
    const first = attempt.questions[0];
    const afterOne = await saveAnswer(seat.req, attempt.id, { questionId: first.id, selectedOptions: [first.options[0].id] });
    assert.equal(afterOne.answeredQuestionCount, 1);
    const afterClear = await saveAnswer(seat.req, attempt.id, { questionId: first.id, selectedOptions: [] });
    assert.equal(afterClear.answeredQuestionCount, 0, 'clearing an answer un-answers it');

    await saveAnswer(seat.req, attempt.id, { questionId: first.id, selectedOptions: [first.options[0].id] });
    const dashboard = await adminDashboard(ADMIN, test.code);
    assert.equal(dashboard.registrations[0].answeredCount, 1, 'the dashboard agrees');
  });

  await check('a blank short answer scores zero without creating manual work', async () => {
    const { seat, attempt, test } = await liveTest({
      endsAt: at(minutes(60)), questionMix: { mcq: 0, msq: 0, short: 1 },
      questions: [...scoringQuestions, { prompt: 'Explain a queue.', type: 'short' }]
    });
    await submitAttemptForStudent(seat.req, attempt.id);

    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.released, true);
    assert.equal(result.score, 0);
  });

  await check('a mixed paper scores each question independently', async () => {
    const { seat, attempt, test } = await liveTest({
      endsAt: at(minutes(60)), questionMix: { mcq: 1, msq: 1, short: 1 },
      questions: [...scoringQuestions, { prompt: 'Explain a queue.', type: 'short' }]
    });
    const mcq = attempt.questions.find((question) => question.type === 'mcq');
    const msq = attempt.questions.find((question) => question.type === 'msq');
    const short = attempt.questions.find((question) => question.type === 'short');

    await saveAnswer(seat.req, attempt.id, { questionId: mcq.id, selectedOptions: [optionByText(mcq, 'Queue')] });
    await saveAnswer(seat.req, attempt.id, { questionId: msq.id, selectedOptions: [optionByText(msq, 'GET')] });
    await saveAnswer(seat.req, attempt.id, { questionId: short.id, answerText: 'Items leave in arrival order.' });
    await submitAttemptForStudent(seat.req, attempt.id);

    await gradeManualAnswer(ADMIN, test.code, seat.registration.id, { questionId: short.id, isCorrect: 1 });
    const result = await attemptResult(seat.req, attempt.id);
    assert.equal(result.totalQuestions, 3);
    assert.equal(result.score, 2, 'MCQ right, MSQ incomplete, short marked right');
  });

  await check('the export reports the same score the student is shown', async () => {
    const { seat, attempt, test } = await liveTest({
      endsAt: at(minutes(60)), questionMix: { mcq: 1, msq: 1, short: 0 }, questions: scoringQuestions
    });
    const mcq = attempt.questions.find((question) => question.type === 'mcq');
    const msq = attempt.questions.find((question) => question.type === 'msq');
    await saveAnswer(seat.req, attempt.id, { questionId: mcq.id, selectedOptions: [optionByText(mcq, 'Queue')] });
    await saveAnswer(seat.req, attempt.id, { questionId: msq.id, selectedOptions: [optionByText(msq, 'GET'), optionByText(msq, 'POST')] });
    await submitAttemptForStudent(seat.req, attempt.id);

    const shown = await attemptResult(seat.req, attempt.id);
    const data = await adminExportData(ADMIN, test.code);
    const row = data.registrations.find((entry) => entry.id === seat.registration.id);
    assert.equal(row.score, shown.score, 'dashboard matches the student view');

    const correctRows = data.responses.filter((response) => response.isCorrect === true).length;
    assert.equal(correctRows, shown.score, 'the per-answer export agrees too');
  });

  await check('the answer key never reaches the student, shuffled or not', async () => {
    const { attempt } = await liveTest({
      endsAt: at(minutes(60)), shuffleQuestions: true,
      questionMix: { mcq: 1, msq: 1, short: 0 }, questions: scoringQuestions
    });
    const serialized = JSON.stringify(attempt);
    assert.equal(serialized.includes('correctOptions'), false);
    assert.equal(serialized.includes('optionOrder'), false, 'the shuffle itself is not exposed');
    assert.equal(serialized.includes('isCorrect'), false);
  });

  /* ================================================ 12. rule invariants === */
  section('invariants');

  await check('a test stored with the old extraSeconds field still edits cleanly', async () => {
    const test = await newTest({ endsAt: at(minutes(90)) });
    // Simulate a document written before extra time was removed.
    await tests().updateOne({ code: test.code }, { $set: { extraSeconds: 600, overallSeconds: 660 } });

    const dashboard = await adminDashboard(ADMIN, test.code);
    assert.equal('extraSeconds' in dashboard.test, false, 'the field is no longer published');
    assert.equal(Date.parse(dashboard.test.endsAt), Date.parse(test.endsAt), 'its end time is unchanged');

    // Editing recomputes the estimate without the old padding, and the end time
    // the admin chose survives untouched - so no student's deadline moves.
    const edited = await updateTestSettings(ADMIN, test.code, { title: `Legacy ${run}` });
    assert.equal(Date.parse(edited.test.endsAt), Date.parse(test.endsAt));
    assert.equal(edited.test.estimatedSeconds, test.estimatedSeconds);
  });

  await check('isTimeOver reads a legacy closesAt document', async () => {
    const past = { closesAt: new Date(Date.now() - 1_000) };
    const future = { closesAt: new Date(Date.now() + minutes(10)) };
    assert.equal(isTimeOver(past), true);
    assert.equal(isTimeOver(future), false);
    assert.equal(isTimeOver({ endsAt: future.closesAt, closesAt: past.closesAt }), false, 'endsAt wins');
  });
} finally {
  if (createdCodes.length) {
    await tests().deleteMany({ code: { $in: createdCodes } });
    await registrations().deleteMany({ testCode: { $in: createdCodes } });
  }
  if (profileEmails.length) {
    await studentProfiles().deleteMany({ email: { $in: profileEmails } });
    await portalSessions().deleteMany({ email: { $in: profileEmails } });
  }
  await closeDatabase();

  const failed = results.filter((entry) => !entry.ok);
  let current = '';
  for (const entry of results) {
    if (entry.group !== current) {
      current = entry.group;
      console.log(`\n  ${current.toUpperCase()}`);
    }
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
    if (!entry.ok) console.log(`        ${entry.error.split('\n')[0]}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log(`  ${failed.length} FAILED:`);
    failed.forEach((entry) => console.log(`   - [${entry.group}] ${entry.name}`));
    process.exitCode = 1;
  }
}
