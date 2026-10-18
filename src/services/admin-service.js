import { csvCell } from '../lib/csv.js';
import { registrations as registrationsCollection, studentProfiles, tests } from '../db/index.js';
import { config } from '../config.js';
import { PublicTestError } from '../lib/errors.js';
import { asInteger } from '../lib/crypto.js';
import { dateMs, iso, now } from '../lib/time.js';
import { locationTrailOf, publicTest, responseDetails, scoreSummary, studentResponseData, timeTakenSeconds } from '../domain/presenters.js';
import { imageView } from '../domain/question-image.js';
import { isGuestAccount } from '../auth/portal-auth.js';
import { questionType } from '../domain/question-bank.js';
import { automaticMarks, earnedMarks, paperMarks, paperScore, questionMarks, roundMarks } from '../domain/marks.js';
import { refuseIfFrozen } from '../domain/freeze.js';
import { END_GRACE_MS, attemptDeadlineMs, endModeOf, isPerStudent, isTimeOver, isUntimed, ownBaseDeadlineMs } from '../domain/attempt-rules.js';
import { extraTimeWrite, hasQuestionTimers, isStrict, lockedMsToGiveBack } from '../domain/strict-timing.js';
import { DEVICE_KINDS, DEVICE_NOTES, deviceFactLine, deviceFits, deviceRuleOf, kindWord } from '../domain/device.js';
import {
  MAX_EVENTS, describeEvent, integrityCells, integrityHeaders, integrityRecord, integritySummary, keptEvents, locksOnViolation, violationActionOf
} from '../domain/integrity.js';
import { endTimeMs, normalizeSapId } from '../domain/test-builder.js';
import {
  FILTER_GROUPS, RESULT_SORTS, STUDENT_SORTS, dashboardCounts, paginateDashboard, rankRegistration, resultSort, sortFor
} from '../domain/dashboard-view.js';
import {
  deleteRegistrationsOf, invalidateTestCache, publicCode, registrationsOf, requireOwnedRegistration, requireOwnedTest, serializeTestWrite,
  testDocByCode, updateAttemptWhere, updateRegistration, updateRegistrationFields, updateRegistrationsWhere, updateTest
, GUEST_SEATS, STUDENT_SEATS
} from '../data/test-repository.js';
import { buildAttempt, finalizeAttempt, venueClosed } from './attempt-service.js';
import { activityLog } from '../domain/activity.js';
import { beginTest, plannedEndsAt } from './test-lifecycle.js';
import { dashboardAnswerFilter } from './dashboard-answer-filter.js';

/* ------------------------------------------------------------------ reading */

/**
 * Whether a student went past what this test allows. Nothing is blocked by
 * it: it marks the row for the admin, who decides what it is worth.
 */
export function overLimit(test, attempt) {
  const record = attempt ? integritySummary(attempt) : null;
  // "Record only" has no limits to be over: the admin sets none.
  if (!record || violationActionOf(test) === 'record') return null;
  const exitLimit = Number(test.fullscreenExitLimit) || 0;
  const awayLimitMs = (Number(test.fullscreenAbsenceLimitSeconds) || 0) * 1000;
  const exits = exitLimit > 0 && record.leaveCount > exitLimit; // matches the lock: "3 allowed" locks on the 4th
  const away = awayLimitMs > 0 && record.awayMs > awayLimitMs; // the limit is on the total time away
  return exits || away ? { exits, away, leaveCount: record.leaveCount, exitLimit, awayMs: record.awayMs, longestAwayMs: record.longestAwayMs, awayLimitSeconds: Math.round(awayLimitMs / 1000) } : null;
}

// Registrations from before faculty could sit tests carry no account type.
const registrationAccountType = (registration) => registration.accountType
  || (isGuestAccount(registration.collegeEmail) ? 'guest' : 'student');

/** How long a paper runs, in minutes: a set duration, the window to a fixed end, or the estimate. */
function runMinutes(test) {
  if (isUntimed(test)) return null;
  if (['duration', 'each'].includes(endModeOf(test)) && test.durationMinutes) return Number(test.durationMinutes);
  if (test.windowSeconds) return Math.round(test.windowSeconds / 60);
  return test.estimatedSeconds ? Math.max(1, Math.round(test.estimatedSeconds / 60)) : null;
}

/**
 * The admin's quiz list: each quiz with what its card shows - who registered,
 * who handed in, and how the handed-in papers scored on average.
 */
export async function adminTests(req) {
  const docs = await tests().find({ ownerEmail: String(req.portalUser?.email || '').toLowerCase() }, { projection: { registrations: 0 } })
    .sort({ createdAt: -1 }).toArray();
  const students = docs.length
    ? await registrationsCollection().find(
      { testCode: { $in: docs.map((test) => test.code) } },
      { projection: { _id: 0, testCode: 1, status: 1, 'attempt.status': 1, 'attempt.isLocked': 1, 'attempt.answers.questionId': 1, 'attempt.answers.isCorrect': 1, 'attempt.answers.answeredAt': 1 } }
    ).toArray()
    : [];
  return docs.map((test) => {
    const registrations = students.filter((entry) => entry.testCode === test.code);
    const submitted = registrations.filter((entry) => entry.attempt?.status === 'submitted');
    // Each paper's marks out of its own full marks (domain/marks.js).
    const percents = submitted
      .map((entry) => scoreSummary(entry, test))
      .filter((summary) => summary.total > 0)
      .map((summary) => (summary.score / summary.total) * 100);
    return {
      ...publicTest(test),
      registrationCount: registrations.length,
      pendingCount: registrations.filter((entry) => entry.status === 'pending').length,
      startedCount: registrations.filter((entry) => entry.attempt).length,
      // Approved but never began: not started yet while it runs, missed once it has ended.
      notStartedCount: registrations.filter((entry) => entry.status === 'approved' && !entry.attempt).length,
      submittedCount: submitted.length,
      // Locked papers still being written, waiting to be revived (the home page's Live now).
      lockedCount: registrations.filter((entry) => entry.attempt?.status === 'in_progress' && entry.attempt.isLocked).length,
      // Handed in with a written answer nobody has marked yet (as on the home page).
      toMarkCount: submitted.filter((entry) => (entry.attempt.answers || []).some((answer) => answer.isCorrect === null && answer.answeredAt)).length,
      // Marks still to be given by hand count as zero until they are.
      averageScore: percents.length ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length) : null,
      runMinutes: runMinutes(test),
      createdAt: iso(test.createdAt),
      updatedAt: iso(test.updatedAt || test.createdAt),
      startedAt: iso(test.startedAt),
      closedAt: iso(test.closedAt),
      archivedAt: iso(test.archivedAt)
    };
  });
}

/**
 * A new, unstarted quiz with this one's questions and settings. Nothing about
 * who sat the original comes with it. A start or end time that belonged to
 * the original's sitting is dropped: the copy starts when the admin presses
 * Start and, if the original ended at a set time, runs for as long.
 */
export async function duplicateTest(req, code) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  let copyCode = publicCode();
  while (await testDocByCode(copyCode, { withStudents: false })) copyCode = publicCode();
  const endMode = endModeOf(test) === 'at' ? 'duration' : endModeOf(test);
  const createdAt = now();
  const doc = {
    ...Object.fromEntries(Object.entries(test).filter(([key]) => !DUPLICATE_SKIPS.has(key))),
    code: copyCode,
    title: `${test.title} (copy)`.slice(0, 120),
    startMode: 'manual',
    opensAt: null,
    endMode,
    endsAt: null,
    durationMinutes: endMode === 'duration' || endMode === 'each' ? (test.durationMinutes || runMinutes(test) || 30) : test.durationMinutes ?? null,
    // A new test follows today's rule: no going back with a timer on each question
    // (an older original may have both - test-builder.js).
    strictPrevious: test.strictPrevious === true && !hasQuestionTimers(test),
    isStarted: false, startedAt: null, isClosed: false, closedAt: null, closedAutomatically: false,
    paperSlots: 0, resultsReleasedAt: null, releaseUnmarked: false, resultsFrozenAt: null, outages: [],
    createdAt, updatedAt: createdAt, archivedAt: null
  };
  await tests().insertOne(doc);
  await invalidateTestCache(doc.code);
  return { test: publicTest(doc) };
}

// Everything that belongs to the original's sitting rather than to the quiz itself.
const DUPLICATE_SKIPS = new Set(['_id', 'registrations', 'outages']);

/** Hidden from the list (not deleted); `archived: false` brings it back. */
export async function archiveTest(req, code, raw = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const archivedAt = raw.archived === false ? null : now();
  await updateTest(test.code, { $set: { archivedAt } });
  return { code: test.code, archivedAt: iso(archivedAt) };
}

// The live table never needs prompt text, drafts, event history or answer log.
// Keeping this projection tight matters twice: a page query moves just 25-200
// compact registrations over the wire, and the count aggregations do not retain
// each paper's large fields while they work.
const DASHBOARD_REGISTRATION_PROJECTION = {
  _id: 0,
  id: 1, fullName: 1, collegeEmail: 1, sapId: 1, accountType: 1, status: 1,
  requestedAt: 1, decidedAt: 1, exitedAt: 1, deviceSwitches: 1,
  locationVerifiedAt: 1, locationDistanceMeters: 1, locationOverride: 1, locationProblem: 1,
  device: 1, deviceLog: 1, deviceOverride: 1,
  'attempt.id': 1, 'attempt.status': 1, 'attempt.windowCheck': 1, 'attempt.device': 1,
  'attempt.startedAt': 1, 'attempt.submittedAt': 1, 'attempt.submittedBy': 1,
  'attempt.answers.questionId': 1, 'attempt.answers.isCorrect': 1, 'attempt.answers.answeredAt': 1,
  'attempt.questions.questionId': 1, 'attempt.locationChecks': 1,
  'attempt.fullscreenExitCount': 1, 'attempt.fullscreenTotalAbsenceMs': 1,
  'attempt.isLocked': 1, 'attempt.lockedAt': 1, 'attempt.lockReason': 1,
  'attempt.pausedAt': 1, 'attempt.extraMs': 1, 'attempt.lastSeenAt': 1,
  'attempt.awaySince': 1, 'attempt.integrity': 1
};

// An aggregation needs `_id` only until it has applied the stable final sort.
const DASHBOARD_AGGREGATION_PROJECTION = { ...DASHBOARD_REGISTRATION_PROJECTION, _id: 1 };
const dashboardStatusRank = {
  $switch: {
    branches: [
      { case: { $eq: ['$status', 'pending'] }, then: 0 },
      { case: { $eq: ['$status', 'approved'] }, then: 1 }
    ],
    default: 2
  }
};

