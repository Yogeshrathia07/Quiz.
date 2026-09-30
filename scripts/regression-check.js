/**
 * End-to-end check against a real MongoDB: one admin creates tests, students
 * register, sit them, and are marked, exercising every service the portal
 * exposes. Run it with `npm run test:regression`.
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { closeDatabase, initializeDatabase, serverState, registrations, studentProfiles, tests } from '../src/db/index.js';
import { testDocByCode } from '../src/data/test-repository.js';
import { compensateForOutage } from '../src/services/outage.js';
import { PublicTestError } from '../src/lib/errors.js';
import { createTest, updateTestSettings } from '../src/services/test-service.js';
import { beginGuestSession, getTest, registerForTest, studentProfile } from '../src/services/registration-service.js';
import {
  attemptResult, getAttempt, nextQuestion, recordFullscreenEvent, saveAnswer, startAttempt, submitAttemptForStudent
} from '../src/services/attempt-service.js';
import { STRICT_GRACE_MS } from '../src/domain/strict-timing.js';
import { activityLog } from '../src/domain/activity.js';
import {
  adminDashboard, adminExportData, adminTests, archiveTest, bulkDecision, closeTest, decideRegistration, duplicateTest, gradeManualAnswer, releaseResults,
  continueAttempt, pauseAttempt, reopenTest, resetTest, restartAllAttempts, submitStudentPaper, restartAttempt, restartQuiz, resumeAttempt, setLocationOverride, setTestEndTime,
  startTest, updateStudentSapId
} from '../src/services/admin-service.js';
import { buildStudentResponseSpreadsheet, buildTestSpreadsheet } from '../src/export/spreadsheet.js';
import { saveTestPaper, testForEditing } from '../src/services/paper-service.js';
import { userDetail, userResponseData } from '../src/services/user-service.js';
import { config } from '../src/config.js';
import { END_GRACE_MS } from '../src/domain/attempt-rules.js';
import { runScheduleOnce } from '../src/services/scheduler.js';

// These checks cover the lock rules, which are off by default (LOCK_ON_EXIT).
config.lockOnExit = true;
// A few time-travel scenarios intentionally edit MongoDB directly instead of
// using the service that invalidates cache. Keep those synthetic writes live.
config.redis.testCacheMs = 0;

const identifier = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const sapId = String(100_000_000 + (Date.now() % 890_000_000));
const updatedSapId = String(100_000_000 + ((Date.now() + 1_000_003) % 890_000_000));
const studentEmail = `regression-${identifier}@stu.upes.ac.in`;
const profileEmails = [studentEmail];
const adminReq = { portalUser: { email: `regression-admin-${identifier}@ddn.upes.ac.in`, displayName: 'Regression Admin', role: 'admin' } };
const studentReq = { portalUser: { email: studentEmail, displayName: 'Regression Student', role: 'student' } };
const createdCodes = [];

function cookieResponse() {
  const cookies = new Map();
  return { cookies, cookie(name, value) { cookies.set(name, value); } };
}

const registeredRequest = (code, response) => ({
  ...studentReq,
  signedCookies: { [`test_access_${code}`]: response.cookies.get(`test_access_${code}`) }
});

async function expectPublicError(action, status) {
  await assert.rejects(action, (error) => error instanceof PublicTestError && error.status === status);
}

/** Moves the test's end time into the past to exercise the end-time policy. */
async function expireTestEndTime(code, agoMs = 1_000) {
  await tests().updateOne({ code }, { $set: { endsAt: new Date(Date.now() - agoMs) } });
}

const storedTestEndMs = async (code) => (await testDocByCode(code)).endsAt.getTime();

function mixedPayload(title) {
  return {
    title,
    instructions: 'Regression coverage for the test workflow.',
    opensAt: new Date().toISOString(),
    questionMix: { mcq: 1, msq: 1, short: 1 },
    fullscreenExitLimit: 1,
    fullscreenAbsenceLimitSeconds: 0,
    shuffleQuestions: true,
    locationRequired: false,
    resultReleaseMode: 'instant',
    questions: [
      { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['1'] },
      { prompt: 'Select the valid HTTP methods.', type: 'msq', options: ['GET', 'POST', 'FETCH'], correctOptions: ['0', '1'] },
      { prompt: 'Describe why a queue is useful.', type: 'short' }
    ]
  };
}

