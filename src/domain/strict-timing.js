import { asInteger } from '../lib/crypto.js';
import { dateMs } from '../lib/time.js';
import { PublicTestError } from '../lib/errors.js';
import { QUESTION_TYPES, questionType } from './question-bank.js';

/**
 * Strict timing
 * -------------
 * A test may give each question its own time. The paper then shows ONE
 * question at a time, forward only: when a question's time runs out, or the
 * student presses Next, that question is closed for good and the next one
 * opens. A question with no time of its own waits until the student moves on.
 *
 * A question's time is, in order: its own `timeSeconds` (0 = no limit), else
 * the test's default for its type (`typeSeconds`), else no limit.
 *
 * The clock is the server's. `attempt.strict` holds where the student is:
 *   index    which question of their paper is open (== length once done)
 *   shownAt  when that question's clock started, or null if the previous
 *            one timed out while nobody was looking. Its clock starts only
 *            when it is actually shown, so a dropped connection costs the
 *            question that was open, never the ones after it.
 *   sentAt   when the server opened that question and sent it, while the
 *            student's device has not yet said it is on screen; null once it
 *            has. Until then shownAt is sentAt. The device's "on screen" moves
 *            shownAt on to when it said so - but never more than the shown
 *            grace past sentAt (see clockStartOnShown), so a slow connection
 *            does not eat the question's time and a tampered page that holds
 *            back its "on screen" gains at most that grace.
 *   log      one entry per closed question: shown, closed, and whether it
 *            was the student ('next') or the clock ('time') that closed it.
 *   pausedSince  set while the student is away from the paper, or it is
 *            locked: the open question's clock is stopped, so it cannot run
 *            out meanwhile. Once they are back on it, shownAt moves on by the
 *            time away - a question's time only counts while the student is
 *            on it, and "closed minus shown" is the time spent on it.
 */

export const DEFAULT_TYPE_SECONDS = { mcq: 60, msq: 60, short: 120 };
export const MAX_QUESTION_SECONDS = 60 * 60;
/** An answer sent in the last instant before zero still counts. */
export const STRICT_GRACE_MS = 3_000;

export const isStrict = (test) => test?.strictTiming === true;
/** Tests saved before this setting existed showed Next, and still do. */
export const allowsNext = (test) => test?.strictNext !== false;
/** How early a "time is up" from the student's screen may arrive and still count. */
export const EARLY_TIMEOUT_MS = 1_500;

export const emptyStrictState = (shownAt = null) => ({ index: 0, shownAt, sentAt: shownAt, log: [] });

/**
 * Where a clock should start once the device says what was sent at `sentMs`
 * is on screen at `atMs`: then, but no later than `graceMs` after it was sent.
 * Null when that would not move the clock's present start (`startMs`) later -
 * this only ever gives time back, never takes it.
 */
export function clockStartOnShown(sentMs, startMs, atMs, graceMs) {
  if (!Number.isFinite(sentMs) || !Number.isFinite(startMs)) return null;
  const target = Math.min(atMs, sentMs + Math.max(0, Number(graceMs) || 0));
  return target > startMs ? target : null;
}

/**
 * Strict timing: the open question's "on screen" arrived at `atMs`. Returns the
 * strict fields to write - shownAt moved on, sentAt cleared - or null when
 * there is nothing waiting for it. Measured against the clock's start as it
 * stands (a pause included), so a pause and this together never give back
 * more than the grace.
 */
export function acknowledgeShown(state, atMs, graceMs) {
  if (!state?.sentAt || !state.shownAt) return null;
  const startMs = effectiveShownMs(state, atMs);
  const target = clockStartOnShown(dateMs(state.sentAt), startMs, atMs, graceMs);
  const shownAt = target === null ? new Date(state.shownAt) : new Date(dateMs(state.shownAt) + (target - startMs));
  return { shownAt, sentAt: null };
}

/** 0..3600 seconds, where 0 means no limit; null/'' when not given. */
export function secondsOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = asInteger(value, 0, MAX_QUESTION_SECONDS);
  if (seconds === null) throw new PublicTestError(400, `${label} must be between 0 (no limit) and ${MAX_QUESTION_SECONDS} seconds.`);
  return seconds;
}