const dashboardManualQuestionIds = (test) => (test.questions || []).filter((question) => question.manualGrading).map((question) => question.id);

/**
 * The device a student reported last (domain/device.js), what they began on,
 * every change of device, and whether it fits the test's rule - for the
 * teacher to check by eye as well as for the rule.
 */
function dashboardDevice(test, registration) {
  const device = registration.device;
  return {
    device: device ? {
      kind: DEVICE_KINDS.includes(device.kind) ? device.kind : 'unknown',
      label: device.label || '',
      stage: device.stage || null,
      at: iso(device.at),
      facts: deviceFactLine(device.facts),
      notes: (device.notes || []).map((note) => DEVICE_NOTES[note]).filter(Boolean),
      suspicious: Boolean(device.suspicious)
    } : null,
    deviceBegan: registration.attempt?.device ? { kind: registration.attempt.device.kind, label: registration.attempt.device.label || '' } : null,
    deviceLog: (registration.deviceLog || []).map((entry) => ({ kind: entry.kind, label: entry.label || '', stage: entry.stage || null, at: iso(entry.at) })),
    deviceOverride: Boolean(registration.deviceOverride),
    deviceFits: deviceFits(deviceRuleOf(test), device?.kind ?? 'unknown')
  };
}

function dashboardRegistration(test, registration, manualQuestionIds) {
  const attempt = registration.attempt;
  const answers = attempt?.answers || [];
  const manualIds = manualQuestionIds instanceof Set ? manualQuestionIds : new Set(manualQuestionIds);
  const manualAnswers = answers.filter((answer) => manualIds.has(answer.questionId));
  return {
    id: registration.id,
    name: registration.fullName,
    email: registration.collegeEmail,
    sapId: registration.sapId,
    accountType: registrationAccountType(registration),
    status: registration.status,
    requestedAt: iso(registration.requestedAt),
    decidedAt: iso(registration.decidedAt),
    exitedAt: iso(registration.exitedAt),
    deviceSwitches: registration.deviceSwitches || 0,
    attemptId: attempt?.id || null,
    attemptStatus: attempt?.status || null,
    windowCheck: attempt?.windowCheck || null,
    ...dashboardDevice(test, registration),
    startedAt: iso(attempt?.startedAt),
    submittedAt: iso(attempt?.submittedAt),
    // 'student', 'time' or 'admin': how the paper was handed in.
    submittedBy: attempt?.submittedBy || null,
    timeTakenSeconds: timeTakenSeconds(attempt),
    deadlineAt: attempt ? iso(test.endsAt ?? test.closesAt) : null,
    answeredCount: answers.filter((answer) => answer.answeredAt).length,
    totalQuestions: attempt?.questions?.length || 0,
    // Marks earned, out of the paper's full marks (domain/marks.js).
    score: attempt?.status === 'submitted' ? paperScore(attempt) : null,
    totalMarks: attempt ? paperMarks(test, attempt) : null,
    manualTotal: manualAnswers.length,
    manualGraded: manualAnswers.filter((answer) => answer.isCorrect !== null).length,
    locationVerifiedAt: iso(registration.locationVerifiedAt),
    locationDistanceMeters: registration.locationDistanceMeters,
    locationOverride: Boolean(registration.locationOverride),
    // Why their page could not share a location at Begin, if it could not (attempt-service verifyStartLocation).
    locationProblem: registration.locationProblem
      ? { reason: registration.locationProblem.reason, asked: registration.locationProblem.asked ?? null, at: iso(registration.locationProblem.at), accuracyMeters: registration.locationProblem.accuracyMeters ?? null }
      : null,
    locationChecks: attempt?.locationChecks || { inRange: 0, outOfRange: 0, inconclusive: 0, last: null },
    venueClosed: attempt?.status === 'in_progress' ? venueClosed(test, registration, attempt) : null,
    fullscreenExitCount: attempt?.fullscreenExitCount || 0,
    fullscreenTotalAbsenceMs: attempt?.fullscreenTotalAbsenceMs || 0,
    isLocked: Boolean(attempt?.isLocked),
    lockedAt: iso(attempt?.lockedAt),
    isPaused: Boolean(attempt?.pausedAt),
    pausedAt: iso(attempt?.pausedAt),
    // Time given back for pauses, and this student's own end because of it.
    extraMs: Number(attempt?.extraMs) || 0,
    ownDeadlineAt: attempt && !isUntimed(test) && Number.isFinite(attemptDeadlineMs(test, attempt)) ? new Date(attemptDeadlineMs(test, attempt)).toISOString() : null,
    lockReason: attempt?.lockReason || null,
    // Every departure over the whole attempt, reviving and restarting
    // included - what the student actually did, not what the limits allowed.
    integrity: attempt ? integritySummary(attempt) : null,
    overLimit: overLimit(test, attempt)
  };
}

function dashboardTest(test) {
  return {
    ...publicTest(test),
    locationLatitude: test.locationLatitude ?? null,
    locationLongitude: test.locationLongitude ?? null,
    // Whether going past the limits locks an attempt: this test's choice and the server's LOCK_ON_EXIT.
    locksOnExit: locksOnViolation(test, config.lockOnExit),
    // The server's own switch, so the dashboard can say why a lock-mode test does not lock.
    serverLocks: config.lockOnExit
  };
}

function dashboardShell(test, registrations, manualQuestionIds) {
  return {
    // The dashboard's countdowns run on the server's clock.
    serverTime: new Date().toISOString(),
    test: dashboardTest(test),
    registrations: registrations.map((registration) => dashboardRegistration(test, registration, manualQuestionIds))
  };
}

// Browser mutations do not need a freshly rebuilt table of thousands of
// students.  The next lightweight page query reconciles counts and any rows
// outside the current page.  Direct service callers (exports, audits and the
// existing regression suite) retain the complete dashboard response.
const compactAction = (test, extra = {}) => ({
  ok: true,
  code: test.code,
  serverTime: new Date().toISOString(),
  test: dashboardTest(test),
  ...extra
});

async function actionResult(req, code, test, compact, extra = {}) {
  if (compact) return compactAction(test, extra);
  return { ...(await adminDashboard(req, code)), ...extra };
}

async function registrationActionResult(req, code, test, registrationId, compact, extra = {}) {
  if (!compact) return actionResult(req, code, test, false, extra);
  const [registration] = await registrationsOf(test.code, { id: String(registrationId) });
  return compactAction(test, {
    ...extra,
    registration: registration
      ? dashboardRegistration(test, registration, dashboardManualQuestionIds(test))
      : { id: String(registrationId) }
  });
}

export async function adminDashboard(req, code, pageOptions = null) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const manualQuestionIds = dashboardManualQuestionIds(test);

  // Exports and a few offline reports intentionally request the whole class.
  // Keep that established behaviour, but make normal browser table reads use
  // `skip`/`limit` in MongoDB instead of fetching every registration first.
  if (pageOptions?.pageSize || pageOptions?.af !== undefined) return pagedAdminDashboard(test, pageOptions, manualQuestionIds);

  const registrations = await registrationsCollection().find(
    { testCode: test.code }, { projection: DASHBOARD_REGISTRATION_PROJECTION }
  ).toArray();
  registrations.sort((a, b) => rankRegistration(a.status) - rankRegistration(b.status) || dateMs(a.requestedAt) - dateMs(b.requestedAt));
  return dashboardShell(test, registrations, manualQuestionIds);
}

const answeredExpression = {
  $size: { $filter: { input: { $ifNull: ['$attempt.answers', []] }, as: 'answer', cond: { $ne: [{ $ifNull: ['$$answer.answeredAt', null] }, null] } } }
};
const scoreExpression = {
  $reduce: {
    input: { $ifNull: ['$attempt.answers', []] },
    initialValue: 0,
    in: { $add: ['$$value', { $convert: { input: '$$this.isCorrect', to: 'double', onError: 0, onNull: 0 } }] }
  }
};
/*
 * Either way round is the exact reverse of the other - ties included. A tie
 * that kept one order both ways made the switch look broken: with nothing
 * marked yet every score is 0, and "Lowest first" showed the very list
 * "Highest first" did. Ties on a count go to whoever was first (to hand in,
 * to register) in the field's own first direction, and mirror with it.
 */
function dashboardSortStages(page) {
  const [field, way] = page.sort.split('-');
  const direction = way === 'desc' ? -1 : 1;
  if (field === 'sap') return [{ $set: { __sap: { $ifNull: ['$sapId', ''] } } }, { $sort: { __sap: direction, _id: direction } }];
  if (field === 'answered') return [{ $set: { __answered: answeredExpression } }, { $sort: { __answered: direction, requestedAt: -direction, _id: -direction } }];
  if (field === 'submitted') return [{ $sort: { 'attempt.submittedAt': direction, _id: direction } }];
  if (field === 'name') return [{ $set: { __name: { $toLower: { $ifNull: ['$fullName', ''] } } } }, { $sort: { __name: direction, _id: direction } }];
  // Equal scores: highest first puts whoever handed in first ahead; lowest first is its mirror.
  if (field === 'score') return [{ $set: { __score: scoreExpression } }, { $sort: { __score: direction, 'attempt.submittedAt': -direction, _id: -direction } }];
  return [{ $sort: { __dashboardStatusRank: 1, requestedAt: direction, _id: direction } }];
}

const registrationFilterIds = Object.keys(FILTER_GROUPS).filter((id) => !id.startsWith('marking:') && !id.startsWith('finish:'));
const responseFilterIds = Object.keys(FILTER_GROUPS).filter((id) => id.startsWith('marking:') || id.startsWith('finish:'));