function objectivePayload(title, options = {}) {
  return {
    title,
    instructions: 'Objective-question lifecycle coverage.',
    opensAt: new Date().toISOString(),
    questionMix: options.questionMix || { mcq: 1, msq: 0, short: 0 },
    fullscreenExitLimit: 3,
    fullscreenAbsenceLimitSeconds: 10,
    shuffleQuestions: true,
    allowGuests: Boolean(options.allowGuests),
    locationRequired: Boolean(options.locationRequired),
    locationRadiusMeters: options.locationRadiusMeters || 250,
    locationLatitude: options.locationRequired ? 30.3165 : null,
    locationLongitude: options.locationRequired ? 78.0322 : null,
    resultReleaseMode: options.resultReleaseMode || 'instant',
    ...options.schedule,
    questions: [
      { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['1'] },
      { prompt: 'Which structure is LIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['0'] }
    ]
  };
}

/** Registers, approves, starts the test, and begins the student's attempt. */
async function seatStudent(code, request = studentReq, studentSapId = sapId) {
  const response = cookieResponse();
  await registerForTest(request, response, code, { sapId: studentSapId });
  const doc = await testDocByCode(code);
  const registration = doc.registrations.find((entry) => entry.collegeEmail === request.portalUser.email);
  await decideRegistration(adminReq, code, registration.id, 'approve');
  return { registration, studentRequest: { ...request, signedCookies: response.cookies.size ? { [`test_access_${code}`]: response.cookies.get(`test_access_${code}`) } : {} }, response };
}

await initializeDatabase();
try {
  /* ---------------------------------------------- registration and identity */
  const created = await createTest(adminReq, mixedPayload(`Regression ${identifier}`));
  const code = created.test.code;
  createdCodes.push(code);

  await expectPublicError(
    () => registerForTest({ portalUser: { email: `invalid-${identifier}@stu.upes.ac.in`, displayName: 'Invalid Student', role: 'student' } }, cookieResponse(), code, { sapId: '1234' }),
    400
  );
  // Outside accounts are always refused; guest accounts only where the admin
  // allowed them, which this test did not.
  await expectPublicError(
    () => registerForTest({ portalUser: { email: `outsider-${identifier}@gmail.com`, displayName: 'Outside Account', role: 'student' } }, cookieResponse(), code, { sapId }),
    403
  );
  await expectPublicError(
    () => registerForTest({ portalUser: { email: `guest-${identifier}@guest.test`, displayName: 'Guest Student', role: 'student' } }, cookieResponse(), code, { sapId }),
    403
  );
  await expectPublicError(() => beginGuestSession(cookieResponse(), { name: 'Uninvited', testCode: code }), 403);

  const registrationResponse = cookieResponse();
  await registerForTest(studentReq, registrationResponse, code, { sapId });
  assert.equal((await studentProfile(studentReq)).profile.sapId, sapId);
  const storedTest = await testDocByCode(code);
  const registration = storedTest.registrations.find((entry) => entry.collegeEmail === studentEmail);
  assert.ok(registration);
  assert.equal((await getTest(studentReq, code)).test.code, code);

  const registeredStudentReq = registeredRequest(code, registrationResponse);
  await expectPublicError(() => startAttempt(registeredStudentReq, code), 403);

  /* ---------------------------------------- sitting the paper, lock, revive */
  await decideRegistration(adminReq, code, registration.id, 'approve');
  await startTest(adminReq, code);
  let attempt = await startAttempt(registeredStudentReq, code);
  assert.equal(attempt.questions.length, 3);
  assert.equal(attempt.timeOver, false);
  assert.ok(Date.parse(attempt.deadlineAt) > Date.parse(attempt.serverTime));

  // "1 switch allowed": the first is allowed, the second locks.
  const allowed = await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal(allowed.attempt.isLocked, false, 'the allowed switch does not lock');
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  const locked = await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal(locked.attempt.isLocked, true, 'one past the allowance locks');
  assert.equal(locked.attempt.questions, undefined, 'a locked attempt must not leak question text');
  await expectPublicError(() => saveAnswer(registeredStudentReq, attempt.id, { questionId: 1, selectedOptions: ['0'] }), 423);

  const deadlineBeforeRevive = await storedTestEndMs(code);
  await resumeAttempt(adminReq, code, registration.id);
  assert.equal(await storedTestEndMs(code), deadlineBeforeRevive, 'reviving one attempt must not move the test end time');

  // "Warn only": going past the limit is recorded and warned about, never locked.
  await updateTestSettings(adminReq, code, { violationAction: 'warn' });
  for (let round = 0; round < 3; round += 1) {
    const left = await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
    assert.equal(left.attempt.isLocked, false, 'a warn-only test never locks');
    assert.equal(left.attempt.locksOnViolation, false, 'the paper is told it only warns');
    await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  }
  assert.ok((await getAttempt(registeredStudentReq, code)).timesLeft >= 4, 'every exit is still counted');
  // Back to locking: the next exit past the limit locks; switching to warn lifts that lock.
  await updateTestSettings(adminReq, code, { violationAction: 'lock' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' })).attempt.isLocked, true);
  await updateTestSettings(adminReq, code, { violationAction: 'warn' });
  assert.equal((await getAttempt(registeredStudentReq, code)).isLocked, false, 'switching to warn only lifts an existing lock');
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  // "Warn, then lock": the paper is told to warn, and past the warnings it locks.
  // With 1 exit allowed and 1 warning: exit 1 is free, exit 2 is warned, exit 3 locks.
  await updateTestSettings(adminReq, code, { violationAction: 'warn_lock', warningsBeforeLock: 1 });
  const warnLock = await getAttempt(registeredStudentReq, code);
  assert.equal(warnLock.warnsOnViolation, true, 'warn, then lock warns');
  assert.equal(warnLock.locksOnViolation, true, 'warn, then lock locks');
  assert.equal(warnLock.warningsBeforeLock, 1);
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' })).attempt.isLocked, false, 'the allowed exit does not lock');
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  const warned = await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal(warned.attempt.isLocked, false, 'the warning does not lock');
  assert.equal(warned.attempt.violationCount, 1, 'the paper is told a warning was given');
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' })).attempt.isLocked, true, 'past the warnings it locks');
  await resumeAttempt(adminReq, code, registration.id);
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  // "Warn, then lock" with 0 warnings is simply "lock".
  await updateTestSettings(adminReq, code, { violationAction: 'warn_lock', warningsBeforeLock: 0 });
  assert.equal((await getAttempt(registeredStudentReq, code)).warnsOnViolation, false, '0 warnings locks with no warning');
  await updateTestSettings(adminReq, code, { violationAction: 'lock' });
  assert.equal((await getAttempt(registeredStudentReq, code)).warnsOnViolation, false, 'lock only shows no warnings');
  // "Record only": neither warns nor locks.
  await updateTestSettings(adminReq, code, { violationAction: "record" });
  const recordOnly = await getAttempt(registeredStudentReq, code);
  assert.equal(recordOnly.warnsOnViolation, false, "record only shows no warnings");
  assert.equal(recordOnly.locksOnViolation, false, "record only never locks");
  await updateTestSettings(adminReq, code, { violationAction: "lock" });

  // Locked while still away, revived, then the page reports how long it was
  // away: that absence caused the lock Revive forgave, so it must not lock again.
  await updateTestSettings(adminReq, code, { fullscreenAbsenceLimitSeconds: 10 });
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' })).attempt.isLocked, true);
  await resumeAttempt(adminReq, code, registration.id);
  const lateReturn = await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 15_000, detail: 'tab_switch' });
  assert.equal(lateReturn.attempt.isLocked, false, 'one absence never needs two Revives');
  // A new absence after the Revive still counts.
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 15_000, detail: 'tab_switch' })).attempt.isLocked, true, 'a fresh absence past the limit still locks');
  await resumeAttempt(adminReq, code, registration.id);
  // The time limit is on the TOTAL: two 6-second absences go past 10 seconds.
  await updateTestSettings(adminReq, code, { fullscreenExitLimit: 0 });
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 6_000, detail: 'tab_switch' })).attempt.isLocked, false, '6 s of 10 s is allowed');
  await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  assert.equal((await recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs: 6_000, detail: 'tab_switch' })).attempt.isLocked, true, '12 s in total locks');
  await resumeAttempt(adminReq, code, registration.id);
  await updateTestSettings(adminReq, code, { fullscreenAbsenceLimitSeconds: 0, fullscreenExitLimit: 1 });

  // ---- Unlocking never leads straight into a second lock.
  const storedAttempt = async () => (await testDocByCode(code)).registrations.find((entry) => entry.id === registration.id).attempt;
  const backdate = (field, ms) => registrations().updateOne({ testCode: code, id: registration.id }, { $set: { [`attempt.${field}`]: new Date(Date.now() - ms) } });
  const leaveNow = () => recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'exit', detail: 'tab_switch' });
  const comeBack = (durationMs) => recordFullscreenEvent(registeredStudentReq, attempt.id, { type: 'return', durationMs, detail: 'tab_switch' });
  await updateTestSettings(adminReq, code, { fullscreenAbsenceLimitSeconds: 30 });

  // Locked by the poll while still away (never came back), then revived.
  await leaveNow();
  await backdate('awaySince', 40_000);
  assert.equal((await getAttempt(registeredStudentReq, code)).isLocked, true, 'away past the total time locks, even without a return');
  await resumeAttempt(adminReq, code, registration.id);
  assert.equal((await storedAttempt()).lastSeenAt, null, 'an unlock waits for the next check-in before watching again');
  // A locked tab in the background checks in rarely: that silence is not "offline".
  assert.equal((await getAttempt(registeredStudentReq, code)).isLocked, false, 'the first check-in after an unlock never locks');
  // Their page then reports the old absence: forgiven, not counted again.
  assert.equal((await comeBack(60_000)).attempt.isLocked, false, 'the absence that caused the lock is not counted twice');
  assert.equal((await storedAttempt()).fullscreenTotalAbsenceMs, 0);
  assert.ok((await storedAttempt()).lastSeenAt, 'watched again from that first check-in');

  // Warn, then lock on time away: one absence is one warning, however it is reported.
  await updateTestSettings(adminReq, code, { violationAction: 'warn_lock', warningsBeforeLock: 2, fullscreenExitLimit: 0 });
  await leaveNow();
  await backdate('awaySince', 40_000);
  let polled = await getAttempt(registeredStudentReq, code);
  assert.equal(polled.isLocked, false, 'the first violation only warns');
  assert.equal(polled.violationCount, 1);
  assert.equal((await comeBack(40_000)).attempt.violationCount, 1, 'the same absence is not a second warning');
  const secondWarning = await leaveNow();
  assert.equal(secondWarning.attempt.isLocked, false, 'already over the total: the next exit is warning 2');
  assert.equal(secondWarning.attempt.violationCount, 2);
  await comeBack(1_000);
  assert.equal((await leaveNow()).attempt.isLocked, true, 'after the last warning, the next one locks');
  await resumeAttempt(adminReq, code, registration.id);
  assert.equal((await getAttempt(registeredStudentReq, code)).violationCount, 0, 'an unlock gives a fresh set of warnings');
  await comeBack(500);

  // Neither Warn nor Lock: every exit is only recorded.
  await updateTestSettings(adminReq, code, { violationAction: 'record', fullscreenExitLimit: 1, fullscreenAbsenceLimitSeconds: 0 });
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await leaveNow()).attempt.isLocked, false, 'record only never locks');
    await comeBack(500);
  }
  assert.equal((await storedAttempt()).violationCount || 0, 0, 'record only gives no warnings');
  await updateTestSettings(adminReq, code, { violationAction: 'lock', warningsBeforeLock: 0, fullscreenExitLimit: 1 });
  await resumeAttempt(adminReq, code, registration.id).catch(() => {});

  // Answer every question in reverse, proving free navigation across the paper.
  attempt = await getAttempt(registeredStudentReq, code);
  const bank = new Map(storedTest.questions.map((question) => [question.id, question]));
  for (const question of [...attempt.questions].reverse()) {
    const source = bank.get(question.id);
    attempt = await saveAnswer(registeredStudentReq, attempt.id, source.manualGrading
      ? { questionId: question.id, answerText: 'A queue processes waiting items in arrival order.' }
      : { questionId: question.id, selectedOptions: source.correctOptions });
  }
  assert.equal(attempt.answeredQuestionCount, 3);

  // An answer can still be rewritten while the time is running.
  const objectiveQuestion = attempt.questions.find((question) => question.type !== 'short');
  const rewritten = await saveAnswer(registeredStudentReq, attempt.id, { questionId: objectiveQuestion.id, selectedOptions: [] });
  assert.equal(rewritten.questions.find((question) => question.id === objectiveQuestion.id).answered, false);
  attempt = await saveAnswer(registeredStudentReq, attempt.id, {
    questionId: objectiveQuestion.id,
    selectedOptions: bank.get(objectiveQuestion.id).correctOptions
  });

  attempt = await submitAttemptForStudent(registeredStudentReq, attempt.id);
  assert.equal(attempt.status, 'submitted');

  /* ------------------------------------------- marking, analysis and export */
  const shortQuestion = storedTest.questions.find((question) => question.manualGrading);
  await gradeManualAnswer(adminReq, code, registration.id, { questionId: shortQuestion.id, isCorrect: 1 });
  const result = await attemptResult(registeredStudentReq, attempt.id);
  assert.equal(result.released, true);
  assert.equal(result.score, 3);

  const analysis = await adminExportData(adminReq, code);
  assert.equal(analysis.responses.length, 3);
  assert.equal(analysis.responses.filter((answer) => answer.manualGrading)[0].isCorrect, true);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildTestSpreadsheet(analysis));
  assert.ok(workbook.getWorksheet('Results'));
  assert.ok(workbook.getWorksheet('Responses'));

  // The Users page reads this same service. It must list the test's actual
  // date, open the exact registration that was clicked, and provide all audit
  // sheets in the individual Excel download.
  const person = await userDetail(studentEmail);
  const personTest = person.results.find((entry) => entry.code === code && entry.registrationId === registration.id);
  assert.ok(personTest, 'the student record appears on the Users page');
  assert.ok(personTest.testDate, 'the test date is provided for the Users search filter');
  const personExport = await userResponseData(studentEmail, code, registration.id);
  assert.equal(personExport.student.email, studentEmail);
  assert.ok(personExport.activity.length, 'the individual export carries the answer and event timeline');
  assert.ok(personExport.integrity.events.length, 'the individual export carries raw integrity events');
  const personWorkbook = new ExcelJS.Workbook();
  await personWorkbook.xlsx.load(await buildStudentResponseSpreadsheet(personExport, { audit: true }));
  ['My responses', 'Test record', 'Activity log', 'Integrity log', 'Location checks'].forEach((name) => {
    assert.ok(personWorkbook.getWorksheet(name), `individual export contains ${name}`);
  });

  await updateStudentSapId(adminReq, code, registration.id, { sapId: updatedSapId });
  assert.equal((await studentProfile(studentReq)).profile.sapId, updatedSapId);
  const second = await createTest(adminReq, mixedPayload(`Saved profile ${identifier}`));
  createdCodes.push(second.test.code);
  await registerForTest(studentReq, cookieResponse(), second.test.code, { sapId });
  const secondTest = await testDocByCode(second.test.code);
  assert.equal(secondTest.registrations[0].sapId, updatedSapId, 'a saved SAP ID follows the student to every test');

  /* ----------------------------------------------- THE END-TIME POLICY ---- */
  const timing = await createTest(adminReq, objectivePayload(`End time ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }));
  createdCodes.push(timing.test.code);
  const seated = await seatStudent(timing.test.code);
  await startTest(adminReq, timing.test.code);
  let timed = await startAttempt(seated.studentRequest, timing.test.code);

  const [firstQuestion, secondQuestion] = timed.questions;
  timed = await saveAnswer(seated.studentRequest, timed.id, { questionId: firstQuestion.id, selectedOptions: [firstQuestion.options[0].id] });
  assert.equal(timed.questions.find((question) => question.id === firstQuestion.id).locked, false);

  // Time is up: the whole paper locks, but answers already on their way still
  // land during the grace.
  await expireTestEndTime(timing.test.code);
  timed = await getAttempt(seated.studentRequest, timing.test.code);
  assert.equal(timed.timeOver, true, 'the attempt reports that its time is over');
  assert.equal(timed.questions.every((question) => question.locked), true, 'every question locks once time is up');
  timed = await saveAnswer(seated.studentRequest, timed.id, { questionId: secondQuestion.id, selectedOptions: [secondQuestion.options[0].id] });
  assert.equal(timed.answeredQuestionCount, 2, 'an answer arriving within the grace is kept');

  // Past the grace, nothing more is accepted.
  await expireTestEndTime(timing.test.code, END_GRACE_MS + 1_000);
  await expectPublicError(
    () => saveAnswer(seated.studentRequest, timed.id, { questionId: firstQuestion.id, selectedOptions: [firstQuestion.options[1].id] }),
    409
  );

  // Extending the end time gives the paper back.
  const extended = await setTestEndTime(adminReq, timing.test.code, { addMinutes: 30 });
  assert.ok(Date.parse(extended.test.endsAt) > Date.now(), 'the end time moved into the future');
  timed = await getAttempt(seated.studentRequest, timing.test.code);
  assert.equal(timed.timeOver, false, 'an extension reopens the test');
  assert.equal(timed.questions.every((question) => !question.locked), true, 'every answer can change again');
  timed = await saveAnswer(seated.studentRequest, timed.id, { questionId: firstQuestion.id, selectedOptions: [firstQuestion.options[1].id] });
  assert.deepEqual(timed.questions.find((question) => question.id === firstQuestion.id).selectedOptions, [firstQuestion.options[1].id]);

  // An explicit end time is accepted too, not just a number of minutes.
  const explicitEnd = new Date(Date.now() + 5 * 60_000);
  const setExplicitly = await setTestEndTime(adminReq, timing.test.code, { endsAt: explicitEnd.toISOString() });
  assert.equal(Date.parse(setExplicitly.test.endsAt), explicitEnd.getTime());

  // An end time must be a real window after the start, and minutes must be sane.
  await expectPublicError(() => setTestEndTime(adminReq, timing.test.code, { addMinutes: 0 }), 400);
  await expectPublicError(() => setTestEndTime(adminReq, timing.test.code, { addMinutes: 5000 }), 400);
  await expectPublicError(
    () => setTestEndTime(adminReq, timing.test.code, { endsAt: new Date(Date.parse(timing.test.opensAt) - 60_000).toISOString() }),
    400
  );
  await expectPublicError(() => setTestEndTime(adminReq, timing.test.code, { endsAt: 'not a date' }), 400);

  // The scheduler leaves a test alone until the grace has passed...
  await expireTestEndTime(timing.test.code);
  await runScheduleOnce();
  assert.equal((await testDocByCode(timing.test.code)).isClosed, false, 'no close inside the grace');
  // ...then submits every paper and closes the test by itself.
  await expireTestEndTime(timing.test.code, END_GRACE_MS + 1_000);
  await runScheduleOnce();
  const autoClosed = await testDocByCode(timing.test.code);
  assert.equal(autoClosed.isClosed, true, 'the test closes itself when time is up');
  assert.equal(autoClosed.closedAutomatically, true);
  assert.equal(autoClosed.registrations[0].attempt.status, 'submitted');
  assert.equal(autoClosed.registrations[0].attempt.submittedBy, 'time');
  const autoSubmitted = await getAttempt(seated.studentRequest, timing.test.code);
  assert.equal(autoSubmitted.status, 'submitted');
  assert.equal(autoSubmitted.submittedBy, 'time');

  /* --------------------------------------------- SCHEDULED START + DURATION */
  const soon = new Date(Date.now() + 60 * 60_000);
  const scheduled = await createTest(adminReq, objectivePayload(`Scheduled ${identifier}`, {
    schedule: { startMode: 'scheduled', opensAt: soon.toISOString(), endMode: 'duration', durationMinutes: 20 }
  }));
  createdCodes.push(scheduled.test.code);
  assert.equal(scheduled.test.startMode, 'scheduled');
  assert.equal(scheduled.test.endMode, 'duration');
  const scheduledSeat = await seatStudent(scheduled.test.code);
  await expectPublicError(() => startAttempt(scheduledSeat.studentRequest, scheduled.test.code), 403);
  await runScheduleOnce();
  assert.equal((await getTest(scheduledSeat.studentRequest, scheduled.test.code)).test.isStarted, false, 'not before its time');

  // The countdown ends: the student's own page starts it, without waiting for the scheduler...
  await tests().updateOne({ code: scheduled.test.code }, { $set: { opensAt: new Date(Date.now() - 1_000) } });
  const arrived = await getTest(scheduledSeat.studentRequest, scheduled.test.code);
  assert.equal(arrived.test.isStarted, true, 'a scheduled test starts when its time comes');
  assert.ok(arrived.serverTime, 'the waiting page gets the server clock for its countdown');
  // ...and a duration counts from the real start.
  const durationEnd = Date.parse(arrived.test.endsAt) - Date.parse(arrived.test.startedAt);
  assert.equal(durationEnd, 20 * 60_000, 'the duration runs from the actual start');
  await startAttempt(scheduledSeat.studentRequest, scheduled.test.code);
  assert.equal((await closeTest(adminReq, scheduled.test.code)).completedAttemptCount, 1);
  assert.equal((await getAttempt(scheduledSeat.studentRequest, scheduled.test.code)).submittedBy, 'admin');

  // The scheduler starts a due test on its own, too.
  const selfStarting = await createTest(adminReq, objectivePayload(`Self start ${identifier}`, {
    schedule: { startMode: 'scheduled', opensAt: new Date(Date.now() - 1_000).toISOString(), endMode: 'manual' }
  }));
  createdCodes.push(selfStarting.test.code);
  assert.equal(selfStarting.test.untimed, true);
  await runScheduleOnce();
  assert.equal((await testDocByCode(selfStarting.test.code)).isStarted, true, 'the scheduler starts it');

  // A manual start with a duration has no end until Start, which fixes it.
  const manualDuration = await createTest(adminReq, objectivePayload(`Manual duration ${identifier}`, {
    schedule: { startMode: 'manual', opensAt: null, endMode: 'duration', durationMinutes: 45 }
  }));
  createdCodes.push(manualDuration.test.code);
  assert.equal(manualDuration.test.endsAt, null);
  const manualStarted = await startTest(adminReq, manualDuration.test.code);
  assert.equal(Date.parse(manualStarted.test.endsAt) - Date.parse(manualStarted.test.startedAt), 45 * 60_000);
  // Reset puts the duration back to "from the next start".
  assert.equal((await resetTest(adminReq, manualDuration.test.code)).test.endsAt, null);

  // A start time is required for a scheduled start, and a set end time must not be in the past.
  await expectPublicError(() => createTest(adminReq, objectivePayload(`Bad schedule ${identifier}`, {
    schedule: { startMode: 'scheduled', opensAt: null, endMode: 'manual' }
  })), 400);
  await expectPublicError(() => createTest(adminReq, objectivePayload(`Past end ${identifier}`, {
    schedule: { startMode: 'manual', opensAt: null, endMode: 'at', endsAt: new Date(Date.now() - 10 * 60_000).toISOString() }
  })), 400);

  /* ------------------------------------------------------- STRICT TIMING ---- */
  const strictTest = await createTest(adminReq, {
    ...objectivePayload(`Strict ${identifier}`, { questionMix: { mcq: 3, msq: 0, short: 0 } }),
    shuffleQuestions: false,
    strictTiming: true,
    typeSeconds: { mcq: 30, msq: 60, short: 120 },
    questions: [
      { prompt: 'First strict question?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'] },
      { prompt: 'Second strict question?', type: 'mcq', options: ['A', 'B'], correctOptions: ['1'], timeSeconds: 90 },
      { prompt: 'Third strict question?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 0 }
    ]
  });
  createdCodes.push(strictTest.test.code);
  assert.equal(strictTest.test.strictTiming, true);
  assert.equal(strictTest.test.questionLayout, 'one', 'strict timing is always one question at a time');
  const strictSeat = await seatStudent(strictTest.test.code);
  await startTest(adminReq, strictTest.test.code);
  let paper = await startAttempt(strictSeat.studentRequest, strictTest.test.code);
  assert.equal(paper.strict.index, 0);
  assert.equal(paper.strict.total, 3);
  assert.equal(paper.questions.length, 1, 'only the open question is sent');
  assert.equal(paper.questions[0].prompt, 'First strict question?');
  assert.equal(Date.parse(paper.strict.questionEndsAt) - Date.parse(paper.startedAt), 30_000, 'MCQ default time');
  const [q1, q2, q3] = (await testDocByCode(strictTest.test.code)).questions;

  // Only the open question takes answers.
  await expectPublicError(() => saveAnswer(strictSeat.studentRequest, paper.id, { questionId: q2.id, selectedOptions: ['0'] }), 409);
  paper = await saveAnswer(strictSeat.studentRequest, paper.id, { questionId: q1.id, selectedOptions: ['0'] });
  assert.equal(paper.questions[0].answered, true);

  // Next moves on for good; a repeated Next for the same question does nothing more.
  paper = await nextQuestion(strictSeat.studentRequest, paper.id, { questionId: q1.id });
  assert.equal(paper.strict.index, 1);
  assert.equal(paper.questions[0].id, q2.id);
  assert.equal(Date.parse(paper.strict.questionEndsAt) - Date.parse(paper.serverTime) > 85_000, true, 'its own 90 s');
  paper = await nextQuestion(strictSeat.studentRequest, paper.id, { questionId: q1.id });
  assert.equal(paper.strict.index, 1, 'a late or double Next never skips an unseen question');
  await expectPublicError(() => saveAnswer(strictSeat.studentRequest, paper.id, { questionId: q1.id, selectedOptions: ['1'] }), 409);

  // Its time runs out while nobody is looking: the server closes it on the next request.
  await registrations().updateOne(
    { testCode: strictTest.test.code, id: strictSeat.registration.id },
    { $set: { 'attempt.strict.shownAt': new Date(Date.now() - 90_000 - STRICT_GRACE_MS - 1_000) } }
  );
  paper = await getAttempt(strictSeat.studentRequest, strictTest.test.code);
  assert.equal(paper.strict.index, 2, 'the timed-out question closed by itself');
  assert.equal(paper.strict.closed[1].how, 'time');
  assert.equal(paper.strict.questionEndsAt, null, 'a question with no limit has no clock');
  await expectPublicError(() => saveAnswer(strictSeat.studentRequest, paper.id, { questionId: q2.id, selectedOptions: ['1'] }), 409);

  // Next on the last question hands the paper in, with the answer on screen riding along.
  paper = await nextQuestion(strictSeat.studentRequest, paper.id, { questionId: q3.id, answer: { selectedOptions: ['0'] } });
  assert.equal(paper.status, 'submitted');
  assert.equal(paper.submittedBy, 'student');
  const carriedAnswer = (await testDocByCode(strictTest.test.code))
    .registrations[0].attempt.answers.find((entry) => entry.questionId === q3.id);
  assert.deepEqual(carriedAnswer.selectedOptions, ['0'], 'the answer sent with Next is saved before the move');

  // The admin sees how long each question took and which ones ran out.
  const strictExport = await adminExportData(adminReq, strictTest.test.code);
  const byQuestion = new Map(strictExport.responses.map((response) => [response.questionId, response]));
  assert.equal(byQuestion.get(q1.id).timedOut, false);
  assert.equal(byQuestion.get(q2.id).timedOut, true);
  assert.equal(byQuestion.get(q2.id).timeAllowedSeconds, 90);
  assert.equal(byQuestion.get(q3.id).timeAllowedSeconds, null);
  const strictDoc = await testDocByCode(strictTest.test.code);
  assert.ok(activityLog(strictDoc, strictDoc.registrations[0]).some((entry) => /Time ran out on Q2/.test(entry.label)));
  await buildTestSpreadsheet(strictExport);
  // Strict settings are fixed once the test has started.
  await expectPublicError(() => updateTestSettings(adminReq, strictTest.test.code, { strictTiming: false }), 409);
  await closeTest(adminReq, strictTest.test.code);

  /* ------------------------------------- STRICT TIMING WITHOUT A NEXT BUTTON ---- */
  const noNext = await createTest(adminReq, {
    ...objectivePayload(`No next ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }),
    shuffleQuestions: false, strictTiming: true, strictNext: false, requirePrivateWindow: true,
    questions: [
      { prompt: 'Timed?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 60 },
      { prompt: 'Untimed?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 0 }
    ]
  });
  createdCodes.push(noNext.test.code);
  assert.equal(noNext.test.strictNext, false);
  const noNextSeat = await seatStudent(noNext.test.code);
  await startTest(adminReq, noNext.test.code);
  // Private window only: a paper is refused from a window the browser says is normal.
  await expectPublicError(() => startAttempt(noNextSeat.studentRequest, noNext.test.code, { window: 'normal' }), 403);
  let noNextPaper = await startAttempt(noNextSeat.studentRequest, noNext.test.code, { window: 'declared' });
  assert.equal(noNextPaper.requirePrivateWindow, true, 'the paper is told the rule, so a mid-test change reaches it');
  assert.equal(noNextPaper.strict.canMoveOn, false, 'a timed question offers no Next');
  const [timedQuestion, untimedQuestion] = (await testDocByCode(noNext.test.code)).questions;
  // The server refuses to skip ahead, whatever the page sends.
  await expectPublicError(() => nextQuestion(noNextSeat.studentRequest, noNextPaper.id, { questionId: timedQuestion.id }), 409);
  // Its time up (a moment early is the student's clock), it moves on.
  await registrations().updateOne(
    { testCode: noNext.test.code, id: noNextSeat.registration.id },
    { $set: { 'attempt.strict.shownAt': new Date(Date.now() - 59_000) } }
  );
  noNextPaper = await nextQuestion(noNextSeat.studentRequest, noNextPaper.id, { questionId: timedQuestion.id });
  assert.equal(noNextPaper.questions[0].id, untimedQuestion.id);
  assert.equal(noNextPaper.strict.canMoveOn, true, 'a question with no timer always gets Next');
  // Submit is always there: hand in mid-test.
  const handedIn = await submitAttemptForStudent(noNextSeat.studentRequest, noNextPaper.id);
  assert.equal(handedIn.status, 'submitted');
  const noNextDoc = await testDocByCode(noNext.test.code);
  assert.equal(noNextDoc.registrations[0].attempt.windowCheck, 'declared', 'what the private-window check saw is kept');
  assert.equal((await adminDashboard(adminReq, noNext.test.code)).registrations[0].windowCheck, 'declared');
  await closeTest(adminReq, noNext.test.code);

  /* ------------------------ STRICT TIMING: THE CLOCK STOPS WHILE AWAY ---- */
  const paused = await createTest(adminReq, {
    ...objectivePayload(`Paused clock ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }),
    shuffleQuestions: false, strictTiming: true, strictNext: false,
    fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 0, violationAction: 'record',
    questions: [
      { prompt: 'Paused one?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 60 },
      { prompt: 'Paused two?', type: 'mcq', options: ['A', 'B'], correctOptions: ['1'], timeSeconds: 60 }
    ]
  });
  createdCodes.push(paused.test.code);
  const pausedSeat = await seatStudent(paused.test.code);
  await startTest(adminReq, paused.test.code);
  let pausedPaper = await startAttempt(pausedSeat.studentRequest, paused.test.code, {});
  const [pausedOne] = (await testDocByCode(paused.test.code)).questions;
  const pausedKey = { testCode: paused.test.code, id: pausedSeat.registration.id };
  const leftOf = (view) => (Date.parse(view.strict.questionEndsAt) - Date.parse(view.serverTime)) / 1000;
  const strictState = async () => (await registrations().findOne(pausedKey)).attempt.strict;
  // 50 s into the question, the student leaves: its clock stops with 10 s to go.
  await registrations().updateOne(pausedKey, { $set: { 'attempt.strict.shownAt': new Date(Date.now() - 50_000) } });
  pausedPaper = (await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'exit', detail: 'tab_switch' })).attempt;
  assert.equal(pausedPaper.strict.questionPaused, true, 'leaving stops the question clock');
  assert.ok(Math.abs(leftOf(pausedPaper) - 10) < 1.5, 'with the time it had left');
  // Two minutes away - far past the question's end - and it is still open, with the same 10 s.
  await registrations().updateOne(pausedKey, { $set: {
    'attempt.strict.shownAt': new Date(Date.now() - 170_000),
    'attempt.strict.pausedSince': new Date(Date.now() - 120_000),
    'attempt.awaySince': new Date(Date.now() - 120_000)
  } });
  pausedPaper = await getAttempt(pausedSeat.studentRequest, paused.test.code);
  assert.equal(pausedPaper.strict.index, 0, 'a paused question never runs out');
  assert.ok(Math.abs(leftOf(pausedPaper) - 10) < 1.5, 'its time left holds still while away');
  await expectPublicError(() => nextQuestion(pausedSeat.studentRequest, pausedPaper.id, { questionId: pausedOne.id }), 409);
  // Back: the clock runs from where it stopped, and the away time is not the question's.
  pausedPaper = (await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'return', durationMs: 120_000, detail: 'tab_switch' })).attempt;
  assert.equal(pausedPaper.strict.questionPaused, false, 'coming back starts it again');
  assert.ok(Math.abs(leftOf(pausedPaper) - 10) < 1.5, 'still 10 s to go');
  assert.equal((await strictState()).pausedSince, null);
  assert.ok(Math.abs((Date.now() - (await strictState()).shownAt.getTime()) / 1000 - 50) < 1.5, 'the time on it is the 50 s spent on it');
  pausedPaper = await saveAnswer(pausedSeat.studentRequest, pausedPaper.id, { questionId: pausedOne.id, selectedOptions: ['0'] });
  assert.equal(pausedPaper.strict.index, 0, 'and it still takes an answer');
  // Locked: the clock stops too, and stays stopped after the unlock until the page is back.
  await updateTestSettings(adminReq, paused.test.code, { violationAction: 'lock', fullscreenExitLimit: 1 });
  await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'exit', detail: 'tab_switch' });
  await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'return', durationMs: 500, detail: 'tab_switch' });
  const lockedView = (await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'exit', detail: 'tab_switch' })).attempt;
  assert.equal(lockedView.isLocked, true);
  assert.ok((await strictState()).pausedSince, 'a lock stops the question clock');
  await registrations().updateOne(pausedKey, { $set: {
    'attempt.strict.shownAt': new Date((await strictState()).shownAt.getTime() - 300_000),
    'attempt.strict.pausedSince': new Date(Date.now() - 300_000)
  } });
  await resumeAttempt(adminReq, paused.test.code, pausedSeat.registration.id);
  assert.ok((await strictState()).pausedSince, 'still stopped until the student is back on the paper');
  pausedPaper = await getAttempt(pausedSeat.studentRequest, paused.test.code);
  assert.equal(pausedPaper.strict.questionPaused, false, 'the paper checking in after the unlock starts it again');
  assert.equal(pausedPaper.strict.index, 0, 'five minutes locked did not run it out');
  assert.ok(leftOf(pausedPaper) > 5 && leftOf(pausedPaper) < 11, 'the time it had left when it locked');
  // Text that arrived in an answer all at once is recorded against its question.
  await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'flag', detail: 'text_burst', questionId: pausedOne.id, chars: 214 });
  const burstAttempt = (await registrations().findOne(pausedKey)).attempt;
  assert.equal(burstAttempt.integrity.flags.text_burst, 1);
  const burstEvent = burstAttempt.events.find((event) => event.detail === 'text_burst');
  assert.equal(burstEvent.note, 'Q1: 214 characters', 'the note is the server\'s, naming the question');
  assert.equal(burstEvent.questionId, pausedOne.id);
  await expectPublicError(() => recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'flag', detail: 'text_burst', questionId: 999_999, chars: 50 }), 400);
  await recordFullscreenEvent(pausedSeat.studentRequest, pausedPaper.id, { type: 'flag', detail: 'drop' });
  assert.equal((await registrations().findOne(pausedKey)).attempt.integrity.flags.drop, 1, 'dragging text in is recorded');
  await submitAttemptForStudent(pausedSeat.studentRequest, pausedPaper.id);
  await closeTest(adminReq, paused.test.code);

  /* --------------------------------------------------- EDITING THE PAPER ---- */
  const mcqs = [
    { prompt: 'Paper one?', type: 'mcq', options: ['A', 'B'], correctOptions: ['1'] },
    { prompt: 'Paper two?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'] },
    { prompt: 'Paper three?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'] }
  ];
  const paperTest = await createTest(adminReq, {
    ...objectivePayload(`Paper ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }), shuffleQuestions: false, questions: mcqs
  });
  createdCodes.push(paperTest.test.code);
  const paperCode = paperTest.test.code;
  const editable = async () => (await testForEditing(adminReq, paperCode)).questions;
  const asSent = (questions) => questions.map(({ onPapers, ...question }) => question);

  // Before anyone has a paper: edit freely, no question asked; ids stay.
  let paperBank = await editable();
  paperBank[0].prompt = 'Paper one (fixed typo)?';
  const beforeStart = await saveTestPaper(adminReq, paperCode, { questions: asSent(paperBank), questionMix: { mcq: 2, msq: 0, short: 0 } });
  assert.equal(beforeStart.paperSummary.applyTo, null);
  assert.equal((await editable())[0].id, paperBank[0].id, 'an edited question keeps its id');

  // Two students: one submits (answers A to both: Q1 wrong, Q2 right), one is mid-test.
  const paperStudents = [];
  for (const seatNumber of [1, 2]) {
    const email = `regression-${identifier}-paper${seatNumber}@stu.upes.ac.in`;
    profileEmails.push(email);
    const request = { portalUser: { email, displayName: `Paper Student ${seatNumber}`, role: 'student' } };
    const seatSap = String(100_000_000 + ((Date.now() + seatNumber * 104_729) % 890_000_000));
    paperStudents.push(await seatStudent(paperCode, request, seatSap));
  }
  await startTest(adminReq, paperCode);
  const [submitter, sitter] = paperStudents;
  let submitted = await startAttempt(submitter.studentRequest, paperCode);
  for (const question of submitted.questions) {
    submitted = await saveAnswer(submitter.studentRequest, submitted.id, { questionId: question.id, selectedOptions: [question.options.find((option) => option.text === 'A').id] });
  }
  await submitAttemptForStudent(submitter.studentRequest, submitted.id);
  const sitting = await startAttempt(sitter.studentRequest, paperCode);
  const scoreOf = async () => (await adminDashboard(adminReq, paperCode)).registrations.find((row) => row.email === submitter.registration.collegeEmail).score;
  assert.equal(await scoreOf(), 1);

  // Papers are out: the admin must say who the change reaches.
  paperBank = await editable();
  assert.deepEqual(paperBank.map((question) => question.onPapers), [2, 2, 0]);
  await assert.rejects(() => saveTestPaper(adminReq, paperCode, { questions: asSent(paperBank) }), (error) => error.code === 'NEEDS_APPLY_TO');

  // Everyone: fix Q1's answer key (A is right) and Q2's wording.
  paperBank[0].correctOptions = ['0'];
  paperBank[1].prompt = 'Paper two, reworded?';
  const toEveryone = await saveTestPaper(adminReq, paperCode, { questions: asSent(paperBank), applyTo: 'everyone' });
  assert.equal(toEveryone.paperSummary.edited, 2);
  assert.equal(toEveryone.paperSummary.papersUpdated, 2);
  assert.equal(await scoreOf(), 2, 'the submitted paper is re-marked with the fixed key');
  let seen = await getAttempt(sitter.studentRequest, paperCode);
  assert.ok(seen.questions.some((question) => question.prompt === 'Paper two, reworded?'), 'a student mid-test sees the fix');

  // New papers only: reword Q2 again; the student mid-test keeps the version they have.
  paperBank = await editable();
  paperBank[1].prompt = 'Paper two, third wording?';
  const toNew = await saveTestPaper(adminReq, paperCode, { questions: asSent(paperBank), applyTo: 'new' });
  assert.equal(toNew.paperSummary.papersUpdated, 0);
  seen = await getAttempt(sitter.studentRequest, paperCode);
  assert.ok(seen.questions.some((question) => question.prompt === 'Paper two, reworded?'), 'existing papers keep their version');
  const stored = (await testDocByCode(paperCode)).questions;
  assert.equal(stored.filter((question) => question.retired).length, 1, 'the old version is kept for them');
  assert.equal((await editable()).length, 3, 'the editor shows only current questions');
  const newVersionId = (await editable())[1].id;
  assert.notEqual(newVersionId, paperBank[1].id, 'the new version is a new question for new papers');
  // A student who starts now gets the new wording.
  const latecomerEmail = `regression-${identifier}-paper3@stu.upes.ac.in`;
  profileEmails.push(latecomerEmail);
  const latecomer = await seatStudent(paperCode, { portalUser: { email: latecomerEmail, displayName: 'Paper Student 3', role: 'student' } },
    String(100_000_000 + ((Date.now() + 3 * 104_729) % 890_000_000)));
  const latePaper = await startAttempt(latecomer.studentRequest, paperCode);
  assert.ok(latePaper.questions.some((question) => question.prompt === 'Paper two, third wording?'));

  // Everyone: delete Q1 - taken off every paper, the submitted score recounted.
  paperBank = await editable();
  const deleted = paperBank.shift();
  const afterDelete = await saveTestPaper(adminReq, paperCode, { questions: asSent(paperBank), applyTo: 'everyone', questionMix: { mcq: 2, msq: 0, short: 0 } });
  assert.equal(afterDelete.paperSummary.removed, 1);
  const submitterRow = afterDelete.registrations.find((row) => row.email === submitter.registration.collegeEmail);
  assert.equal(submitterRow.totalQuestions, 1, 'Q1 is gone from the submitted paper');
  assert.equal(submitterRow.score, 1, 'only Q2 (answered A, right) counts now');
  seen = await getAttempt(sitter.studentRequest, paperCode);
  assert.equal(seen.questions.some((question) => question.id === deleted.id), false, 'and from the paper being written');
  await closeTest(adminReq, paperCode);

  /* ---------------------------------------------------- SERVER OUTAGES ---- */
  // A running test gets the outage back, exactly once however many checks race for it.
  const outageTest = await createTest(adminReq, objectivePayload(`Outage ${identifier}`, { schedule: { endMode: 'duration', durationMinutes: 30 } }));
  createdCodes.push(outageTest.test.code);
  await startTest(adminReq, outageTest.test.code);
  await tests().updateOne({ code: outageTest.test.code }, { $set: { startedAt: new Date(Date.now() - 5 * 60_000) } });
  const endBeforeOutage = (await testDocByCode(outageTest.test.code)).endsAt.getTime();
  const savedBeat = await serverState().findOne({ _id: 'heartbeat' });
  await serverState().updateOne({ _id: 'heartbeat' }, { $set: { at: new Date(Date.now() - 90_000) } }, { upsert: true });
  const claims = (await Promise.all([compensateForOutage(), compensateForOutage(), compensateForOutage()])).filter(Boolean);
  assert.equal(claims.length, 1, 'one outage is claimed once');
  const movedBy = (await testDocByCode(outageTest.test.code)).endsAt.getTime() - endBeforeOutage;
  assert.ok(movedBy >= 90_000 && movedBy < 95_000, `the end time moved by the outage (${movedBy} ms)`);
  if (savedBeat) await serverState().updateOne({ _id: 'heartbeat' }, { $set: { at: new Date() } });
  await closeTest(adminReq, outageTest.test.code);

  /* ------------------------------------------------------ RESTART QUIZ ---- */
  const again = await createTest(adminReq, objectivePayload(`Restart quiz ${identifier}`, {
    schedule: { endMode: 'at', endsAt: new Date(Date.now() + 30 * 60_000).toISOString() }
  }));
  createdCodes.push(again.test.code);
  await expectPublicError(() => restartQuiz(adminReq, again.test.code), 409); // not started yet: nothing to restart
  const againSeat = await seatStudent(again.test.code);
  await startTest(adminReq, again.test.code);
  const firstPaper = await startAttempt(againSeat.studentRequest, again.test.code);
  await saveAnswer(againSeat.studentRequest, firstPaper.id, { questionId: firstPaper.questions[0].id, selectedOptions: [firstPaper.questions[0].options[0].id] });
  await submitAttemptForStudent(againSeat.studentRequest, firstPaper.id);
  await closeTest(adminReq, again.test.code);
  // Finished, end time passed: a new length is required.
  await expireTestEndTime(again.test.code, 60_000);
  await assert.rejects(() => restartQuiz(adminReq, again.test.code), (error) => error.code === 'NEEDS_END_TIME');
  const restartedQuiz = await restartQuiz(adminReq, again.test.code, { addMinutes: 20 });
  assert.equal(restartedQuiz.test.isStarted, true, 'running again');
  assert.equal(restartedQuiz.test.isClosed, false, 'reopened');
  assert.ok(Math.abs(Date.parse(restartedQuiz.test.endsAt) - (Date.now() + 20 * 60_000)) < 5_000, 'ends 20 minutes from now');
  assert.equal(restartedQuiz.registrations[0].status, 'approved', 'approval kept');
  assert.equal(restartedQuiz.registrations[0].attemptStatus, null, 'paper cleared');
  await assert.rejects(() => getAttempt(againSeat.studentRequest, again.test.code), (error) => error.code === 'NO_ATTEMPT');
  const secondPaper = await startAttempt(againSeat.studentRequest, again.test.code);
  assert.equal(secondPaper.status, 'in_progress');
  assert.equal(secondPaper.answeredQuestionCount, 0, 'a blank paper');
  // While running, with the end still ahead, the end time is kept.
  const keptEnd = restartedQuiz.test.endsAt;
  assert.equal((await restartQuiz(adminReq, again.test.code)).test.endsAt, keptEnd);
  await closeTest(adminReq, again.test.code);
  // A duration counts afresh from the restart.
  const againDuration = await createTest(adminReq, objectivePayload(`Restart duration ${identifier}`, { schedule: { endMode: 'duration', durationMinutes: 15 } }));
  createdCodes.push(againDuration.test.code);
  await startTest(adminReq, againDuration.test.code);
  await closeTest(adminReq, againDuration.test.code);
  const durationAgain = await restartQuiz(adminReq, againDuration.test.code);
  assert.equal(Date.parse(durationAgain.test.endsAt) - Date.parse(durationAgain.test.startedAt), 15 * 60_000);
  await closeTest(adminReq, againDuration.test.code);

  /* -------------------------------------- RESUME AFTER A CLOSE BY MISTAKE ---- */
  const oops = await createTest(adminReq, objectivePayload(`Resume ${identifier}`, {
    resultReleaseMode: 'admin', schedule: { endMode: 'at', endsAt: new Date(Date.now() + 30 * 60_000).toISOString() }
  }));
  createdCodes.push(oops.test.code);
  const otherEmail = `regression-other-${identifier}@stu.upes.ac.in`;
  profileEmails.push(otherEmail);
  const otherReq = { portalUser: { email: otherEmail, displayName: 'Other Student', role: 'student' } };
  const writing = await seatStudent(oops.test.code);
  const otherSapId = String(100_000_000 + ((Date.now() + 2_000_029) % 890_000_000));
  const finished = await seatStudent(oops.test.code, otherReq, otherSapId);
  await startTest(adminReq, oops.test.code);
  const writingPaper = await startAttempt(writing.studentRequest, oops.test.code);
  const oopsQuestion = writingPaper.questions[0];
  await saveAnswer(writing.studentRequest, writingPaper.id, { questionId: oopsQuestion.id, selectedOptions: [oopsQuestion.options[0].id] });
  const finishedPaper = await startAttempt(finished.studentRequest, oops.test.code);
  await submitAttemptForStudent(finished.studentRequest, finishedPaper.id);
  const endBeforeClose = await storedTestEndMs(oops.test.code);
  await expectPublicError(() => reopenTest(adminReq, oops.test.code), 409); // not closed: nothing to resume
  await closeTest(adminReq, oops.test.code);
  await releaseResults(adminReq, oops.test.code);
  // Ten minutes pass before the teacher notices.
  await tests().updateOne({ code: oops.test.code }, { $set: { closedAt: new Date(Date.now() - 10 * 60_000) } });
  const resumed = await reopenTest(adminReq, oops.test.code);
  assert.equal(resumed.test.isClosed, false, 'running again');
  assert.equal(resumed.test.resultsReleasedAt, null, 'released marks hidden again');
  assert.equal(resumed.affectedCount, 1, 'only the paper the Close handed in');
  const movedByResume = (await storedTestEndMs(oops.test.code)) - endBeforeClose;
  assert.ok(movedByResume >= 10 * 60_000 && movedByResume < 10 * 60_000 + 5_000, `the time closed is given back (${movedByResume} ms)`);
  const rowOf = (dashboard, email) => dashboard.registrations.find((row) => row.email === email);
  assert.equal(rowOf(resumed, studentEmail).attemptStatus, 'in_progress', 'the open paper reopens');
  assert.equal(rowOf(resumed, studentEmail).answeredCount, 1, 'with its answer');
  assert.equal(rowOf(resumed, otherEmail).attemptStatus, 'submitted', 'a paper the student handed in stays handed in');
  assert.equal(rowOf(resumed, otherEmail).submittedBy, 'student');
  assert.equal((await attemptResult(writing.studentRequest, writingPaper.id)).reopened, true, 'an open result page is sent back to the paper');
  const backOnPaper = await getAttempt(writing.studentRequest, oops.test.code);
  assert.equal(backOnPaper.status, 'in_progress');
  assert.equal(backOnPaper.answeredQuestionCount, 1);
  await expectPublicError(() => reopenTest(adminReq, oops.test.code), 409); // a second click: already running
  // The answer can be changed again now.
  const oopsSecond = backOnPaper.questions[0];
  const changed = await saveAnswer(writing.studentRequest, backOnPaper.id, { questionId: oopsSecond.id, selectedOptions: [oopsSecond.options[1].id] });
  assert.deepEqual(changed.questions[0].selectedOptions, [oopsSecond.options[1].id]);
  const resumedHandIn = await submitAttemptForStudent(writing.studentRequest, backOnPaper.id);
  assert.equal(resumedHandIn.status, 'submitted');
  assert.equal(handedIn.submittedBy, 'student');
  await closeTest(adminReq, oops.test.code);
  // With no time left when it closed, there is nothing to resume; nor after the clock ended it.
  await tests().updateOne({ code: oops.test.code }, { $set: { endsAt: new Date(Date.now() - 60_000) } });
  await expectPublicError(() => reopenTest(adminReq, oops.test.code), 409);
  await tests().updateOne({ code: oops.test.code }, { $set: { endsAt: new Date(Date.now() + 60 * 60_000), closedAutomatically: true } });
  await expectPublicError(() => reopenTest(adminReq, oops.test.code), 409);

  // Strict timing: the open question's clock moves on by the time closed, so it is not lost.
  const oopsStrict = await createTest(adminReq, {
    ...objectivePayload(`Resume strict ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }),
    shuffleQuestions: false, strictTiming: true,
    questions: [
      { prompt: 'Strict one?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 60 },
      { prompt: 'Strict two?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], timeSeconds: 60 }
    ]
  });
  createdCodes.push(oopsStrict.test.code);
  const strictWriter = await seatStudent(oopsStrict.test.code);
  await startTest(adminReq, oopsStrict.test.code);
  const strictOpen = await startAttempt(strictWriter.studentRequest, oopsStrict.test.code);
  await closeTest(adminReq, oopsStrict.test.code);
  // As if all of it happened ten minutes ago: the question opened, then the Close.
  await tests().updateOne({ code: oopsStrict.test.code }, { $set: { closedAt: new Date(Date.now() - 10 * 60_000) } });
  await registrations().updateOne({ testCode: oopsStrict.test.code, id: strictWriter.registration.id },
    [{ $set: { 'attempt.strict.shownAt': { $subtract: ['$attempt.strict.shownAt', 10 * 60_000] } } }]);
  await reopenTest(adminReq, oopsStrict.test.code);
  const strictBack = await getAttempt(strictWriter.studentRequest, oopsStrict.test.code);
  assert.equal(strictBack.status, 'in_progress');
  assert.equal(strictBack.strict.index, 0, 'still on the question that was open - not timed out by the time closed');
  const leftBefore = Date.parse(strictOpen.strict.questionEndsAt) - Date.parse(strictOpen.serverTime);
  const leftAfter = Date.parse(strictBack.strict.questionEndsAt) - Date.parse(strictBack.serverTime);
  assert.ok(Math.abs(leftAfter - leftBefore) < 5_000, `the question keeps the time it had (${leftBefore} ms before, ${leftAfter} ms after)`);
  await closeTest(adminReq, oopsStrict.test.code);

  /* ------------------------- PAUSE ONE STUDENT, HAND IN ONE PAPER, REJECT ---- */
  const pauseTest = await createTest(adminReq, objectivePayload(`Pause ${identifier}`, {
    schedule: { endMode: 'at', endsAt: new Date(Date.now() + 30 * 60_000).toISOString() }
  }));
  const pauseCode = pauseTest.test.code;
  createdCodes.push(pauseCode);
  const heldSeat = await seatStudent(pauseCode);
  const handedSeat = await seatStudent(pauseCode, otherReq, otherSapId);
  await startTest(adminReq, pauseCode);
  const heldPaper = await startAttempt(heldSeat.studentRequest, pauseCode);
  const handedPaper = await startAttempt(handedSeat.studentRequest, pauseCode);
  const pauseQuestion = heldPaper.questions[0];
  await saveAnswer(heldSeat.studentRequest, heldPaper.id, { questionId: pauseQuestion.id, selectedOptions: [pauseQuestion.options[0].id] });
  let pauseBoard = await pauseAttempt(adminReq, pauseCode, heldSeat.registration.id);
  assert.equal(rowOf(pauseBoard, studentEmail).isPaused, true);
  const whilePaused = await getAttempt(heldSeat.studentRequest, pauseCode);
  assert.equal(whilePaused.paused, true);
  assert.equal(whilePaused.questions, undefined, 'no paper on screen while paused');
  await assert.rejects(() => saveAnswer(heldSeat.studentRequest, heldPaper.id, { questionId: pauseQuestion.id, selectedOptions: [pauseQuestion.options[1].id] }),
    (error) => error.code === 'PAUSED', 'no answers while paused');
  await assert.rejects(() => submitAttemptForStudent(heldSeat.studentRequest, heldPaper.id), (error) => error.code === 'PAUSED', 'no submitting while paused');
  // Ten minutes paused: their own end moves ten minutes later; everyone else's does not.
  await registrations().updateOne({ testCode: pauseCode, id: heldSeat.registration.id }, { $set: { 'attempt.pausedAt': new Date(Date.now() - 10 * 60_000) } });
  pauseBoard = await continueAttempt(adminReq, pauseCode, heldSeat.registration.id);
  const continued = rowOf(pauseBoard, studentEmail);
  assert.equal(continued.isPaused, false);
  assert.ok(continued.extraMs >= 10 * 60_000 && continued.extraMs < 10 * 60_000 + 5_000, `ten minutes given back (${continued.extraMs} ms)`);
  const classEnd = Date.parse(pauseBoard.test.endsAt);
  assert.ok(Math.abs(Date.parse(continued.ownDeadlineAt) - (classEnd + continued.extraMs)) < 1_000, 'their own end is the test end plus the pause');
  assert.equal(rowOf(pauseBoard, otherEmail).extraMs, 0, 'nobody else gets the time');
  const afterContinue = await getAttempt(heldSeat.studentRequest, pauseCode);
  assert.equal(afterContinue.paused, false);
  assert.equal(afterContinue.answeredQuestionCount, 1, 'the answer saved before the pause is there');
  assert.ok(Math.abs(Date.parse(afterContinue.deadlineAt) - Date.parse(continued.ownDeadlineAt)) < 1_000, 'the student sees their own end');
  // Rejected mid-test: told plainly, and approving again lets them carry on.
  await decideRegistration(adminReq, pauseCode, heldSeat.registration.id, 'reject');
  await assert.rejects(() => getAttempt(heldSeat.studentRequest, pauseCode), (error) => error.code === 'REJECTED' && /rejected your registration/.test(error.message));
  await decideRegistration(adminReq, pauseCode, heldSeat.registration.id, 'approve');
  assert.equal((await getAttempt(heldSeat.studentRequest, pauseCode)).status, 'in_progress', 'approved again: back on the paper');
  // One paper handed in by the teacher.
  pauseBoard = await submitStudentPaper(adminReq, pauseCode, handedSeat.registration.id);
  assert.equal(rowOf(pauseBoard, otherEmail).attemptStatus, 'submitted');
  assert.equal(rowOf(pauseBoard, otherEmail).submittedBy, 'teacher');
  assert.equal((await attemptResult(handedSeat.studentRequest, handedPaper.id)).submittedBy, 'teacher');
  // The class's time runs out; the test waits for the ten minutes still owed to the paused student.
  await tests().updateOne({ code: pauseCode }, { $set: { endsAt: new Date(Date.now() - END_GRACE_MS - 5_000) } });
  await runScheduleOnce();
  assert.equal((await testDocByCode(pauseCode)).isClosed, false, 'the automatic end waits for time a pause is owed');
  assert.equal((await getAttempt(heldSeat.studentRequest, pauseCode)).status, 'in_progress');
  // Their own end passes too: their paper is handed in for time, and the test closes.
  await registrations().updateOne({ testCode: pauseCode, id: heldSeat.registration.id }, { $set: { 'attempt.extraMs': 0 } });
  await runScheduleOnce();
  const pauseDoc = await testDocByCode(pauseCode);
  assert.equal(pauseDoc.isClosed, true);
  assert.equal(pauseDoc.registrations.find((entry) => entry.id === heldSeat.registration.id).attempt.submittedBy, 'time');

  /* ------------------------------- UNANSWERED REQUESTS EXPIRE ON THEIR OWN ---- */
  const expiryTest = await createTest(adminReq, objectivePayload(`Expiry ${identifier}`));
  const expiryCode = expiryTest.test.code;
  createdCodes.push(expiryCode);
  const waitMinutes = config.pendingRequestMinutes;
  assert.ok(waitMinutes > 0, 'requests expire by default');
  const asked = await registerForTest(studentReq, cookieResponse(), expiryCode, { sapId });
  assert.equal(asked.registration.status, 'pending');
  assert.equal(Date.parse(asked.registration.expiresAt) - Date.parse(asked.registration.requestedAt), waitMinutes * 60_000,
    'the student is told when an unanswered request is withdrawn');
  await registerForTest(otherReq, cookieResponse(), expiryCode, { sapId: otherSapId });
  const expiryRow = async (email) => (await testDocByCode(expiryCode)).registrations.find((entry) => entry.collegeEmail === email);
  await decideRegistration(adminReq, expiryCode, (await expiryRow(otherEmail)).id, 'approve');
  // Both asked long ago; only the one nobody answered goes.
  const longAgo = new Date(Date.now() - (waitMinutes + 1) * 60_000);
  await registrations().updateMany({ testCode: expiryCode }, { $set: { requestedAt: longAgo } });
  const swept = await runScheduleOnce();
  assert.ok(swept.expired >= 1, 'the scheduler removes the stale request');
  assert.equal(await expiryRow(studentEmail), undefined, 'an unanswered request is gone after the wait');
  assert.equal((await expiryRow(otherEmail)).status, 'approved', 'an approved student is kept however long ago they asked');
  // They simply ask again, and a fresh request is left alone.
  assert.equal((await registerForTest(studentReq, cookieResponse(), expiryCode, { sapId })).registration.status, 'pending');
  await runScheduleOnce();
  assert.equal((await expiryRow(studentEmail)).status, 'pending', 'a request inside the wait stays');

  /* ------------------- AN IPHONE KEYBOARD'S OWN APP IS NOT LEAVING THE TEST ---- */
  // Warn only, 3 exits and 10 seconds away allowed: a note must never add a warning; a real absence does.
  const keyboardTest = await createTest(adminReq, { ...objectivePayload(`Keyboard ${identifier}`), violationAction: 'warn' });
  const keyboardCode = keyboardTest.test.code;
  createdCodes.push(keyboardCode);
  const typist = { portalUser: { email: `regression-typist-${identifier}@stu.upes.ac.in`, displayName: 'Typist Student', role: 'student' } };
  const typistSeat = await seatStudent(keyboardCode, typist, String(100_000_000 + ((Date.now() + 5_000_011) % 890_000_000)));
  await startTest(adminReq, keyboardCode);
  const typistPaper = await startAttempt(typistSeat.studentRequest, keyboardCode);
  const typistRecord = async () => (await registrations().findOne({ testCode: keyboardCode, id: typistSeat.registration.id })).attempt;
  const presence = (event) => recordFullscreenEvent(typistSeat.studentRequest, typistPaper.id, event);
  // Left while typing: shown as away at once, but nothing counted yet.
  const awayNow = await presence({ type: 'exit', detail: 'tab_switch', typing: true });
  assert.equal(awayNow.attempt.isAway, true, 'the teacher still sees them away');
  assert.equal((await typistRecord()).integrity?.leaveCount || 0, 0, 'but it is not counted yet');
  // Back in 4 seconds: a note, not a departure.
  await presence({ type: 'return', durationMs: 4_000, detail: 'tab_switch' });
  let typed = await typistRecord();
  assert.equal(typed.integrity.flags.keyboard_app, 1);
  assert.equal(typed.integrity?.leaveCount || 0, 0, 'a keyboard blip is not leaving');
  assert.equal(typed.fullscreenExitCount || 0, 0);
  assert.equal(typed.awaySince, null);
  assert.equal(typed.events.at(-1).detail, 'keyboard_app');
  // Two more (one of them a pop-up over the page rather than another app).
  await presence({ type: 'exit', detail: 'focus_lost', typing: true });
  await presence({ type: 'return', durationMs: 2_000, detail: 'focus_lost' });
  await presence({ type: 'exit', detail: 'tab_switch', typing: true });
  await presence({ type: 'return', durationMs: 3_000, detail: 'tab_switch' });
  typed = await typistRecord();
  assert.equal(typed.integrity.flags.keyboard_app, 3);
  assert.equal(typed.integrity?.leaveCount || 0, 0);
  // A fourth: past the three notes a paper gets, it counts like any other.
  await presence({ type: 'exit', detail: 'tab_switch', typing: true });
  await presence({ type: 'return', durationMs: 2_000, detail: 'tab_switch' });
  typed = await typistRecord();
  assert.equal(typed.integrity.flags.keyboard_app, 3, 'no more than three notes');
  assert.equal(typed.integrity.leaveCount, 1, 'the fourth counts');
  assert.equal(typed.integrity.leaves.tab_switch, 1);
  // Away while typing for 30 seconds (the server's own clock, whatever the page says): counted once, from when
  // it began - and the silence is not counted a second time as going offline.
  await presence({ type: 'exit', detail: 'tab_switch', typing: true });
  await registrations().updateOne({ testCode: keyboardCode, id: typistSeat.registration.id }, { $set: {
    'attempt.awaySince': new Date(Date.now() - 30_000), 'attempt.lastSeenAt': new Date(Date.now() - 90_000)
  } });
  await presence({ type: 'return', durationMs: 1_000, detail: 'tab_switch' });
  typed = await typistRecord();
  assert.equal(typed.integrity.leaveCount, 2, 'the long one counts once');
  assert.equal(typed.integrity.leaves.offline || 0, 0, 'and not again as offline');
  assert.ok(typed.integrity.awayMs >= 30_000, `its whole time away is kept (${typed.integrity.awayMs} ms)`);
  assert.equal(typed.violationCount, 1, 'past the 10 seconds allowed: warned');
  const exitEvent = typed.events.findLast((event) => event.type === 'fullscreen_exit');
  assert.ok(Date.now() - new Date(exitEvent.createdAt).getTime() >= 29_000, 'the departure is dated when it began');
  // Leaving without typing is counted at once, as before; so is leaving fullscreen while typing.
  await presence({ type: 'exit', detail: 'tab_switch' });
  assert.equal((await typistRecord()).integrity.leaveCount, 3);
  await presence({ type: 'return', durationMs: 1_000, detail: 'tab_switch' });
  await presence({ type: 'exit', detail: 'fullscreen', typing: true });
  assert.equal((await typistRecord()).integrity.leaveCount, 4, 'only switching app or a pop-up can be the keyboard');
  await presence({ type: 'return', durationMs: 1_000, detail: 'fullscreen' });
  await closeTest(adminReq, keyboardCode);

  /* ------------------------------------------ LEAST-OVERLAP QUESTION DRAW ---- */
  const drawBank = Array.from({ length: 6 }, (_unused, index) => ({
    prompt: `Draw question ${index + 1}?`, type: 'mcq', options: ['A', 'B'], correctOptions: ['0']
  }));
  const drawTest = await createTest(adminReq, {
    ...objectivePayload(`Draw ${identifier}`, { questionMix: { mcq: 2, msq: 0, short: 0 } }),
    questionDraw: 'spread', questions: drawBank
  });
  createdCodes.push(drawTest.test.code);
  assert.equal(drawTest.test.questionDraw, 'spread');
  await startTest(adminReq, drawTest.test.code);
  const drawPapers = [];
  for (let seatNumber = 1; seatNumber <= 3; seatNumber += 1) {
    const email = `regression-${identifier}-draw${seatNumber}@stu.upes.ac.in`;
    profileEmails.push(email);
    const request = { portalUser: { email, displayName: `Draw Student ${seatNumber}`, role: 'student' } };
    const drawSap = String(100_000_000 + ((Date.now() + seatNumber * 7_919) % 890_000_000));
    const { studentRequest, registration: drawRegistration } = await seatStudent(drawTest.test.code, request, drawSap);
    const paper = await startAttempt(studentRequest, drawTest.test.code);
    drawPapers.push({ ids: paper.questions.map((question) => question.id).sort(), registration: drawRegistration, studentRequest });
  }
  const drawn = drawPapers.flatMap((paper) => paper.ids);
  assert.equal(new Set(drawn).size, 6, 'three students in a row share no question: 3 papers × 2 = the whole bank of 6');
  // A restart keeps the student's own block.
  await restartAttempt(adminReq, drawTest.test.code, drawPapers[1].registration.id);
  const drawRestarted = await getAttempt(drawPapers[1].studentRequest, drawTest.test.code);
  assert.deepEqual(drawRestarted.questions.map((question) => question.id).sort(), drawPapers[1].ids);
  // Reset hands the blocks out from the start again.
  await closeTest(adminReq, drawTest.test.code);
  await resetTest(adminReq, drawTest.test.code);
  const afterReset = await testDocByCode(drawTest.test.code);
  assert.equal(afterReset.paperSlots, 0);
  assert.equal(afterReset.registrations.every((entry) => entry.paperSlot === null), true);

  // A late starter is bound by the same end time as everyone else.
  const lateTest = await createTest(adminReq, objectivePayload(`Late start ${identifier}`));
  createdCodes.push(lateTest.test.code);
  const lateSeat = await seatStudent(lateTest.test.code);
  await startTest(adminReq, lateTest.test.code);
  const sharedEnd = new Date(Date.now() + 90_000);
  await setTestEndTime(adminReq, lateTest.test.code, { endsAt: sharedEnd.toISOString() });
  const lateAttempt = await startAttempt(lateSeat.studentRequest, lateTest.test.code);
  assert.equal(
    Date.parse(lateAttempt.deadlineAt), sharedEnd.getTime(),
    'starting late does not buy a fresh personal clock'
  );
  assert.ok(Date.parse(lateAttempt.deadlineAt) - Date.parse(lateAttempt.startedAt) < 120 * 1000);
  // One test at a time: the student's paper here is still open, so they cannot
  // begin another test until it is submitted or the test is closed.
  await closeTest(adminReq, lateTest.test.code);

  /* ------------------------------------------------------- test lifecycle */
  const lifecycle = await createTest(adminReq, objectivePayload(`Lifecycle ${identifier}`, { resultReleaseMode: 'after_quiz' }));
  createdCodes.push(lifecycle.test.code);
  const editedStart = new Date(Date.now() + 15 * 60_000);
  const edited = await updateTestSettings(adminReq, lifecycle.test.code, {
    title: `Edited lifecycle ${identifier}`,
    instructions: 'Updated before students begin.',
    opensAt: editedStart.toISOString(),
    fullscreenExitLimit: 2,
    fullscreenAbsenceLimitSeconds: 12,
    shuffleQuestions: false,
    locationRequired: false,
    resultReleaseMode: 'after_quiz'
  });
  assert.equal(edited.test.title, `Edited lifecycle ${identifier}`);
  assert.equal(edited.test.estimatedSeconds, 60);
  // The start moved past the old end and no new end came with it, so the window
  // is rebuilt from the estimate rather than failing on an impossible window.
  assert.equal(new Date(edited.test.endsAt).getTime(), editedStart.getTime() + 60_000);

  // Questions per student is editable before the test starts, and the end time
  // follows it.
  const regrouped = await updateTestSettings(adminReq, lifecycle.test.code, { questionMix: { mcq: 2, msq: 0, short: 0 } });
  assert.equal(regrouped.test.questionCount, 2);
  assert.deepEqual(regrouped.test.questionMix, { mcq: 2, msq: 0, short: 0 });
  assert.equal(regrouped.test.estimatedSeconds, 120);
  assert.deepEqual(regrouped.test.questionPool, { mcq: 2, msq: 0, short: 0 });

  // An end time the admin actually chose survives an unrelated settings edit.
  const chosenEnd = new Date(editedStart.getTime() + 45 * 60_000);
  const withEnd = await updateTestSettings(adminReq, lifecycle.test.code, { endsAt: chosenEnd.toISOString() });
  assert.equal(new Date(withEnd.test.endsAt).getTime(), chosenEnd.getTime());
  const retitled = await updateTestSettings(adminReq, lifecycle.test.code, { title: `Kept end ${identifier}` });
  assert.equal(new Date(retitled.test.endsAt).getTime(), chosenEnd.getTime(), 'the chosen end time is not recalculated away');

  const lifecycleResponse = cookieResponse();
  await registerForTest(studentReq, lifecycleResponse, lifecycle.test.code, { sapId });
  const secondStudentEmail = `bulk-${identifier}@stu.upes.ac.in`;
  profileEmails.push(secondStudentEmail);
  const secondStudentReq = { portalUser: { email: secondStudentEmail, displayName: 'Bulk Student', role: 'student' } };
  await registerForTest(secondStudentReq, cookieResponse(), lifecycle.test.code, { sapId: String(Number(sapId) + 2) });

  const bulk = await bulkDecision(adminReq, lifecycle.test.code, 'approve');
  assert.equal(bulk.registrations.filter((item) => item.status === 'approved').length, 2);
  await startTest(adminReq, lifecycle.test.code);
  // A running test still takes the edits that cannot reshape anyone's paper,
  // and refuses the ones that could.
  const renamedLive = await updateTestSettings(adminReq, lifecycle.test.code, { title: `Renamed live ${identifier}` });
  assert.equal(renamedLive.test.title, `Renamed live ${identifier}`);
  await expectPublicError(() => updateTestSettings(adminReq, lifecycle.test.code, { questionMix: { mcq: 1, msq: 0, short: 0 } }), 409);
  await expectPublicError(() => updateTestSettings(adminReq, lifecycle.test.code, { shuffleQuestions: true }), 409);

  const lifecycleStudentReq = registeredRequest(lifecycle.test.code, lifecycleResponse);
  const lifecycleAttempt = await startAttempt(lifecycleStudentReq, lifecycle.test.code);
  assert.equal(lifecycleAttempt.questions.length, 2);

  const studentRow = bulk.registrations.find((item) => item.email === studentEmail);
  const beforeRestart = Date.parse(lifecycleAttempt.deadlineAt);
  const restarted = await restartAttempt(adminReq, lifecycle.test.code, studentRow.id);
  assert.equal(restarted.registrations.find((item) => item.email === studentEmail).attemptStatus, 'in_progress');
  assert.equal(
    Date.parse((await getAttempt(lifecycleStudentReq, lifecycle.test.code)).deadlineAt), beforeRestart,
    'a restart gives a blank paper, not a new deadline - extending the test is what gives time'
  );
  assert.equal((await restartAllAttempts(adminReq, lifecycle.test.code)).resetCount, 1);

  const completed = await closeTest(adminReq, lifecycle.test.code);
  assert.equal(completed.test.isClosed, true);
  const closedAttempt = await getAttempt(lifecycleStudentReq, lifecycle.test.code);
  assert.equal((await attemptResult(lifecycleStudentReq, closedAttempt.id)).released, true);

  const reset = await resetTest(adminReq, lifecycle.test.code);
  assert.equal(reset.test.isStarted, false);
  assert.equal(reset.test.isClosed, false);
  assert.equal(reset.registrations.every((item) => item.attemptStatus === null), true);

  /* --------------------------------------- release modes and venue checks */
  const adminRelease = await createTest(adminReq, objectivePayload(`Admin release ${identifier}`, { resultReleaseMode: 'admin' }));
  createdCodes.push(adminRelease.test.code);
  const releaseSeat = await seatStudent(adminRelease.test.code);
  await startTest(adminReq, adminRelease.test.code);
  let releaseAttempt = await startAttempt(releaseSeat.studentRequest, adminRelease.test.code);
  const releaseQuestion = releaseAttempt.questions[0];
  await saveAnswer(releaseSeat.studentRequest, releaseAttempt.id, { questionId: releaseQuestion.id, selectedOptions: [releaseQuestion.options[0].id] });
  releaseAttempt = await submitAttemptForStudent(releaseSeat.studentRequest, releaseAttempt.id);
  assert.equal((await attemptResult(releaseSeat.studentRequest, releaseAttempt.id)).released, false);
  await releaseResults(adminReq, adminRelease.test.code);
  assert.equal((await attemptResult(releaseSeat.studentRequest, releaseAttempt.id)).released, true);

  const locationTest = await createTest(adminReq, objectivePayload(`Location ${identifier}`, { locationRequired: true }));
  createdCodes.push(locationTest.test.code);
  const locationSeat = await seatStudent(locationTest.test.code);
  await startTest(adminReq, locationTest.test.code);
  await expectPublicError(() => startAttempt(locationSeat.studentRequest, locationTest.test.code), 403);
  // 250 m test area; the venue is at 30.3165, 78.0322. About 900 m north:
  const farNorth = { latitude: 30.3246, longitude: 78.0322 };
  // Approximate location (±1500 m) cannot say they are away: they are told to turn on precise location.
  await assert.rejects(() => startAttempt(locationSeat.studentRequest, locationTest.test.code, { ...farNorth, accuracyMeters: 1_500 }),
    (error) => error.code === 'LOCATION_IMPRECISE' && /Precise Location/.test(error.message));
  // A precise fix that far away is simply outside.
  await assert.rejects(() => startAttempt(locationSeat.studentRequest, locationTest.test.code, { ...farNorth, accuracyMeters: 15 }),
    (error) => error.status === 403 && /outside the permitted test area/.test(error.message));
  // About 500 m north with a good ±100 m fix: even its near edge is past the area and its buffer.
  await assert.rejects(() => startAttempt(locationSeat.studentRequest, locationTest.test.code, { latitude: 30.3210, longitude: 78.0322, accuracyMeters: 100 }),
    (error) => error.status === 403 && /outside the permitted test area/.test(error.message));
  await setLocationOverride(adminReq, locationTest.test.code, locationSeat.registration.id, { enabled: true });
  assert.equal((await startAttempt(locationSeat.studentRequest, locationTest.test.code)).status, 'in_progress');
  // In the building, the phone puts them about 300 m out, ±100 m: the margin reaches into the area.
  // The paper would not count that reading against them, so it does not stop them starting either.
  const edgeRequest = { portalUser: { email: `regression-edge-${identifier}@stu.upes.ac.in`, displayName: 'Edge Student', role: 'student' } };
  const edgeSeat = await seatStudent(locationTest.test.code, edgeRequest, String(100_000_000 + ((Date.now() + 3_000_017) % 890_000_000)));
  const edgePaper = await startAttempt(edgeSeat.studentRequest, locationTest.test.code, { latitude: 30.3192, longitude: 78.0322, accuracyMeters: 100 });
  assert.equal(edgePaper.status, 'in_progress', 'a good reading just past the edge may begin');
  assert.equal((await registrations().findOne({ testCode: locationTest.test.code, id: edgeSeat.registration.id })).attempt.locationChecks.inconclusive, 1,
    'and it is recorded as a reading that could not tell');

  /* ------------------------------------------- guests, at the admin's choice */
  const guestTest = await createTest(adminReq, objectivePayload(`Guest ${identifier}`, { allowGuests: true }));
  createdCodes.push(guestTest.test.code);

  const guestResponse = cookieResponse();
  const guestSession = await beginGuestSession(guestResponse, { name: 'Walk In', testCode: guestTest.test.code });
  assert.equal(guestSession.user.isGuest, true);
  assert.equal(guestSession.user.role, 'student');
  assert.match(guestSession.user.name, /^Guest: /);
  const guestEmail = guestSession.user.email;
  profileEmails.push(guestEmail);
  await expectPublicError(() => beginGuestSession(cookieResponse(), { name: 'X', testCode: guestTest.test.code }), 400);

  const guestReq = { portalUser: { email: guestEmail, displayName: guestSession.user.name, role: 'student' } };
  const guestSeat = await seatStudent(guestTest.test.code, guestReq, String(Number(sapId) + 3));
  assert.equal(guestSeat.registration.status, 'pending');
  await startTest(adminReq, guestTest.test.code);
  const guestAttempt = await startAttempt(guestSeat.studentRequest, guestTest.test.code);
  assert.equal(guestAttempt.status, 'in_progress');

  // Turning the toggle off shuts the door again, for sessions and registrations.
  await closeTest(adminReq, guestTest.test.code);
  const guestOff = await createTest(adminReq, objectivePayload(`Guest off ${identifier}`));
  createdCodes.push(guestOff.test.code);
  await expectPublicError(() => beginGuestSession(cookieResponse(), { name: 'Walk In', testCode: guestOff.test.code }), 403);
  await expectPublicError(() => registerForTest(guestReq, cookieResponse(), guestOff.test.code, { sapId: String(Number(sapId) + 4) }), 403);

  /* ------------------------------------------------ quiz list, duplicate, archive */
  let list = await adminTests(adminReq);
  const scored = list.find((entry) => entry.code === code);
  assert.ok(scored.submittedCount >= 1, 'the list counts submitted papers');
  assert.equal(typeof scored.averageScore, 'number', 'and averages their scores');
  assert.ok(scored.averageScore >= 0 && scored.averageScore <= 100);
  assert.ok(scored.updatedAt, 'every quiz has a last-edited time');
  const copy = await duplicateTest(adminReq, code);
  createdCodes.push(copy.test.code);
  const copyDoc = await testDocByCode(copy.test.code);
  assert.notEqual(copy.test.code, code);
  assert.equal(copyDoc.registrations.length, 0, 'a copy carries no students');
  assert.equal(copyDoc.isStarted, false);
  assert.equal(copyDoc.questions.length, (await testDocByCode(code)).questions.length, 'but every question');
  await archiveTest(adminReq, copy.test.code);
  list = await adminTests(adminReq);
  assert.ok(list.find((entry) => entry.code === copy.test.code).archivedAt, 'archived');
  await archiveTest(adminReq, copy.test.code, { archived: false });
  list = await adminTests(adminReq);
  assert.equal(list.find((entry) => entry.code === copy.test.code).archivedAt, null, 'and restored');

  console.log([
    'Regression check passed:',
    'registration (student domain, plus guests only where the admin allowed them), SAP profile, approval and bulk approval,',
    'setup editing including questions per student and the end time, start, venue exception, lock/revive, warn-only tests,',
    'free navigation across the paper, the shared end time for late starters, time up (grace, lock, extension)',
    'and automatic submission by the scheduler, scheduled starts, durations from the real start,',
    'strict per-question timing (forward only, server-side timeouts, auto-submit on the last question),',
    'server outages given back once, editing the question paper for everyone or new papers only, restart quiz (running or finished), resuming a test closed by mistake (papers back where they were, time given back), pausing one student (time stopped and given back, the automatic end waiting for it), handing in one paper, rejecting mid-test, unanswered requests expiring after the wait, a phone keyboard opening its own app noted rather than counted as leaving, the least-overlap question draw, strict timing without Next (server-enforced), the question clock stopping while away or locked, the private-window record,',
    'close, manual marking, analysis, Excel export, restart/reset, all result-release modes, and the quiz list (scores, duplicate, archive).'
  ].join(' '));
} finally {
  if (createdCodes.length) {
    await tests().deleteMany({ code: { $in: createdCodes } });
    await registrations().deleteMany({ testCode: { $in: createdCodes } });
  }
  await studentProfiles().deleteMany({ email: { $in: profileEmails } });
  await closeDatabase();
}
