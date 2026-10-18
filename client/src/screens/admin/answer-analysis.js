import { sanitizeAnswerFilters } from './answer-filters.js';
import { questionStatisticsOf } from './question-statistics.js';

export const ANSWER_ANALYSIS_OUTCOMES = Object.freeze([
  { id: 'O', label: 'Correct', tone: 'correct' },
  { id: 'W', label: 'Incorrect', tone: 'incorrect' },
  { id: 'P', label: 'Partial credit', tone: 'partial' },
  { id: 'B', label: 'Unanswered', tone: 'blank' },
  { id: 'Q', label: 'Still to mark', tone: 'pending' },
  { id: 'N', label: 'Not on paper', tone: 'not-on-paper' }
].map(Object.freeze));

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const idOf = (value) => (typeof value === 'string' || typeof value === 'number') && String(value).trim()
  ? String(value).trim() : null;
const states = new Set(ANSWER_ANALYSIS_OUTCOMES.map(({ id }) => id));
const percentOf = (count, total) => total ? Math.round(count / total * 1000) / 10 : null;
const errorOf = (id, problem, fallback) => ({ id, message: String(problem?.message || problem || fallback).slice(0, 300) });

/** Reading or editing one question never resets another question's rules.
 * An omitted option remains Ignore; this only selects students, never regrades.
 */
export function answerConditionOf(filters, questionId) {
  const id = idOf(questionId) || '';
  const found = sanitizeAnswerFilters(filters).questions.find((condition) => condition.id === id);
  return found ? { ...found, options: { ...found.options }, states: [...found.states] }
    : { id, optionMatch: 'all', options: {}, states: [] };
}

/** A supplied options/states patch replaces that field, as with React state.
 * Inactive clauses disappear, while the global All/Any mode is preserved.
 */
export function updateAnswerCondition(filters, questionId, patch, questions = null) {
  const current = sanitizeAnswerFilters(filters);
  const id = idOf(questionId);
  if (!id) return sanitizeAnswerFilters(current, questions);
  const next = { ...answerConditionOf(current, id), ...(record(patch) ? patch : {}), id };
  const found = current.questions.some((condition) => condition.id === id);
  return sanitizeAnswerFilters({ ...current, questions: found
    ? current.questions.map((condition) => condition.id === id ? next : condition)
    : [...current.questions, next] }, questions);
}

/** Switching the named view replaces the previous outcome AND option rules.
 * Choice questions keep the exact-correct-selection view; written answers use
 * the recorded outcome. This never changes the key or the saved marks.
 */
export function answerOutcomePatch(question, view) {
  const empty = { options: {}, optionMatch: 'all', states: [] };
  if (view === 'all') return empty;
  if (view === 'incorrect') return { ...empty, states: ['W'] };
  if (view !== 'correct') return empty;
  const options = Array.isArray(question?.options) ? question.options : [];
  const keys = new Set((question?.correctOptions || []).map(String));
  const valid = options.map((_option, index) => index).filter((index) => keys.has(String(index)));
  if (question?.type === 'short' || question?.manualGrading || !valid.length) return { ...empty, states: ['O'] };
  return { ...empty, options: Object.fromEntries(options.map((_option, index) => [index, keys.has(String(index)) ? 'selected' : 'not-selected'])) };
}

function cohortOf(students) {
  const found = new Map();
  for (const student of students || []) {
    const id = idOf(record(student) ? student.id : student);
    if (id && !found.has(id)) found.set(id, record(student) ? student : { id });
  }
  return found;
}