function dashboardPageOptions(raw = {}) {
  const section = raw.section === 'responses' ? 'responses' : raw.section === 'students' ? 'students' : 'test';
  const pageSize = Math.min(200, Math.max(25, Number(raw.pageSize) || 100));
  const requestedPage = Math.max(1, Number(raw.page) || 1);
  const search = String(raw.search || '').trim().toLowerCase().slice(0, 120);
  const selected = [...new Set(Array.isArray(raw.filters) ? raw.filters : String(raw.filters || '').split(',').filter(Boolean))]
    .filter((id) => FILTER_GROUPS[id]);
  const groups = Object.values(selected.reduce((result, id) => {
    (result[FILTER_GROUPS[id]] ||= []).push(id);
    return result;
  }, {}));
  const sort = sortFor(section, raw.sort);
  return {
    section, pageSize, requestedPage, search, selected, groups, sort,
    relevantIds: section === 'responses' ? responseFilterIds : section === 'students' ? registrationFilterIds : []
  };
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const joinMongoAnd = (parts) => {
  const defined = parts.filter((part) => part && Object.keys(part).length);
  return defined.length === 0 ? {} : defined.length === 1 ? defined[0] : { $and: defined };
};
const joinExpressionAnd = (parts) => parts.length === 0 ? true : parts.length === 1 ? parts[0] : { $and: parts };
const joinExpressionOr = (parts) => parts.length === 0 ? false : parts.length === 1 ? parts[0] : { $or: parts };

function dashboardBaseMatch(code, page) {
  const match = { testCode: code };
  if (page.section === 'responses') match['attempt.status'] = 'submitted';
  if (!page.search) return match;
  // What was typed, escaped and matched as plain text, ignoring case.
  const query = { $regex: escapeRegex(page.search), $options: 'i' };
  return joinMongoAnd([match, { $or: [{ fullName: query }, { sapId: query }, { collegeEmail: query }] }]);
}

function manualAnswerExpressions(manualQuestionIds) {
  if (!manualQuestionIds.length) return { total: { $literal: 0 }, graded: { $literal: 0 } };
  const manualAnswers = {
    $filter: {
      input: { $ifNull: ['$attempt.answers', []] },
      as: 'answer',
      cond: { $in: ['$$answer.questionId', manualQuestionIds] }
    }
  };
  return {
    total: { $size: manualAnswers },
    // The original row presenter considers an old/missing isCorrect value
    // graded (only an explicit null means waiting), so this does the same.
    graded: {
      $size: {
        $filter: { input: manualAnswers, as: 'answer', cond: { $ne: ['$$answer.isCorrect', null] } }
      }
    }
  };
}

function dashboardMongoFilter(id, manualQuestionIds) {
  const noAttempt = { $or: [{ 'attempt.status': null }, { 'attempt.status': '' }] };
  const notPaused = { 'attempt.pausedAt': null };
  const notOverride = { locationOverride: { $ne: true } };
  const guest = { $or: [{ accountType: 'guest' }, { collegeEmail: /@guest\.test$/i }] };
  if (['pending', 'approved', 'rejected'].includes(id)) return { status: id };
  if (id === 'paper:not_started') return noAttempt;
  if (id === 'paper:submitted') return { 'attempt.status': 'submitted' };
  if (id === 'paper:paused') return joinMongoAnd([{ 'attempt.status': 'in_progress' }, { 'attempt.pausedAt': { $exists: true, $ne: null } }]);
  if (id === 'paper:locked') return joinMongoAnd([{ 'attempt.status': 'in_progress' }, notPaused, { 'attempt.isLocked': true }]);
  if (id === 'paper:in_progress') return joinMongoAnd([{ 'attempt.status': 'in_progress' }, notPaused, { 'attempt.isLocked': { $ne: true } }]);
  if (id === 'guest') return guest;
  if (id === 'verified') return { $nor: [{ accountType: 'guest' }, { collegeEmail: /@guest\.test$/i }] };
  if (id === 'venue:exception') return { locationOverride: true };
  if (id === 'venue:in_range') return joinMongoAnd([notOverride, { locationVerifiedAt: { $exists: true, $ne: null } }]);
  if (id === 'venue:out_of_range') return joinMongoAnd([notOverride, { locationVerifiedAt: null }, { locationDistanceMeters: { $exists: true, $ne: null } }]);
  if (id === 'venue:not_checked') return joinMongoAnd([notOverride, { locationVerifiedAt: null }, { locationDistanceMeters: null }]);
  if (id === 'device:unknown') return { 'device.kind': { $nin: DEVICE_KINDS } };
  if (id.startsWith('device:')) return { 'device.kind': id.slice(7) };
  // One per student: a device exception first, then signals that disagree.
  if (id === 'devicecheck:exception') return { deviceOverride: true };
  if (id === 'devicecheck:disagree') return joinMongoAnd([{ deviceOverride: { $ne: true } }, { 'device.suspicious': true }]);
  if (id === 'devicecheck:ok') return joinMongoAnd([{ deviceOverride: { $ne: true } }, { 'device.suspicious': { $ne: true } }]);
  if (id === 'marking:awaiting' || id === 'marking:done') {
    const manual = manualAnswerExpressions(manualQuestionIds);
    return { $expr: id === 'marking:awaiting' ? { $gt: [manual.total, manual.graded] } : { $lte: [manual.total, manual.graded] } };
  }
  if (id.startsWith('finish:')) {
    const value = id.slice(7);
    return value === 'unknown'
      ? { 'attempt.submittedBy': { $nin: ['student', 'time', 'admin', 'teacher'] } }
      : { 'attempt.submittedBy': value };
  }
  return {};
}

function dashboardSelectedMongoMatch(page, manualQuestionIds) {
  return joinMongoAnd(page.groups.map((ids) => ({ $or: ids.map((id) => dashboardMongoFilter(id, manualQuestionIds)) })));
}

const field = (path) => `$${path}`;
const isPresent = (path) => ({ $ne: [{ $ifNull: [field(path), null] }, null] });
const isMissing = (path) => ({ $eq: [{ $ifNull: [field(path), null] }, null] });
const isTrue = (path) => ({ $eq: [{ $ifNull: [field(path), false] }, true] });
const isNotTrue = (path) => ({ $not: [{ $ifNull: [field(path), false] }] });
const equals = (path, value) => ({ $eq: [field(path), value] });

function dashboardFilterExpression(id) {
  const guest = joinExpressionOr([
    equals('accountType', 'guest'),
    { $regexMatch: { input: { $ifNull: [field('collegeEmail'), ''] }, regex: '@guest\\.test$', options: 'i' } }
  ]);
  if (['pending', 'approved', 'rejected'].includes(id)) return equals('status', id);
  if (id === 'paper:not_started') return joinExpressionOr([isMissing('attempt.status'), equals('attempt.status', '')]);
  if (id === 'paper:submitted') return equals('attempt.status', 'submitted');
  if (id === 'paper:paused') return joinExpressionAnd([equals('attempt.status', 'in_progress'), isPresent('attempt.pausedAt')]);
  if (id === 'paper:locked') return joinExpressionAnd([equals('attempt.status', 'in_progress'), isNotTrue('attempt.pausedAt'), isTrue('attempt.isLocked')]);
  if (id === 'paper:in_progress') return joinExpressionAnd([equals('attempt.status', 'in_progress'), isNotTrue('attempt.pausedAt'), isNotTrue('attempt.isLocked')]);
  if (id === 'guest') return guest;
  if (id === 'verified') return { $not: [guest] };
  if (id === 'venue:exception') return isTrue('locationOverride');
  if (id === 'venue:in_range') return joinExpressionAnd([isNotTrue('locationOverride'), isPresent('locationVerifiedAt')]);
  if (id === 'venue:out_of_range') return joinExpressionAnd([isNotTrue('locationOverride'), isMissing('locationVerifiedAt'), isPresent('locationDistanceMeters')]);
  if (id === 'venue:not_checked') return joinExpressionAnd([isNotTrue('locationOverride'), isMissing('locationVerifiedAt'), isMissing('locationDistanceMeters')]);
  if (id === 'device:unknown') return { $not: [{ $in: [{ $ifNull: [field('device.kind'), ''] }, DEVICE_KINDS] }] };
  if (id.startsWith('device:')) return equals('device.kind', id.slice(7));
  if (id === 'devicecheck:exception') return isTrue('deviceOverride');
  if (id === 'devicecheck:disagree') return joinExpressionAnd([isNotTrue('deviceOverride'), isTrue('device.suspicious')]);
  if (id === 'devicecheck:ok') return joinExpressionAnd([isNotTrue('deviceOverride'), isNotTrue('device.suspicious')]);
  if (id === 'marking:awaiting') return { $gt: [field('__manualTotal'), field('__manualGraded')] };
  if (id === 'marking:done') return { $lte: [field('__manualTotal'), field('__manualGraded')] };
  if (id.startsWith('finish:')) {
    const value = id.slice(7);
    return value === 'unknown'
      ? { $not: [{ $in: [field('attempt.submittedBy'), ['student', 'time', 'admin', 'teacher']] }] }
      : equals('attempt.submittedBy', value);
  }
  return true;
}

function dashboardSelectedExpression(page) {
  return joinExpressionAnd(page.groups.map((ids) => joinExpressionOr(ids.map(dashboardFilterExpression))));
}

function withManualMetrics(pipeline, manualQuestionIds) {
  const manual = manualAnswerExpressions(manualQuestionIds);
  pipeline.push({ $set: { __manualTotal: manual.total, __manualGraded: manual.graded } });
  return pipeline;
}

function countGroup(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, condition]) => [key, { $sum: { $cond: [condition, 1, 0] } }]));
}

function dashboardClassCountPipeline(code, manualQuestionIds, cohortMatch = null) {
  const awaiting = joinExpressionAnd([equals('attempt.status', 'submitted'), dashboardFilterExpression('marking:awaiting')]);
  return withManualMetrics([
    { $match: joinMongoAnd([{ testCode: code }, cohortMatch]) },
    { $project: DASHBOARD_AGGREGATION_PROJECTION }
  ], manualQuestionIds).concat([{
    $group: {
      _id: null,
      total: { $sum: 1 },
      ...countGroup({
        pending: equals('status', 'pending'),
        started: isPresent('attempt.status'),
        submitted: equals('attempt.status', 'submitted'),
        awaitingMarking: awaiting,
        owedTime: joinExpressionAnd([
          equals('attempt.status', 'in_progress'),
          joinExpressionOr([isPresent('attempt.pausedAt'), { $gt: [{ $ifNull: [field('attempt.extraMs'), 0] }, 0] }])
        ]),
        handedInByClose: joinExpressionAnd([equals('attempt.status', 'submitted'), equals('attempt.submittedBy', 'admin')]),
        writing: equals('attempt.status', 'in_progress')
      }),
      // Each student's own time: the latest Begin (with time given back) among
      // papers still being written - the last of them ends a duration later.
      lastOwnBase: { $max: { $cond: [equals('attempt.status', 'in_progress'), { $add: ['$attempt.startedAt', { $ifNull: ['$attempt.extraMs', 0] }] }, null] } }
    }
  }]);
}

