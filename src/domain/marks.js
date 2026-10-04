/**
 * What questions are worth. Each question type has a default on its test
 * (`typeMarks`, like `typeSeconds`), and a question may have its own
 * (`marks`; null follows its type). Tests from before marks existed have
 * neither, and every question is worth 1 - exactly as they always scored.
 *
 * An answer's `isCorrect` holds the marks it earned: 0 up to its question's
 * marks, or null while a short answer waits to be marked. With every question
 * worth 1 that is 1 for right and 0 for wrong, as it always was, so papers
 * from before marks existed need nothing done to them.
 */

import { PublicTestError } from '../lib/errors.js';

export const DEFAULT_TYPE_MARKS = { mcq: 1, msq: 1, short: 1 };
export const MAX_QUESTION_MARKS = 100;
const TYPES = Object.keys(DEFAULT_TYPE_MARKS);

const typeOf = (question) => (question?.manualGrading ? 'short' : question?.type === 'short' ? 'short' : question?.type || 'mcq');

/** Marks rounded to two places, so 0.1 + 0.2 shows as 0.3. */
export const roundMarks = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** A positive number of marks up to MAX_QUESTION_MARKS, else null. */
export function marksOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= MAX_QUESTION_MARKS ? roundMarks(number) : null;
}

/** A saved form's marks: none given is null (follow the type); anything else must be valid. */
export function marksField(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const marks = marksOrNull(value);
  if (marks === null) throw new PublicTestError(400, `${label} must be more than 0 and at most ${MAX_QUESTION_MARKS}.`);
  return marks;
}

/** What each question type is worth on a test, 1 where nothing is given. */
export function buildTypeMarks(raw) {
  return Object.fromEntries(TYPES.map((type) => [type, marksField(raw?.[type], `The ${type.toUpperCase()} marks`) ?? DEFAULT_TYPE_MARKS[type]]));
}

/** What a question is worth on its test: its own marks, else its type's, else 1. */
export function questionMarks(test, question) {
  const own = marksOrNull(question?.marks);
  if (own !== null) return own;
  return marksOrNull(test?.typeMarks?.[typeOf(question)]) ?? 1;
}

/** Whether a choice answer is right: exactly the correct options, no more and no fewer. */
export function isRightChoice(question, answer) {
  const correct = (question?.correctOptions || []).map(String).sort();
  const selected = (answer?.selectedOptions || []).map(String).sort();
  return correct.length === selected.length && correct.every((item, index) => item === selected[index]);
}

/**
 * What the automatic marking gives a choice answer: all its marks or none. A
 * teacher can give it something else (`marksOverride` on the answer); that
 * mark then stands, re-marking included, until they go back to the automatic
 * one. A short answer has no automatic mark.
 */
export const automaticMarks = (test, question, answer) => (
  question?.manualGrading ? null : isRightChoice(question, answer) ? questionMarks(test, question) : 0
);

/** Marks an answer earned, or null while it waits to be marked. */
export const earnedMarks = (answer) => (answer?.isCorrect === null || answer?.isCorrect === undefined ? null : Number(answer.isCorrect) || 0);

/** A paper's score: the marks its answers earned, an unmarked one counting nothing yet. */
export const paperScore = (attempt) => roundMarks((attempt?.answers || []).reduce((total, answer) => total + (earnedMarks(answer) || 0), 0));

// A test's questions by id, built once per test document rather than once per
// paper: the dashboard and the quiz list ask for every paper of a test in turn.
const banks = new WeakMap();
function bankOf(test) {
  const questions = test?.questions || [];
  let bank = test && banks.get(test);
  if (!bank || bank.source !== questions) {
    bank = { source: questions, byId: new Map(questions.map((question) => [question.id, question])) };
    if (test) banks.set(test, bank);
  }
  return bank.byId;
}

/** A paper's full marks: what its questions are worth together. */
export function paperMarks(test, attempt) {
  const bank = bankOf(test);
  const entries = attempt?.questions?.length ? attempt.questions : attempt?.answers || [];
  return roundMarks(entries.reduce((total, entry) => total + questionMarks(test, bank.get(entry.questionId)), 0));
}
