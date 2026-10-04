import { tidyLines } from './rich-text.js';
import { DEVICE_RULES } from './device.js';
import { PublicTestError } from '../lib/errors.js';
import { asInteger } from '../lib/crypto.js';
import { dateMs } from '../lib/time.js';
import { ESTIMATE_SECONDS, QUESTION_DRAWS, QUESTION_LAYOUTS, estimateSeconds, questionMixCount, questionMixFrom } from './question-bank.js';
import { buildTypeSeconds, secondsOrNull, strictEstimateSeconds } from './strict-timing.js';
import { buildTypeMarks, marksField } from './marks.js';
import { END_MODES } from './attempt-rules.js';

export const RESULT_RELEASE_MODES = ['instant', 'after_quiz', 'admin'];

export function cleanText(value, label, min, max) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) throw new PublicTestError(400, `${label} must be between ${min} and ${max} characters.`);
  return text;
}

export function coordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

export const isSapId = (value) => /^\d{9}$/.test(String(value ?? ''));

export function normalizeSapId(value) {
  const sapId = String(value ?? '').trim();
  if (!isSapId(sapId)) throw new PublicTestError(400, 'SAP ID must contain exactly 9 digits, for example 500123456.');
  return sapId;
}

export const MAX_TEST_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * Accepts a time as an ISO string from the browser or as the stored Date when
 * only other settings are being edited. Going through `String(date)` would
 * silently drop the milliseconds and shift the calculated window.
 */
export function timeMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : dateMs(String(value ?? ''));
  if (!Number.isFinite(ms)) throw new PublicTestError(400, `Choose a valid ${label}.`);
  return ms;
}

export const startTimeMs = (value) => timeMs(value, 'test start time');

const given = (value) => value !== undefined && value !== null && value !== '';
export const MAX_DURATION_MINUTES = 24 * 60;

/**
 * How the test starts and ends - see attempt-rules.js. Payloads from before
 * these modes existed (and JSON imports) carry only `opensAt`, `endsAt` and
 * `untimed`: they start by hand, as they always did, and end at `endsAt`
 * or, when untimed, by hand.
 */
export function buildSchedule(raw, estimatedSeconds) {
  const startMode = raw.startMode === 'scheduled' ? 'scheduled' : 'manual';
  if (startMode === 'scheduled' && !given(raw.opensAt)) {
    throw new PublicTestError(400, 'Choose when the test starts, or let it start when you press Start.');
  }
  const opensAtMs = given(raw.opensAt) ? startTimeMs(raw.opensAt) : null;
  const endMode = END_MODES.includes(raw.endMode) ? raw.endMode : raw.untimed === true ? 'manual' : 'at';

  if (endMode === 'manual') return { startMode, opensAtMs, endMode, endsAtMs: null, durationMinutes: null };
  if (endMode === 'duration' || endMode === 'each') {
    const durationMinutes = asInteger(raw.durationMinutes, 1, MAX_DURATION_MINUTES);
    if (durationMinutes === null) throw new PublicTestError(400, 'Choose a test duration between 1 minute and 24 hours.');
    // A scheduled start already fixes the end; a manual one fixes it on Start.
    // Each student's own time has no shared end at all.
    const endsAtMs = endMode === 'duration' && startMode === 'scheduled' ? opensAtMs + durationMinutes * 60_000 : null;
    return { startMode, opensAtMs, endMode, endsAtMs, durationMinutes };
  }
  // No end time given (an older payload, or a JSON import): fall back to the
  // estimate, which is what the admin would otherwise have to type themselves.
  const endsAtMs = given(raw.endsAt)
    ? endTimeMs(raw.endsAt, opensAtMs)
    : (opensAtMs ?? Date.now()) + estimatedSeconds * 1000;
  return { startMode, opensAtMs, endMode, endsAtMs, durationMinutes: null };
}

/**
 * Validates the admin's chosen end time against the start. The test may be
 * given a window shorter than the estimate - that is the admin's call, and the
 * forms warn about it - but it must be a real window, not zero or negative.
 * A test the admin starts by hand has no start time to measure against.
 */
