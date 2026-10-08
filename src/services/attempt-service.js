import { config } from '../config.js';
import { paperHasImages, questionHasImage, shownGraceMs } from '../domain/question-image.js';
import { registrations, tests } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { asInteger, hash, hmac, randomId, stableSort } from '../lib/crypto.js';
import { currentMs, dateMs, now } from '../lib/time.js';
import { activeQuestions, questionType, selectedAttemptQuestions } from '../domain/question-bank.js';
import { attemptView } from '../domain/presenters.js';
import { TIME_OVER_MESSAGE, acceptsAttemptAnswers, isAttemptTimeOver, isPerStudent, isTimeOver } from '../domain/attempt-rules.js';
import { MAX_EVENTS, RETIRED_FLAGS, emptyIntegrity, flagReason, leaveReason, locksOnViolation, violationActionOf, warningsBeforeLockOf } from '../domain/integrity.js';
import { ANSWER_LOG_MAX, TYPING_MERGE_MS } from '../domain/activity.js';
import { automaticMarks, earnedMarks, paperMarks, paperScore, pendingMarks, questionMarks } from '../domain/marks.js';
import {
  adminEmail, attemptContext, hasRegistrationCookie, preparedPaperOf, registrationFor, requireRegistration, requireTestForStudent,
  serializePaperWrite, updateAttemptWhere, updateRegistrationFields
} from '../data/test-repository.js';
import { startIfDue } from './test-lifecycle.js';
import { deviceFromRequest, deviceUpdate, ownsTest, recordDevice } from './device-service.js';
import { deviceRefusal, deviceVerdict } from '../domain/device.js';
import { justWokeUp } from './outage.js';
import {
  EARLY_TIMEOUT_MS, STRICT_GRACE_MS, acknowledgeShown, allowsNext, clockStartOnShown, effectiveShownMs, emptyStrictState, isStrict, resolveStrict, strictPaper
} from '../domain/strict-timing.js';
import { lateAnswerDeadline, lateAnswerRecord } from '../domain/late-answers.js';
import { resultsFrozen } from '../domain/freeze.js';

// Faculty have no SAP ID, so their paper is seeded from their email instead.
const attemptSeed = (test, registration) => hmac(`${test.code}:${registration.sapId || registration.collegeEmail}`, config.sessionSecret);

/** A student's questions in their order, each with its options' order, and an empty answer for each. */
function paperQuestions(test, registration, seed) {
  const selected = selectedAttemptQuestions(test, seed, registration.paperSlot ?? null);
  return {
    questions: selected.map((question, index) => ({
      questionIndex: index,
      questionId: question.id,
      optionOrder: stableSort(question.options.map((_option, optionIndex) => String(optionIndex)), `${seed}:${question.id}`, (id) => id)
    })),
    answers: selected.map((question) => ({
      questionId: question.id, selectedOptions: [], answerText: '', answeredAt: null, isCorrect: null
    }))
  };
}

/**
 * What a student's paper is made from, as one short string: the questions
 * (each kind and number of options), how many of each kind, the draw and the
 * shuffle, and the student's own seed (their SAP ID, which an admin may
 * correct). A paper made ahead from anything since changed is not used
 * (preparePaper).
 */
export const paperBasis = (test, registration) => hash(JSON.stringify([
  activeQuestions(test).map((question) => [question.id, questionType(question), (question.options || []).length]),
  test.questionMix || null, test.questionCount ?? null, test.questionDraw || null, Boolean(test.shuffleQuestions),
  attemptSeed(test, registration)
])).slice(0, 24);

/**
 * A fresh paper for one student. The deadline is not stored here: it is the
 * test's own `endsAt`, shared by everyone, so moving that end time immediately
 * moves every attempt with it. `prepared`: the questions and answers made
 * ahead (preparePaper) - the very ones this would make now.
 */
export function buildAttempt(existingId, test, registration, prepared = null) {
  const startedAt = now();
  const seed = attemptSeed(test, registration);
  const { questions, answers } = prepared || paperQuestions(test, registration, seed);
  return {
    id: existingId || randomId(18),
    status: 'in_progress',
    startedAt,
    submittedAt: null,
    seed,
    questions,
    answers,
    fullscreenExitCount: 0,
    fullscreenTotalAbsenceMs: 0,
    // outsideStreak: readings in a row placing them outside; outsideSince is
    // set once that passes the allowance, and closes the paper until they return.
    // outsideCount/outsideMs: how many times the student left the venue during
    // the test and how long they were away from it in total. submit: where
    // they were when they handed the paper in.
    locationChecks: {
      inRange: 0, outOfRange: 0, inconclusive: 0, last: null,
      outsideStreak: 0, outsideSince: null, outsideCount: 0, outsideMs: 0, submit: null
    },
    isLocked: false,
    lockedAt: null,
    lockReason: null,
    // When the student left and has not yet come back; null while present.
    awaySince: null,
    // The last time this paper was heard from - see checkIn().
    lastSeenAt: startedAt,
    // The lifetime record for the report - see domain/integrity.js.
    integrity: emptyIntegrity(),
    events: [],
    // Every answer saved, for the activity report - see domain/activity.js.
    answerLog: [],
    // Each student's own time: the paper's clock waits for the device to say
    // the paper is on screen (markShown), as strict timing's questions do.
    clockSentAt: isPerStudent(test) ? startedAt : null,
    // Strict timing: which question is open and since when - see domain/strict-timing.js.
    ...(isStrict(test) ? { strict: emptyStrictState(startedAt) } : {})
  };
}

function distanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6_371_000;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const angle = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(angle), Math.sqrt(1 - angle));
}

const LOCATION_ACCURACY_LIMIT_METERS = 200;
const LOCATION_EDGE_BUFFER_METERS = 75;

/**
 * GPS is an estimate. A reading is only called outside when even the nearest
 * edge of its accuracy circle is beyond the venue plus a small boundary
 * buffer. Poor or boundary-straddling readings are inconclusive.
 */
export function classifyLocationCheck(test, raw) {
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  const accuracyMeters = Number(raw?.accuracyMeters);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    return { status: 'inconclusive', distanceMeters: null, accuracyMeters: null };
  }
  const distance = distanceMeters(Number(test.locationLatitude), Number(test.locationLongitude), latitude, longitude);
  if (accuracyMeters > LOCATION_ACCURACY_LIMIT_METERS) {
    return { status: 'inconclusive', distanceMeters: distance, accuracyMeters };
  }
  const edge = Number(test.locationRadiusMeters) + LOCATION_EDGE_BUFFER_METERS;
  if (distance - accuracyMeters > edge) return { status: 'outOfRange', distanceMeters: distance, accuracyMeters };
  if (distance + accuracyMeters <= edge) return { status: 'inRange', distanceMeters: distance, accuracyMeters };
  return { status: 'inconclusive', distanceMeters: distance, accuracyMeters };
}

/** The newest readings kept on a paper (one comes at Begin, each question change and about once a minute). */
const LOCATION_TRAIL_LIMIT = 400;
const coordinate = (value, limit) => {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? Math.round(number * 1e6) / 1e6 : null;
};

/**
 * One reading as the teacher's Location tab lists it: where the device said
 * it was while the paper was open, how sure it was, and what the check made
 * of it. A check with no reading (permission refused, no fix) is kept too,
 * without coordinates.
 */
export function locationReading(raw, check, at, trigger) {
  const latitude = coordinate(raw?.latitude, 90);
  const longitude = coordinate(raw?.longitude, 180);
  const known = latitude !== null && longitude !== null;
  const accuracy = Number(raw?.accuracyMeters);
  return {
    at,
    trigger,
    status: check.status,
    latitude: known ? latitude : null,
    longitude: known ? longitude : null,
    accuracyMeters: known && Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null,
    distanceMeters: Number.isFinite(check.distanceMeters) ? Math.round(check.distanceMeters) : null
  };
}

/**
 * Why a student's page could not get their location at Begin, as the page
 * found it (client/src/lib/geo.js) - kept on the registration so the teacher's
 * row says why, beside the location exception that lets them in. Not the
 * position itself: that is kept only once a paper is open (locationReading).
 */
const LOCATION_PROBLEMS = ['denied', 'inapp', 'unavailable', 'timeout', 'insecure', 'unsupported', 'imprecise'];
const locationProblemOf = (raw) => ({
  reason: LOCATION_PROBLEMS.includes(raw?.locationProblem?.reason) ? raw.locationProblem.reason : 'unknown',
  // Whether the browser showed the question at all (false: refused at once).
  asked: typeof raw?.locationProblem?.asked === 'boolean' ? raw.locationProblem.asked : null,
  at: now()
});

