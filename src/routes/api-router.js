import { Router } from 'express';
import { config } from '../config.js';
import {
  authStatus, logout, requireAccount, requireAdmin, requireTestTaker, requireUserManager
} from '../auth/portal-auth.js';
import {
  changePassword, logIn, passwordStatus, requestCode, resetPassword, signUp
} from '../auth/account-login.js';
import { beginMicrosoftLogin, finishMicrosoftLogin } from '../auth/microsoft-login.js';
import { createTest, testQrSvg, updateTestSettings } from '../services/test-service.js';
import { saveTestPaper, testForEditing } from '../services/paper-service.js';
import {
  beginGuestSession, endGuestVisit, getTest, myResponseData, myResults, registerForTest, setMySapId, studentProfile
} from '../services/registration-service.js';
import {
  blockUser, deleteUser, listUsers, setUserName, setUserSapId, unblockUser, userDetail, userResponseData
} from '../services/user-service.js';
import {
  attemptResult, getAttempt, nextQuestion, recordFullscreenEvent, recordFullscreenEvents, recordLocationCheck, saveAnswer, startAttempt, submitAttemptForStudent
} from '../services/attempt-service.js';
import { attemptRevision, compactAnswerResponse, compactAttemptState, revisionedAttempt } from '../domain/attempt-sync.js';
import {
  adminDashboard, adminExportData, adminTests, archiveTest, userTestAnalysis, bulkAttemptAction, duplicateTest, bulkDecision, closeTest, csvForAdmin, decideRegistration,
  deleteTest, gradeManualAnswer, manualReview, registrationAnalysis, releaseResults, restartAllAttempts, restartQuiz,
  continueAttempt, pauseAttempt, reopenTest, restartAttempt, resetTest, resumeAttempt, submitStudentPaper, setLocationOverride, setTestEndTime, startTest, updateStudentSapId
} from '../services/admin-service.js';
import { exportWorkerStats, runExportJob } from '../export/worker-pool.js';
import { performanceSnapshot } from '../services/traffic.js';
import {
  addManualMark, attendanceExportData, attendanceForAdmin, attendanceForStudent, attendanceQrSvg, attendanceSettings, beginAttendanceGuest,
  closeAttendance, createAttendance, deleteAttendance, listAttendance, markAttendance, reopenAttendance, searchPeople, setMarkStatus
} from '../services/attendance-service.js';

/** Forwards any thrown PublicTestError to the central error handler. */
const route = (handler) => async (req, res, next) => {
  try { await handler(req, res, next); } catch (error) { next(error); }
};

const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
const joinUrl = (req, code) => `${baseUrl(req)}/?test=${encodeURIComponent(code)}`;

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendResponseSheet = async (res, data, { audit = false } = {}) => {
  // Keep numeric SAP IDs in the download name (`\w`, not the literal letter
  // "w"); this also makes one student's file easy to identify after export.
  const who = String(data.student.sapId || data.student.email.split('@')[0]).replace(/[^\w.-]/g, '');
  res.type(XLSX_TYPE).attachment(`${data.test.code}-${who}-${audit ? 'audit' : 'responses'}.xlsx`).send(await runExportJob('student', data, { audit }));
};