function dashboardPageCountPipeline(baseMatch, page, manualQuestionIds) {
  const needsManualMetrics = page.relevantIds.some((id) => id.startsWith('marking:')) || page.selected.some((id) => id.startsWith('marking:'));
  const pipeline = [{ $match: baseMatch }, { $project: DASHBOARD_AGGREGATION_PROJECTION }];
  if (needsManualMetrics) withManualMetrics(pipeline, manualQuestionIds);
  const selected = dashboardSelectedExpression(page);
  const filterCounts = Object.fromEntries(page.relevantIds.map((id, index) => [
    `filter${index}`, { $sum: { $cond: [dashboardFilterExpression(id), 1, 0] } }
  ]));
  pipeline.push({
    $group: {
      _id: null,
      total: { $sum: { $cond: [selected, 1, 0] } },
      unfilteredTotal: { $sum: 1 },
      ...filterCounts
    }
  });
  return pipeline;
}

function dashboardPagePipeline(baseMatch, selectedMatch, page) {
  return [
    { $match: joinMongoAnd([baseMatch, selectedMatch]) },
    { $project: DASHBOARD_AGGREGATION_PROJECTION },
    { $set: { __dashboardStatusRank: dashboardStatusRank } },
    ...dashboardSortStages(page),
    { $skip: (page.requestedPage - 1) * page.pageSize },
    { $limit: page.pageSize },
    { $project: DASHBOARD_REGISTRATION_PROJECTION }
  ];
}

function asDashboardCounts(result = {}, test = null) {
  const lastOwnBase = result.lastOwnBase ? dateMs(result.lastOwnBase) : NaN;
  return {
    writing: Number(result.writing) || 0,
    // When the last paper still being written runs out of its own time (each student's own time only).
    lastOwnEndAt: test && isPerStudent(test) && Number.isFinite(lastOwnBase) ? iso(lastOwnBase + Number(test.durationMinutes) * 60_000) : null,
    total: Number(result.total) || 0,
    pending: Number(result.pending) || 0,
    started: Number(result.started) || 0,
    submitted: Number(result.submitted) || 0,
    awaitingMarking: Number(result.awaitingMarking) || 0,
    owedTime: Number(result.owedTime) || 0,
    handedInByClose: Number(result.handedInByClose) || 0
  };
}

// Kept importable from here as before: the tests and the regression check read them from this module.
export { RESULT_SORTS, STUDENT_SORTS, dashboardCounts, paginateDashboard, resultSort };

async function pagedAdminDashboard(test, rawPage, manualQuestionIds) {
  const page = dashboardPageOptions(rawPage);
  const emptyPage = page.section === 'test';
  const collection = registrationsCollection();
  // Resolve every submitted paper first, not just the first returned page.
  // Search, the usual filters, totals and sorting all see the same cohort.
  const answerFilter = await dashboardAnswerFilter(collection, test, rawPage.af);
  const baseMatch = joinMongoAnd([dashboardBaseMatch(test.code, page), answerFilter?.match]);
  const selectedMatch = dashboardSelectedMongoMatch(page, manualQuestionIds);

  const [pageCounts, wholeCounts, initialRows, classCounts] = await Promise.all([
    emptyPage ? Promise.resolve([]) : collection.aggregate(dashboardPageCountPipeline(baseMatch, page, manualQuestionIds)).toArray(),
    collection.aggregate(dashboardClassCountPipeline(test.code, manualQuestionIds, answerFilter?.match)).toArray(),
    emptyPage ? Promise.resolve([]) : collection.aggregate(dashboardPagePipeline(baseMatch, selectedMatch, page)).toArray(),
    answerFilter ? collection.aggregate(dashboardClassCountPipeline(test.code, manualQuestionIds)).toArray() : Promise.resolve(null)
  ]);

  const pageCount = pageCounts[0] || {};
  const total = Number(pageCount.total) || 0;
  const unfilteredTotal = Number(pageCount.unfilteredTotal) || 0;
  const pages = Math.max(1, Math.ceil(total / page.pageSize));
  const resolvedPage = Math.min(pages, page.requestedPage);
  // Normal requests run the count and page query together. Only an out-of-date
  // deep link needs this second, bounded query to honour the old "last page"
  // behaviour without keeping every row in memory just to clamp it.
  const registrations = resolvedPage === page.requestedPage || emptyPage
    ? initialRows
    : await collection.aggregate(dashboardPagePipeline(baseMatch, selectedMatch, { ...page, requestedPage: resolvedPage })).toArray();
  const filterCounts = Object.fromEntries(page.relevantIds.map((id, index) => [id, Number(pageCount[`filter${index}`]) || 0]));
  const dashboard = dashboardShell(test, registrations, manualQuestionIds);
  return {
    ...dashboard,
    counts: asDashboardCounts(wholeCounts[0], test),
    ...(answerFilter ? { answerFilter: answerFilter.metadata, classCounts: asDashboardCounts(classCounts?.[0], test) } : {}),
    filterCounts,
    pagination: { page: resolvedPage, pageSize: page.pageSize, total, unfilteredTotal, pages, section: page.section }
  };
}

export async function adminExportData(req, code) {
  const test = await requireOwnedTest(req, code);
  const dashboard = await adminDashboard(req, code);
  const responses = (test.registrations || []).flatMap((registration) => responseDetails(test, registration).map((answer) => ({
    studentName: registration.fullName,
    email: registration.collegeEmail,
    sapId: registration.sapId,
    registrationId: registration.id,
    attemptStatus: registration.attempt?.status || '',
    startedAt: iso(registration.attempt?.startedAt),
    submittedAt: iso(registration.attempt?.submittedAt),
    ...answer
  })));
  // The whole bank in its authored order, so the export can lay every
  // student's answers out side by side even though each drew a different set.
  const questionBank = (test.questions || []).map((question, index) => ({
    id: question.id,
    number: index + 1,
    type: questionType(question),
    prompt: question.prompt,
    options: question.options || [],
    manualGrading: Boolean(question.manualGrading),
    // What it is worth: the Marks sheet's "out of" row.
    maxMarks: questionMarks(test, question),
    // An older version kept for the papers that were given it.
    retired: Boolean(question.retired),
    correctAnswer: question.manualGrading
      ? ''
      : (question.correctOptions || []).map((id) => question.options?.[Number(id)]).filter((text) => text !== undefined).join(' • ')
  }));
  const integrityLog = (test.registrations || []).flatMap((registration) => keptEvents(registration.attempt?.events).map((event) => ({
    studentName: registration.fullName,
    email: registration.collegeEmail,
    sapId: registration.sapId,
    ...describeEvent(event),
    createdAt: iso(event.createdAt)
  })));
  // Every student's whole test, one row per event, student by student.
  const activity = (test.registrations || [])
    .slice()
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)))
    .flatMap((registration) => activityLog(test, registration).map((entry) => ({
      studentName: registration.fullName, email: registration.collegeEmail, sapId: registration.sapId, ...entry
    })));
  return { ...dashboard, responses, integrityLog, activity, questionBank };
}

export function csvForAdmin(dashboard) {
  // Formula-looking text stays text in Excel (lib/csv.js).
  const quote = csvCell;
  const rows = [[
    'Name', 'College email', 'SAP ID', 'Registration status', 'Requested at', 'Attempt status',
    'Started at', 'Submitted at', 'Time taken (seconds)', 'Account type', 'Left at (guests)', 'Answered', 'Score', 'Fullscreen exits',
    'Time outside fullscreen (seconds)', 'Over the allowance', 'Venue check', 'Distance from venue (m)',
    'Location checks in range', 'Location checks out of range', 'Location checks inconclusive',
    'Times left the venue', 'Time outside the venue (seconds)', 'Location when submitted', 'Attempt locked', 'Lock reason',
    'Device', 'Began on', 'Device signals', 'Device notes', 'Device exception', 'Devices seen',
    ...integrityHeaders
  ]];
  dashboard.registrations.forEach((entry) => rows.push([
    entry.name, entry.email, entry.sapId, entry.status, entry.requestedAt, entry.attemptStatus || '',
    entry.startedAt || '', entry.submittedAt || '', entry.timeTakenSeconds ?? '', entry.accountType, entry.exitedAt || '', entry.answeredCount, entry.score ?? '',
    entry.fullscreenExitCount, Math.round(entry.fullscreenTotalAbsenceMs / 1000),
    entry.overLimit ? [entry.overLimit.exits ? `${entry.overLimit.leaveCount} of ${entry.overLimit.exitLimit} switches` : '',
      entry.overLimit.away ? `${Math.round(entry.overLimit.awayMs / 1000)}s away in total (limit ${entry.overLimit.awayLimitSeconds}s)` : ''].filter(Boolean).join('; ') : '',
    entry.locationOverride ? 'Exception granted' : entry.locationVerifiedAt ? 'In range' : entry.locationDistanceMeters === null || entry.locationDistanceMeters === undefined ? 'Not checked' : 'Out of range',
    entry.locationDistanceMeters === null || entry.locationDistanceMeters === undefined ? '' : Math.round(entry.locationDistanceMeters),
    entry.locationChecks?.inRange || 0, entry.locationChecks?.outOfRange || 0, entry.locationChecks?.inconclusive || 0,
    entry.locationChecks?.outsideCount || 0,
    Math.round((entry.locationChecks?.outsideMs || 0) / 1000),
    entry.locationChecks?.submit
      ? `${entry.locationChecks.submit.status === 'inRange' ? 'At the venue' : entry.locationChecks.submit.status === 'outOfRange' ? 'Away from the venue' : 'Could not tell'}${entry.locationChecks.submit.distanceMeters === null || entry.locationChecks.submit.distanceMeters === undefined ? '' : ` (${Math.round(entry.locationChecks.submit.distanceMeters)} m)`}`
      : '',
    entry.isLocked ? 'yes' : 'no', entry.lockReason || '',
    entry.device ? `${kindWord(entry.device.kind)} (${entry.device.label})` : '',
    entry.deviceBegan ? `${kindWord(entry.deviceBegan.kind)} (${entry.deviceBegan.label})` : '',
    entry.device?.facts || '', (entry.device?.notes || []).join(' '), entry.deviceOverride ? 'yes' : 'no',
    (entry.deviceLog || []).map((seen) => `${kindWord(seen.kind)} (${seen.label})`).join(' → '),
    ...integrityCells(entry.integrity)
  ]));
  return rows.map((row) => row.map(quote).join(',')).join('\r\n');
}