async function verifyStartLocation(test, registration, raw) {
  if (!test.locationRequired) return null;
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    if (registration.locationOverride) return classifyLocationCheck(test, raw);
    await updateRegistrationFields(test.code, registration.id, { locationProblem: locationProblemOf(raw) });
    throw new PublicTestError(403, 'Allow location access to verify that you are at the test venue.', 'LOCATION_NEEDED');
  }
  const distance = distanceMeters(Number(test.locationLatitude), Number(test.locationLongitude), latitude, longitude);
  const accuracy = Number(raw?.accuracyMeters);
  const radius = Number(test.locationRadiusMeters);
  if (!registration.locationOverride && distance > radius) {
    // Refused only when clearly away: even the near edge of the reading's own
    // margin is past the area and the same buffer the paper's checks allow.
    // It used to refuse any reading whose centre fell outside - and indoors a
    // phone in the room is often put a few dozen metres off, so students at
    // the venue needed an exception for a reading the paper itself would not
    // have counted against them.
    const nearEdge = distance - (Number.isFinite(accuracy) ? accuracy : 0);
    if (nearEdge > radius + LOCATION_EDGE_BUFFER_METERS) {
      await updateRegistrationFields(test.code, registration.id, { locationDistanceMeters: distance });
      throw new PublicTestError(403, `You are outside the permitted test area (${Math.round(distance)} m away; limit ${Math.round(radius)} m). Ask the administrator for an exception if this is incorrect.`);
    }
    // Too vague to tell - a phone sharing only its approximate location (a
    // setting on both iPhone and Android) places the student anywhere within
    // a kilometre or more. "You are 1400 m away" would send them looking in
    // the wrong place: say what to change instead.
    if (!Number.isFinite(accuracy) || accuracy > LOCATION_ACCURACY_LIMIT_METERS) {
      await updateRegistrationFields(test.code, registration.id, {
        locationProblem: { reason: 'imprecise', asked: null, at: now(), accuracyMeters: Number.isFinite(accuracy) ? Math.round(accuracy) : null }
      });
      throw new PublicTestError(403, `Your phone shared only an approximate location (within ${Math.round(accuracy) || 'several hundred'} m), which cannot show you are at the venue. Turn on Precise Location for your browser - on an iPhone: Settings → Privacy & Security → Location Services → Safari Websites (or Chrome) → Precise Location; on Android: Settings → Apps → Chrome → Permissions → Location → Use precise location. Indoors, also turn on Wi-Fi (no need to connect to a network): phones use it to find where they are. Then try again.`, 'LOCATION_IMPRECISE');
    }
    // A good reading just past the edge, its margin reaching into the area:
    // the checks during the paper decide, as they would for this reading.
  }
  await updateRegistrationFields(test.code, registration.id, { locationVerifiedAt: now(), locationDistanceMeters: distance, locationProblem: null });
  return classifyLocationCheck(test, raw);
}

export const PAUSED_MESSAGE = 'Your teacher has paused your test. Your time is stopped - you carry on from here when they continue it.';

/**
 * Marks a paper's answers: each choice question right or wrong - its marks
 * (domain/marks.js) or 0 - and each short answer as the teacher marked it. A
 * mark the teacher gave a choice answer by hand (`marksOverride`) stands.
 */
export function gradeAnswers(test, attempt) {
  return (attempt.answers || []).map((answer) => {
    const question = (test.questions || []).find((entry) => entry.id === answer.questionId);
    if (!question) return answer;
    const marks = questionMarks(test, question);
    // A mark above what the question is now worth comes down to it.
    const capped = earnedMarks(answer) !== null && earnedMarks(answer) > marks ? { ...answer, isCorrect: marks } : answer;
    if (question.manualGrading) {
      // Left blank: nothing for the admin to mark, so it scores 0 now rather
      // than holding the student's marks back until someone "marks" nothing.
      // The admin can still change it.
      if (!answer.answeredAt && answer.isCorrect === null) return { ...answer, isCorrect: 0 };
      return capped;
    }
    if (answer.marksOverride) return capped;
    return { ...answer, isCorrect: automaticMarks(test, question, answer) };
  });
}

/**
 * Grade and freeze an attempt. Used by the student's Submit, the admin's
 * Close, and the automatic close at the end time. `by` records which:
 * 'student', 'time', 'admin' (the test's Close) or 'teacher' (one paper handed
 * in by the teacher) - a student submitting once the clock has run out is
 * recorded as 'time', since that is what ended their paper.
 *
 * The grade and the status change land in ONE write, and only if the answers
 * are still exactly the ones that were graded. When a whole class submits at
 * once, an answer still in flight could otherwise arrive between the read and
 * the write and be lost, or be saved but left out of the score. If anything
 * moved, re-read and grade again. The same guard makes a double submit (two
 * taps, a retry after a dropped connection, the admin's Close) finalise once.
 */
export async function finalizeAttempt(test, registration, attempt = registration.attempt, { requireUnlocked = false, by = 'student' } = {}) {
  let current = attempt;
  const submittedBy = by === 'student' && isAttemptTimeOver(test, attempt) ? 'time' : by;
  for (let round = 0; round < 5; round += 1) {
    if (!current || current.status === 'submitted') return current;
    if (requireUnlocked && current.isLocked) requireWritableAttempt(current);
    const answers = gradeAnswers(test, current);
    const submittedAt = now();
    const expect = { id: current.id, status: 'in_progress', answers: current.answers || [] };
    if (requireUnlocked) expect.isLocked = { $ne: true };
    const applied = await updateAttemptWhere(test.code, registration.id, expect, {
      $set: { status: 'submitted', submittedAt, submittedBy, answers, awaySince: null, pausedAt: null }
    });
    if (applied) return { ...current, status: 'submitted', submittedAt, submittedBy, answers, awaySince: null, pausedAt: null };
    current = (await attemptContext(current.id))?.attempt;
  }
  throw new PublicTestError(503, 'The server is busy. Your answers are safe - press Submit again in a moment.');
}

async function ownedAttempt(req, attemptId) {
  const context = await attemptContext(attemptId);
  if (!context) throw new PublicTestError(404, 'Test attempt not found.', 'NO_ATTEMPT');
  // Only the attempt's own registration is loaded, so a student holding some
  // other registration on this test simply finds nothing here: that is a 404,
  // exactly as before. No registration cookie at all still means "register".
  if (!registrationFor(req, context.test)) {
    if (!hasRegistrationCookie(req, context.test.code)) requireRegistration(req, context.test, true);
    throw new PublicTestError(404, 'Test attempt not found.');
  }
  requireRegistration(req, context.test, true);
  return context;
}

// Coded, so the paper keeps an answer queued through a lock rather than
// taking it as refused for good: it goes once the paper is revived.
function requireWritableAttempt(attempt) {
  if (attempt.isLocked) throw new PublicTestError(423, 'This test attempt is locked. It unlocks automatically after a short wait.', 'LOCKED');
  return attempt;
}

/**
 * Strict timing: closes the open question if its time ran out since the last
 * look, starts the clock on the question now being shown, and writes that
 * back - only if nobody else moved the paper meanwhile. Finishing the last
 * question submits the paper. Returns the attempt as it now stands.
 */
async function syncStrict(test, registration, attempt, atMs = Date.now()) {
  if (!isStrict(test) || !attempt || attempt.status !== 'in_progress' || attempt.isLocked) return attempt;
  const state = resolveStrict(test, attempt, atMs);
  if (!state.changed) return attempt;
  const storedIndex = attempt.strict?.index ?? 0;
  const applied = await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', 'strict.index': storedIndex }, {
    $set: { 'strict.index': state.index, 'strict.shownAt': state.shownAt, 'strict.sentAt': state.sentAt, 'strict.pausedSince': state.pausedSince },
    ...(state.closed.length ? { $push: { 'strict.log': { $each: state.closed } } } : {})
  });
  const fresh = (await attemptContext(attempt.id))?.attempt || attempt;
  if (applied && state.done) return finalizeAttempt(test, registration, fresh, { by: 'time' });
  return fresh;
}

/** The paper as this student sees it, including where the venue check stands. */
async function studentView(test, registration, attempt) {
  const current = await syncStrict(test, registration, attempt);
  return attemptView(test, current, currentMs(), { venue: venueClosed(test, registration, current) });
}

/** private: detected; mobile: a phone browser (no extensions); declared: the student said so; unknown: no signal. */
const WINDOW_CHECKS = ['private', 'mobile', 'declared', 'unknown'];
/** Private-window tests bind everyone who sits them except the test's own creator. */
const mustUsePrivateWindow = (req, test) => Boolean(test.requirePrivateWindow) && test.ownerEmail !== adminEmail(req);

/**
 * Spread draw: this student's place in the order papers are made - while they
 * wait (preparePaper), or at Begin - taken once and kept, so a reload or an
 * admin's restart gives them the same block.
 */
