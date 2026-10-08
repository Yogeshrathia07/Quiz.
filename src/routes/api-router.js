import express, { Router } from 'express';
import { config } from '../config.js';
import {
  authStatus, logout, requireAccount, requireAdmin, requireTestTaker, requireUserManager
} from '../auth/portal-auth.js';
import {
  changePassword, checkCode, logIn, passwordStatus, requestCode, resetPassword, signUp
} from '../auth/account-login.js';
import { beginMicrosoftLogin, finishMicrosoftLogin } from '../auth/microsoft-login.js';
  import { createTest, testQrSvg, updateTestSettings } from '../services/test-service.js';
import { saveTestPaper, testForEditing } from '../services/paper-service.js';
import { importMarks } from '../services/marks-import.js';
import {
  beginGuestSession, endGuestVisit, getTest, myResponseData, myResponseView, myResults, registerForTest, setMySapId, studentProfile
} from '../services/registration-service.js';
import {
  blockUser, deleteUser, listUsers, setUserName, setUserSapId, unblockUser, userDetail, userResponseData
} from '../services/user-service.js';
import {
  attemptResult, getAttempt, markShown, nextQuestion, recordFullscreenEvent, recordFullscreenEvents, recordLocationCheck, saveAnswer, startAttempt, submitAttemptForStudent
} from '../services/attempt-service.js';
import { attemptRevision, compactAnswerResponse, compactAttemptState, revisionedAttempt } from '../domain/attempt-sync.js';
import {
  adminDashboard, adminExportData, adminTests, archiveTest, userTestAnalysis, bulkAttemptAction, duplicateTest, bulkDecision, closeTest, csvForAdmin, decideRegistration,
  deleteTest, gradeManualAnswer, manualReview, registrationAnalysis, registrationRecord, releaseResults, restartAllAttempts, restartQuiz, reviewData, setAnswerMarks, setResultsFrozen, setUnmarkedRelease,
  continueAttempt, pauseAttempt, reopenTest, restartAttempt, resetTest, resumeAttempt, reopenStudentPaper, submitStudentPaper, setDeviceOverride, setLocationOverride, setTestEndTime, startTest, updateStudentSapId
} from '../services/admin-service.js';
import { exportWorkerStats, runExportJob } from '../export/worker-pool.js';
import { performanceSnapshot } from '../services/traffic.js';
import { requireOwnedTest, requireRegistration, requireTestForStudent } from '../data/test-repository.js';
import { publishLiveEvent } from '../coordination/index.js';
import { openAdminUpdates, openStudentUpdates } from '../realtime/live-updates.js';
import {
  addManualMark, addManualMarks, attendanceExportData, attendanceForAdmin, attendanceRegisterData, attendanceRoster, attendanceForStudent,
  attendanceSettings, beginAttendanceGuest, closeAttendance, createAttendance, deleteAttendance, listAttendance, markAttendance,
  reopenAttendance, searchPeople, setMarkStatus, setMarkStatuses
} from '../services/attendance-service.js';
import { homeSummary } from '../services/home-service.js';
import { testMatrix, testOverview } from '../services/overview-service.js';
import { MAX_IMAGE_BYTES, questionImage, saveQuestionImage } from '../services/question-image-service.js';
import { checkAnyDevice, checkTestDevice } from '../services/device-service.js';
import { limitPerAddress } from '../lib/security.js';

/** Forwards any thrown PublicTestError to the central error handler. */
const route = (handler) => async (req, res, next) => {
  try { await handler(req, res, next); } catch (error) { next(error); }
};

const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
const joinUrl = (req, code) => `${baseUrl(req)}/?test=${encodeURIComponent(code)}`;
const testCode = (code) => String(code || '').toUpperCase();