/**
 * One student's whole record on your test, for the Excel download beside
 * their activity log: answers, activity, integrity, venue and device - the
 * same file the Users page gives, from the test's own dashboard.
 */
export async function registrationRecord(req, code, registrationId) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  return studentResponseData(test, registration);
}

export async function registrationAnalysis(req, code, registrationId) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  return analysisOf(test, registration);
}

/**
 * The same analysis for the Users page, which may open anyone's test: only
 * this person's own registration on it, and only to a user manager (the route).
 */
export async function userTestAnalysis(rawEmail, code, registrationId) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const test = await testDocByCode(code, { withStudents: false });
  const [registration] = test ? await registrationsOf(test.code, { id: String(registrationId ?? ''), collegeEmail: email }) : [];
  if (!registration) throw new PublicTestError(404, 'This person has no registration on that test.');
  test.registrations = [registration];
  return analysisOf(test, registration);
}

function analysisOf(test, registration) {
  const attempt = registration.attempt;
  return {
    test: { code: test.code, title: test.title },
    registration: {
      id: registration.id, name: registration.fullName, email: registration.collegeEmail,
      sapId: registration.sapId, status: registration.status
    },
    attempt: attempt
      ? {
        id: attempt.id, status: attempt.status, startedAt: iso(attempt.startedAt), submittedAt: iso(attempt.submittedAt),
        timeTakenSeconds: timeTakenSeconds(attempt), ...scoreSummary(registration, test)
      }
      : null,
    integrity: attempt
      ? {
        ...integritySummary(attempt),
        isLocked: Boolean(attempt.isLocked),
        lockReason: attempt.lockReason || null,
        limits: { exits: test.fullscreenExitLimit || 0, awaySeconds: test.fullscreenAbsenceLimitSeconds || 0 },
        timeline: keptEvents(attempt.events).map((event) => ({ ...describeEvent(event), createdAt: iso(event.createdAt) })),
        activity: activityLog(test, registration)
      }
      : null,
    location: attempt?.locationChecks || null,
    locationTrail: locationTrailOf(attempt),
    answers: responseDetails(test, registration)
  };
}

/* ------------------------------------------------------- registration review */

export async function decideRegistration(req, code, registrationId, decision, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  if (!['approve', 'reject'].includes(decision)) throw new PublicTestError(400, 'Invalid registration action.');
  const decidedAt = now();
  await updateRegistrationFields(test.code, registrationId, {
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt
  });
  if (options.compact) {
    return compactAction(test, {
      registration: dashboardRegistration(test, {
        ...registration,
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedAt
      }, dashboardManualQuestionIds(test))
    });
  }
  return adminDashboard(req, code);
}

/**
 * Approves or rejects many registrations at once. With `registrationIds` - the
 * students the dashboard's filter shows - it acts on exactly those (skipping
 * any already decided that way); without, on everyone still pending.
 */
export async function bulkDecision(req, code, decision, raw = {}, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  if (!['approve', 'reject'].includes(decision)) throw new PublicTestError(400, 'Invalid registration action.');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const chosen = Array.isArray(raw.registrationIds) ? new Set(raw.registrationIds.map(String)) : null;
  const filter = chosen
    ? { id: { $in: [...chosen] }, status: { $ne: status } }
    : { status: 'pending' };
  const changed = await updateRegistrationsWhere(test.code, filter, { $set: { status, decidedAt: now() } });
  return actionResult(req, code, test, options.compact, { affectedCount: changed.modifiedCount });
}