async function paperSlotFor(test, registration) {
  if (test.questionDraw !== 'spread') return null;
  if (Number.isInteger(registration.paperSlot)) return registration.paperSlot;
  // One atomic increment: no queue needed, even with the whole class pressing Begin at once.
  const before = await tests().findOneAndUpdate(
    { code: test.code },
    { $inc: { paperSlots: 1 } },
    { returnDocument: 'before', projection: { paperSlots: 1 } }
  );
  return Number(before?.paperSlots) || 0;
}

/**
 * One test at a time per account: a paper cannot be started while the same
 * email still has an unsubmitted paper on another test that is not closed.
 * Submitting that one - or the admin closing it - frees them.
 */
async function refuseIfSittingAnotherTest(test, registration) {
  const open = await registrations().find(
    { collegeEmail: registration.collegeEmail, 'attempt.status': 'in_progress', testCode: { $ne: test.code } },
    { projection: { testCode: 1 } }
  ).toArray();
  const other = open.length
    ? await tests().findOne({ code: { $in: open.map((entry) => entry.testCode) }, isClosed: { $ne: true } }, { projection: { code: 1, title: 1 } })
    : null;
  if (other) {
    throw new PublicTestError(409, `You are still sitting "${other.title}" (${other.code}). Submit that test before starting another one.`, 'OTHER_TEST_IN_PROGRESS');
  }
}

/**
 * Made while the student waits for the test to start (their waiting page asks
 * for the test every few seconds - getTest), so that Begin - when the whole
 * class presses it at once - has less to do: their place in the question draw
 * is taken now, one student at a time, rather than by everyone in the same
 * instant, and their questions and option order are put in order now. The very
 * paper Begin would make (the same seed and place), kept on the server and
 * never sent: nothing of it reaches the page before they begin. Made again if
 * the paper changes before Start (paperBasis); never once the test has started.
 */
export async function preparePaper(test, registration) {
  if (!registration || registration.status !== 'approved' || registration.attempt || test.isStarted || test.isClosed) return;
  const basis = paperBasis(test, registration);
  if (registration.preparedBasis === basis || preparing >= PREPARING_AT_ONCE) return;
  preparing += 1;
  try {
    await makePaperAhead(test, registration, basis);
  } finally {
    preparing -= 1;
  }
}

/**
 * Papers made ahead at the same moment, at most. A whole class polling in the
 * same second - just after a bulk approval, say - is answered as before, and
 * the rest of their papers are made on a later poll (or at Begin): the
 * waiting page never queues behind this work.
 */
const PREPARING_AT_ONCE = 8;
let preparing = 0;

async function makePaperAhead(test, registration, basis) {
  const paperSlot = await paperSlotFor(test, registration);
  const slot = Number.isInteger(paperSlot) && paperSlot !== registration.paperSlot ? { paperSlot } : {};
  const keep = (fields) => (Object.keys(fields).length
    ? registrations().updateOne({ testCode: test.code, id: registration.id, attempt: null }, { $set: fields })
    : null);
  let preparedPaper;
  try {
    preparedPaper = { ...paperQuestions(test, { ...registration, paperSlot }, attemptSeed(test, registration)), preparedAt: now() };
  } catch (error) {
    // Not ready (a question bank still being written): the place in the draw
    // is kept all the same, so the next poll does not take another.
    await keep(slot);
    throw error;
  }
  await keep({ preparedPaper, preparedBasis: basis, ...slot });
  registration.preparedBasis = basis;
}

export async function startAttempt(req, code, raw = {}) {
  let test = await requireTestForStudent(req, code);
  // Pressing Begin the second the countdown ends may beat the scheduler.
  if (await startIfDue(test)) test = await requireTestForStudent(req, code);
  const registration = requireRegistration(req, test, true);
  if (test.isClosed) throw new PublicTestError(403, 'This test has been completed.');
  if (!test.isStarted) throw new PublicTestError(403, 'The administrator has not started this test yet.');
  if (registration.attempt) return studentView(test, registration, registration.attempt);

  // Nobody may pick up a fresh paper once time is up. The admin extends the
  // end time to let a latecomer in.
  if (isTimeOver(test)) {
    throw new PublicTestError(403, 'The test time is over, so a new attempt cannot be started. Ask your administrator to extend the time.');
  }

  // The paper made while they waited (preparePaper), if it is still this test's paper.
  const [prepared] = await Promise.all([
    registration.preparedBasis === paperBasis(test, registration) ? preparedPaperOf(test.code, registration.id) : null,
    refuseIfSittingAnotherTest(test, registration)
  ]);
  if (mustUsePrivateWindow(req, test) && raw.window === 'normal') {
    throw new PublicTestError(403, 'This test must be taken in an Incognito (private) window. Open the test link in one and sign in there.');
  }
  // Phones only, or laptops only: decided here from what the page and the
  // request say (domain/device.js), whatever the page itself showed. Kept
  // even when Begin is refused, so the teacher sees a refused device too;
  // otherwise kept by the same write that creates the paper.
  const device = deviceFromRequest(req, raw.device);
  const deviceWrite = deviceUpdate(registration, device, 'begin');
  const keepDevice = () => (deviceWrite ? recordDevice(test, registration, device, 'begin') : null);
  const deviceCheck = deviceVerdict(test, registration, device, { exempt: ownsTest(req, test) });
  if (!deviceCheck.allowed) {
    await keepDevice();
    throw new PublicTestError(403, deviceRefusal(deviceCheck.rule, device), 'DEVICE_NOT_ALLOWED');
  }
  const initialLocation = await verifyStartLocation(test, registration, raw).catch(async (error) => {
    await keepDevice();
    throw error;
  });
  // The administrator's explicit Start action is the gate. Registration times
  // organise the cohort; they are not a second block after Start.
  const paperSlot = await paperSlotFor(test, registration);
  const attempt = buildAttempt(null, test, { ...registration, paperSlot }, prepared && { questions: prepared.questions, answers: prepared.answers });
  // Private-window tests: what the student's browser looked like when they
  // began - see client/src/lib/private-mode.js. Shown on the dashboard.
  if (test.requirePrivateWindow) attempt.windowCheck = WINDOW_CHECKS.includes(raw.window) ? raw.window : 'unknown';
  // What they began on, kept with the paper: the dashboard shows it, and a
  // paper later opened on another kind of device is noted against it.
  attempt.device = { kind: device.kind, label: device.label };
  if (initialLocation) {
    attempt.locationChecks[initialLocation.status] = 1;
    attempt.locationChecks.last = { ...initialLocation, checkedAt: now(), trigger: 'start' };
    attempt.locationTrail = [locationReading(raw, initialLocation, attempt.locationChecks.last.checkedAt, 'start')];
  }
  // When the admin presses Start, every waiting student asks for a paper at
  // once, and a double tap sends two requests. Only the first may create the
  // paper; any other gets the one that won rather than replacing it.
  const created = await registrations().updateOne(
    { testCode: test.code, id: registration.id, attempt: null },
    {
      $set: { attempt, paperSlot, ...deviceWrite?.$set },
      $unset: { preparedPaper: '', preparedBasis: '' },
      ...(deviceWrite?.$push ? { $push: deviceWrite.$push } : {})
    }
  );
  if (created.matchedCount === 1) return studentView(test, registration, attempt);
  const existing = registrationFor(req, await requireTestForStudent(req, code));
  if (!existing?.attempt) throw new PublicTestError(409, 'Your paper could not be created. Try again.');
  return studentView(test, registration, existing.attempt);
}

export async function getAttempt(req, code, windowKind = null) {
  const test = await requireTestForStudent(req, code);
  const registration = requireRegistration(req, test, true);
  if (!registration.attempt) throw new PublicTestError(404, 'No test attempt has started yet.', 'NO_ATTEMPT');
  // Turned on while the paper was open: note which window it is continued in.
  if (test.requirePrivateWindow && !registration.attempt.windowCheck && registration.attempt.status === 'in_progress' && WINDOW_CHECKS.includes(windowKind)) {
    await updateAttemptWhere(test.code, registration.id, { id: registration.attempt.id, windowCheck: null }, { $set: { windowCheck: windowKind } });
    registration.attempt.windowCheck = windowKind;
  }
  const checked = await checkIn(test, registration, registration.attempt);
  const attempt = await enforceAwayLimit(test, registration, checked);
  return studentView(test, registration, attempt);
}

/**
 * Where this reading leaves the student. One stray fix never shuts a paper:
 * it takes `config.locationStrikes` readings in a row outside the venue. A
 * reading inside clears the run at once, and an inconclusive one (poor GPS,
 * or permission refused) leaves it where it was.
 */
