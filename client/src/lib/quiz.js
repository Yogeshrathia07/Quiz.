export const QUESTION_TYPES = ['mcq', 'msq', 'short'];

export const QUESTION_TYPE_LABELS = {
  mcq: 'Single-choice (MCQ)',
  msq: 'Multiple-choice (MSQ)',
  short: 'Short answer (manual marking)'
};

export const QUESTION_LAYOUTS = [
  ['one', 'One at a time', 'With Previous and Next.'],
  ['all', 'All on one page', 'One scrolling page with a single Submit at the end.']
];

/**
 * Roughly what one question of each type takes, mirroring the server. Questions
 * carry no time of their own - nothing counts a question down - so this only
 * estimates a sensible default end time for the admin to adjust.
 */
export const ESTIMATE_SECONDS = { mcq: 60, msq: 60, short: 120 };

export const newQuestion = () => ({ prompt: '', type: 'mcq', options: ['', '', '', ''], correctOptions: ['0'] });

export const emptyMix = () => ({ mcq: 0, msq: 0, short: 0 });

export const mixTotal = (mix) => QUESTION_TYPES.reduce((total, type) => total + Number(mix?.[type] || 0), 0);

/** How many questions of each type the bank holds: `{ mcq: 3, msq: 1, short: 2 }`. */
export function poolCounts(questions = []) {
  return QUESTION_TYPES.reduce((pool, type) => ({
    ...pool,
    [type]: questions.filter((question) => question.type === type).length
  }), {});
}

export const availableOfType = (pool, type) => Number(pool?.[type] || 0);

/** What a paper of this shape is expected to take. Guidance, never a deadline. */
export function estimateSeconds(mix) {
  return QUESTION_TYPES.reduce((total, type) => total + Number(mix?.[type] || 0) * ESTIMATE_SECONDS[type], 0);
}

/** Clamps every count to what the bank can actually supply. */
export function clampMix(mix, pool) {
  return QUESTION_TYPES.reduce((result, type) => ({
    ...result,
    [type]: Math.max(0, Math.min(Number(mix?.[type] || 0), availableOfType(pool, type)))
  }), {});
}

/**
 * Mirrors the server's `addMinutes` arithmetic in setTestEndTime: the extension
 * runs from whichever is later, the current end time or now, so adding minutes
 * to a test whose window has already lapsed really does grant that many minutes
 * of working time. Kept here, and tested, so the previewed end time in the
 * Extend time dialog cannot drift away from the one the server stores.
 */
export const extendedEndMs = (currentEndMs, minutes, nowMs = Date.now()) =>
  Math.max(currentEndMs, nowMs) + Number(minutes || 0) * 60_000;

/* ------------------------------------------------------ strict timing ---- */

/** Mirrors the server's defaults: what each type gets unless a question says otherwise. */
export const DEFAULT_TYPE_SECONDS = { mcq: 60, msq: 60, short: 120 };

/** A question's time under strict timing; 0 means no limit. `timeSeconds` null follows its type. */
export const questionSecondsFor = (question, typeSeconds = DEFAULT_TYPE_SECONDS) => (
  question.timeSeconds !== undefined && question.timeSeconds !== null && question.timeSeconds !== ''
    ? Number(question.timeSeconds)
    : Number(typeSeconds?.[question.type] ?? DEFAULT_TYPE_SECONDS[question.type] ?? 0)
);

/** "No limit", "45 s", "1 min", "1 min 30 s". */
export function secondsLabel(seconds) {
  const value = Number(seconds) || 0;
  if (!value) return 'No limit';
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (!minutes) return `${rest} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * Mirrors the server's strict estimate: the longest-timed questions of each
 * type a student could draw, with "no limit" counted at the usual estimate.
 */
export function strictEstimateSeconds(questions, mix, typeSeconds) {
  return QUESTION_TYPES.reduce((total, type) => {
    const times = questions
      .filter((question) => question.type === type)
      .map((question) => questionSecondsFor(question, typeSeconds) || ESTIMATE_SECONDS[type])
      .sort((a, b) => b - a);
    return total + times.slice(0, Number(mix?.[type] || 0)).reduce((sum, seconds) => sum + seconds, 0);
  }, 0);
}

/* ------------------------------------------------------ question draw ---- */

const TYPE_SHORT = { mcq: 'MCQs', msq: 'MSQs', short: 'short answers' };

/**
 * What the chosen draw means for this bank, in one line: how many students
 * in a row get entirely different questions (least overlap), or how many
 * questions two students share on average (fully random). Null when every
 * student gets the whole bank anyway.
 */
export function drawSummary(pool, mix, draw) {
  const parts = QUESTION_TYPES
    .filter((type) => Number(mix?.[type]) > 0 && Number(pool?.[type]) > Number(mix[type]))
    .map((type) => {
      const bank = Number(pool[type]);
      const drawn = Number(mix[type]);
      if (draw === 'spread') {
        const run = Math.floor(bank / drawn);
        return run >= 2
          ? `${run} students in a row get completely different ${TYPE_SHORT[type]}`
          : `the ${TYPE_SHORT[type]} bank is small, so neighbours share some — add more to avoid it`;
      }
      const shared = Math.round(((drawn * drawn) / bank) * 10) / 10;
      return `two students share about ${shared} of their ${drawn} ${TYPE_SHORT[type]}`;
    });
  return parts.length ? `${parts.join('; ')}.` : null;
}