export async function updateStudentSapId(req, code, registrationId, raw, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  const accountType = registrationAccountType(registration);
  if (accountType === 'faculty') throw new PublicTestError(409, 'Faculty accounts do not have a SAP ID.');
  const sapId = normalizeSapId(raw?.sapId);
  // The check and the change run together in this test's queue, where new
  // seats are also taken, so nobody can register with the ID in between.
  await serializeTestWrite(test.code, async () => {
    // Compared only with the same kind of seat: a guest's with guests', a student's with students'.
    const [alreadyUsed] = await registrationsOf(test.code, {
      id: { $ne: registration.id }, sapId, exitedAt: null, ...(accountType === 'guest' ? GUEST_SEATS : STUDENT_SEATS)
    });
    if (alreadyUsed) throw new PublicTestError(409, `Another ${accountType === 'guest' ? 'guest' : 'student'} in this test already uses that SAP ID.`);
    // A guest's SAP ID belongs to this seat only; it is never saved to a profile.
    if (accountType !== 'guest') {
      try {
        await studentProfiles().updateOne(
          { email: registration.collegeEmail },
          { $set: { sapId, displayName: registration.fullName, updatedAt: now() }, $setOnInsert: { createdAt: now() } },
          { upsert: true }
        );
      } catch (error) {
        if (error?.code === 11000) throw new PublicTestError(409, 'This SAP ID is already linked to another student account.');
        throw error;
      }
    }
    await updateRegistrationFields(test.code, registration.id, { sapId });
  });
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

/**
 * Lets one student sit a phones-only or laptops-only test on the device they
 * have (or takes that back): for a device the check gets wrong, or a student
 * whose own device has failed. Given before or during the test.
 */
export async function setDeviceOverride(req, code, registrationId, raw, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  await updateRegistrationFields(test.code, registration.id, { deviceOverride: raw?.enabled !== false });
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

export async function setLocationOverride(req, code, registrationId, raw, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  if (!test.locationRequired) throw new PublicTestError(409, 'This test does not require a location check.');
  await updateRegistrationFields(test.code, registration.id, { locationOverride: raw?.enabled !== false });
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

/* ----------------------------------------------------------- manual marking */

export async function manualReview(req, code, registrationId) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  const attempt = registration.attempt;
  if (!attempt) throw new PublicTestError(404, 'This student has not started an attempt yet.');
  if (attempt.status !== 'submitted') throw new PublicTestError(409, 'Manual answers can be marked after the student submits the test.');

  const manualQuestions = new Map((test.questions || []).filter((question) => question.manualGrading).map((question) => [question.id, question]));
  const answers = (attempt.answers || [])
    .filter((answer) => manualQuestions.has(answer.questionId))
    .map((answer) => ({
      questionId: answer.questionId,
      questionNumber: ((attempt.questions || []).find((entry) => entry.questionId === answer.questionId)?.questionIndex ?? 0) + 1,
      prompt: manualQuestions.get(answer.questionId).prompt,
      answerText: answer.answerText || '',
      marks: earnedMarks(answer),
      maxMarks: questionMarks(test, manualQuestions.get(answer.questionId)),
      isCorrect: answer.isCorrect === null ? null : Boolean(answer.isCorrect)
    }))
    .sort((a, b) => a.questionNumber - b.questionNumber);

  return {
    registration: { id: registration.id, name: registration.fullName, sapId: registration.sapId },
    attempt: { id: attempt.id, submittedAt: iso(attempt.submittedAt) },
    answers
  };
}

/**
 * The update that gives one answer its mark. A short answer takes the mark as
 * given. A choice answer takes it as the teacher's own (`marksOverride`), so
 * re-marking leaves it be - unless it is the automatic mark, which is the
 * automatic marking again; `{ auto: true }` goes back to that.
 */
export function markUpdate(test, question, answer, raw = {}) {
  const worth = questionMarks(test, question);
  const automatic = automaticMarks(test, question, answer);
  if (raw.auto === true) {
    if (automatic === null) throw new PublicTestError(400, 'A short answer has no automatic mark: give it one.');
    return { set: automatic, override: false };
  }
  // Marks out of what the question is worth (`marks`); `isCorrect` true/false
  // - from before marks existed - is full marks or none.
  const marks = raw.marks !== undefined ? markWithin(raw.marks, worth)
    : raw.isCorrect === true || raw.isCorrect === 1 || raw.isCorrect === '1' ? worth
      : raw.isCorrect === false || raw.isCorrect === 0 || raw.isCorrect === '0' ? 0 : null;
  if (marks === null) throw new PublicTestError(400, `Give a mark from 0 to ${worth}.`);
  return { set: marks, override: automatic !== null && marks !== automatic };
}

/** One answer's mark written: `$[ans]` is the answer, by its question. */
export const markWrite = (update, at = 'ans') => ({
  $set: { [`attempt.answers.$[${at}].isCorrect`]: update.set, ...(update.override ? { [`attempt.answers.$[${at}].marksOverride`]: true } : {}) },
  ...(update.override ? {} : { $unset: { [`attempt.answers.$[${at}].marksOverride`]: '' } })
});

/** Any answer on a handed-in paper given its mark, by hand: the paper as it now stands. */
export async function setAnswerMarks(req, code, registrationId, raw = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  refuseIfFrozen(test, 'change a mark');
  const attempt = registration.attempt;
  if (!attempt) throw new PublicTestError(404, 'This student has not started an attempt yet.');
  if (attempt.status !== 'submitted') throw new PublicTestError(409, 'Marks can be given once the student hands the paper in.');
  const questionId = asInteger(raw?.questionId, 1, Number.MAX_SAFE_INTEGER);
  const question = (test.questions || []).find((entry) => entry.id === questionId);
  const answer = (attempt.answers || []).find((entry) => entry.questionId === questionId);
  if (questionId === null || !question || !answer) throw new PublicTestError(404, 'That question is not on this paper.');

  await updateRegistration(test.code, registration.id, markWrite(markUpdate(test, question, answer, raw || {})), { arrayFilters: [{ 'ans.questionId': questionId }] });
  const [fresh] = await registrationsOf(test.code, { id: registration.id });
  return { paper: reviewPaper(test, fresh) };
}

/** A short answer marked by hand (the paper analysis): its marks out of what it is worth. */
export async function gradeManualAnswer(req, code, registrationId, raw) {
  await setAnswerMarks(req, code, registrationId, raw);
  return manualReview(req, code, registrationId);
}

/**
 * One handed-in paper for the result review: each answer in the paper's own
 * order, with the marks it earned, what the automatic marking gives it, and
 * whether the teacher changed that.
 */
function reviewPaper(test, registration) {
  const attempt = registration.attempt;
  const bank = new Map((test.questions || []).map((question) => [question.id, question]));
  const answers = new Map((attempt.answers || []).map((answer) => [answer.questionId, answer]));
  return {
    registrationId: registration.id,
    name: registration.fullName,
    sapId: registration.sapId,
    email: registration.collegeEmail,
    accountType: registrationAccountType(registration),
    submittedAt: iso(attempt.submittedAt),
    score: paperScore(attempt),
    totalMarks: paperMarks(test, attempt),
    answers: [...(attempt.questions || [])]
      .sort((left, right) => left.questionIndex - right.questionIndex)
      .map((assigned) => {
        const question = bank.get(assigned.questionId);
        if (!question) return null;
        const answer = answers.get(assigned.questionId) || {};
        return {
          questionId: question.id,
          position: assigned.questionIndex + 1,
          selectedOptions: (answer.selectedOptions || []).map(String),
          answerText: answer.answerText || '',
          answered: Boolean(answer.answeredAt),
          answeredAt: iso(answer.answeredAt),
          marks: earnedMarks(answer),
          maxMarks: questionMarks(test, question),
          autoMarks: automaticMarks(test, question, answer),
          overridden: Boolean(answer.marksOverride),
          // Held on the device by a lost connection, taken after its time (domain/late-answers.js).
          late: answer.late ? { madeAt: iso(answer.late.madeAt), arrivedAt: iso(answer.late.arrivedAt) } : null
        };
      })
      .filter(Boolean)
  };
}

/**
 * Everything the result review needs: every question on a handed-in paper
 * (in the bank's order, with its options and key) and every handed-in paper,
 * by name - to go student by student, or question by question.
 */
export async function reviewData(req, code) {
  const test = await requireOwnedTest(req, code);
  const papers = (test.registrations || []).filter((registration) => registration.attempt?.status === 'submitted');
  const used = new Set(papers.flatMap((registration) => (registration.attempt.questions || []).map((assigned) => assigned.questionId)));
  return {
    test: { code: test.code, title: test.title, frozen: Boolean(test.resultsFrozenAt) },
    questions: (test.questions || [])
      .map((question, index) => ({ question, number: index + 1 }))
      .filter(({ question }) => used.has(question.id))
      .map(({ question, number }) => ({
        id: question.id,
        number,
        type: questionType(question),
        prompt: question.prompt,
        image: imageView(question.image),
        options: question.options || [],
        correctOptions: (question.correctOptions || []).map(String),
        manualGrading: Boolean(question.manualGrading),
        maxMarks: questionMarks(test, question),
        retired: Boolean(question.retired)
      })),
    papers: papers
      .sort((left, right) => String(left.fullName || '').localeCompare(String(right.fullName || '')))
      .map((registration) => reviewPaper(test, registration))
  };
}

/** A mark from 0 to `worth`, to two places, or null. */
function markWithin(value, worth) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= worth ? roundMarks(number) : null;
}

/* -------------------------------------------------------- attempt lifecycle */

export async function resumeAttempt(req, code, registrationId, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  const attempt = registration.attempt;
  if (test.isClosed) throw new PublicTestError(409, 'Completed tests cannot be resumed. Reset the student attempt instead.');
  if (!attempt) throw new PublicTestError(404, 'This student has not started an attempt yet.');
  if (attempt.status === 'submitted') throw new PublicTestError(409, 'A submitted attempt must be restarted, not resumed.');
  if (!attempt.isLocked) throw new PublicTestError(409, 'This attempt is not locked.');

  await reviveAttempt(test, registration);
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

const teacherEvent = (type, createdAt, durationMs = null) => ({ events: { $each: [{ type, createdAt, durationMs, detail: null }], $slice: -MAX_EVENTS } });

/**
 * Pauses one student. Their paper leaves their screen, takes no answers, and
 * their clock stops: their own end moves later by however long the pause
 * lasts (attemptDeadlineMs), and under strict timing the open question's
 * clock stops too. Nothing they do while paused counts as leaving the test.
 * The automatic end of the test waits for the time a pause is still owed.
 */
export async function pauseAttempt(req, code, registrationId, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  const attempt = registration.attempt;
  if (test.isClosed) throw new PublicTestError(409, 'This test is closed.');
  if (!attempt) throw new PublicTestError(404, 'This student has not started yet.');
  if (attempt.status === 'submitted') throw new PublicTestError(409, 'This paper has already been handed in.');
  if (attempt.pausedAt) return registrationActionResult(req, code, test, registrationId, options.compact);
  const pausedAt = now();
  // Stop the open question's clock - unless the student's own absence already has.
  const stopsQuestion = Boolean(attempt.strict?.shownAt && !attempt.strict?.pausedSince);
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', pausedAt: null }, {
    $set: { pausedAt, questionPausedByTeacher: stopsQuestion, ...(stopsQuestion ? { 'strict.pausedSince': pausedAt } : {}) },
    $push: teacherEvent('teacher_paused', pausedAt)
  });
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

/** Lets a paused student carry on, with the time the pause took given back. */
async function continuePausedAttempt(test, registration) {
  const attempt = registration.attempt;
  if (!attempt?.pausedAt || attempt.status !== 'in_progress') return false;
  const at = now();
  const pausedMs = Math.max(0, at.getTime() - dateMs(attempt.pausedAt));
  const hasNumericExtra = typeof attempt.extraMs === 'number' && Number.isFinite(attempt.extraMs);
  const set = {
    pausedAt: null, questionPausedByTeacher: false, lastSeenAt: at,
    ...(!hasNumericExtra ? { extraMs: (Number(attempt.extraMs) || 0) + pausedMs } : {})
  };
  if (attempt.questionPausedByTeacher && attempt.strict?.shownAt && attempt.strict?.pausedSince) {
    set['strict.shownAt'] = new Date(dateMs(attempt.strict.shownAt) + (at.getTime() - dateMs(attempt.strict.pausedSince)));
    set['strict.pausedSince'] = null;
  }
  // Increment a normal clock so a concurrent extension is kept. Older papers
  // may have no numeric extraMs yet; initialise those only if still unchanged.
  const expect = { id: attempt.id, status: 'in_progress', pausedAt: attempt.pausedAt,
    ...(!hasNumericExtra ? { extraMs: attempt.extraMs ?? null } : {}) };
  return updateAttemptWhere(test.code, registration.id, expect, {
    $set: set,
    ...(hasNumericExtra ? { $inc: { extraMs: pausedMs } } : {}),
    $push: teacherEvent('teacher_continued', at, pausedMs)
  });
}

export async function continueAttempt(req, code, registrationId, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  if (test.isClosed) throw new PublicTestError(409, 'This test is closed.');
  if (!registration.attempt?.pausedAt || registration.attempt.status !== 'in_progress') throw new PublicTestError(409, 'This student is not paused.');
  await continuePausedAttempt(test, registration);
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

/** Hands in one student's paper now, as it stands - recorded as handed in by the teacher. */
export async function submitStudentPaper(req, code, registrationId, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  const attempt = registration.attempt;
  if (!attempt) throw new PublicTestError(404, 'This student has not started yet.');
  if (attempt.status === 'submitted') throw new PublicTestError(409, 'This paper has already been handed in.');
  await finalizeAttempt(test, registration, attempt, { by: 'teacher' });
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id }, { $push: teacherEvent('teacher_submitted', now()) });
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

/** A reopened paper needs at least this long left to write. */
const REOPEN_MIN_LEFT_MS = 60_000;

/**
 * Gives one student back a paper they have handed in: the same questions and
 * answers, carrying on where they left off. Marks are cleared, as on any open
 * paper, and worked out again when it is handed in.
 *
 * On a timed test the student needs time left. `addMinutes` gives it to them
 * alone - their own end moves later (`extraMs`, as a pause's time is given
 * back); nobody else's does - counted from their end or from now, whichever
 * is later. With under a minute left and none added, it is refused.
 *
 * A timer on each question makes every question final once it has passed, so
 * those papers cannot be reopened. A test that closed because its time ran
 * out opens again for this student: nobody new can begin (its time is over),
 * and it closes itself again once they are done (finishTest waits for time a
 * student is owed). One the teacher closed is resumed with Resume test first.
 */
export async function reopenStudentPaper(req, code, registrationId, raw = {}, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  refuseIfFrozen(test, 'reopen a paper');
  const attempt = registration.attempt;
  if (!attempt) throw new PublicTestError(404, 'This student has not started yet.');
  if (attempt.status !== 'submitted') throw new PublicTestError(409, 'This paper is still open.');
  if (isStrict(test)) {
    throw new PublicTestError(409, 'Papers with a timer on each question cannot be reopened: every question is final once it has passed.');
  }
  if (test.isClosed && !test.closedAutomatically) {
    throw new PublicTestError(409, 'You closed this test. Use More → Resume test to open it again, then reopen this paper.', 'TEST_CLOSED');
  }
  const asked = raw.addMinutes;
  const minutes = asked === undefined || asked === null || asked === '' || Number(asked) === 0 ? 0 : asInteger(asked, 1, 24 * 60);
  if (minutes === null) throw new PublicTestError(400, 'Add between 1 and 1440 minutes.');

  const at = now();
  // The test's shared end - or, each student's own time, their Begin plus the duration.
  const base = ownBaseDeadlineMs(test, attempt);
  let extraMs = Number(attempt.extraMs) || 0;
  if (Number.isFinite(base)) {
    const ownEnd = base + extraMs;
    const newEnd = minutes ? Math.max(ownEnd, at.getTime()) + minutes * 60_000 : ownEnd;
    if (newEnd - at.getTime() < REOPEN_MIN_LEFT_MS) {
      throw new PublicTestError(409, `${registration.fullName} has no time left. Add minutes for them to reopen the paper.`, 'NEEDS_TIME');
    }
    extraMs = newEnd - base;
  }

  // Closed because its time ran out: open again, for this student.
  if (test.isClosed) {
    await serializeTestWrite(test.code, () => tests().updateOne(
      { code: test.code, isClosed: true },
      { $set: { isClosed: false, closedAt: null, closedAutomatically: false } }
    ));
    await invalidateTestCache(test.code);
  }
  // Only while still handed in: a double click reopens it once.
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'submitted' }, {
    $set: {
      status: 'in_progress',
      submittedAt: null,
      submittedBy: null,
      reopenedAt: at,
      // Heard from now: the time handed in is not the student leaving.
      lastSeenAt: at,
      awaySince: null,
      awayTyping: null,
      pausedAt: null,
      extraMs,
      answers: (attempt.answers || []).map((answer) => ({ ...answer, isCorrect: null }))
    },
    $push: teacherEvent('teacher_reopened', at, minutes ? minutes * 60_000 : null)
  });
  const current = await requireOwnedTest(req, code, { withStudents: false });
  return registrationActionResult(req, code, current, registrationId, options.compact);
}