export function venueVerdict(checks, status, atMs = Date.now()) {
  const streak = status === 'outOfRange' ? (checks?.outsideStreak || 0) + 1
    : status === 'inRange' ? 0
      : checks?.outsideStreak || 0;
  const wasOutside = Boolean(checks?.outsideSince);
  const outside = status === 'inRange' ? false : wasOutside || streak >= Math.max(1, Number(config.locationStrikes) || 2);
  return {
    outsideStreak: streak,
    outsideSince: outside ? (checks?.outsideSince || new Date(atMs)) : null,
    left: outside && !wasOutside,
    returned: !outside && wasOutside
  };
}

/**
 * True while the student must not be answering: the venue check says they are
 * away from it, or the paper has stopped reporting where it is. An admin's
 * location exception lifts it.
 */
export function venueClosed(test, registration, attempt, atMs = Date.now()) {
  if (!test.locationRequired || registration.locationOverride) return null;
  const checks = attempt?.locationChecks || {};
  if (checks.outsideSince) {
    return { reason: 'outside', since: checks.outsideSince, distanceMeters: checks.last?.distanceMeters ?? null };
  }
  const lastAt = checks.last?.checkedAt ? dateMs(checks.last.checkedAt) : dateMs(attempt?.startedAt);
  const graceMs = (Number(config.locationGraceSeconds) || 180) * 1000;
  if (Number.isFinite(lastAt) && atMs - lastAt > graceMs) {
    return { reason: 'silent', since: new Date(lastAt), distanceMeters: null };
  }
  return null;
}

export async function recordLocationCheck(req, attemptId, raw = {}) {
  const { test, registration, attempt } = await ownedAttempt(req, attemptId);
  if (!test.locationRequired) throw new PublicTestError(409, 'This test does not use venue monitoring.');
  if (attempt.status === 'submitted') throw new PublicTestError(409, 'This test attempt has already been submitted.');
  const trigger = ['question', 'timer', 'manual', 'blocked', 'submit'].includes(raw.trigger) ? raw.trigger : 'timer';
  const check = classifyLocationCheck(test, raw);
  const checkedAt = now();
  const verdict = registration.locationOverride
    ? { outsideStreak: 0, outsideSince: null, left: false, returned: false }
    : venueVerdict(attempt.locationChecks, check.status, checkedAt.getTime());
  const update = {
    $inc: { [`locationChecks.${check.status}`]: 1 },
    $set: {
      'locationChecks.last': { ...check, checkedAt, trigger },
      'locationChecks.outsideStreak': verdict.outsideStreak,
      'locationChecks.outsideSince': verdict.outsideSince
    },
    // Every reading, with where it was, for the teacher's Location tab.
    $push: { locationTrail: { $each: [locationReading(raw, check, checkedAt, trigger)], $slice: -LOCATION_TRAIL_LIMIT } }
  };
  // Leaving the venue and coming back both belong in the student's timeline.
  if (verdict.left || verdict.returned) {
    Object.assign(update.$push, logEvent({
      type: verdict.left ? 'venue_left' : 'venue_returned',
      createdAt: checkedAt,
      durationMs: verdict.returned && attempt.locationChecks?.outsideSince
        ? Math.max(0, checkedAt.getTime() - dateMs(attempt.locationChecks.outsideSince))
        : null,
      detail: check.distanceMeters === null ? null : `${Math.round(check.distanceMeters)} m`
    }));
  }
  // The tally the admin reads: how many times they left, and for how long.
  if (verdict.left) update.$inc['locationChecks.outsideCount'] = 1;
  if (verdict.returned && attempt.locationChecks?.outsideSince) {
    update.$inc['locationChecks.outsideMs'] = Math.max(0, checkedAt.getTime() - dateMs(attempt.locationChecks.outsideSince));
  }
  if (trigger === 'submit') update.$set['locationChecks.submit'] = { ...check, checkedAt };
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress' }, update);
  const stored = (await attemptContext(attempt.id))?.attempt || attempt;
  return {
    code: test.code,
    attemptId: attempt.id,
    locationChecks: stored.locationChecks || { inRange: 0, outOfRange: 0, inconclusive: 0, last: null },
    venue: venueClosed(test, registration, stored)
  };
}

function readAnswerPayload(question, assigned, raw) {
  if (question.manualGrading) {
    const answerText = String(raw.answerText ?? '').trim();
    if (answerText.length > 4000) throw new PublicTestError(400, 'Short answers must be 4,000 characters or fewer.');
    return { answerText, selectedOptions: [] };
  }
  const selected = Array.isArray(raw.selectedOptions) ? [...new Set(raw.selectedOptions.map(String))] : null;
  const allowed = (assigned.optionOrder || []).map(String);
  if (!selected || !selected.every((item) => allowed.includes(item)) || (question.type === 'mcq' && selected.length > 1)) {
    throw new PublicTestError(400, 'That answer selection is invalid.');
  }
  return { answerText: '', selectedOptions: selected };
}

/**
 * The single write path for a student's answer. Before the deadline any question
 * can be written and rewritten; after it (and a short grace) nothing is taken.
 * Under strict timing only the open question can be written.
 */
export async function saveAnswer(req, attemptId, raw) {
  const { test, registration, attempt } = await ownedAttempt(req, attemptId);
  return studentView(test, registration, await writeAnswer(test, registration, attempt, raw));
}

/**
 * Checks and saves one answer on an attempt already loaded, and returns the
 * attempt as it now stands - handed in, if it was submitted meanwhile. Moving
 * on under strict timing saves the answer on screen with this too, in the same
 * request, without loading the paper twice.
 */
async function writeAnswer(test, registration, owned, raw) {
  // Handed in (by the clock or the test's Close) while this device was
  // offline: only an answer held back by the connection may still come.
  if (owned.status === 'submitted') return (await takeLateAnswer(test, registration, owned, owned, raw)) || owned;
  const closed = venueClosed(test, registration, owned);
  if (closed) {
    throw new PublicTestError(403, closed.reason === 'outside'
      ? 'You are away from the test venue, so answers cannot be saved. Go back to the venue - the paper opens again by itself.'
      : 'Your location could not be checked. Allow location access and stay at the venue to carry on.', 'VENUE_CLOSED');
  }
  // Answers queued while offline arrive here first when the connection comes
  // back: the offline period is noted (never counted as leaving) first.
  const checked = await checkIn(test, registration, owned);
  requireWritableAttempt(checked);
  if (checked.status === 'submitted') return (await takeLateAnswer(test, registration, owned, checked, raw)) || checked;

  const questionId = asInteger(raw?.questionId, 1, Number.MAX_SAFE_INTEGER);
  const assigned = (checked.questions || []).find((entry) => entry.questionId === questionId);
  const question = assigned && (test.questions || []).find((entry) => entry.id === questionId);
  if (!question) throw new PublicTestError(404, 'That question is not on your paper.');

  if (test.isClosed || (!checked.pausedAt && !acceptsAttemptAnswers(test, checked))) {
    const late = await takeLateAnswer(test, registration, owned, checked, raw);
    if (late) return late;
    throw new PublicTestError(409, test.isClosed ? 'This test is closed, so answers can no longer be saved.' : TIME_OVER_MESSAGE, 'TIME_OVER');
  }
  if (checked.pausedAt) throw new PublicTestError(423, PAUSED_MESSAGE, 'PAUSED');
  // Strict timing: the paper as synced (the open question's clock may just
  // have started), so what is returned carries that too. A question that
  // closed while this device was offline may still take the answer made on it.
  let strictOpen = null;
  if (isStrict(test)) {
    try {
      strictOpen = await refuseUnlessOpenQuestion(test, registration, checked, questionId);
    } catch (error) {
      if (error?.code !== 'QUESTION_CLOSED') throw error;
      const latest = (await attemptContext(checked.id))?.attempt || checked;
      const late = await takeLateAnswer(test, registration, owned, latest, raw);
      if (late) return late;
      throw error;
    }
  }
  const strictIndex = strictOpen ? strictOpen.index : null;
  const attempt = strictOpen ? strictOpen.attempt : checked;

  const { answerText, selectedOptions } = readAnswerPayload(question, assigned, raw || {});
  const hasContent = question.manualGrading ? answerText.length > 0 : selectedOptions.length > 0;
  // Clearing a selection before the deadline returns the question to "blank",
  // so it stays answerable once the deadline passes.
  const answeredAt = hasContent ? now() : null;

  // The checks above ran on a read that may already be stale: the student may
  // have submitted from another tab, or been locked. Say that in the write
  // itself, so it lands only if it is still allowed.
  const expect = { id: attempt.id, status: 'in_progress', isLocked: { $ne: true } };
  // Strict timing: and only while this question is still the open one.
  if (strictIndex !== null) expect['strict.index'] = strictIndex;
  // The activity report's entry rides in the same write. A short answer
  // autosaves while it is typed, so saves close together make one entry.
  const lastLogged = (attempt.answerLog || []).at(-1);
  const stillTyping = question.manualGrading && hasContent && lastLogged?.questionId === questionId
    && !lastLogged.cleared && Date.now() - dateMs(lastLogged.at) < TYPING_MERGE_MS;
  const update = { $set: {
    'answers.$[ans].selectedOptions': selectedOptions,
    'answers.$[ans].answerText': answerText,
    'answers.$[ans].answeredAt': answeredAt
  } };
  if (stillTyping) {
    // Same entry, now holding the answer's latest length.
    update.$set[`answerLog.${attempt.answerLog.length - 1}.textLength`] = answerText.length;
  } else {
    update.$push = { answerLog: { $each: [{
      questionId, at: now(), selectedOptions, textLength: answerText.length, cleared: !hasContent
    }], $slice: -ANSWER_LOG_MAX } };
  }
  // Takes its turn with an edit rewriting this paper (see serializePaperWrite).
  const applied = await serializePaperWrite(test.code, registration.id,
    () => updateAttemptWhere(test.code, registration.id, expect, update, { arrayFilters: [{ 'ans.questionId': questionId }] }));

  if (!applied) {
    const latest = (await attemptContext(attempt.id))?.attempt;
    if (!latest) throw new PublicTestError(404, 'Test attempt not found.');
    if (latest.status === 'submitted') return latest;
    requireWritableAttempt(latest);
    if (strictIndex !== null && (latest.strict?.index ?? 0) !== strictIndex) {
      throw new PublicTestError(409, 'That question is closed — the paper has moved on to the next one.', 'QUESTION_CLOSED');
    }
    throw new PublicTestError(409, 'Your answer could not be saved. Try again.');
  }
  const answers = (attempt.answers || []).map((entry) => entry.questionId === questionId
    ? { ...entry, selectedOptions, answerText, answeredAt }
    : entry);
  return { ...attempt, answers };
}

