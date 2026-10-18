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
 *   keyed    the question whose key the device was given in the open one's
 *            last moments (domain/paper-seal.js): it is on the device from
 *            then on, so when the open one runs out unseen, its clock counts
 *            from that end - not from whenever the server next looks.
 *   reached  how many questions have been opened at least once (the furthest
 *            one's place plus one). Without going back it is always index + 1.
 *
 * Going back (`strictPrevious`): only for a paper with no question timers now
 * (hasQuestionTimers), where a teacher may also turn it on while the test runs.
 * Older tests saved with timers and going back keep it: a question keeps the
 * time it did not use. Leaving it - Next, Previous
 * or its number - stops its clock; opening it again starts the clock on what
 * is left. One whose time ran out is closed for good, and questions not
 * reached yet still open only one at a time, with Next. Without going back,
 * leaving a question closes it for good, as before. Each visit is one entry
 * in `log`, so a question's time used is the sum of its visits.
 */

export const DEFAULT_TYPE_SECONDS = { mcq: 60, msq: 60, short: 120 };
export const MAX_QUESTION_SECONDS = 60 * 60;
/** An answer sent in the last instant before zero still counts. */
export const STRICT_GRACE_MS = 3_000;
/** A question left with less time than this has none worth opening it for. */
export const MIN_LEFT_MS = 1_000;

export const isStrict = (test) => test?.strictTiming === true;
/** Tests saved before this setting existed showed Next, and still do. */
export const allowsNext = (test) => test?.strictNext !== false;
/** Whether students may go back to a question they have seen that still has time. */
export const allowsPrevious = (test) => isStrict(test) && test?.strictPrevious === true;
/**
 * A paper held one at a time with a timer on any of its questions. Such a
 * paper goes forward only - with or without Next - and going back cannot be
 * chosen for it (test-builder.js, setNavigation); tests saved with both before
 * that rule keep them, and this engine still serves them.
 */
export const hasQuestionTimers = (test) => isStrict(test)
  && (test?.questions || []).some((question) => !question.retired && questionSeconds(test, question) > 0);
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

/** How many questions of a paper of `total` have been opened at least once. */
export function reachedOf(state, total) {
  const index = Number(state?.index) || 0;
  return Math.min(total, Math.max(Number(state?.reached) || 0, index + 1));
}

/** Each question's time on screen so far (ms), summed over its visits in `log`. */
export function usedMsByQuestion(log = []) {
  const used = new Map();
  for (const entry of log) {
    const ms = dateMs(entry.closedAt) - dateMs(entry.shownAt);
    used.set(entry.questionId, (used.get(entry.questionId) || 0) + (Number.isFinite(ms) ? Math.max(0, ms) : 0));
  }
  return used;
}

/**
 * Where each question of the paper stands for moving between them: the time
 * it has left (Infinity with no timer; the open one's visit not counted yet),
 * and whether it is closed for good. `extra`: visits ending now, not yet in
 * the stored log.
 */
export function strictProgress(test, attempt, extra = []) {
  const paper = strictPaper(test, attempt);
  const log = [...(attempt.strict?.log || []), ...extra];
  const used = usedMsByQuestion(log);
  const visited = new Set(log.map((entry) => entry.questionId));
  const timedOut = new Set(log.filter((entry) => entry.how === 'time').map((entry) => entry.questionId));
  const previous = allowsPrevious(test);
  const leftMs = (position) => {
    const entry = paper[position];
    if (!entry) return 0;
    if (!entry.seconds) return Infinity;
    return Math.max(0, entry.seconds * 1000 - (used.get(entry.questionId) || 0));
  };
  // Its time ran out; or it was left at all on a paper with no going back.
  const isFinal = (position) => {
    const entry = paper[position];
    if (!entry) return true;
    if (timedOut.has(entry.questionId)) return true;
    if (!visited.has(entry.questionId)) return false;
    return !previous || leftMs(position) < MIN_LEFT_MS;
  };
  return { paper, used, timedOut, previous, leftMs, isFinal };
}

/**
 * The question Next goes to from `from`: the next one seen before that can
 * still open, else the first not reached yet; null when there is none - Next
 * then finishes the paper.
 */
export function nextOpenAfter(progress, from, reached) {
  for (let position = from + 1; position < reached; position += 1) {
    if (!progress.isFinal(position)) return position;
  }
  return reached < progress.paper.length ? reached : null;
}

/** The question Previous goes to from `from`, or null (none, or no going back on this paper). */
export function openBefore(progress, from) {
  if (!progress.previous) return null;
  for (let position = from - 1; position >= 0; position -= 1) {
    if (!progress.isFinal(position)) return position;
  }
  return null;
}

/** The first question seen before that can still open (going back only), or null. */
export function firstOpen(progress, reached) {
  if (!progress.previous) return null;
  for (let position = 0; position < reached; position += 1) {
    if (!progress.isFinal(position)) return position;
  }
  return null;
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
  let reached = reachedOf(stored, paper.length);
  const closed = [];
  // Only the open question can run out: the next one's clock starts when it
  // is shown, which is below, at `atMs`. A paused clock does not run.
  if (index < paper.length && shownAt) {
    const { seconds, questionId } = paper[index];
    const endsMs = effectiveShownMs(stored, atMs) + strictProgress(test, attempt).leftMs(index);
    if (seconds > 0 && atMs >= endsMs + STRICT_GRACE_MS) {
      closed.push({ questionId, shownAt: new Date(shownAt), closedAt: new Date(endsMs), how: 'time' });
      // On to the next question that can open - with going back, to one still
      // with time when there is nothing ahead - or the paper is done.
      const after = strictProgress(test, attempt, closed);
      const target = nextOpenAfter(after, index, reached) ?? firstOpen(after, reached);
      const fresh = target !== null && target >= reached;
      index = target ?? paper.length;
      shownAt = null;
      // Its key was given before this one ended: it was there to read from
      // then, so that is when it was sent. The "on screen" grace still applies.
      if (fresh && stored.keyed != null && stored.keyed === paper[index].questionId) {
        shownAt = new Date(endsMs);
        sentAt = shownAt;
      }
    }
  }
  // A place that cannot open (its question was taken off the paper, say): the next one that can.
  if (index < paper.length && !shownAt) {
    const progress = strictProgress(test, attempt, closed);
    if (progress.isFinal(index)) index = nextOpenAfter(progress, index, Math.max(reached, index + 1)) ?? firstOpen(progress, reached) ?? paper.length;
  }
  if (index < paper.length && !shownAt) {
    shownAt = new Date(atMs);
    // Sent now; its clock waits for the device to say it is on screen.
    sentAt = shownAt;
    // Opened while the student is away: its clock starts stopped.
    if (pausedSince) pausedSince = shownAt;
  }
  if (index < paper.length) reached = Math.max(reached, index + 1);
  if (index >= paper.length) sentAt = null;
  const changed = index !== stored.index || String(shownAt) !== String(stored.shownAt)
    || String(pausedSince) !== String(stored.pausedSince || null) || reached !== reachedOf(stored, paper.length);
  return { index, shownAt, sentAt, pausedSince, reached, closed, changed, total: paper.length, done: index >= paper.length, paper };
}

/**
 * Strict timing: how long a lock held the paper, given back on the student's
 * own end when it lifts (`atMs`). The open question's clock stood still the
 * whole time and carries on where it was, so without this the paper's end
 * would cut off the questions still to come by however long the lock took -
 * as a teacher's pause gives its time back. 0 when there is nothing to give.
 */
export function lockedMsToGiveBack(test, attempt, atMs) {
  if (!isStrict(test) || !attempt?.lockedAt) return 0;
  return Math.max(0, atMs - dateMs(attempt.lockedAt));
}

/**
 * The write that gives `ms` back on a paper's own end (`extraMs`), with what
 * it must still match: a number is added to, so an extension landing at the
 * same moment is kept; an older paper with none yet is set, only while still
 * unchanged. Empty when there is nothing to give.
 */
export function extraTimeWrite(attempt, ms) {
  if (!(ms > 0)) return { set: {}, inc: null, expect: {} };
  const numeric = typeof attempt?.extraMs === 'number' && Number.isFinite(attempt.extraMs);
  return numeric
    ? { set: {}, inc: { extraMs: ms }, expect: {} }
    : { set: { extraMs: (Number(attempt?.extraMs) || 0) + ms }, inc: null, expect: { extraMs: attempt?.extraMs ?? null } };
}

/**
 * When the open question's time ends, or null if it has none. While it is
 * paused: when it would end if the student came back at `atMs`.
 */
export function openQuestionEndsAt(test, attempt, atMs = Date.now()) {
  const state = attempt.strict;
  if (!state || !state.shownAt) return null;
  const progress = strictProgress(test, attempt);
  const entry = progress.paper[state.index];
  return entry && entry.seconds > 0 ? new Date(effectiveShownMs(state, atMs) + progress.leftMs(state.index)) : null;
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