export function endTimeMs(value, opensAtMs) {
  const ms = timeMs(value, 'test end time');
  if (opensAtMs === null || opensAtMs === undefined) return ms;
  if (ms <= opensAtMs) throw new PublicTestError(400, 'The test end time must be after the start time.');
  if (ms - opensAtMs > MAX_TEST_WINDOW_SECONDS * 1000) throw new PublicTestError(400, 'A test cannot run for longer than 30 days.');
  return ms;
}

function buildQuestion(rawQuestion, index) {
  // Its lines are kept: bullet points and numbered steps are one per line.
  const prompt = tidyLines(rawQuestion.prompt);
  if (prompt.length < 3 || prompt.length > 3000) throw new PublicTestError(400, `Question ${index + 1} must be between 3 and 3000 characters.`);
  const type = ['short', 'msq', 'mcq'].includes(rawQuestion.type) ? rawQuestion.type : null;
  if (!type) throw new PublicTestError(400, `Question ${index + 1} has an invalid type.`);
  // Its own time under strict timing, and its own marks: null follows the test's default for its type.
  const timeSeconds = secondsOrNull(rawQuestion.timeSeconds, `Question ${index + 1}'s time`);
  const marks = marksField(rawQuestion.marks, `Question ${index + 1}'s marks`);
  if (type === 'short') return { prompt, type, options: [], correctOptions: [], timeSeconds, marks };

  if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length < 2 || rawQuestion.options.length > 8) {
    throw new PublicTestError(400, `Question ${index + 1} needs 2 to 8 answer options.`);
  }
  const options = rawQuestion.options.map((option, optionIndex) => cleanText(option, `Question ${index + 1}, option ${optionIndex + 1}`, 1, 600));
  const correctOptions = Array.isArray(rawQuestion.correctOptions) ? [...new Set(rawQuestion.correctOptions.map(String))] : [];
  if (!correctOptions.length || !correctOptions.every((id) => /^\d+$/.test(id) && Number(id) >= 0 && Number(id) < options.length)) {
    throw new PublicTestError(400, `Choose valid correct answer(s) for question ${index + 1}.`);
  }
  if (type === 'mcq' && correctOptions.length !== 1) throw new PublicTestError(400, `Question ${index + 1} is single-choice, so select one correct answer.`);
  return { prompt, type, options, correctOptions, timeSeconds, marks };
}

/**
 * Validates an admin's test payload and derives everything the stored document
 * needs. `estimatedSeconds` is what the chosen questions are expected to take;
 * `endsAt` is the wall-clock deadline the admin actually sets, defaulting to
 * start + estimate but free to be anything after the start.
 */