/**
 * An answer made on the device before its time ran out but held there by a
 * lost connection (domain/late-answers.js): taken now, marked "arrived late"
 * with when the device says it was made and when it came, and on the
 * timeline for the teacher. Null when it may not be taken - the caller then
 * refuses it as before. `owned` is the paper as read before this request
 * checked in, which says when the server last heard from it.
 */
async function takeLateAnswer(test, registration, owned, current, raw) {
  const lateMs = (Number(config.lateAnswerMinutes) || 0) * 60_000;
  const questionId = asInteger(raw?.questionId, 1, Number.MAX_SAFE_INTEGER);
  const madeAtMs = Number(raw?.madeAt);
  if (!lateMs || !questionId || !Number.isFinite(madeAtMs) || !current) return null;
  // Marks made final are not changed by anything, this included.
  if (current.status === 'submitted' && resultsFrozen(test)) return null;
  if (current.status === 'in_progress' && (current.isLocked || current.pausedAt)) return null;
  const atMs = Date.now();
  const deadlineMs = lateAnswerDeadline(test, current, questionId, atMs, lateMs);
  if (deadlineMs === null) return null;
  const record = lateAnswerRecord({
    deadlineMs,
    madeAtMs,
    startedMs: dateMs(current.startedAt),
    lastSeenMs: owned.lastSeenAt ? dateMs(owned.lastSeenAt) : NaN,
    events: current.events || [],
    atMs
  });
  if (!record) return null;
  const assigned = (current.questions || []).find((entry) => entry.questionId === questionId);
  const question = assigned && (test.questions || []).find((entry) => entry.id === questionId);
  if (!question) return null;
  const { answerText, selectedOptions } = readAnswerPayload(question, assigned, raw);
  const stored = (current.answers || []).find((entry) => entry.questionId === questionId) || { questionId };
  // Sent again because the reply to the first send was lost: already taken.
  if (stored.late && stored.answerText === answerText && JSON.stringify(stored.selectedOptions || []) === JSON.stringify(selectedOptions)) return current;

  const hasContent = question.manualGrading ? answerText.length > 0 : selectedOptions.length > 0;
  const late = { madeAt: record.madeAt, arrivedAt: record.arrivedAt };
  const set = {
    'answers.$[ans].selectedOptions': selectedOptions,
    'answers.$[ans].answerText': answerText,
    'answers.$[ans].answeredAt': hasContent ? record.madeAt : null,
    'answers.$[ans].late': late
  };
  if (current.status === 'submitted') {
    // Marked as any handed-in answer is: worked out now, or left for the
    // teacher. A mark given by hand was for the answer this one replaces.
    const [graded] = gradeAnswers(test, { answers: [{ ...stored, selectedOptions, answerText, answeredAt: hasContent ? record.madeAt : null, isCorrect: null, marksOverride: false }] });
    set['answers.$[ans].isCorrect'] = graded.isCorrect;
    set['answers.$[ans].marksOverride'] = false;
  }
  const number = assigned.questionIndex + 1;
  const update = {
    $set: set,
    $inc: { 'integrity.lateAnswers': 1 },
    $push: {
      answerLog: { $each: [{ questionId, at: record.arrivedAt, selectedOptions, textLength: answerText.length, cleared: !hasContent, late }], $slice: -ANSWER_LOG_MAX },
      events: { $each: [{ type: 'late_answer', createdAt: record.arrivedAt, durationMs: null, detail: `Q${number}`, note: `Q${number}: made ${seconds(atMs - madeAtMs)} s before it arrived` }], $slice: -MAX_EVENTS }
    }
  };
  const expect = current.status === 'submitted'
    ? { id: current.id, status: 'submitted' }
    : { id: current.id, status: 'in_progress', isLocked: { $ne: true } };
  const applied = await serializePaperWrite(test.code, registration.id,
    () => updateAttemptWhere(test.code, registration.id, expect, update, { arrayFilters: [{ 'ans.questionId': questionId }] }));
  const latest = (await attemptContext(current.id))?.attempt;
  if (applied) return latest || current;
  // Handed in by the clock in the same moment: judged again on the paper as it now is.
  return latest && latest.status !== current.status ? takeLateAnswer(test, registration, owned, latest, raw) : null;
}

/**
 * Strict timing: only the open question takes answers, and only while its
 * time (plus a moment's grace for an answer already on its way) lasts.
 */
async function refuseUnlessOpenQuestion(test, registration, attempt, questionId) {
  const synced = await syncStrict(test, registration, attempt);
  const open = strictPaper(test, synced)[synced.strict?.index ?? 0];
  if (synced.status !== 'in_progress' || !open || open.questionId !== questionId) {
    throw new PublicTestError(409, 'That question is closed — the paper has moved on to the next one.', 'QUESTION_CLOSED');
  }
  const shownMs = effectiveShownMs(synced.strict);
  if (open.seconds > 0 && shownMs !== null && Date.now() > shownMs + open.seconds * 1000 + STRICT_GRACE_MS) {
    throw new PublicTestError(409, 'The time for this question is over.', 'QUESTION_CLOSED');
  }
  return { index: synced.strict?.index ?? 0, attempt: synced };
}

/**
 * Strict timing: the student is done with the open question - they pressed
 * Next, or its time ran out on their screen. `questionId` says which one
 * they meant, so a repeated or late request can never skip a question they
 * have not seen. Moving on from the last question submits the paper.
 * The answer still on screen may ride along in `answer`, so moving on is one
 * request rather than a save followed by a move.
 */
