import { currentMs, dateMs, iso } from '../lib/time.js';
import { config } from '../config.js';
import { describeEvent, integrityRecord, integritySummary, keptEvents, locksOnViolation, violationActionOf, warningsBeforeLockOf, warnsOnViolation } from './integrity.js';
import { activityLog } from './activity.js';
import { activeQuestions, questionPoolCounts, questionType } from './question-bank.js';
import { attemptDeadlineMs, endModeOf, isAnswered, isAttemptTimeOver, isPerStudent, isTimeOver, isUntimed, startModeOf } from './attempt-rules.js';
import { DEFAULT_TYPE_SECONDS, allowsNext, isStrict, openQuestionEndsAt, questionSeconds, strictPaper } from './strict-timing.js';
import { DEVICE_NOTES, deviceRuleOf, kindWord } from './device.js';
import { DEFAULT_TYPE_MARKS, earnedMarks, paperMarks, paperScore, questionMarks, roundMarks } from './marks.js';
import { imageView, paperHasImages, questionHasImage, shownGraceMs } from './question-image.js';

const lockWaitMs = () => (Number(config.lockWaitSeconds) || 0) * 1000;
/**
 * A clock sent at `sentAt` still waits for the device to say it is on screen
 * (attempt-service markShown) - until the shown grace is up, when saying so
 * could no longer move it.
 */
/** Sent, and still within the wait for "on screen" - longer where a picture has to arrive (domain/question-image.js). */
const waitsForShown = (sentAt, atMs, withImage = false) => Boolean(sentAt) && atMs < dateMs(sentAt) + shownGraceMs(withImage);