export function createApiRouter() {
  const router = Router();

  /* ------------------------------------------------------------------ auth */
  router.get('/api/auth/status', (req, res) => res.json(authStatus(req)));
  router.post('/api/auth/login', route(async (req, res) => res.json(await logIn(req, res, req.body || {}))));
  // Sign-up and password reset each start with a code emailed to the address.
  router.post('/api/auth/code', route(async (req, res) => res.json(await requestCode(req, req.body || {}))));
  router.post('/api/auth/signup', route(async (req, res) => res.json(await signUp(req, res, req.body || {}))));
  router.post('/api/auth/reset-password', route(async (req, res) => res.json(await resetPassword(req, res, req.body || {}))));
  router.get('/api/auth/password', requireAccount, route(async (req, res) => res.json(await passwordStatus(req))));
  router.post('/api/auth/change-password', requireAccount, route(async (req, res) => res.json(await changePassword(req, req.body || {}))));
  // Faculty only - see microsoft-login.js.
  router.get('/auth/microsoft', route(beginMicrosoftLogin));
  router.get('/auth/microsoft/callback', route(finishMicrosoftLogin));
  // Scoped to one test on purpose: a guest session exists only for a test whose
  // admin allowed guests, never as a general-purpose account.
  router.post('/api/auth/guest', route(async (req, res) => {
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
    res.type('image/svg+xml').send(await testQrSvg(req.params.code, joinUrl(req, req.params.code)));
  }));
  router.post('/api/tests/:code/register', requireTestTaker, route(async (req, res) => {
    res.status(201).json(await registerForTest(req, res, req.params.code, req.body || {}));
  }));

  /* -------------------------------------------------------- taking the test */
  router.post('/api/tests/:code/start', requireTestTaker, route(async (req, res) => {
    res.status(201).json({ attempt: await startAttempt(req, req.params.code, req.body || {}) });
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
    res.json(body.compact === true ? compactAnswerResponse(attempt, body.questionId) : { attempt });
  }));
  // Strict timing: close the open question and open the next.
  router.post('/api/test-attempts/:attemptId/next', requireTestTaker, route(async (req, res) => {
    res.json({ attempt: await nextQuestion(req, req.params.attemptId, req.body || {}) });
  }));
  router.post('/api/test-attempts/:attemptId/submit', requireTestTaker, route(async (req, res) => {
    res.json({ attempt: await submitAttemptForStudent(req, req.params.attemptId) });
  }));
  router.post('/api/test-attempts/:attemptId/fullscreen', requireTestTaker, route(async (req, res) => {
    res.json(await recordFullscreenEvent(req, req.params.attemptId, req.body || {}));
  }));
  router.post('/api/test-attempts/:attemptId/events', requireTestTaker, route(async (req, res) => {
    const result = await recordFullscreenEvents(req, req.params.attemptId, req.body || {});
    res.json(compactAttemptState(result.attempt, { processed: result.processed }));
  }));
  router.post('/api/test-attempts/:attemptId/location', requireTestTaker, route(async (req, res) => {
    res.json(await recordLocationCheck(req, req.params.attemptId, req.body || {}));
  }));
  router.get('/api/test-attempts/:attemptId/result', requireTestTaker, route(async (req, res) => {
    res.json({ result: await attemptResult(req, req.params.attemptId) });
  }));

  /* --------------------------------------------------------- admin: reading */
  router.get('/api/admin/tests', requireAdmin, route(async (req, res) => res.json({ tests: await adminTests(req) })));
  router.get('/api/admin/performance', requireAdmin, route(async (_req, res) => res.json(performanceSnapshot({ exports: exportWorkerStats() }))));
  router.get('/api/admin/tests/:code', requireAdmin, route(async (req, res) => {
    const paged = req.query.pageSize ? {
      section: req.query.section,
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      filters: req.query.filters
    } : null;
    res.json(await adminDashboard(req, req.params.code, paged));
  }));
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
    res.json(await updateTestSettings(req, req.params.code, req.body || {}));
  }));
  // The whole question paper, for the editor; saving it asks who it reaches once papers are out.
  router.get('/api/admin/tests/:code/paper', requireAdmin, route(async (req, res) => res.json(await testForEditing(req, req.params.code))));
  router.put('/api/admin/tests/:code/paper', requireAdmin, route(async (req, res) => res.json(await saveTestPaper(req, req.params.code, req.body || {}))));
  // Works while the test is live: this is how an admin gives time back.
  router.post('/api/admin/tests/:code/end-time', requireAdmin, route(async (req, res) => {
    res.json(await setTestEndTime(req, req.params.code, req.body || {}));
  }));
  router.post('/api/admin/tests/:code/start', requireAdmin, route(async (req, res) => res.json(await startTest(req, req.params.code))));
  router.post('/api/admin/tests/:code/close', requireAdmin, route(async (req, res) => res.json(await closeTest(req, req.params.code))));
  router.post('/api/admin/tests/:code/reopen', requireAdmin, route(async (req, res) => res.json(await reopenTest(req, req.params.code))));
  // Everyone starts again from a blank paper, now - running or finished.
  router.post('/api/admin/tests/:code/restart-quiz', requireAdmin, route(async (req, res) => res.json(await restartQuiz(req, req.params.code, req.body || {}))));
  router.post('/api/admin/tests/:code/reset', requireAdmin, route(async (req, res) => res.json(await resetTest(req, req.params.code))));
  router.post('/api/admin/tests/:code/results/release', requireAdmin, route(async (req, res) => res.json(await releaseResults(req, req.params.code))));
  router.post('/api/admin/tests/:code/attempts/restart', requireAdmin, route(async (req, res) => res.json(await restartAllAttempts(req, req.params.code))));
  router.post('/api/admin/tests/:code/attempts/bulk/:action', requireAdmin, route(async (req, res) => {
    res.json(await bulkAttemptAction(req, req.params.code, req.params.action, req.body || {}));
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
  router.post('/api/admin/attendance', requireAdmin, route(async (req, res) => res.status(201).json(await createAttendance(req, req.body || {}))));
  router.get('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => res.json(await attendanceForAdmin(req, req.params.code))));
  router.patch('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => {
    res.json(await attendanceSettings(req, req.params.code, req.body || {}));
  }));
  router.get('/api/admin/attendance/:code/qr.svg', requireAdmin, route(async (req, res) => {
    res.set('cache-control', 'no-store').type('image/svg+xml').send(await attendanceQrSvg(req, req.params.code, baseUrl(req)));
  }));
  router.post('/api/admin/attendance/:code/close', requireAdmin, route(async (req, res) => res.json(await closeAttendance(req, req.params.code))));
  router.post('/api/admin/attendance/:code/reopen', requireAdmin, route(async (req, res) => res.json(await reopenAttendance(req, req.params.code))));
  router.get('/api/admin/attendance/:code/people', requireAdmin, route(async (req, res) => {
    res.json(await searchPeople(req, req.params.code, req.query.q));
  }));
  router.post('/api/admin/attendance/:code/marks', requireAdmin, route(async (req, res) => {
    res.status(201).json(await addManualMark(req, req.params.code, req.body || {}));
  }));
  router.post('/api/admin/attendance/:code/marks/:markId/:action', requireAdmin, route(async (req, res) => {
    res.json(await setMarkStatus(req, req.params.code, req.params.markId, req.params.action));
  }));
  router.get('/api/admin/attendance/:code/export.xlsx', requireAdmin, route(async (req, res) => {
    const session = await attendanceExportData(req, req.params.code);
    res.type(XLSX_TYPE).attachment(`${session.code}-attendance.xlsx`).send(await runExportJob('attendance', session));
  }));
  router.delete('/api/admin/attendance/:code', requireAdmin, route(async (req, res) => res.json(await deleteAttendance(req, req.params.code))));

  /* ---------------------------------------------------- admin: per student */
  const registrationPath = '/api/admin/tests/:code/registrations/:registrationId';
  router.post('/api/admin/tests/:code/registrations/bulk/:action', requireAdmin, route(async (req, res) => {
    res.json(await bulkDecision(req, req.params.code, req.params.action, req.body || {}));
  }));
  router.get(`${registrationPath}/manual-review`, requireAdmin, route(async (req, res) => {
    res.json(await manualReview(req, req.params.code, req.params.registrationId));
  }));
  router.get(`${registrationPath}/analysis`, requireAdmin, route(async (req, res) => {
    res.json(await registrationAnalysis(req, req.params.code, req.params.registrationId));
  }));
  router.post(`${registrationPath}/manual-grade`, requireAdmin, route(async (req, res) => {
    res.json(await gradeManualAnswer(req, req.params.code, req.params.registrationId, req.body || {}));
  }));
  router.post(`${registrationPath}/sap-id`, requireAdmin, route(async (req, res) => {
    res.json(await updateStudentSapId(req, req.params.code, req.params.registrationId, req.body || {}));
  }));
  router.post(`${registrationPath}/location-override`, requireAdmin, route(async (req, res) => {
    res.json(await setLocationOverride(req, req.params.code, req.params.registrationId, req.body || {}));
  }));
  router.post(`${registrationPath}/resume`, requireAdmin, route(async (req, res) => {
    res.json(await resumeAttempt(req, req.params.code, req.params.registrationId));
  }));
  router.post(`${registrationPath}/restart`, requireAdmin, route(async (req, res) => {
    res.json(await restartAttempt(req, req.params.code, req.params.registrationId));
  }));
  router.post(`${registrationPath}/pause`, requireAdmin, route(async (req, res) => {
    res.json(await pauseAttempt(req, req.params.code, req.params.registrationId));
  }));
  router.post(`${registrationPath}/continue`, requireAdmin, route(async (req, res) => {
    res.json(await continueAttempt(req, req.params.code, req.params.registrationId));
  }));
  router.post(`${registrationPath}/submit`, requireAdmin, route(async (req, res) => {
    res.json(await submitStudentPaper(req, req.params.code, req.params.registrationId));
  }));
  // Keep last: :action would otherwise swallow the named routes above.
  router.post(`${registrationPath}/:action`, requireAdmin, route(async (req, res) => {
    res.json(await decideRegistration(req, req.params.code, req.params.registrationId, req.params.action));
  }));

  return router;
}