export async function nextQuestion(req, attemptId, raw = {}) {
  // The paper is loaded once for the whole move: when time runs out, the next
  // question waits on this request, and every read is a trip to the database.
  const { test, registration, attempt: owned } = await ownedAttempt(req, attemptId);
  if (!isStrict(test)) throw new PublicTestError(409, 'This test lets you move between questions freely.');
  if (owned.pausedAt && owned.status !== 'submitted') throw new PublicTestError(423, PAUSED_MESSAGE, 'PAUSED');
  let loaded = owned;
  if (raw.answer && typeof raw.answer === 'object') {
    try {
      loaded = await writeAnswer(test, registration, owned, { ...raw.answer, questionId: raw.questionId });
    } catch (error) {
      // Too late for this answer is not a reason to stay on the question.
      if (error?.code !== 'QUESTION_CLOSED' && error?.code !== 'TIME_OVER') throw error;
      loaded = (await attemptContext(owned.id))?.attempt || owned;
    }
  }
  const checked = await checkIn(test, registration, loaded);
  if (checked.status === 'submitted') return studentView(test, registration, checked);
  requireWritableAttempt(checked);
  const attempt = await syncStrict(test, registration, checked);
  if (attempt.status === 'submitted') return studentView(test, registration, attempt);

  const paper = strictPaper(test, attempt);
  const index = attempt.strict?.index ?? 0;
  const open = paper[index];
  // Already moved on (a double tap, or the clock got there first).
  if (!open || open.questionId !== asInteger(raw.questionId, 1, Number.MAX_SAFE_INTEGER)) return studentView(test, registration, attempt);

  const nextIndex = index + 1;
  const done = nextIndex >= paper.length;
  const closedAt = now();
  // The question's start as it stands - moved on by any time away from it.
  const shownAt = attempt.strict?.shownAt ? new Date(effectiveShownMs(attempt.strict, closedAt.getTime())) : closedAt;
  const endsMs = shownAt.getTime() + open.seconds * 1000;
  // Moving on while still counted as away (only ever a race): the next
  // question starts with its clock stopped too.
  const pausedSince = !done && attempt.strict?.pausedSince ? closedAt : null;
  // Without a Next button, a timed question closes only when its time is up
  // (a moment early is the student's clock running ahead, not a skip).
  if (!allowsNext(test) && open.seconds > 0 && closedAt.getTime() < endsMs - EARLY_TIMEOUT_MS) {
    throw new PublicTestError(409, 'This question stays open until its time runs out.', 'QUESTION_OPEN');
  }
  const how = open.seconds > 0 && closedAt.getTime() >= endsMs - EARLY_TIMEOUT_MS ? 'time' : 'next';
  const closing = { questionId: open.questionId, shownAt, closedAt, how };
  const applied = await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', 'strict.index': index }, {
    $set: { 'strict.index': nextIndex, 'strict.shownAt': done ? null : closedAt, 'strict.sentAt': done ? null : closedAt, 'strict.pausedSince': pausedSince },
    $push: { 'strict.log': closing }
  });
  // Written only over what was read, so when it lands the paper as it now
  // stands is known without reading it back. Otherwise something else moved
  // it (another tab, the clock): read what that left.
  const fresh = applied
    ? { ...attempt, strict: { ...attempt.strict, index: nextIndex, shownAt: done ? null : closedAt, sentAt: done ? null : closedAt, pausedSince, log: [...(attempt.strict?.log || []), closing] } }
    : (await attemptContext(attempt.id))?.attempt || attempt;
  if (applied && done) {
    return studentView(test, registration, await finalizeAttempt(test, registration, fresh, { by: how === 'time' ? 'time' : 'student' }));
  }
  return studentView(test, registration, fresh);
}


/**
 * The student's device says what it was sent is now on screen: the paper (on
 * each student's own time, `paper: true`) and, under strict timing, the open
 * question (`questionId`). Each clock still waiting for that starts now, but
 * no later than the shown grace after it was sent (domain/strict-timing.js
 * clockStartOnShown). So the seconds a weak connection spends delivering it
 * are given back, and holding this back gains a tampered page at most the
 * grace. Once per clock: a repeat, or one past the grace, changes nothing.
 */
export async function markShown(req, attemptId, raw = {}) {
  const { test, registration, attempt: owned } = await ownedAttempt(req, attemptId);
  if (owned.status !== 'in_progress' || owned.pausedAt) return studentView(test, registration, owned);
  const checked = await checkIn(test, registration, owned);
  if (checked.status !== 'in_progress' || checked.isLocked) return studentView(test, registration, checked);
  const atMs = Date.now();
  const expect = { id: checked.id, status: 'in_progress' };
  const set = {};
  if (raw.paper === true && checked.clockSentAt) {
    const start = clockStartOnShown(dateMs(checked.clockSentAt), dateMs(checked.startedAt), atMs, shownGraceMs(paperHasImages(test, checked)));
    if (start !== null) set.startedAt = new Date(start);
    set.clockSentAt = null;
    expect.clockSentAt = checked.clockSentAt;
  }
  const questionId = asInteger(raw.questionId, 1, Number.MAX_SAFE_INTEGER);
  const open = isStrict(test) && checked.strict ? strictPaper(test, checked)[checked.strict.index ?? 0] : null;
  if (open && questionId === open.questionId) {
    const shown = acknowledgeShown(checked.strict, atMs, shownGraceMs(questionHasImage(test, open.questionId)));
    if (shown) {
      set['strict.shownAt'] = shown.shownAt;
      set['strict.sentAt'] = null;
      expect['strict.index'] = checked.strict.index ?? 0;
      expect['strict.sentAt'] = checked.strict.sentAt;
    }
  }
  if (!Object.keys(set).length) return studentView(test, registration, checked);
  // Conditional on what was read, so two of these crossing land once.
  await updateAttemptWhere(test.code, registration.id, expect, { $set: set });
  return studentView(test, registration, (await attemptContext(checked.id))?.attempt || checked);
}

export async function submitAttemptForStudent(req, attemptId) {
  const { test, registration, attempt: owned } = await ownedAttempt(req, attemptId);
  if (owned.pausedAt && owned.status !== 'submitted') throw new PublicTestError(423, PAUSED_MESSAGE, 'PAUSED');
  const attempt = await checkIn(test, registration, owned);
  requireWritableAttempt(attempt);
  return studentView(test, registration, await finalizeAttempt(test, registration, attempt, { requireUnlocked: true }));
}

/* ------------------------------------------------ leaving and coming back */

const DAY_MS = 24 * 60 * 60 * 1000;
const seconds = (ms) => Math.ceil(ms / 1000);
const logEvent = (event) => ({ events: { $each: [event], $slice: -MAX_EVENTS } });

/**
 * Strict timing: the open question's clock stops while the student is away
 * from the paper or it is locked - its time counts only while they are on
 * it. The fields to write with the departure or the lock (none if it is
 * already stopped, or no question is open).
 */
function pauseQuestionClock(test, attempt, atDate) {
  return isStrict(test) && attempt?.strict?.shownAt && !attempt.strict.pausedSince ? { 'strict.pausedSince': atDate } : {};
}

/**
 * ...and starts again once they are back on it: no longer away, not locked.
 * The question's start moves on by the time it was stopped. Conditional on
 * the pause as read, so two requests arriving together move it once.
 */
async function resumeQuestionClock(test, registration, attempt) {
  const state = attempt?.strict;
  if (!state?.pausedSince || attempt.status !== 'in_progress' || attempt.isLocked || attempt.awaySince) return attempt;
  const shownAt = state.shownAt ? new Date(effectiveShownMs(state, Date.now())) : null;
  const applied = await updateAttemptWhere(test.code, registration.id,
    { id: attempt.id, status: 'in_progress', 'strict.index': state.index, 'strict.pausedSince': state.pausedSince },
    { $set: { 'strict.shownAt': shownAt, 'strict.pausedSince': null } });
  return applied ? { ...attempt, strict: { ...state, shownAt, pausedSince: null } } : (await attemptContext(attempt.id))?.attempt || attempt;
}

/**
 * Locks the attempt, once. Conditional, so two events crossing the limit at
 * the same moment produce one lock and one "locked" entry, not two.
 */
async function lockAttempt(test, registration, attempt, reason, counted = {}) {
  const lockedAt = now();
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', isLocked: { $ne: true } }, {
    $set: { isLocked: true, lockedAt, lockReason: reason, ...counted, ...pauseQuestionClock(test, attempt, lockedAt) },
    $inc: { 'integrity.lockCount': 1 },
    $push: logEvent({ type: 'attempt_locked', createdAt: lockedAt, durationMs: null, detail: reason })
  });
}

/**
 * Which limit, if any, the attempt is past right now: more exits than
 * allowed, or more time away IN TOTAL than allowed - counting an absence
 * still going on, so someone who never comes back cannot escape it.
 */
function limitReached(test, attempt, atMs) {
  const exitLimit = Number(test.fullscreenExitLimit) || 0;
  const awayLimitMs = (Number(test.fullscreenAbsenceLimitSeconds) || 0) * 1000;
  const exits = attempt.fullscreenExitCount || 0;
  if (exitLimit > 0 && exits > exitLimit) return `Left the test ${exits} times (${exitLimit} allowed).`;
  const ongoingMs = attempt.awaySince ? Math.max(0, atMs - dateMs(attempt.awaySince)) : 0;
  const totalMs = (attempt.fullscreenTotalAbsenceMs || 0) + ongoingMs;
  if (awayLimitMs > 0 && totalMs > awayLimitMs) {
    return `Away from the test for ${seconds(totalMs)} seconds in total (limit: ${test.fullscreenAbsenceLimitSeconds} seconds).`;
  }
  return null;
}

/**
 * Judges one absence - `key` names it - against the limits. Being past a
 * limit is a violation, counted once per absence however many events it
 * sends. With Lock on, the first "warnings before lock" violations only warn
 * and the next one locks (0 warnings: the first one locks). Without Lock -
 * or on a server with LOCK_ON_EXIT=false - nothing locks; the count is kept.
 */