/** How long a submitted paper took, start to submit; null until it is submitted. */
export const timeTakenSeconds = (attempt) => (attempt?.startedAt && attempt?.submittedAt
  ? Math.max(0, Math.round((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 1000))
  : null);

/** The test as anyone may see it. Never includes question text or answer keys. */
export function publicTest(doc) {
  return {
    code: doc.code,
    title: doc.title,
    instructions: doc.instructions,
    startMode: startModeOf(doc),
    opensAt: iso(doc.opensAt),
    endMode: endModeOf(doc),
    durationMinutes: doc.durationMinutes ?? null,
    untimed: isUntimed(doc),
    endsAt: isUntimed(doc) ? null : iso(doc.endsAt ?? doc.closesAt),
    questionCount: doc.questionCount,
    questionMix: doc.questionMix || null,
    questionPool: questionPoolCounts(activeQuestions(doc)),
    estimatedSeconds: doc.estimatedSeconds ?? doc.overallSeconds,
    fullscreenExitLimit: doc.fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds: doc.fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: warningsBeforeLockOf(doc),
    violationAction: violationActionOf(doc),
    // Whether going past the limits locks here: the test's choice, and the server's switch.
    locksOnViolation: locksOnViolation(doc, config.lockOnExit),
    warnsOnViolation: warnsOnViolation(doc),
    shuffleQuestions: Boolean(doc.shuffleQuestions),
    allowGuests: Boolean(doc.allowGuests),
    requirePrivateWindow: Boolean(doc.requirePrivateWindow),
    // 'any', 'phone' (and tablets) or 'laptop' (and desktops): see domain/device.js.
    devices: deviceRuleOf(doc),
    questionLayout: doc.questionLayout === 'all' ? 'all' : 'one',
    strictTiming: isStrict(doc),
    // One way only, and whether any question has a timer - with none, it is just "no going back".
    strictTimed: isStrict(doc) && activeQuestions(doc).some((question) => questionSeconds(doc, question) > 0),
    strictNext: allowsNext(doc),
    questionDraw: doc.questionDraw === 'spread' ? 'spread' : 'random',
    typeSeconds: doc.typeSeconds || DEFAULT_TYPE_SECONDS,
    // What each question type is worth unless a question says otherwise (domain/marks.js).
    typeMarks: { ...DEFAULT_TYPE_MARKS, ...(doc.typeMarks || {}) },
    locationRequired: Boolean(doc.locationRequired),
    locationRadiusMeters: doc.locationRadiusMeters || null,
    resultReleaseMode: doc.resultReleaseMode,
    resultsReleasedAt: iso(doc.resultsReleasedAt),
    // Marks shown before marking is finished, unmarked answers as not marked yet.
    releaseUnmarked: Boolean(doc.releaseUnmarked),
    // Marks final: nothing changes them until unfrozen (domain/freeze.js).
    resultsFrozenAt: iso(doc.resultsFrozenAt),
    isStarted: Boolean(doc.isStarted),
    startedAt: iso(doc.startedAt),
    isClosed: Boolean(doc.isClosed),
    closedAt: iso(doc.closedAt),
    closedAutomatically: Boolean(doc.closedAutomatically),
    // Server outages during this run, newest last (see services/outage.js).
    outages: (doc.outages || []).slice(-3).map((outage) => ({ from: iso(outage.from), ms: outage.ms, extended: Boolean(outage.extended) }))
  };
}

const answerFor = (attempt, questionId) => (attempt.answers || []).find((answer) => answer.questionId === questionId);

/**
 * One question as it appears on the student's paper, carrying its own answer and
 * its own lock state so the client never has to re-derive the end-time policy.
 */
function paperQuestion(test, attempt, assigned, atMs) {
  const question = (test.questions || []).find((entry) => entry.id === assigned.questionId);
  if (!question) return null;
  const answer = answerFor(attempt, question.id) || {};
  const order = (assigned.optionOrder || []).map(String);
  return {
    index: assigned.questionIndex,
    number: assigned.questionIndex + 1,
    id: question.id,
    type: questionType(question),
    prompt: question.prompt,
    // Its picture, if it has one: where to fetch it and its size, so the page keeps room for it.
    image: imageView(question.image),
    options: order
      .map((id) => ({ id, text: question.options[Number(id)] }))
      .filter((option) => option.text !== undefined),
    selectedOptions: (answer.selectedOptions || []).map(String),
    answerText: answer.answerText || '',
    answered: isAnswered(answer),
    // Once time is up nothing on the paper changes: it is being submitted.
    locked: isAttemptTimeOver(test, attempt, atMs),
    timeSeconds: isStrict(test) ? questionSeconds(test, question) || null : null,
    // What it is worth, shown on the paper.
    marks: questionMarks(test, question)
  };
}

/**
 * Strict timing sends only the open question - never the ones ahead, which
 * would let a student read the paper in advance, nor the ones behind, which
 * are closed. The rest of the paper is described by counts alone.
 */
function strictView(test, attempt, atMs) {
  const state = attempt.strict || { index: 0, shownAt: null, log: [] };
  const paper = strictPaper(test, attempt);
  const open = paper[state.index];
  const assigned = open && (attempt.questions || []).find((entry) => entry.questionId === open.questionId);
  const endsAt = openQuestionEndsAt(test, attempt, atMs);
  // What the rest of the paper can still take: this question's time left plus
  // every later question's time. Questions without a timer add nothing, so
  // then it is "at least".
  const later = paper.slice(state.index + 1);
  const laterSeconds = later.reduce((total, entry) => total + (entry.seconds || 0), 0);
  const untimedLeft = later.filter((entry) => !entry.seconds).length + (open && !open.seconds ? 1 : 0);
  return {
    strict: {
      index: state.index,
      total: paper.length,
      questionEndsAt: iso(endsAt),
      // Stopped while the student is away (or locked): the times above are then
      // as if they came back now, and the page holds them still.
      questionPaused: Boolean(state.pausedSince),
      // Sent, and its clock waits for this device to say it is on screen.
      shownPending: Boolean(open) && Boolean(state.shownAt) && waitsForShown(state.sentAt, atMs, questionHasImage(test, open.questionId)),
      paperEndsAt: endsAt ? iso(new Date(endsAt.getTime() + laterSeconds * 1000)) : null,
      laterSeconds,
      untimedLeft,
      questionSeconds: open?.seconds || null,
      // Next is offered when the admin allows it, and always on a question
      // with no timer - otherwise the student could never leave it.
      canMoveOn: allowsNext(test) || !open?.seconds,
      // For the dots along the top: done, and whether the clock closed it.
      closed: (state.log || []).map((entry) => ({ how: entry.how }))
    },
    questions: assigned ? [paperQuestion(test, attempt, assigned, atMs)].filter(Boolean) : []
  };
}

/**
 * The attempt as the student sees it. A submitted or locked attempt returns the
 * summary only - question text is withheld once the paper is out of their hands.
 */
export function attemptView(test, attempt, atMs = currentMs(), { venue = null } = {}) {
  const answers = attempt.answers || [];
  const summary = {
    id: attempt.id,
    code: test.code,
    title: test.title,
    status: attempt.status,
    startedAt: iso(attempt.startedAt),
    submittedAt: iso(attempt.submittedAt),
    submittedBy: attempt.submittedBy || null,
    untimed: isUntimed(test),
    // Each student's own time: so many minutes from their own Begin, not one end for everybody.
    ownTime: isPerStudent(test),
    durationMinutes: isPerStudent(test) ? Number(test.durationMinutes) || null : null,
    // This student's own end: the test's (or their own time's), plus any time given back.
    deadlineAt: isUntimed(test) || !Number.isFinite(attemptDeadlineMs(test, attempt, atMs)) ? null : new Date(attemptDeadlineMs(test, attempt, atMs)).toISOString(),
    serverTime: new Date(atMs).toISOString(),
    timeOver: isAttemptTimeOver(test, attempt, atMs),
    // Each student's own time: the paper's clock waits for this device to say it is on screen.
    clockPending: attempt.status === 'in_progress' && waitsForShown(attempt.clockSentAt, atMs, paperHasImages(test, attempt)),
    // Paused by the teacher: no paper on screen, no answers taken, and the clock stopped.
    paused: Boolean(attempt.pausedAt),
    totalQuestions: attempt.questions?.length || test.questionCount,
    totalMarks: paperMarks(test, attempt),
    questionLayout: test.questionLayout === 'all' ? 'all' : 'one',
    answeredQuestionCount: answers.filter(isAnswered).length,
    isLocked: Boolean(attempt.isLocked),
    lockReason: attempt.lockReason || null,
    // Null when the lock waits for the administrator rather than a clock.
    unlocksAt: attempt.isLocked && attempt.lockedAt && lockWaitMs() > 0
      ? new Date(dateMs(attempt.lockedAt) + lockWaitMs()).toISOString()
      : null,
    // The lifetime record, for the student's own result page.
    timesLeft: integrityRecord(attempt).leaveCount,
    timesLocked: integrityRecord(attempt).lockCount,
    timeAwayMs: integrityRecord(attempt).awayMs,
    fullscreenExitCount: attempt.fullscreenExitCount || 0,
    fullscreenTotalAbsenceMs: attempt.fullscreenTotalAbsenceMs || 0,
    locationRequired: Boolean(test.locationRequired),
    locationRadiusMeters: test.locationRequired ? Number(test.locationRadiusMeters) || null : null,
    locationChecks: attempt.locationChecks || { inRange: 0, outOfRange: 0, inconclusive: 0, last: null },
    // Set while the venue check says the student is away from the venue, or
    // the paper has stopped saying where it is. Answers are refused until it clears.
    venueClosed: venue ? { reason: venue.reason, distanceMeters: venue.distanceMeters, since: iso(venue.since) } : null,
    // What the student is allowed before their attempt locks.
    fullscreenExitLimit: Number(test.fullscreenExitLimit) || 0,
    fullscreenAbsenceLimitSeconds: Number(test.fullscreenAbsenceLimitSeconds) || 0,
    // False when the test only warns: the paper then says so instead of threatening a lock.
    locksOnViolation: locksOnViolation(test, config.lockOnExit),
    // Whether each exit shows the student a numbered warning.
    warnsOnViolation: warnsOnViolation(test),
    violationAction: violationActionOf(test),
    // Read on every poll, so turning it on during the test reaches open papers.
    requirePrivateWindow: Boolean(test.requirePrivateWindow),
    // Phones only or laptops only, read on every poll too: a change reaches the
    // paper, which asks again whether this device may sit it.
    devices: deviceRuleOf(test),
    // With Lock on: warnings given so far, and how many come before the lock.
    violationCount: attempt.violationCount || 0,
    warningsBeforeLock: warningsBeforeLockOf(test),
    isAway: Boolean(attempt.awaySince),
    // Per-question timing: its clock is paused while the paper is locked or left.
    strictTiming: isStrict(test)
  };
  if (attempt.status === 'submitted' || attempt.isLocked || attempt.pausedAt) return summary;
  if (isStrict(test)) return { ...summary, ...strictView(test, attempt, atMs) };
  return {
    ...summary,
    questions: [...(attempt.questions || [])]
      .sort((left, right) => left.questionIndex - right.questionIndex)
      .map((assigned) => paperQuestion(test, attempt, assigned, atMs))
      .filter(Boolean)
  };
}

const optionText = (question, optionIds) => {
  const text = (optionIds || []).map((id) => question.options?.[Number(id)]).filter((value) => value !== undefined);
  return text.length ? text.join(' • ') : 'No answer';
};

function strictTimes(test, attempt, questionId) {
  if (!isStrict(test)) return {};
  const entry = (attempt.strict?.log || []).find((item) => item.questionId === questionId);
  const question = (test.questions || []).find((item) => item.id === questionId);
  return {
    timeAllowedSeconds: questionSeconds(test, question) || null,
    timeSpentSeconds: entry ? Math.max(0, Math.round((dateMs(entry.closedAt) - dateMs(entry.shownAt)) / 1000)) : null,
    timedOut: entry ? entry.how === 'time' : null
  };
}

/** Per-question detail for the admin analysis view and the Excel export. */
export function responseDetails(test, registration) {
  const attempt = registration.attempt;
  if (!attempt) return [];
  const questions = new Map((test.questions || []).map((question) => [question.id, question]));
  const answers = new Map((attempt.answers || []).map((answer) => [answer.questionId, answer]));
  return [...(attempt.questions || [])]
    .sort((left, right) => left.questionIndex - right.questionIndex)
    .map((assigned) => {
      const question = questions.get(assigned.questionId);
      if (!question) return null;
      const answer = answers.get(assigned.questionId) || {};
      const manualGrading = Boolean(question.manualGrading);
      const maxMarks = questionMarks(test, question);
      const marks = earnedMarks(answer);
      return {
        questionId: question.id,
        questionNumber: assigned.questionIndex + 1,
        type: questionType(question),
        prompt: question.prompt,
        image: imageView(question.image),
        selectedAnswer: manualGrading ? (answer.answerText || 'No answer') : optionText(question, answer.selectedOptions),
        correctAnswer: manualGrading ? '' : optionText(question, question.correctOptions),
        answeredAt: iso(answer.answeredAt),
        answered: isAnswered(answer),
        // Marks earned (null while unmarked) out of what the question is worth.
        marks,
        maxMarks,
        // Right means full marks; a short answer can also earn part of them.
        isCorrect: marks === null ? null : marks >= maxMarks,
        partial: marks !== null && marks > 0 && marks < maxMarks,
        // A choice answer's mark the teacher changed by hand (domain/marks.js automaticMarks).
        overridden: Boolean(answer.marksOverride),
        manualGrading,
        // Made in time on the device but held there by a lost connection
        // (domain/late-answers.js): when it says it was made, and when it came.
        late: answer.late ? { madeAt: iso(answer.late.madeAt), arrivedAt: iso(answer.late.arrivedAt) } : null,
        // Strict timing: how long the question was open, and whether its time ran out.
        ...strictTimes(test, attempt, question.id)
      };
    })
    .filter(Boolean);
}

/** Where a paper was, reading by reading, oldest first - for its teacher only. */
export const locationTrailOf = (attempt) => (attempt?.locationTrail || []).map((reading) => ({ ...reading, at: iso(reading.at) }));

/**
 * One student's own paper for their response download: every question with
 * their answer, the key and the mark, with unmarked short answers left null.
 */
export function studentResponseData(test, registration) {
  const answers = responseDetails(test, registration);
  const attempt = registration.attempt;
  return {
    test: {
      code: test.code,
      title: test.title,
      startsAt: iso(test.startedAt || test.opensAt),
      endsAt: isUntimed(test) ? null : iso(test.endsAt || test.closesAt),
      closedAt: iso(test.closedAt)
    },
    student: { name: registration.fullName, email: registration.collegeEmail, sapId: registration.sapId },
    registration: {
      status: registration.status,
      requestedAt: iso(registration.requestedAt),
      decidedAt: iso(registration.decidedAt)
    },
    attempt: {
      status: attempt?.status || null,
      startedAt: iso(attempt?.startedAt),
      submittedAt: iso(attempt?.submittedAt),
      submittedBy: attempt?.submittedBy || null,
      locked: Boolean(attempt?.isLocked),
      lockReason: attempt?.lockReason || null
    },
    // These are the same records that faculty sees in the paper analysis.
    // Keeping them with the response data means a user-manager download is a
    // complete audit trail, rather than a score sheet with the evidence lost.
    integrity: attempt ? {
      ...integritySummary(attempt),
      events: keptEvents(attempt.events).map((event) => ({
        ...describeEvent(event),
        // `describeEvent` intentionally hides most raw detail in the UI; the
        // exported audit needs the original recorded value as well.
        detail: event.detail || null,
        createdAt: iso(event.createdAt)
      }))
    } : null,
    activity: activityLog(test, registration),
    location: attempt?.locationChecks || null,
    // Written only into the audit download (spreadsheet.js), never a student's own.
    locationTrail: locationTrailOf(attempt),
    // The device the paper was begun on and the one last seen (domain/device.js).
    device: registration.device ? {
      last: `${kindWord(registration.device.kind)} (${registration.device.label || 'unknown browser'})`,
      began: attempt?.device ? `${kindWord(attempt.device.kind)} (${attempt.device.label || 'unknown browser'})` : null,
      notes: (registration.device.notes || []).map((note) => DEVICE_NOTES[note]).filter(Boolean),
      exception: Boolean(registration.deviceOverride)
    } : null,
    answers,
    summary: {
      total: answers.length,
      score: roundMarks(answers.reduce((total, answer) => total + (answer.marks || 0), 0)),
      totalMarks: roundMarks(answers.reduce((total, answer) => total + answer.maxMarks, 0)),
      correct: answers.filter((answer) => answer.isCorrect === true).length,
      partial: answers.filter((answer) => answer.partial).length,
      incorrect: answers.filter((answer) => answer.answered && answer.isCorrect === false && !answer.partial).length,
      unanswered: answers.filter((answer) => !answer.answered).length,
      ungraded: answers.filter((answer) => answer.manualGrading && answer.answered && answer.isCorrect === null).length
    }
  };
}

/** A paper's marks: earned, out of its full marks (domain/marks.js); its questions and how many were answered; and how many answers wait for a mark. */
export function scoreSummary(registration, test) {
  const answers = registration.attempt?.answers || [];
  return {
    total: paperMarks(test, registration.attempt),
    questions: registration.attempt?.questions?.length || answers.length,
    answered: answers.filter(isAnswered).length,
    score: paperScore(registration.attempt),
    manualTotal: answers.filter((answer) => answer.isCorrect === null).length
  };
}
