import { PublicTestError } from '../lib/errors.js';
import { asInteger, stableSort } from '../lib/crypto.js';

export const QUESTION_TYPES = ['mcq', 'msq', 'short'];
export const QUESTION_LAYOUTS = ['one', 'all'];
/**
 * How each student's questions are picked from a bank bigger than one paper:
 *   random  - an independent random pick per student; overlap is left to chance.
 *   spread  - the bank is put in one fixed order for the test, and each student
 *             who begins takes the next block of it (wrapping round). Students
 *             who begin one after another get different questions until the
 *             bank runs out, and every question is used about equally often.
 */
export const QUESTION_DRAWS = ['spread', 'random'];

/**
 * Roughly what one question of each type takes to answer. Questions carry no
 * time of their own - nothing in the app counts a question down - so these are
 * used only to estimate a sensible default end time for the admin to adjust.
 */
export const ESTIMATE_SECONDS = { mcq: 60, msq: 60, short: 120 };

/**
 * Short-answer questions are stored as `msq` with `manualGrading: true` so that
 * one storage shape covers every question. This is the only place that
 * translation happens.
 */
export function questionType(question) {
  return question.manualGrading ? 'short' : question.type;
}

/**
 * The questions new papers are drawn from. An edited or deleted question that
 * papers already handed out still use stays in the bank, `retired`, so those
 * papers can still show and mark it - but no new paper gets it.
 */
export const activeQuestions = (test) => (test?.questions || []).filter((question) => !question.retired);

export function questionPoolCounts(questions = []) {
  return QUESTION_TYPES.reduce((counts, type) => ({
    ...counts,
    [type]: questions.filter((question) => questionType(question) === type).length
  }), {});
}

export function questionMixFrom(rawMix, questions) {
  if (!rawMix || typeof rawMix !== 'object' || Array.isArray(rawMix)) {
    throw new PublicTestError(400, 'Question mix must specify the MCQ, MSQ, and short-answer counts.');
  }
  const available = questionPoolCounts(questions);
  const mix = QUESTION_TYPES.reduce((result, type) => {
    const count = asInteger(rawMix[type] ?? 0, 0, available[type]);
    if (count === null) {
      throw new PublicTestError(400, `Choose between 0 and ${available[type]} ${type.toUpperCase()} question${available[type] === 1 ? '' : 's'} per student.`);
    }
    return { ...result, [type]: count };
  }, {});
  if (!QUESTION_TYPES.some((type) => mix[type] > 0)) throw new PublicTestError(400, 'Choose at least one question per student.');
  return mix;
}

export function questionMixCount(mix) {
  return QUESTION_TYPES.reduce((total, type) => total + Number(mix?.[type] || 0), 0);
}

/** What a paper of this shape is expected to take. Guidance, never a deadline. */
export function estimateSeconds(mix, questionCount = null) {
  if (mix) return QUESTION_TYPES.reduce((total, type) => total + Number(mix[type] || 0) * ESTIMATE_SECONDS[type], 0);
  return Number(questionCount || 0) * ESTIMATE_SECONDS.mcq;
}

/**
 * `count` questions from `candidates` for the student in `slot` (the order
 * they began in): the block after the previous student's, wrapping round.
 * The order is the test's own - shuffled once for the whole test, never per
 * student - so the blocks do not overlap until the bank is used up.
 */
function spreadBlock(test, candidates, count, slot, key) {
  if (!count) return [];
  const ordered = test.shuffleQuestions ? stableSort(candidates, `${test.code}:spread:${key}`) : candidates;
  const start = (slot * count) % ordered.length;
  return Array.from({ length: count }, (_unused, offset) => ordered[(start + offset) % ordered.length]);
}

/**
 * The questions one student receives, drawn deterministically from `seed` so a
 * reload returns exactly the same paper in exactly the same order. Under the
 * spread draw, `slot` is the student's place in the order papers were begun.
 */
export function selectedAttemptQuestions(test, seed, slot = null) {
  const bank = activeQuestions(test);
  if (bank.length < test.questionCount) throw new PublicTestError(503, 'The test is not configured correctly.');
  const spread = test.questionDraw === 'spread' && Number.isInteger(slot);
  if (!test.questionMix) {
    if (spread) return spreadBlock(test, bank, test.questionCount, slot, 'all');
    return (test.shuffleQuestions ? stableSort(bank, seed) : bank).slice(0, test.questionCount);
  }
  const selected = QUESTION_TYPES.flatMap((type) => {
    const candidates = bank.filter((question) => questionType(question) === type);
    const requested = Number(test.questionMix[type] || 0);
    if (candidates.length < requested) throw new PublicTestError(503, 'The test question pool is not configured correctly.');
    if (spread) return spreadBlock(test, candidates, requested, slot, type);
    const ordered = test.shuffleQuestions ? stableSort(candidates, `${seed}:${type}`) : candidates;
    return ordered.slice(0, requested);
  });
  if (selected.length !== test.questionCount) throw new PublicTestError(503, 'The test question pool is not configured correctly.');
  return test.shuffleQuestions ? stableSort(selected, `${seed}:question-order`) : selected;
}