async function enforceLimits(test, registration, attempt, key) {
  if (!key || !attempt || attempt.isLocked || attempt.status !== 'in_progress') return attempt;
  // "Record only" has no limits: every exit is already on the record.
  if (attempt.violationKey === key || violationActionOf(test) === 'record') return attempt;
  const reason = limitReached(test, attempt, Date.now());
  if (!reason) return attempt;
  const counted = { violationCount: (attempt.violationCount || 0) + 1, violationKey: key };
  if (locksOnViolation(test, config.lockOnExit) && counted.violationCount > warningsBeforeLockOf(test)) {
    await lockAttempt(test, registration, attempt, reason, counted);
  } else {
    await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', violationKey: attempt.violationKey ?? null }, {
      $set: counted,
      $push: logEvent({ type: 'attempt_warned', createdAt: now(), durationMs: null, detail: reason })
    });
  }
  return (await attemptContext(attempt.id))?.attempt || attempt;
}

/** One absence, however it is reported: when it began. */
const absenceKey = (since) => (since ? new Date(since).toISOString() : null);

/*
 * Leaving while typing an answer. On an iPhone a keyboard's own button - voice
 * typing on Gboard or SwiftKey, its settings - opens that keyboard's app, and
 * the test page is put away exactly as if the student had switched apps. The
 * page cannot tell the two apart, so the server decides on the way back, by
 * its own clock: back within KEYBOARD_GRACE_MS is a note for the teacher, not
 * a departure - at most KEYBOARD_NOTES_MAX times in a paper. Longer, or more
 * often, it counts like any other departure, from when it began.
 */
const KEYBOARD_GRACE_MS = 15_000;
const KEYBOARD_NOTES_MAX = 3;
const KEYBOARD_REASONS = ['tab_switch', 'focus_lost'];
const awayWhileTyping = (attempt) => Boolean(attempt?.awaySince && attempt.awayTyping);

/** The poll's view of a student who left and has not come back. */
const enforceAwayLimit = (test, registration, attempt) => {
  if (!attempt.awaySince) return attempt;
  // Maybe only their keyboard's app, still inside its grace: not judged yet.
  if (awayWhileTyping(attempt) && Date.now() - dateMs(attempt.awaySince) <= KEYBOARD_GRACE_MS) return attempt;
  return enforceLimits(test, registration, attempt, absenceKey(attempt.awaySince));
};

/**
 * Records one departure. A student is either present or away, so a second
 * "exit" while already away - Android fires both a visibility change and a
 * fullscreen exit for one press of Home - is the same departure, not another.
 * One that began while typing is only marked (the student shows as away) and
 * judged on the return - see KEYBOARD_GRACE_MS.
 */
async function recordLeave(test, registration, attempt, raw) {
  const reason = leaveReason(raw.detail);
  const createdAt = now();
  const typing = raw.typing === true && KEYBOARD_REASONS.includes(reason);
  const applied = await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', awaySince: null }, typing
    ? { $set: { awaySince: createdAt, awayTyping: reason, ...pauseQuestionClock(test, attempt, createdAt) } }
    : {
      $set: { awaySince: createdAt, awayTyping: null, ...pauseQuestionClock(test, attempt, createdAt) },
      $inc: { fullscreenExitCount: 1, 'integrity.leaveCount': 1, [`integrity.leaves.${reason}`]: 1 },
      $push: logEvent({ type: 'fullscreen_exit', createdAt, durationMs: null, detail: reason })
    });
  return applied && !typing ? absenceKey(createdAt) : null;
}

/**
 * The return from a departure that began while typing: a note if it was only
 * a moment, otherwise the departure and the return, counted as any other.
 */
async function recordTypingReturn(test, registration, attempt, raw, reported) {
  const reason = leaveReason(attempt.awayTyping);
  const createdAt = now();
  const sinceMs = dateMs(attempt.awaySince);
  const measured = raw.queued ? 0 : Math.max(0, createdAt.getTime() - sinceMs);
  const durationMs = Math.min(DAY_MS, Math.max(reported, measured));
  const notes = Number(attempt.integrity?.flags?.keyboard_app) || 0;
  const filter = { id: attempt.id, status: 'in_progress', awaySince: attempt.awaySince };
  if (durationMs <= KEYBOARD_GRACE_MS && notes < KEYBOARD_NOTES_MAX) {
    await updateAttemptWhere(test.code, registration.id, filter, {
      $set: { awaySince: null, awayTyping: null },
      $inc: { 'integrity.flags.keyboard_app': 1 },
      $push: logEvent({ type: 'integrity_flag', createdAt, durationMs, detail: 'keyboard_app', note: `back in ${seconds(durationMs)} s` })
    });
    return null;
  }
  const applied = await updateAttemptWhere(test.code, registration.id, filter, {
    $set: { awaySince: null, awayTyping: null },
    $inc: {
      fullscreenExitCount: 1, 'integrity.leaveCount': 1, [`integrity.leaves.${reason}`]: 1,
      fullscreenTotalAbsenceMs: durationMs, 'integrity.awayMs': durationMs
    },
    $max: { 'integrity.longestAwayMs': durationMs },
    $push: { events: { $each: [
      { type: 'fullscreen_exit', createdAt: attempt.awaySince, durationMs: null, detail: reason },
      { type: 'fullscreen_return', createdAt, durationMs, detail: reason }
    ], $slice: -MAX_EVENTS } }
  });
  return applied ? absenceKey(attempt.awaySince) : null;
}

/**
 * Records the return and how long the student was gone. The browser measures
 * that, but the server also knows when the departure arrived, and takes the
 * longer of the two so a tampered page cannot report "gone for 0 seconds".
 * An event that sat in the phone's offline queue is the exception: its
 * arrival time says nothing about when it happened.
 */
async function recordReturn(test, registration, attempt, raw) {
  const reported = asInteger(raw.durationMs, 0, DAY_MS);
  if (reported === null) throw new PublicTestError(400, 'Invalid fullscreen absence duration.');
  if (awayWhileTyping(attempt)) return recordTypingReturn(test, registration, attempt, raw, reported);
  const createdAt = now();
  const since = attempt.awaySince ? dateMs(attempt.awaySince) : null;
  const measured = since && !raw.queued ? Math.max(0, createdAt.getTime() - since) : 0;
  const durationMs = Math.min(DAY_MS, Math.max(reported, measured));
  const event = { type: 'fullscreen_return', createdAt, durationMs, detail: leaveReason(raw.detail) };
  // The admin revived the attempt while the student was still away: that
  // absence already caused the lock Revive forgave, so it goes on the record
  // but not against the limits again - or one absence would lock twice.
  const forgiven = !attempt.awaySince && createdAt.getTime() - durationMs < lastRevivedMs(attempt);

  const applied = await updateAttemptWhere(
    test.code,
    registration.id,
    { id: attempt.id, status: 'in_progress', awaySince: attempt.awaySince ?? null },
    {
      $set: { awaySince: null },
      $inc: { fullscreenTotalAbsenceMs: forgiven ? 0 : durationMs, 'integrity.awayMs': durationMs },
      $max: { 'integrity.longestAwayMs': durationMs },
      $push: logEvent(event)
    }
  );
  if (!applied || forgiven) return null;
  return absenceKey(attempt.awaySince) || `return:${createdAt.toISOString()}`;
}

/** When the attempt was last unlocked (by the admin's Revive or the lock wait), or 0. */
function lastRevivedMs(attempt) {
  const events = attempt.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'attempt_resumed') return dateMs(events[index].createdAt) || 0;
  }
  return 0;
}

/* ------------------------------------------- going offline, unlocking */

const OFFLINE_MS = () => (Number(config.offlineSeconds) || 60) * 1000;
const LOCK_WAIT_MS = () => (Number(config.lockWaitSeconds) || 0) * 1000;
// A silence that began before this server started is the server's own
// downtime, not the student leaving - see services/outage.js.
const SERVER_STARTED_MS = Date.now();
// "Last seen" is refreshed at most this often, to keep the class's writes down.
const SEEN_REFRESH_MS = 20_000;

/**
 * A locked attempt waits for the admin's Revive. Only where a lock wait is
 * configured (LOCK_WAIT_SECONDS) does it lift itself, and the limit counters
 * then start again from zero while the lifetime record keeps every exit.
 */
async function autoUnlock(test, registration, attempt) {
  if (!attempt.isLocked || test.isClosed) return attempt;
  // A lock waits for the admin unless a wait is configured; with locking off
  // - on the server, or for this test (switched to warn only) - a lock left
  // over from before is lifted now.
  if (locksOnViolation(test, config.lockOnExit) && (LOCK_WAIT_MS() <= 0 || !attempt.lockedAt || Date.now() - dateMs(attempt.lockedAt) < LOCK_WAIT_MS())) return attempt;
  const unlockedAt = now();
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress', isLocked: true, lockedAt: attempt.lockedAt ?? null }, {
    $set: {
      isLocked: false, lockedAt: null, lockReason: null,
      fullscreenExitCount: 0, fullscreenTotalAbsenceMs: 0, violationCount: 0, violationKey: null, awaySince: null, lastSeenAt: null
    },
    $push: logEvent({ type: 'attempt_resumed', createdAt: unlockedAt, durationMs: null, detail: 'automatic' })
  });
  return (await attemptContext(attempt.id))?.attempt || attempt;
}