export function buildTest(raw) {
  const title = cleanText(raw.title, 'Test title', 3, 120);
  const instructions = String(raw.instructions || '').trim().slice(0, 2000);
  const fullscreenExitLimit = asInteger(raw.fullscreenExitLimit ?? 3, 0, 20);
  const fullscreenAbsenceLimitSeconds = asInteger(raw.fullscreenAbsenceLimitSeconds ?? 10, 0, 3600);
  if (fullscreenExitLimit === null || fullscreenAbsenceLimitSeconds === null) {
    throw new PublicTestError(400, 'Test settings are invalid.');
  }
  // Leaving the test: warn only, lock only, or warn and then lock (see
  // domain/integrity.js). Tests made before the choice existed lock.
  const warningsBeforeLock = asInteger(raw.warningsBeforeLock ?? 0, 0, 20);
  if (warningsBeforeLock === null) throw new PublicTestError(400, 'Test settings are invalid.');
  const chosen = ['record', 'warn', 'lock', 'warn_lock'].includes(raw.violationAction) ? raw.violationAction : 'lock';
  // "Warn, then lock" with no warnings left to give is simply "lock".
  const violationAction = chosen === 'warn_lock' && warningsBeforeLock === 0 ? 'lock' : chosen;
  const shuffleQuestions = raw.shuffleQuestions !== false;
  const allowGuests = raw.allowGuests === true;
  // Students must use a private (Incognito) window, where browser extensions
  // are off. Off unless the admin turns it on, like the venue check.
  const requirePrivateWindow = raw.requirePrivateWindow === true;
  // Which devices may sit it: any, phones (and tablets) only, or laptops (and
  // desktops) only - see domain/device.js. Any, unless the admin chooses.
  const devices = DEVICE_RULES.includes(raw.devices) ? raw.devices : 'any';
  // Strict timing: a time per question, one at a time, forward only.
  const strictTiming = raw.strictTiming === true;
  // Whether students may move on before a question's time runs out. Off, a
  // timed question stays on screen for its full time.
  const strictNext = raw.strictNext !== false;
  // Tests saved before this choice existed drew at random, and still do.
  const questionDraw = QUESTION_DRAWS.includes(raw.questionDraw) ? raw.questionDraw : 'random';
  const typeSeconds = buildTypeSeconds(raw.typeSeconds);
  // What each question type is worth unless a question says otherwise (domain/marks.js).
  const typeMarks = buildTypeMarks(raw.typeMarks);
  const questionLayout = strictTiming ? 'one' : QUESTION_LAYOUTS.includes(raw.questionLayout) ? raw.questionLayout : 'one';
  const resultReleaseMode = RESULT_RELEASE_MODES.includes(raw.resultReleaseMode) ? raw.resultReleaseMode : 'instant';

  const locationRequired = raw.locationRequired === true;
  const locationRadiusMeters = locationRequired ? asInteger(raw.locationRadiusMeters, 10, 100_000) : null;
  const locationLatitude = locationRequired ? coordinate(raw.locationLatitude, -90, 90) : null;
  const locationLongitude = locationRequired ? coordinate(raw.locationLongitude, -180, 180) : null;
  if (locationRequired && (locationRadiusMeters === null || locationLatitude === null || locationLongitude === null)) {
    throw new PublicTestError(400, 'Set a valid test location and radius.');
  }

  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 100) {
    throw new PublicTestError(400, 'Add between 1 and 100 questions.');
  }
  const questions = raw.questions.map(buildQuestion);

  const hasQuestionMix = raw.questionMix !== undefined || raw.question_mix !== undefined;
  const questionMix = hasQuestionMix ? questionMixFrom(raw.questionMix ?? raw.question_mix, questions) : null;
  const questionCount = questionMix ? questionMixCount(questionMix) : asInteger(raw.questionCount, 1, questions.length);
  if (questionCount === null) throw new PublicTestError(400, 'Questions shown per student is invalid.');

  const estimatedSeconds = (strictTiming && strictEstimateSeconds({ questions, typeSeconds }, questionMix, ESTIMATE_SECONDS))
    || estimateSeconds(questionMix, questionCount);
  const schedule = buildSchedule(raw, estimatedSeconds);
  const { opensAtMs, endsAtMs } = schedule;

  return {
    title,
    instructions,
    startMode: schedule.startMode,
    opensAt: opensAtMs === null ? null : new Date(opensAtMs),
    endMode: schedule.endMode,
    // Kept alongside endMode for older readers: true means "the admin closes it".
    untimed: schedule.endMode === 'manual',
    endsAt: endsAtMs === null ? null : new Date(endsAtMs),
    durationMinutes: schedule.durationMinutes,
    estimatedSeconds,
    windowSeconds: schedule.durationMinutes ? schedule.durationMinutes * 60
      : endsAtMs !== null && opensAtMs !== null ? Math.round((endsAtMs - opensAtMs) / 1000) : null,
    questionCount,
    questionMix,
    fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: violationAction === 'warn_lock' ? warningsBeforeLock : 0,
    violationAction,
    shuffleQuestions,
    allowGuests,
    requirePrivateWindow,
    devices,
    questionLayout,
    strictTiming,
    strictNext,
    typeSeconds,
    typeMarks,
    questionDraw,
    resultReleaseMode,
    locationRequired,
    locationRadiusMeters,
    locationLatitude,
    locationLongitude,
    questions
  };
}
