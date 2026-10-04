import QRCode from 'qrcode';
import { tests } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { hash, randomId } from '../lib/crypto.js';
import { now } from '../lib/time.js';
import { buildTest, timeMs } from '../domain/test-builder.js';
import { endModeOf, startModeOf } from '../domain/attempt-rules.js';
import { publicTest } from '../domain/presenters.js';
import { activeQuestions } from '../domain/question-bank.js';
import { qrSvg } from '../domain/qr-art.js';
import { adminEmail, invalidateTestCache, publicCode, requireOwnedTest, requireTest, testDocByCode, updateTest } from '../data/test-repository.js';

/** Where each active question sits in the stored bank array. */
const activeQuestionPositions = (test) => (test.questions || [])
  .map((question, position) => (question.retired ? null : position))
  .filter((position) => position !== null);

/** A start or end time the admin has just typed must still be ahead of us. */
export function refusePastTimes(input, raw) {
  const nowMs = Date.now() - 60_000;
  if (input.endMode === 'at' && raw.endsAt !== undefined && input.endsAt && input.endsAt.getTime() <= nowMs) {
    throw new PublicTestError(400, 'The end time has already passed. Choose a later end time.');
  }
}

export async function createTest(req, raw) {
  const input = buildTest(raw);
  refusePastTimes(input, raw);
  let code = publicCode();
  while (await testDocByCode(code, { withStudents: false })) code = publicCode();

  const doc = {
    code,
    title: input.title,
    instructions: input.instructions,
    startMode: input.startMode,
    opensAt: input.opensAt,
    endMode: input.endMode,
    untimed: input.untimed,
    endsAt: input.endsAt,
    durationMinutes: input.durationMinutes,
    windowSeconds: input.windowSeconds,
    questionCount: input.questionCount,
    questionMix: input.questionMix,
    estimatedSeconds: input.estimatedSeconds,
    // Retained for compatibility with existing local databases; admin access is
    // decided by `ownerEmail` and the signed-in session, never by this token.
    organizerTokenHash: hash(randomId()),
    ownerEmail: adminEmail(req),
    isStarted: false,
    startedAt: null,
    isClosed: false,
    closedAt: null,
    fullscreenExitLimit: input.fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds: input.fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: input.warningsBeforeLock,
    violationAction: input.violationAction,
    shuffleQuestions: input.shuffleQuestions,
    allowGuests: input.allowGuests,
    requirePrivateWindow: input.requirePrivateWindow,
    devices: input.devices,
    questionLayout: input.questionLayout,
    strictTiming: input.strictTiming,
    strictNext: input.strictNext,
    typeSeconds: input.typeSeconds,
    typeMarks: input.typeMarks,
    questionDraw: input.questionDraw,
    // Under the spread draw, the next student to begin takes this block.
    paperSlots: 0,
    locationRequired: input.locationRequired,
    locationLatitude: input.locationLatitude,
    locationLongitude: input.locationLongitude,
    locationRadiusMeters: input.locationRadiusMeters,
    resultReleaseMode: input.resultReleaseMode,
    resultsReleasedAt: null,
    createdAt: now(),
    // Short-answer questions are stored as `msq` with `manualGrading: true`.
    questions: input.questions.map((question, index) => ({
      id: index + 1,
      prompt: question.prompt,
      type: question.type === 'short' ? 'msq' : question.type,
      options: question.options,
      correctOptions: question.correctOptions,
      manualGrading: question.type === 'short',
      timeSeconds: question.timeSeconds,
      // Its own marks; null follows its type's (domain/marks.js).
      marks: question.marks ?? null
    }))
  };
  await tests().insertOne(doc);
  await invalidateTestCache(doc.code);
  return { test: publicTest(doc) };
}

/**
 * Fields that decide which questions a student's paper is drawn from. Once the
 * test starts, papers exist: changing these would leave the cohort sitting
 * different tests, and a restarted student would get a paper unlike everyone
 * else's. Everything not listed here is safe to change while the test runs.
 */