export function buildTypeSeconds(raw) {
  return QUESTION_TYPES.reduce((result, type) => ({
    ...result,
    [type]: secondsOrNull(raw?.[type], `The ${type.toUpperCase()} question time`) ?? DEFAULT_TYPE_SECONDS[type]
  }), {});
}

/** This question's time in seconds; 0 means it has no limit. */
export function questionSeconds(test, question) {
  if (!question) return 0;
  if (question.timeSeconds !== undefined && question.timeSeconds !== null) return question.timeSeconds;
  return test?.typeSeconds?.[questionType(question)] ?? DEFAULT_TYPE_SECONDS[questionType(question)] ?? 0;
}

/** The student's paper in order, each entry with its question and its time. */
export function strictPaper(test, attempt) {
  const bank = new Map((test.questions || []).map((question) => [question.id, question]));
  return [...(attempt.questions || [])]
    .sort((left, right) => left.questionIndex - right.questionIndex)
    .map((assigned) => {
      const question = bank.get(assigned.questionId);
      return { questionId: assigned.questionId, question, seconds: questionSeconds(test, question) };
    });
}

/**
 * When the open question's clock started, as it stands at `atMs`. While it
 * is paused that start moves on with time, so the question never runs out
 * meanwhile, and what is left of it stays where it was.
 */
export function effectiveShownMs(state, atMs = Date.now()) {
  if (!state?.shownAt) return null;
  const shownMs = dateMs(state.shownAt);
  return state.pausedSince ? shownMs + Math.max(0, atMs - dateMs(state.pausedSince)) : shownMs;
}

/**
 * Where the student stands at `atMs`, with every question whose time ran out
 * since the last look closed. Pure: the caller writes the result back.
 * Returns the new state and whether anything changed.
 */
export function resolveStrict(test, attempt, atMs = Date.now()) {
  const paper = strictPaper(test, attempt);
  const stored = attempt.strict || emptyStrictState(attempt.startedAt);
  let { index, shownAt } = stored;
  let sentAt = stored.sentAt || null;
  let pausedSince = stored.pausedSince || null;
  const closed = [];
  // Only the open question can run out: the next one's clock starts when it
  // is shown, which is below, at `atMs`. A paused clock does not run.
  if (index < paper.length && shownAt) {
    const { seconds, questionId } = paper[index];
    const endsMs = effectiveShownMs(stored, atMs) + seconds * 1000;
    if (seconds > 0 && atMs >= endsMs + STRICT_GRACE_MS) {
      closed.push({ questionId, shownAt: new Date(shownAt), closedAt: new Date(endsMs), how: 'time' });
      index += 1;
      shownAt = null;
    }
  }
  if (index < paper.length && !shownAt) {
    shownAt = new Date(atMs);
    // Sent now; its clock waits for the device to say it is on screen.
    sentAt = shownAt;
    // Opened while the student is away: its clock starts stopped.
    if (pausedSince) pausedSince = shownAt;
  }
  if (index >= paper.length) sentAt = null;
  const changed = index !== stored.index || String(shownAt) !== String(stored.shownAt)
    || String(pausedSince) !== String(stored.pausedSince || null);
  return { index, shownAt, sentAt, pausedSince, closed, changed, total: paper.length, done: index >= paper.length, paper };
}

/**
 * When the open question's time ends, or null if it has none. While it is
 * paused: when it would end if the student came back at `atMs`.
 */
export function openQuestionEndsAt(test, attempt, atMs = Date.now()) {
  const state = attempt.strict;
  if (!state || !state.shownAt) return null;
  const entry = strictPaper(test, attempt)[state.index];
  return entry && entry.seconds > 0 ? new Date(effectiveShownMs(state, atMs) + entry.seconds * 1000) : null;
}

/**
 * The longest a strict paper can take: each type's longest-timed questions,
 * as many as each student draws. A question with no limit counts at its
 * usual estimate. Used for the suggested overall duration.
 */
export function strictEstimateSeconds(test, mix, fallback) {
  if (!mix) return null;
  return QUESTION_TYPES.reduce((total, type) => {
    const times = (test.questions || [])
      .filter((question) => questionType(question) === type)
      .map((question) => questionSeconds(test, question) || fallback[type])
      .sort((a, b) => b - a);
    return total + times.slice(0, Number(mix[type] || 0)).reduce((sum, seconds) => sum + seconds, 0);
  }, 0);
}