/**
 * Every request from the paper checks in here. The paper polls every 30-40
 * seconds, so a silence longer than the offline limit means the student was
 * disconnected - Wi-Fi off, data off, laptop asleep. That is NOTED for the
 * teacher - from when, for how long - and never counts as leaving the test:
 * it is not an exit, adds no time away and cannot lock the paper. Whatever
 * the student did meanwhile (switched app, left fullscreen) the page still
 * saw, kept on the device, and reports now. A student already recorded as
 * away is not noted twice: their return says how long they were gone.
 */
async function checkIn(test, registration, attempt) {
  if (!attempt || attempt.status !== 'in_progress') return attempt;
  let current = await autoUnlock(test, registration, attempt);
  const atMs = Date.now();
  const lastSeenMs = current.lastSeenAt ? dateMs(current.lastSeenAt) : null;
  const gapMs = lastSeenMs === null ? 0 : atMs - lastSeenMs;

  if (lastSeenMs !== null && lastSeenMs >= SERVER_STARTED_MS && !justWokeUp() && gapMs > OFFLINE_MS() && !current.isLocked && !current.awaySince) {
    const durationMs = Math.min(DAY_MS, gapMs);
    await updateAttemptWhere(
      test.code,
      registration.id,
      { id: current.id, status: 'in_progress', lastSeenAt: current.lastSeenAt, awaySince: null },
      {
        $set: { lastSeenAt: new Date(atMs) },
        $inc: { 'integrity.offlineCount': 1, 'integrity.offlineMs': durationMs },
        $max: { 'integrity.longestOfflineMs': durationMs },
        // From when the server last heard from the paper, which it refreshes
        // only every SEEN_REFRESH_MS: so "about" this long.
        $push: logEvent({ type: 'connection_lost', createdAt: new Date(lastSeenMs), durationMs, detail: null })
      }
    );
    current = (await attemptContext(current.id))?.attempt || current;
    return resumeQuestionClock(test, registration, current);
  }

  // Also covers attempts started before "last seen" existed: they start
  // being watched from now, never penalised for the time before.
  if (lastSeenMs === null || gapMs > SEEN_REFRESH_MS) {
    const seenAt = new Date(atMs);
    await updateAttemptWhere(test.code, registration.id, { id: current.id, status: 'in_progress' }, { $set: { lastSeenAt: seenAt } });
    current = { ...current, lastSeenAt: seenAt };
  }
  // Heard from the paper, present and unlocked (after an unlock, say): the
  // question's clock runs again.
  return resumeQuestionClock(test, registration, current);
}

/** Noted for the report; never counts as leaving and never locks. */
async function recordFlag(test, registration, attempt, raw) {
  // A check taken out (see RETIRED_FLAGS), sent by a page still open from before: dropped.
  if (RETIRED_FLAGS.includes(raw.detail)) return null;
  const reason = flagReason(raw.detail);
  if (!reason) throw new PublicTestError(400, 'Invalid integrity event.');
  await updateAttemptWhere(test.code, registration.id, { id: attempt.id, status: 'in_progress' }, {
    $inc: { [`integrity.flags.${reason}`]: 1 },
    $push: logEvent({ type: 'integrity_flag', createdAt: now(), durationMs: null, detail: reason })
  });
  return null;
}

const presenceHandlers = { exit: recordLeave, return: recordReturn, flag: recordFlag };

/**
 * Every write here is an increment or a push on the stored attempt - never a
 * copy of the attempt written back - so an exit and a return, or two students'
 * events, arriving at the same moment cannot erase each other.
 */
export async function recordFullscreenEvent(req, attemptId, raw) {
  const handler = Object.hasOwn(presenceHandlers, raw?.type) ? presenceHandlers[raw.type] : null;
  if (!handler) throw new PublicTestError(400, 'Invalid fullscreen event.');
  if (raw.type === 'return' && asInteger(raw.durationMs, 0, DAY_MS) === null) {
    throw new PublicTestError(400, 'Invalid fullscreen absence duration.');
  }
  const { test, registration, attempt: owned } = await ownedAttempt(req, attemptId);
  if (owned.status === 'submitted') throw new PublicTestError(409, 'This test attempt has already been submitted.');
  // Paused by the teacher: no paper on screen, so leaving it is not watched.
  if (owned.pausedAt) return { attempt: await studentView(test, registration, owned) };
  const attempt = await checkIn(test, registration, owned);

  const absence = await handler(test, registration, attempt, raw);
  const stored = (await attemptContext(attempt.id))?.attempt || attempt;
  const judged = await enforceLimits(test, registration, stored, absence);
  return { attempt: await studentView(test, registration, await resumeQuestionClock(test, registration, judged)) };
}

/**
 * Sends a short run of exit/return/integrity events in one HTTP request. Events
 * are still applied in order through the same validated write path, so batching
 * changes transport cost rather than exam rules.
 */
export async function recordFullscreenEvents(req, attemptId, raw = {}) {
  const events = Array.isArray(raw.events) ? raw.events : null;
  if (!events?.length || events.length > 30) throw new PublicTestError(400, 'Send between 1 and 30 integrity events.');
  let result = null;
  for (const event of events) result = await recordFullscreenEvent(req, attemptId, event);
  return { ...result, processed: events.length };
}

function resultRelease(test) {
  if (test.resultReleaseMode === 'instant') return { released: true, message: '' };
  if (test.resultReleaseMode === 'after_quiz') {
    return test.isClosed
      ? { released: true, message: '' }
      : { released: false, message: 'Marks will be shown after the administrator closes the test.' };
  }
  return test.resultsReleasedAt
    ? { released: true, message: '' }
    : { released: false, message: 'Marks will be shown after the administrator releases them.' };
}

/**
 * How many short answers on this attempt still wait for the admin's mark.
 * One left blank waits for nothing (papers submitted before blanks were
 * scored 0 automatically still have it unmarked).
 */
export function pendingManualCount(test, attempt) {
  const manual = new Set((test.questions || []).filter((question) => question.manualGrading).map((question) => question.id));
  return (attempt?.answers || []).filter((answer) => manual.has(answer.questionId) && answer.isCorrect === null && answer.answeredAt).length;
}

/**
 * Whether a student may download their own answers with the answer key. Only
 * once the test is closed - after the deadline, classmates still sitting it
 * may answer the questions they left blank, so the key must not be out yet -
 * and the release policy allows marks. Unmarked short answers do not hold it
 * back: the sheet shows them as ungraded, and is rebuilt on every download.
 */
export const responsesAvailable = (test, attempt) => attempt?.status === 'submitted'
  && Boolean(test.isClosed) && resultRelease(test).released;

/**
 * What a student may see of a submitted attempt's marks: the score once the
 * test's release policy allows it and every short answer has been marked - or,
 * once the teacher has chosen to show marks before marking is finished
 * (releaseUnmarked), the score of what is marked so far, with the number of
 * short answers still unmarked. Shared by the results page and the student's
 * dashboard.
 */
export function resultSummary(test, attempt) {
  const release = resultRelease(test);
  if (!release.released) return { released: false, releaseMode: test.resultReleaseMode, message: release.message, canDownload: false };
  const canDownload = responsesAvailable(test, attempt);
  const pendingManual = pendingManualCount(test, attempt);
  if (pendingManual && !test.releaseUnmarked) {
    return {
      released: false, releaseMode: 'manual', message: 'Your short-answer response is awaiting manual marking.', pendingManual, canDownload
    };
  }
  return {
    released: true,
    releaseMode: test.resultReleaseMode,
    // Marks earned out of the paper's full marks; an unmarked answer counts nothing until it is marked.
    score: paperScore(attempt),
    totalMarks: paperMarks(test, attempt),
    // Worth of the short answers not marked yet: neither earned nor lost.
    pendingMarks: pendingMarks(test, attempt),
    answered: (attempt.answers || []).filter((answer) => answer.answeredAt).length,
    pendingManual,
    canDownload
  };
}

export async function attemptResult(req, attemptId) {
  const { test, attempt } = await ownedAttempt(req, attemptId);
  // An administrator can reset a submitted attempt. Returning the new attempt
  // lets an open results page send the student back into the reset test.
  // One reopened after a Close pressed by mistake goes straight back to the paper.
  if (attempt.status !== 'submitted') {
    return { ...attemptView(test, attempt), released: false, ...(attempt.reopenedAt ? { reopened: true } : { wasReset: true }) };
  }
  return { ...attemptView(test, attempt), ...resultSummary(test, attempt) };
}