export const LOCKED_ONCE_STARTED = [
  'questionMix', 'questionCount', 'shuffleQuestions', 'opensAt', 'startMode', 'durationMinutes', 'strictTiming', 'typeSeconds', 'questionTimes',
  'questionDraw', 'strictNext'
];

const LOCKED_LABELS = {
  questionMix: 'questions per student',
  questionCount: 'questions per student',
  shuffleQuestions: 'question shuffling',
  opensAt: 'the start time',
  startMode: 'the start time',
  durationMinutes: 'the duration (use Extend time instead)',
  strictTiming: 'strict timing',
  typeSeconds: 'the question times',
  questionTimes: 'the question times',
  questionDraw: 'how questions are picked',
  strictNext: 'the Next button setting'
};

/**
 * Rewrites a test's setup. The payload is re-validated through `buildTest` with
 * the stored questions, so the end time is always recomputed from whatever
 * question mix is in force - including a mix changed right here.
 *
 * Once the test has started, only the fields that cannot change a paper stay
 * editable: title, instructions, end time, integrity limits, guests, venue and
 * marks visibility.
 */
export async function updateTestSettings(req, code, raw = {}) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  if (test.isClosed) throw new PublicTestError(409, 'This test is complete. Reset it before changing its setup.');
  if (test.isStarted) {
    const blocked = [...new Set(LOCKED_ONCE_STARTED
      .filter((field) => raw[field] !== undefined)
      .map((field) => LOCKED_LABELS[field]))];
    if (blocked.length) {
      throw new PublicTestError(409, `Students have already started, so ${blocked.join(' and ')} cannot change. Reset the test if you need to.`);
    }
  }

  // Once started, the start is history: keep it as it was.
  const startMode = test.isStarted ? startModeOf(test) : raw.startMode ?? startModeOf(test);
  const opensAt = test.isStarted ? test.opensAt : raw.opensAt !== undefined ? raw.opensAt : test.opensAt;
  const endMode = raw.endMode ?? (raw.untimed !== undefined ? (raw.untimed ? 'manual' : 'at') : endModeOf(test));
  // Papers already running keep the clock they began with: each student's own
  // time cannot become a shared end, or the other way round, mid-test.
  if (test.isStarted && (endMode === 'each') !== (endModeOf(test) === 'each')) {
    throw new PublicTestError(409, 'Students have already started, so whether each student gets their own time cannot change. Reset the test if you need to.');
  }
  // Carry the stored end time forward, unless the start has just been moved
  // past it and no new end time came with the edit - then let `buildTest` fall
  // back to start + estimate rather than failing on an impossible window. An
  // untimed test has no stored end; switching it to a set end time without
  // one falls back the same way.
  const storedEnd = test.endsAt ?? test.closesAt;
  const keepsStoredEnd = Boolean(storedEnd)
    && (!opensAt || timeMs(storedEnd, 'test end time') > timeMs(opensAt, 'test start time'));

  const source = {
    title: raw.title ?? test.title,
    instructions: raw.instructions ?? test.instructions,
    startMode,
    opensAt,
    endMode,
    durationMinutes: raw.durationMinutes ?? test.durationMinutes,
    endsAt: raw.endsAt ?? (keepsStoredEnd ? storedEnd : undefined),
    fullscreenExitLimit: raw.fullscreenExitLimit ?? test.fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds: raw.fullscreenAbsenceLimitSeconds ?? test.fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: raw.warningsBeforeLock ?? test.warningsBeforeLock,
    violationAction: raw.violationAction ?? test.violationAction,
    shuffleQuestions: raw.shuffleQuestions ?? test.shuffleQuestions,
    allowGuests: raw.allowGuests ?? test.allowGuests,
    // Tests made before this setting existed keep behaving as they did.
    requirePrivateWindow: raw.requirePrivateWindow ?? test.requirePrivateWindow ?? false,
    devices: raw.devices ?? test.devices,
    questionLayout: raw.questionLayout ?? test.questionLayout,
    strictTiming: raw.strictTiming ?? test.strictTiming === true,
    strictNext: raw.strictNext ?? test.strictNext !== false,
    typeSeconds: raw.typeSeconds ?? test.typeSeconds,
    // Marks are set with the questions (Edit test), not here: kept as they are.
    typeMarks: test.typeMarks,
    questionDraw: raw.questionDraw ?? test.questionDraw,
    locationRequired: raw.locationRequired ?? test.locationRequired,
    locationRadiusMeters: raw.locationRadiusMeters ?? test.locationRadiusMeters,
    locationLatitude: raw.locationLatitude ?? test.locationLatitude,
    locationLongitude: raw.locationLongitude ?? test.locationLongitude,
    resultReleaseMode: raw.resultReleaseMode ?? test.resultReleaseMode,
    // `questionTimes` sets questions' own times by id: { "3": 90, "5": null }.
    questions: activeQuestions(test).map((question) => ({
      prompt: question.prompt,
      type: question.manualGrading ? 'short' : question.type,
      options: question.options,
      correctOptions: question.correctOptions,
      marks: question.marks ?? null,
      timeSeconds: raw.questionTimes && Object.hasOwn(raw.questionTimes, String(question.id))
        ? raw.questionTimes[String(question.id)]
        : question.timeSeconds ?? null
    }))
  };
  if (raw.questionMix !== undefined) source.questionMix = raw.questionMix;
  else if (raw.questionCount !== undefined) source.questionCount = raw.questionCount;
  else if (test.questionMix) source.questionMix = test.questionMix;
  else source.questionCount = test.questionCount;

  const input = buildTest(source);
  refusePastTimes(input, raw);
  // A running duration test already has its real end time (and any extension):
  // it stays unless the admin changed how the test ends.
  let { endsAt } = input;
  if (test.isStarted && input.endMode === 'duration') endsAt = storedEnd ?? endsAt;
  await updateTest(test.code, {
    $set: {
      title: input.title,
      instructions: input.instructions,
      updatedAt: now(),
      startMode: input.startMode,
      opensAt: input.opensAt,
      endMode: input.endMode,
      untimed: input.untimed,
      endsAt,
      durationMinutes: input.durationMinutes,
      windowSeconds: input.windowSeconds,
      estimatedSeconds: input.estimatedSeconds,
      questionCount: input.questionCount,
      questionMix: input.questionMix,
      fullscreenExitLimit: input.fullscreenExitLimit,
      fullscreenAbsenceLimitSeconds: input.fullscreenAbsenceLimitSeconds,
      warningsBeforeLock: input.warningsBeforeLock,
      violationAction: input.violationAction,
      shuffleQuestions: input.shuffleQuestions,
      allowGuests: input.allowGuests,
      requirePrivateWindow: input.requirePrivateWindow,
      devices: input.devices,
      questionLayout: input.questionLayout,
      strictTiming: input.strictTiming,
      strictNext: input.strictNext,
      typeSeconds: input.typeSeconds,
      questionDraw: input.questionDraw,
      // Each active question's own time, written at its real place in the bank
      // (retired versions sit in the same array).
      ...Object.fromEntries(activeQuestionPositions(test).map((position, index) => [`questions.${position}.timeSeconds`, input.questions[index].timeSeconds])),
      locationRequired: input.locationRequired,
      locationRadiusMeters: input.locationRadiusMeters,
      locationLatitude: input.locationLatitude,
      locationLongitude: input.locationLongitude,
      resultReleaseMode: input.resultReleaseMode
    }
  });
  // The settings dialog only needs the settings it just saved. Rebuilding the
  // whole registration dashboard here made a one-field time extension wait
  // behind every student's row and answer history.
  const updated = await requireOwnedTest(req, code, { withStudents: false });
  return { ok: true, code: updated.code, test: publicTest(updated) };
}

export async function testQrSvg(code, joinUrl) {
  await requireTest(code, { withStudents: false });
  return qrSvg(QRCode.create(joinUrl, { errorCorrectionLevel: 'M' }).modules, 320);
}