async function reviveAttempt(test, registration) {
  const attempt = registration.attempt;
  const resumedAt = now();
  // Reviving clears the counters the LIMITS read, so the student can carry
  // on, but never the lifetime record the report reads: the dashboard still
  // shows every time they left. It does not move the deadline - extend the
  // test for that - except with a timer on each question, where the time the
  // lock took comes back on the student's own end (their question's clock
  // stood still meanwhile, and the paper's end must not cut off the rest).
  const back = lockedMsToGiveBack(test, attempt, resumedAt.getTime());
  const extra = extraTimeWrite(attempt, back);
  return updateAttemptWhere(test.code, registration.id, { id: attempt.id, isLocked: true, lockedAt: attempt.lockedAt ?? null, ...extra.expect }, {
    ...(extra.inc ? { $inc: extra.inc } : {}),
    $set: {
      ...extra.set,
      isLocked: false,
      lockedAt: null,
      lockReason: null,
      fullscreenExitCount: 0,
      fullscreenTotalAbsenceMs: 0,
      violationCount: 0,
      violationKey: null,
      awaySince: null,
      // Not "seen at the unlock": the student is watched again from their
      // page's next check-in. A locked tab in the background checks in
      // rarely, and that silence must not read as going offline.
      lastSeenAt: null,
      // Attempts from before the lifetime record existed get one built from
      // their log; newer ones already have it and it is left to its counters.
      ...(attempt.integrity ? {} : { integrity: integrityRecord(attempt) })
    },
    $push: { events: { $each: [{ type: 'attempt_resumed', createdAt: resumedAt, durationMs: back || null, detail: null }], $slice: -MAX_EVENTS } }
  });
}

async function rebuildAttempt(test, registration) {
  const attempt = buildAttempt(registration.attempt.id, test, registration);
  // A blank paper, but the same student: what they did before the restart
  // stays on their record.
  attempt.integrity = integrityRecord(registration.attempt);
  attempt.answerLog = registration.attempt.answerLog || [];
  if (registration.attempt.windowCheck) attempt.windowCheck = registration.attempt.windowCheck;
  attempt.events = [
    ...(registration.attempt.events || []),
    { type: 'attempt_restarted', createdAt: attempt.startedAt, durationMs: null, detail: null }
  ].slice(-MAX_EVENTS);
  await updateRegistrationFields(test.code, registration.id, { attempt });
}

/** A restarted paper on a closed test could never be sat or submitted. */
function refuseIfClosed(test) {
  if (test.isClosed) throw new PublicTestError(409, 'This test is closed, so attempts cannot be restarted. Reset the test to run it again.');
}

export async function restartAttempt(req, code, registrationId, options = {}) {
  const { test, registration } = await requireOwnedRegistration(req, code, registrationId);
  refuseIfClosed(test);
  if (!registration.attempt) throw new PublicTestError(404, 'This student has not started an attempt yet.');
  await rebuildAttempt(test, registration);
  return registrationActionResult(req, code, test, registrationId, options.compact);
}

async function mapWithConcurrency(items, worker, limit = 24) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function restartAllAttempts(req, code, options = {}) {
  const test = await requireOwnedTest(req, code);
  refuseIfClosed(test);
  const withAttempts = (test.registrations || []).filter((entry) => entry.attempt);
  await mapWithConcurrency(withAttempts, (registration) => rebuildAttempt(test, registration));
  return actionResult(req, code, test, options.compact, { resetCount: withAttempts.length });
}

/**
 * Revives or restarts a chosen set of students, or continues every paused
 * student matching the current Students search/filter (across all pages).
 * Students whose state changed meanwhile are skipped, not counted twice.
 */
export async function bulkAttemptAction(req, code, action, raw = {}, options = {}) {
  if (!['resume', 'restart', 'continue'].includes(action)) throw new PublicTestError(400, 'Invalid attempt action.');
  const matching = action === 'continue' && raw.scope === 'matching';
  const test = await requireOwnedTest(req, code, { withStudents: !matching });
  if (!matching && !Array.isArray(raw.registrationIds)) throw new PublicTestError(400, 'Choose the students to apply this to.');
  if (action === 'restart') refuseIfClosed(test);
  if (action !== 'restart' && test.isClosed) {
    throw new PublicTestError(409, 'Completed tests cannot be resumed. Reset the student attempt instead.');
  }

  let eligible;
  if (matching) {
    const page = dashboardPageOptions({ section: 'students', search: raw.search, filters: raw.filters });
    const paused = { 'attempt.status': 'in_progress', 'attempt.pausedAt': { $exists: true, $ne: null } };
    const match = joinMongoAnd([dashboardBaseMatch(test.code, page), dashboardSelectedMongoMatch(page, dashboardManualQuestionIds(test)), paused]);
    eligible = await registrationsCollection().find(match, { projection: {
      _id: 0, id: 1, 'attempt.id': 1, 'attempt.status': 1, 'attempt.pausedAt': 1, 'attempt.extraMs': 1,
      'attempt.questionPausedByTeacher': 1, 'attempt.strict.shownAt': 1, 'attempt.strict.pausedSince': 1
    } }).toArray();
  } else {
    const chosen = new Set(raw.registrationIds.map(String));
    eligible = (test.registrations || []).filter((entry) => {
      if (!chosen.has(String(entry.id)) || !entry.attempt) return false;
      if (action === 'restart') return true;
      if (action === 'continue') return entry.attempt.status === 'in_progress' && entry.attempt.pausedAt;
      return entry.attempt.isLocked && entry.attempt.status !== 'submitted';
    });
  }
  const results = await mapWithConcurrency(eligible, (registration) => (
    action === 'resume' ? reviveAttempt(test, registration)
      : action === 'continue' ? continuePausedAttempt(test, registration)
        : rebuildAttempt(test, registration).then(() => true)
  ));
  return actionResult(req, code, test, options.compact, { affectedCount: results.filter(Boolean).length });
}

/* ------------------------------------------------------------ test lifecycle */

/**
 * Moves the test's end time while it is open - the one lever that gives
 * students more time. Every paper reads `endsAt` on each request, so a new
 * end time reaches every student at once. `addMinutes` extends from
 * whichever is later - the current end time, or now - so the minutes are real.
 */
export async function setTestEndTime(req, code, raw = {}, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  if (test.isClosed) throw new PublicTestError(409, 'This test is complete. Reset it before running it again.');
  if (isPerStudent(test)) return extendOwnTimes(req, code, test, raw, options);

  // Measured from the real start once there is one, else the planned start.
  const startMs = test.startedAt ? dateMs(test.startedAt) : test.opensAt ? dateMs(test.opensAt) : null;
  // An untimed test (or a duration test not yet started) has no end yet:
  // "+10 minutes" counts from now, and giving it an end time turns it into a
  // test that ends at that time from here on.
  const storedEnd = test.endsAt ?? test.closesAt;
  const currentEndMs = isUntimed(test) || !storedEnd ? Date.now() : dateMs(storedEnd);
  let endsAtMs;

  if (raw.addMinutes !== undefined) {
    const minutes = asInteger(raw.addMinutes, 1, 24 * 60);
    if (minutes === null) throw new PublicTestError(400, 'Add between 1 and 1440 minutes.');
    endsAtMs = endTimeMs(new Date(Math.max(currentEndMs, Date.now()) + minutes * 60_000), startMs);
  } else {
    endsAtMs = endTimeMs(raw.endsAt, startMs);
  }

  await updateTest(test.code, {
    $set: {
      untimed: false,
      endMode: endModeOf(test) === 'duration' && test.isStarted ? 'duration' : 'at',
      endsAt: new Date(endsAtMs),
      windowSeconds: startMs === null ? null : Math.round((endsAtMs - startMs) / 1000)
    }
  });
  const updated = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, updated, options.compact);
}

/**
 * Each student's own time has no shared end to move: "+10 min" goes to every
 * student still writing, counted from their own end - or from now, if theirs
 * has already passed (a paused student's end runs on with the pause) - so the
 * minutes are real. A student who begins later gets the full duration anyway.
 */
async function extendOwnTimes(req, code, test, raw, options) {
  if (raw.addMinutes === undefined) {
    throw new PublicTestError(400, 'Each student has their own end time: add minutes for everyone still writing instead.');
  }
  const minutes = asInteger(raw.addMinutes, 1, 24 * 60);
  if (minutes === null) throw new PublicTestError(400, 'Add between 1 and 1440 minutes.');
  const at = now();
  const extra = { $ifNull: ['$attempt.extraMs', 0] };
  const pausing = { $cond: [{ $ifNull: ['$attempt.pausedAt', false] }, { $subtract: [at, '$attempt.pausedAt'] }, 0] };
  const ownEnd = { $add: ['$attempt.startedAt', Number(test.durationMinutes) * 60_000, extra, pausing] };
  const given = await updateRegistrationsWhere(test.code, { 'attempt.status': 'in_progress' }, [{
    $set: { 'attempt.extraMs': { $add: [extra, minutes * 60_000, { $max: [0, { $subtract: [at, ownEnd] }] }] } }
  }]);
  const updated = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, updated, options.compact, { affectedCount: given.modifiedCount });
}

export async function startTest(req, code, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  if (test.isClosed) throw new PublicTestError(409, 'This test is complete. Reset it before starting it again.');
  if (test.isStarted) return actionResult(req, code, test, options.compact);
  // Starting a test whose window has already lapsed would "succeed" and leave a
  // test nobody can sit, because no fresh attempt may begin after the end time.
  // Say so here, where the admin can still do something about it.
  if (isTimeOver(test)) {
    throw new PublicTestError(409, 'The end time has already passed, so nobody could begin. Use Extend time to give this test a window, then start it.');
  }
  await beginTest(test);
  const started = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, started, options.compact);
}

/**
 * Ends the test for everyone: every paper still open is submitted, then the
 * test is closed. The admin's Close, and the scheduler once the end time (and
 * its grace) has passed, both come here. `test` must be the whole document.
 */