// Live frames are hints, never part of an authoritative write.  In particular
// Redis publish must not add its network round-trip to an answer, an approval,
// or Start.  Coalescing also stops a busy class from sending one dashboard
// refresh per individual answer: the next frame is enough for the dashboard to
// ask for the current authorised state.
const pendingSignals = new Map();
let signalFlushTimer = null;
const SIGNAL_BATCH_MS = 25;
const signalKey = (event) => [
  event.code,
  event.broadcast ? '*' : event.registrationId ? `registration:${event.registrationId}` : event.attemptId ? `attempt:${event.attemptId}` : 'admin'
].join('|');
const signal = (event) => {
  if (!event?.code) return;
  const next = { ...event, code: testCode(event.code) };
  pendingSignals.set(signalKey(next), next);
  if (signalFlushTimer) return;
  // A frame is only a refresh hint. Holding it for one animation-sized slice
  // collapses a simultaneous answer rush into one dashboard signal, while the
  // added 25 ms is far below a perceptible admin or student update delay.
  signalFlushTimer = setTimeout(() => {
    signalFlushTimer = null;
    const batch = [...pendingSignals.values()];
    pendingSignals.clear();
    for (const item of batch) {
      // A missed frame is safe: the normal poll and EventSource reconnect
      // fetch the source of truth.  An unhandled publish failure is not.
      void publishLiveEvent(item).catch((error) => console.error('Live update:', error));
    }
  }, SIGNAL_BATCH_MS);
  signalFlushTimer.unref?.();
};
const signalTest = (code, kind, extra = {}) => signal({ code, broadcast: true, kind, ...extra });
const signalRegistration = (code, registrationId, kind, extra = {}) => signal({
  code,
  registrationId: String(registrationId),
  kind,
  ...extra
});

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendResponseSheet = async (res, data, { audit = false } = {}) => {
  // Keep numeric SAP IDs in the download name (`\w`, not the literal letter
  // "w"); this also makes one student's file easy to identify after export.
  const who = String(data.student.sapId || data.student.email.split('@')[0]).replace(/[^\w.-]/g, '');
  res.type(XLSX_TYPE).attachment(`${data.test.code}-${who}-${audit ? 'audit' : 'responses'}.xlsx`).send(await runExportJob('student', data, { audit }));
};