function questionRows(question, detail, cohort) {
  const id = idOf(question?.id);
  const fail = (problem, fallback = 'Question responses are incomplete. Please try again.') => ({
    status: 'error', errors: [errorOf(id, problem, fallback)], responses: null
  });
  if (!id) return fail(null, 'Choose an available question.');
  if (detail?.error || detail?.status === 'error') return fail(detail.error, 'Question responses could not be loaded.');
  if (!detail || detail.loading || detail.status === 'loading' || (Object.hasOwn(detail, 'data') && detail.data == null)) {
    return { status: 'loading', errors: [], responses: null };
  }
  const data = detail.data ?? detail;
  if (!record(data.question) || idOf(data.question.id) !== id || !Array.isArray(data.question.options) || !Array.isArray(data.responses)) return fail();
  const choice = data.question.type !== 'short' && !data.question.manualGrading;
  const rows = new Map();
  for (const response of data.responses) {
    const studentId = idOf(response?.id);
    if (!record(response) || !studentId) return fail();
    if (!cohort.has(studentId)) continue;
    const state = response.state === '.' ? 'N' : response.state;
    if (!states.has(state) || (choice && data.question.options.length && !['B', 'N'].includes(state) && !Array.isArray(response.picks))) return fail();
    const picks = ['B', 'N'].includes(state) || !choice ? [] : [...new Set((response.picks || [])
      .filter((value) => /^(0|[1-9]\d*)$/.test(String(value)))
      .map(Number).filter((index) => Number.isSafeInteger(index) && index < data.question.options.length))].sort((a, b) => a - b);
    // The final duplicate wins, matching the saved answer/matrix convention.
    rows.set(studentId, { id: studentId, state, picks });
  }
  return { status: 'ready', errors: [], responses: rows, question: data.question };
}

/** Counts use the selected cohort; call with filterResult:null and no search
 * for a fixed whole-class baseline beside the live matching-students list.
 * Only complete question replies can establish that a paper lacked a question.
 * Correct/incorrect follow recorded marks, not a speculative answer-key edit.
 *
 * The five received outcomes and option percentages use received papers as
 * denominator. Not-on-paper uses all papers. Every outcome exposes its own
 * denominator, and an empty denominator yields null rather than invented 0%.
 */
export function answerAnalysisOf({ question, detail, students, filterResult = null, search = '' } = {}) {
  const cohort = cohortOf(students);
  const empty = { status: 'loading', errors: [], rows: null, shown: null, total: null, cohortTotal: null,
    totalSubmitted: cohort.size, received: null, notOnPaper: null, optionDenominator: null, outcomes: null, options: null };
  const loaded = questionRows(question, detail, cohort);
  if (loaded.status !== 'ready') return { ...empty, status: loaded.status, errors: loaded.errors };
  let allowed = null;
  if (filterResult?.active) {
    if (filterResult.status === 'error') return { ...empty, status: 'error', errors: filterResult.errors?.length
      ? filterResult.errors.map((error) => errorOf(error.id || null, error, 'Answer analysis could not be loaded.'))
      : [errorOf(null, null, 'Answer analysis could not be loaded.')] };
    if (filterResult.status === 'loading') return empty;
    if (!Array.isArray(filterResult.ids) && !(filterResult.ids instanceof Set)) return { ...empty, status: 'error',
      errors: [errorOf(null, null, 'Matching students are unavailable. Please try again.')] };
    allowed = new Set(Array.from(filterResult.ids, idOf).filter(Boolean));
  }
  const matching = [...cohort].filter(([id]) => !allowed || allowed.has(id));
  const query = String(search || '').trim().toLocaleLowerCase();
  const rows = matching.filter(([, student]) => !query || [student.name, student.fullName, student.sapId, student.email, student.collegeEmail]
    .some((value) => value !== null && value !== undefined && String(value).toLocaleLowerCase().includes(query)))
    .map(([id, student]) => ({ student, ...(loaded.responses.get(id) || { id, state: 'N', picks: [] }) }));
  const receivedRows = rows.filter((row) => row.state !== 'N');
  const statistics = questionStatisticsOf(loaded.question, receivedRows);
  const notOnPaper = rows.length - receivedRows.length;
  const byState = new Map(statistics.outcomes.map((outcome) => [outcome.id, outcome]));
  const outcomes = ANSWER_ANALYSIS_OUTCOMES.map((outcome) => ({ ...outcome,
    count: outcome.id === 'N' ? notOnPaper : byState.get(outcome.id).count,
    percent: outcome.id === 'N' ? percentOf(notOnPaper, rows.length) : byState.get(outcome.id).percent,
    denominator: outcome.id === 'N' ? rows.length : receivedRows.length }));
  return { status: 'ready', errors: [], rows, shown: rows.length, total: rows.length, cohortTotal: matching.length,
    totalSubmitted: cohort.size, received: receivedRows.length, notOnPaper, optionDenominator: receivedRows.length,
    outcomes, options: statistics.options };
}