export async function finishTest(test, { automatic = false, atMs = Date.now() } = {}) {
  if (test.isClosed) return 0;
  const active = await registrationsOf(test.code, { 'attempt.status': 'in_progress' });
  const by = automatic ? 'time' : 'admin';
  // When the clock ends it, a student their teacher paused keeps the time the
  // pause took: their paper stays open until their own end (or while still
  // paused), and the test closes once the last of them is done. The admin's
  // Close ends every paper at once.
  const due = automatic
    ? active.filter(({ attempt }) => !attempt.pausedAt && atMs >= attemptDeadlineMs(test, attempt, atMs) + END_GRACE_MS)
    : active;
  await mapWithConcurrency(due, (registration) => finalizeAttempt(test, registration, registration.attempt, { by }));
  if (due.length < active.length) return due.length;
  await serializeTestWrite(test.code, () => tests().updateOne(
    { code: test.code, isClosed: { $ne: true } },
    { $set: { isClosed: true, closedAt: now(), closedAutomatically: automatic } }
  ));
  await invalidateTestCache(test.code);
  // A paper begun in the moment between the sweep above and the close is
  // submitted too. Nothing new can begin now that the test is closed.
  const late = await registrationsOf(test.code, { 'attempt.status': 'in_progress' });
  await mapWithConcurrency(late, (registration) => finalizeAttempt(test, registration, registration.attempt, { by }));
  return active.length + late.length;
}

/**
 * Each student's own time (endMode 'each'): hands in every paper whose own
 * end - and the grace for answers still arriving - has passed. The student's
 * page does it at zero; this catches a closed tab. The test itself stays open
 * until the admin's Close. A paused student's time is not running. `test`
 * may come without its questions; they are read when a paper is handed in.
 */
export async function finishOwnTimes(test, atMs = Date.now()) {
  if (!isPerStudent(test) || !test.isStarted || test.isClosed || !(Number(test.durationMinutes) > 0)) return 0;
  // Nobody who began after this can be due: time given back only ever adds.
  const latestStart = new Date(atMs - Number(test.durationMinutes) * 60_000 - END_GRACE_MS);
  const candidates = await registrationsOf(test.code, { 'attempt.status': 'in_progress', 'attempt.startedAt': { $lte: latestStart } });
  const due = candidates.filter(({ attempt }) => !attempt.pausedAt && atMs >= attemptDeadlineMs(test, attempt, atMs) + END_GRACE_MS);
  if (!due.length) return 0;
  const whole = test.questions ? test : await tests().findOne({ code: test.code });
  await mapWithConcurrency(due, (registration) => finalizeAttempt(whole, registration, registration.attempt, { by: 'time' }));
  return due.length;
}

export async function closeTest(req, code, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const completedAttemptCount = await finishTest(test);
  const closed = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, closed, options.compact, { completedAttemptCount });
}

/** Adds `ms` to a date field that may be missing or null (as in outage.js). */
const later = (field, ms) => ({ $cond: [{ $ifNull: [field, false] }, { $add: [field, ms] }, field] });

/**
 * Undoes a Close pressed by mistake. The test runs again, and every paper
 * the Close handed in - those submitted by 'admin', which only the Close
 * does - reopens exactly where it was: same questions, same answers, same
 * question open, with the time it had left. The time spent closed is given
 * back the way an outage's is (outage.js): the end time and each open
 * question's clock move on by it. Papers students handed in themselves stay
 * handed in. Marks are cleared as on any open paper - answers can change
 * now - and are worked out again when it is handed in. A test that ended
 * because its time ran out has nothing to resume.
 */
export async function reopenTest(req, code, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  refuseIfFrozen(test, 'resume the test');
  if (!test.isClosed) throw new PublicTestError(409, 'This test is not closed.');
  if (test.closedAutomatically) {
    throw new PublicTestError(409, 'This test ended because its time ran out, so there is nothing to resume. Restart quiz runs it again.');
  }
  const closedMs = dateMs(test.closedAt);
  const timed = test.untimed !== true && Boolean(test.endsAt);
  if (timed && dateMs(test.endsAt) <= closedMs) {
    throw new PublicTestError(409, 'No time was left when this test was closed, so there is nothing to resume.');
  }
  const reopenedAt = now();
  const gapMs = Math.max(0, reopenedAt.getTime() - closedMs);

  // Only while still closed: a double click reopens it once.
  const reopened = await serializeTestWrite(test.code, () => tests().updateOne({ code: test.code, isClosed: true }, [{
    $set: {
      isClosed: false, closedAt: null, closedAutomatically: false,
      // Released marks are hidden again until it closes for real.
      resultsReleasedAt: null, releaseUnmarked: false,
      ...(timed ? { endsAt: { $add: ['$endsAt', gapMs] } } : {}),
      reopenings: { $concatArrays: [{ $ifNull: ['$reopenings', []] }, [{ closedAt: test.closedAt, reopenedAt, ms: gapMs }]] }
    }
  }]));
  if (reopened.modifiedCount) await invalidateTestCache(test.code);
  if (!reopened.modifiedCount) return actionResult(req, code, test, options.compact);

  const papers = await updateRegistrationsWhere(test.code, { 'attempt.status': 'submitted', 'attempt.submittedBy': 'admin' }, [{
    $set: {
      'attempt.status': 'in_progress',
      'attempt.submittedAt': null,
      'attempt.submittedBy': null,
      'attempt.reopenedAt': reopenedAt,
      // Heard from now: the time closed is not the student leaving.
      'attempt.lastSeenAt': reopenedAt,
      'attempt.awaySince': null,
      // Each student's own time: the time spent closed is theirs again.
      ...(isPerStudent(test) ? { 'attempt.extraMs': { $add: [{ $ifNull: ['$attempt.extraMs', 0] }, gapMs] } } : {}),
      'attempt.answers': { $map: { input: { $ifNull: ['$attempt.answers', []] }, as: 'answer', in: { $mergeObjects: ['$$answer', { isCorrect: null }] } } },
      'attempt.strict': {
        $cond: [
          { $ifNull: ['$attempt.strict', false] },
          { $mergeObjects: ['$attempt.strict', { shownAt: later('$attempt.strict.shownAt', gapMs), pausedSince: later('$attempt.strict.pausedSince', gapMs) }] },
          '$$REMOVE'
        ]
      }
    }
  }]);
  const current = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, current, options.compact, { affectedCount: papers.modifiedCount });
}

export async function resetTest(req, code, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  refuseIfFrozen(test, 'reset the test');
  await clearTestRun(test);
  const reset = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, reset, options.compact);
}

/**
 * Wipes a test's run: every paper and mark gone, not started, not closed.
 * Registrations (and their approvals) stay. Shared by Reset and Restart quiz.
 */
async function clearTestRun(test) {
  // A scheduled start that has already passed would fire again the moment
  // the test is reset, so the reset test waits for the Start button instead.
  const startMode = test.startMode === 'scheduled' && test.opensAt && dateMs(test.opensAt) <= Date.now() ? 'manual' : test.startMode ?? 'manual';
  // Back to its planned window: a duration counts again from the next start.
  const endsAt = endModeOf(test) === 'duration' ? plannedEndsAt({ ...test, startMode }) : test.endsAt ?? null;
  await updateTest(test.code, {
    $set: {
      startMode,
      // The spread draw hands out its blocks from the start again.
      paperSlots: 0,
      isStarted: false, startedAt: null, isClosed: false, closedAt: null, closedAutomatically: false, resultsReleasedAt: null, releaseUnmarked: false,
      endsAt,
      outages: []
    }
  });
  // Every paper and its draw slot go - a paper made ahead too, being made from
  // that slot; the registrations (and approvals) stay.
  await updateRegistrationsWhere(test.code, {}, { $set: { attempt: null, paperSlot: null }, $unset: { preparedPaper: '', preparedBasis: '' } });
}

/**
 * Runs a started (or finished) test again from the beginning, in one step:
 * every paper and mark is cleared, approved students keep their place, and
 * the test starts again now. A duration counts afresh from now; a set end
 * time that has passed needs a new one (`addMinutes`), or the restarted test
 * would end the moment it began. Students with the page open are sent to
 * Begin for a fresh paper by their page.
 */
export async function restartQuiz(req, code, raw = {}, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  refuseIfFrozen(test, 'restart the quiz');
  if (!test.isStarted && !test.isClosed) {
    throw new PublicTestError(409, 'This test has not started yet, so there is nothing to restart. Press Start instead.');
  }
  let endsAt = null;
  if (endModeOf(test) === 'at') {
    if (raw.addMinutes !== undefined) {
      const minutes = asInteger(raw.addMinutes, 1, 24 * 60);
      if (minutes === null) throw new PublicTestError(400, 'Choose between 1 and 1440 minutes.');
      endsAt = new Date(Date.now() + minutes * 60_000);
    } else if (!test.endsAt || dateMs(test.endsAt) <= Date.now() + 60_000) {
      throw new PublicTestError(409, 'The end time has passed. Choose how long the restarted test should run.', 'NEEDS_END_TIME');
    }
  }
  await clearTestRun(test);
  const cleared = await requireOwnedTest(req, code, { withStudents: false });
  if (endsAt) {
    await updateTest(test.code, { $set: { endsAt, untimed: false, endMode: 'at' } });
    cleared.endsAt = endsAt;
  }
  await beginTest(cleared);
  const restarted = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, restarted, options.compact);
}

export async function releaseResults(req, code, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  if (!test.resultsReleasedAt) await updateTest(test.code, { $set: { resultsReleasedAt: now() } });
  const current = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, current, options.compact);
}

/**
 * Marks shown before marking is finished: each student sees the score of what
 * is marked so far, with their short answers still unmarked shown as not
 * marked yet; each mark given later shows as it is given. Turning it on also
 * releases marks held for the teacher's release. Off again, a paper with an
 * unmarked answer waits for it as before.
 */
export async function setUnmarkedRelease(req, code, raw = {}, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const show = raw.show !== false;
  const update = { releaseUnmarked: show };
  if (show && test.resultReleaseMode === 'admin' && !test.resultsReleasedAt) update.resultsReleasedAt = now();
  await updateTest(test.code, { $set: update });
  const current = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, current, options.compact);
}

/**
 * Freezes a closed test's results - its marks final (domain/freeze.js) - or
 * unfreezes them. Only a closed test: while it runs, papers are still being
 * handed in and marked.
 */
export async function setResultsFrozen(req, code, raw = {}, options = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const freeze = raw.frozen !== false;
  if (freeze && !test.isClosed) throw new PublicTestError(409, 'Close the test before freezing its results: papers are still being handed in.');
  await updateTest(test.code, { $set: { resultsFrozenAt: freeze ? (test.resultsFrozenAt || now()) : null } });
  const current = await requireOwnedTest(req, code, { withStudents: false });
  return actionResult(req, code, current, options.compact);
}

export async function deleteTest(req, code) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  refuseIfFrozen(test, 'delete the test');
  await tests().deleteOne({ code: test.code });
  await invalidateTestCache(test.code);
  await deleteRegistrationsOf(test.code);
  return { deletedCode: test.code };
}