export function createApiRouter() {
  const router = Router();

  // The server's clock, stamped as each reply leaves. A test paper measures
  // the round trip around it to keep its timers on this clock, however slow
  // or wrong the device's own (client/src/lib/server-clock.js).
  router.use('/api', (_req, res, next) => {
    const writeHead = res.writeHead;
    res.writeHead = function stampServerTime(...args) {
      if (!res.headersSent) res.setHeader('X-Server-Time', String(Date.now()));
      return writeHead.apply(this, args);
    };
    next();
  });

  /* ------------------------------------------------------------------ auth */
  router.get('/api/auth/status', (req, res) => res.json(authStatus(req)));
  router.post('/api/auth/login', route(async (req, res) => res.json(await logIn(req, res, req.body || {}))));
  // Sign-up and password reset each start with a code emailed to the address.
  router.post('/api/auth/code', route(async (req, res) => res.json(await requestCode(req, req.body || {}))));
  // The middle step of sign-up and reset: is this code right? (It is spent only by the last step.)
  router.post('/api/auth/check-code', route(async (req, res) => res.json(await checkCode(req, req.body || {}))));
  router.post('/api/auth/signup', route(async (req, res) => res.json(await signUp(req, res, req.body || {}))));
  router.post('/api/auth/reset-password', route(async (req, res) => res.json(await resetPassword(req, res, req.body || {}))));
  router.get('/api/auth/password', requireAccount, route(async (req, res) => res.json(await passwordStatus(req))));
  router.post('/api/auth/change-password', requireAccount, route(async (req, res) => res.json(await changePassword(req, req.body || {}))));
  // Faculty only - see microsoft-login.js.
  router.get('/auth/microsoft', route(beginMicrosoftLogin));
  router.get('/auth/microsoft/callback', route(finishMicrosoftLogin));
  // Scoped to one test on purpose: a guest session exists only for a test whose
  // admin allowed guests, never as a general-purpose account. Each is a new
  // session, so one network may start only so many.
  const guestLimit = limitPerAddress({ windowMs: 10 * 60_000, max: 300, message: 'Too many guest sign-ins from this network.' });
  router.post('/api/auth/guest', guestLimit, route(async (req, res) => {
    const body = req.body || {};
    res.status(201).json(await (body.attendanceCode ? beginAttendanceGuest(res, body) : beginGuestSession(res, body)));
  }));
  // A guest signing out has left: their paper is submitted and their SAP ID freed.
  router.post('/api/auth/logout', route(async (req, res) => {
    if (req.portalUser) await endGuestVisit(req.portalUser.email);
    await logout(req, res);
  }));
  router.get('/api/student/profile', requireTestTaker, route(async (req, res) => res.json(await studentProfile(req))));
  router.post('/api/student/profile/sap-id', requireAccount, route(async (req, res) => res.json(await setMySapId(req, req.body || {}))));
  router.get('/api/me/results', requireAccount, route(async (req, res) => res.json(await myResults(req))));
  // Their own paper, answer by answer, to read on the page (the .xlsx below is the same, to keep).
  router.get('/api/me/results/:code/responses', requireAccount, route(async (req, res) => res.json(await myResponseView(req, req.params.code))));
  router.get('/api/me/results/:code/responses.xlsx', requireAccount, route(async (req, res) => {
    await sendResponseSheet(res, await myResponseData(req, req.params.code));
  }));

  /* ------------------------------------------------------------ user admin */
  router.get('/api/admin/users', requireUserManager, route(async (_req, res) => res.json(await listUsers())));
  router.get('/api/admin/users/:email', requireUserManager, route(async (req, res) => res.json(await userDetail(req.params.email))));
  router.post('/api/admin/users/:email/name', requireUserManager, route(async (req, res) => res.json(await setUserName(req, req.params.email, req.body || {}))));
  router.post('/api/admin/users/:email/sap-id', requireUserManager, route(async (req, res) => {
    res.json(await setUserSapId(req, req.params.email, req.body || {}));
  }));
  router.get('/api/admin/users/:email/tests/:code/responses.xlsx', requireUserManager, route(async (req, res) => {
    await sendResponseSheet(res, await userResponseData(req.params.email, req.params.code), { audit: true });
  }));
  router.get('/api/admin/users/:email/tests/:code/registrations/:registrationId/responses.xlsx', requireUserManager, route(async (req, res) => {
    await sendResponseSheet(res, await userResponseData(req.params.email, req.params.code, req.params.registrationId), { audit: true });
  }));
  router.get('/api/admin/users/:email/tests/:code/registrations/:registrationId/analysis', requireUserManager, route(async (req, res) => {
    res.json(await userTestAnalysis(req.params.email, req.params.code, req.params.registrationId));
  }));
  router.delete('/api/admin/users/:email', requireUserManager, route(async (req, res) => res.json(await deleteUser(req, req.params.email))));
  router.post('/api/admin/users/:email/block', requireUserManager, route(async (req, res) => {
    res.json(await blockUser(req, req.params.email, req.body || {}));
  }));
  router.post('/api/admin/users/:email/unblock', requireUserManager, route(async (req, res) => res.json(await unblockUser(req, req.params.email))));

  /* -------------------------------------------------- tests and joining in */
  router.post('/api/tests', requireAdmin, route(async (req, res) => {
    const created = await createTest(req, req.body || {});
    res.status(201).json({ test: created.test, joinUrl: joinUrl(req, created.test.code) });
  }));
  router.get('/api/tests/:code', route(async (req, res) => res.json(await getTest(req, req.params.code))));
  router.get('/api/tests/:code/qr.svg', route(async (req, res) => {
    // An SVG opened on its own is a page of this site: it may run nothing and load nothing.
    res.type('image/svg+xml').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .send(await testQrSvg(req.params.code, joinUrl(req, req.params.code)));
  }));
  router.post('/api/tests/:code/register', requireTestTaker, route(async (req, res) => {
    const response = await registerForTest(req, res, req.params.code, req.body || {});
    signal({ code: req.params.code, kind: 'registration_created' });
    res.status(201).json(response);
  }));

  // Phones only or laptops only: may this device sit it? Asked before sign-in
  // too, so no account is needed; once registered, the answer is kept.
  router.post('/api/tests/:code/device', route(async (req, res) => res.json(await checkTestDevice(req, req.params.code, req.body || {}))));
  // The check page: what this device is taken for, with every signal.
  router.post('/api/device-check', route(async (req, res) => res.json(checkAnyDevice(req, req.body || {}))));

  router.get('/api/tests/:code/events', requireTestTaker, route(async (req, res) => {
    const test = await requireTestForStudent(req, req.params.code);
    const registration = requireRegistration(req, test);
    // Never take an id supplied by the browser as authority: a stream may only
    // receive updates for the registration identified by its signed cookie.
    openStudentUpdates(req, res, test.code, registration.attempt?.id || null, registration.id);
  }));

  /* -------------------------------------------------------- taking the test */
  router.post('/api/tests/:code/start', requireTestTaker, route(async (req, res) => {
    const attempt = await startAttempt(req, req.params.code, req.body || {});
    // The new paper is already in this response. Only the admin dashboard
    // needs a hint, so do not wake the student into a duplicate paper fetch.
    signal({ code: req.params.code, kind: 'attempt_started' });
    res.status(201).json({ attempt });
  }));
  router.get('/api/tests/:code/attempt', requireTestTaker, route(async (req, res) => {
    const attempt = await getAttempt(req, req.params.code, typeof req.query.window === 'string' ? req.query.window : null);
    const revision = attemptRevision(attempt);
    res.set('X-Attempt-Revision', revision);
    if (typeof req.query.revision === 'string' && req.query.revision === revision) return res.status(204).end();
    return res.json({ attempt: revisionedAttempt(attempt) });
  }));
  router.post('/api/test-attempts/:attemptId/answer', requireTestTaker, route(async (req, res) => {
    const body = req.body || {};
    const attempt = await saveAnswer(req, req.params.attemptId, body);
    signal({ code: attempt.code, kind: 'answer_saved' });
    res.json(body.compact === true ? compactAnswerResponse(attempt, body.questionId) : { attempt });
  }));
  // Strict timing: close the open question and open the next.
  router.post('/api/test-attempts/:attemptId/next', requireTestTaker, route(async (req, res) => {
    const attempt = await nextQuestion(req, req.params.attemptId, req.body || {});
    signal({ code: attempt.code, kind: 'question_next' });
    res.json({ attempt });
  }));
  // The paper or the open question is on the student's screen: its clock starts.
  router.post('/api/test-attempts/:attemptId/shown', requireTestTaker, route(async (req, res) => {
    res.json({ attempt: await markShown(req, req.params.attemptId, req.body || {}) });
  }));
  router.post('/api/test-attempts/:attemptId/submit', requireTestTaker, route(async (req, res) => {
    const attempt = await submitAttemptForStudent(req, req.params.attemptId);
    signal({ code: attempt.code, kind: 'submitted' });
    res.json({ attempt });
  }));
  router.post('/api/test-attempts/:attemptId/fullscreen', requireTestTaker, route(async (req, res) => {
    const result = await recordFullscreenEvent(req, req.params.attemptId, req.body || {});
    signal({ code: result.attempt.code, kind: 'integrity' });
    res.json(result);
  }));
  router.post('/api/test-attempts/:attemptId/events', requireTestTaker, route(async (req, res) => {
    const result = await recordFullscreenEvents(req, req.params.attemptId, req.body || {});
    signal({ code: result.attempt.code, kind: 'integrity' });
    res.json(compactAttemptState(result.attempt, { processed: result.processed }));
  }));
  router.post('/api/test-attempts/:attemptId/location', requireTestTaker, route(async (req, res) => {
    const result = await recordLocationCheck(req, req.params.attemptId, req.body || {});
    signal({ code: result.code, kind: 'location' });
    res.json(result);
  }));
  router.get('/api/test-attempts/:attemptId/result', requireTestTaker, route(async (req, res) => {
    res.json({ result: await attemptResult(req, req.params.attemptId) });
  }));

  /* --------------------------------------------------------- admin: reading */
  router.get('/api/admin/tests', requireAdmin, route(async (req, res) => res.json({ tests: await adminTests(req) })));
  // A picture for a question, from the editor: its bytes as the body (already shrunk on the admin's device).
  router.post('/api/admin/question-images', requireAdmin, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES + 1024 }), route(async (req, res) => {
    res.status(201).json(await saveQuestionImage(req, req.body, req.query));
  }));
  // A question's picture. Its id cannot be guessed and its bytes never change,
  // so the browser keeps it for good - fetched once when the paper opens, it
  // is there for every later look, and for a paper carried on offline.
  router.get('/api/question-images/:id', route(async (req, res) => {
    const image = await questionImage(req.params.id);
    if (!image) { res.status(404).json({ error: 'This picture does not exist.' }); return; }
    res.set({ 'Content-Type': image.contentType, 'Content-Length': String(image.bytes), 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
    res.end(Buffer.from(image.data.buffer));
  }));
  router.get('/api/admin/home', requireAdmin, route(async (req, res) => res.json(await homeSummary(req))));
  router.get('/api/admin/performance', requireAdmin, route(async (_req, res) => res.json(performanceSnapshot({ exports: exportWorkerStats() }))));
  router.get('/api/admin/tests/:code/events', requireAdmin, route(async (req, res) => {
    const test = await requireOwnedTest(req, req.params.code, { withStudents: false });
    openAdminUpdates(req, res, test.code);
  }));
  router.get('/api/admin/tests/:code', requireAdmin, route(async (req, res) => {
    const paged = req.query.pageSize ? {
      section: req.query.section,
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      filters: req.query.filters,
      sort: req.query.sort
    } : null;
    res.json(await adminDashboard(req, req.params.code, paged));
  }));
  // The Test tab's overview: the whole class at a glance (services/overview-service.js).
  router.get('/api/admin/tests/:code/overview', requireAdmin, route(async (req, res) => res.json(await testOverview(req, req.params.code))));
  // The Analysis tab: every submitted paper against every question (overview-service matrixOf).
  router.get('/api/admin/tests/:code/matrix', requireAdmin, route(async (req, res) => res.json(await testMatrix(req, req.params.code))));
  router.get('/api/admin/tests/:code/export.csv', requireAdmin, route(async (req, res) => {
    const dashboard = await adminDashboard(req, req.params.code);
    res.type('text/csv').attachment(`${req.params.code}-registrations.csv`).send(csvForAdmin(dashboard));
  }));
  router.get('/api/admin/tests/:code/export.xlsx', requireAdmin, route(async (req, res) => {
    const dashboard = await adminExportData(req, req.params.code);
    res.type(XLSX_TYPE)
      .attachment(`${dashboard.test.code}-test-data.xlsx`)
      .send(await runExportJob('test', dashboard));
  }));

  /* ------------------------------------------------------ admin: test setup */
  router.patch('/api/admin/tests/:code/settings', requireAdmin, route(async (req, res) => {
    const response = await updateTestSettings(req, req.params.code, req.body || {});
    signalTest(req.params.code, 'test_settings_changed', { test: response.test });
    res.json(response);
  }));
  // The whole question paper, for the editor; saving it asks who it reaches once papers are out.
  router.get('/api/admin/tests/:code/paper', requireAdmin, route(async (req, res) => res.json(await testForEditing(req, req.params.code))));
  router.put('/api/admin/tests/:code/paper', requireAdmin, route(async (req, res) => res.json(await saveTestPaper(req, req.params.code, req.body || {}))));
  // Works while the test is live: this is how an admin gives time back.
  router.post('/api/admin/tests/:code/end-time', requireAdmin, route(async (req, res) => {
    const response = await setTestEndTime(req, req.params.code, req.body || {}, { compact: true });
    signalTest(req.params.code, 'time_changed', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/start', requireAdmin, route(async (req, res) => {
    const response = await startTest(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'test_started', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/close', requireAdmin, route(async (req, res) => {
    const response = await closeTest(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'test_closed', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/reopen', requireAdmin, route(async (req, res) => {
    const response = await reopenTest(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'test_reopened', { test: response.test });
    res.json(response);
  }));
  // Everyone starts again from a blank paper, now - running or finished.
  router.post('/api/admin/tests/:code/restart-quiz', requireAdmin, route(async (req, res) => {
    const response = await restartQuiz(req, req.params.code, req.body || {}, { compact: true });
    signalTest(req.params.code, 'quiz_restarted', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/reset', requireAdmin, route(async (req, res) => {
    const response = await resetTest(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'test_reset', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/results/release', requireAdmin, route(async (req, res) => {
    const response = await releaseResults(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'results_released', { test: response.test });
    res.json(response);
  }));
  // { frozen: true } makes a closed test's marks final; { frozen: false } unfreezes them.
  router.post('/api/admin/tests/:code/results/freeze', requireAdmin, route(async (req, res) => {
    const response = await setResultsFrozen(req, req.params.code, req.body || {}, { compact: true });
    // Teachers' pages only: students see nothing different.
    signalTest(req.params.code, 'results_frozen', { test: response.test });
    res.json(response);
  }));
  // { show: true } shows marks before marking is finished; { show: false } holds them for it again.
  router.post('/api/admin/tests/:code/results/unmarked', requireAdmin, route(async (req, res) => {
    const response = await setUnmarkedRelease(req, req.params.code, req.body || {}, { compact: true });
    signalTest(req.params.code, 'results_released', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/attempts/restart', requireAdmin, route(async (req, res) => {
    const response = await restartAllAttempts(req, req.params.code, { compact: true });
    signalTest(req.params.code, 'attempts_restarted', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/attempts/bulk/:action', requireAdmin, route(async (req, res) => {
    const response = await bulkAttemptAction(req, req.params.code, req.params.action, req.body || {}, { compact: true });
    signalTest(req.params.code, 'attempts_bulk_updated', { test: response.test });
    res.json(response);
  }));
  router.post('/api/admin/tests/:code/duplicate', requireAdmin, route(async (req, res) => res.status(201).json(await duplicateTest(req, req.params.code))));
  router.post('/api/admin/tests/:code/archive', requireAdmin, route(async (req, res) => res.json(await archiveTest(req, req.params.code, req.body || {}))));
  router.delete('/api/admin/tests/:code', requireAdmin, route(async (req, res) => res.json(await deleteTest(req, req.params.code))));

  /* ------------------------------------------------------------ attendance */
  // Students: opening the scanned link (no sign-in needed to see it), then marking.
  router.get('/api/attendance/:code', route(async (req, res) => {
    res.json(await attendanceForStudent(req, res, req.params.code, req.query.k));
  }));
  router.post('/api/attendance/:code/mark', requireTestTaker, route(async (req, res) => {
    res.json(await markAttendance(req, req.params.code, req.body || {}));
  }));
  // Admin
  router.get('/api/admin/attendance', requireAdmin, route(async (req, res) => res.json(await listAttendance(req))));
  // Many sessions as one register: ?codes=ATT-A,ATT-B (or none, for all of them), &min=75 (per cent).
  router.get('/api/admin/attendance-register.xlsx', requireAdmin, route(async (req, res) => {
    const data = await attendanceRegisterData(req, req.query);
    res.type(XLSX_TYPE).attachment(`attendance-register-${data.exportedAt.slice(0, 10)}.xlsx`).send(await runExportJob('attendanceRegister', data));
  }));
  router.post('/api/admin/attendance', requireAdmin, route(async (req, res) => res.status(201).json(await createAttendance(req, req.body || {}))));
  router.get('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => res.json(await attendanceForAdmin(req, req.params.code))));
  router.patch('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => {
    res.json(await attendanceSettings(req, req.params.code, req.body || {}));
  }));
  // Everyone seen in this class's other sessions: who is absent from this one.
  router.get('/api/admin/attendance/:code/roster', requireAdmin, route(async (req, res) => res.json(await attendanceRoster(req, req.params.code))));
  router.post('/api/admin/attendance/:code/close', requireAdmin, route(async (req, res) => res.json(await closeAttendance(req, req.params.code))));
  router.post('/api/admin/attendance/:code/reopen', requireAdmin, route(async (req, res) => res.json(await reopenAttendance(req, req.params.code))));
  router.get('/api/admin/attendance/:code/people', requireAdmin, route(async (req, res) => {
    res.json(await searchPeople(req, req.params.code, req.query.q));
  }));
  // One person ({ as, lookup | sapId, name }), or several ({ people: [...] }).
  router.post('/api/admin/attendance/:code/marks', requireAdmin, route(async (req, res) => {
    const body = req.body || {};
    res.status(201).json(await (Array.isArray(body.people) ? addManualMarks(req, req.params.code, body.people) : addManualMark(req, req.params.code, body)));
  }));
  // Several marks removed or put back at once: { ids: [...], action: 'reject' | 'restore' }.
  router.post('/api/admin/attendance/:code/marks/status', requireAdmin, route(async (req, res) => {
    const body = req.body || {};
    res.json(await setMarkStatuses(req, req.params.code, body.ids, body.action));
  }));
  router.post('/api/admin/attendance/:code/marks/:markId/:action', requireAdmin, route(async (req, res) => {
    res.json(await setMarkStatus(req, req.params.code, req.params.markId, req.params.action));
  }));
  // The whole session; or, posted { ids, absent, note }, just the rows on the teacher's screen.
  const sendAttendanceSheet = (pick) => route(async (req, res) => {
    const session = await attendanceExportData(req, req.params.code, pick(req));
    res.type(XLSX_TYPE).attachment(`${session.code}-attendance${session.note ? '-filtered' : ''}.xlsx`).send(await runExportJob('attendance', session));
  });
  router.get('/api/admin/attendance/:code/export.xlsx', requireAdmin, sendAttendanceSheet(() => null));
  router.post('/api/admin/attendance/:code/export.xlsx', requireAdmin, sendAttendanceSheet((req) => req.body || {}));
  router.delete('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => res.json(await deleteAttendance(req, req.params.code))));

  /* ---------------------------------------------------- admin: per student */
  const registrationPath = '/api/admin/tests/:code/registrations/:registrationId';
  router.post('/api/admin/tests/:code/registrations/bulk/:action', requireAdmin, route(async (req, res) => {
    const response = await bulkDecision(req, req.params.code, req.params.action, req.body || {}, { compact: true });
    signalTest(req.params.code, 'registrations_changed', { test: response.test });
    res.json(response);
  }));
  router.get(`${registrationPath}/manual-review`, requireAdmin, route(async (req, res) => {
    res.json(await manualReview(req, req.params.code, req.params.registrationId));
  }));
  router.get(`${registrationPath}/analysis`, requireAdmin, route(async (req, res) => {
    res.json(await registrationAnalysis(req, req.params.code, req.params.registrationId));
  }));
  // That student's full record as Excel, from the dashboard's activity log.
  router.get(`${registrationPath}/record.xlsx`, requireAdmin, route(async (req, res) => {
    await sendResponseSheet(res, await registrationRecord(req, req.params.code, req.params.registrationId), { audit: true });
  }));
  router.post(`${registrationPath}/manual-grade`, requireAdmin, route(async (req, res) => {
    const response = await gradeManualAnswer(req, req.params.code, req.params.registrationId, req.body || {});
    // That student's result page, already showing marks (released before marking was done), takes the new one at once.
    signalRegistration(req.params.code, req.params.registrationId, 'marks_updated');
    res.json(response);
  }));
  // The result review: every handed-in paper and question, and any answer's mark changed from it.
  router.get('/api/admin/tests/:code/review', requireAdmin, route(async (req, res) => res.json(await reviewData(req, req.params.code))));
  router.post(`${registrationPath}/marks`, requireAdmin, route(async (req, res) => {
    const response = await setAnswerMarks(req, req.params.code, req.params.registrationId, req.body || {});
    signalRegistration(req.params.code, req.params.registrationId, 'marks_updated');
    res.json(response);
  }));
  // The Excel export's Marks sheet, typed into and sent back as the file itself (services/marks-import.js).
  router.post('/api/admin/tests/:code/marks.xlsx', requireAdmin, express.raw({ type: () => true, limit: '10mb' }), route(async (req, res) => {
    const result = await importMarks(req, req.params.code, req.body);
    if (result.marks) signalTest(req.params.code, 'marks_updated', {});
    res.json(result);
  }));
  router.post(`${registrationPath}/sap-id`, requireAdmin, route(async (req, res) => {
    const response = await updateStudentSapId(req, req.params.code, req.params.registrationId, req.body || {}, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'registration_updated', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/location-override`, requireAdmin, route(async (req, res) => {
    const response = await setLocationOverride(req, req.params.code, req.params.registrationId, req.body || {}, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'location_override', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/device-override`, requireAdmin, route(async (req, res) => {
    const response = await setDeviceOverride(req, req.params.code, req.params.registrationId, req.body || {}, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'device_override', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/resume`, requireAdmin, route(async (req, res) => {
    const response = await resumeAttempt(req, req.params.code, req.params.registrationId, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'attempt_revived', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/restart`, requireAdmin, route(async (req, res) => {
    const response = await restartAttempt(req, req.params.code, req.params.registrationId, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'attempt_restarted', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/pause`, requireAdmin, route(async (req, res) => {
    const response = await pauseAttempt(req, req.params.code, req.params.registrationId, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'attempt_paused', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/continue`, requireAdmin, route(async (req, res) => {
    const response = await continueAttempt(req, req.params.code, req.params.registrationId, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'attempt_continued', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/submit`, requireAdmin, route(async (req, res) => {
    const response = await submitStudentPaper(req, req.params.code, req.params.registrationId, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'attempt_submitted', { registration: response.registration });
    res.json(response);
  }));
  router.post(`${registrationPath}/reopen`, requireAdmin, route(async (req, res) => {
    const response = await reopenStudentPaper(req, req.params.code, req.params.registrationId, req.body || {}, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'paper_reopened', { registration: response.registration });
    res.json(response);
  }));
  // Keep last: :action would otherwise swallow the named routes above.
  router.post(`${registrationPath}/:action`, requireAdmin, route(async (req, res) => {
    const response = await decideRegistration(req, req.params.code, req.params.registrationId, req.params.action, { compact: true });
    signalRegistration(req.params.code, req.params.registrationId, 'registration_changed', { registration: response.registration });
    res.json(response);
  }));

  return router;
}
