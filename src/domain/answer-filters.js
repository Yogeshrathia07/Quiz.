/** Shared, data-only answer selection rules for Analysis and dashboard links. */
export const ANSWER_FILTER_LIMITS = Object.freeze({ questions: 32, options: 32, idLength: 128, urlLength: 16_000 });
export const ANSWER_FILTER_STATES = Object.freeze([
  { id: 'O', label: 'Correct' }, { id: 'W', label: 'Incorrect' }, { id: 'P', label: 'Partial' },
  { id: 'B', label: 'Unanswered' }, { id: 'Q', label: 'Still to mark' }, { id: 'N', label: 'Not on paper' }
].map(Object.freeze));

const STATES = new Set(ANSWER_FILTER_STATES.map(({ id }) => id));
const MODES = new Set(['all', 'any']);
const OPTION_RULES = new Set(['selected', 'not-selected']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const empty = () => ({ mode: 'all', questions: [] });
const idOf = (value) => (typeof value === 'string' || typeof value === 'number') && String(value).trim() && !/[\u0000-\u001f\u007f]/.test(String(value))
  && String(value).trim().length <= ANSWER_FILTER_LIMITS.idLength ? String(value).trim() : null;
const optionIndex = (value) => /^(0|[1-9]\d{0,3})$/.test(String(value)) ? Number(value) : null;
const optionCount = (question) => question.type === 'short' || question.manualGrading ? 0 : question.options.length;

function invalid(message, code = 'ANSWER_FILTER_INVALID') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function inspected(raw, questions = null) {
  const issues = [];
  const issue = (id, reason) => issues.push({ id, message: reason });
  if (!record(raw)) return { filters: empty(), issues: raw == null ? [] : [{ id: null, message: 'Answer filters must be an object.' }] };
  if (Object.keys(raw).some((key) => !['mode', 'questions'].includes(key))) issue(null, 'The answer filter contains an unknown setting.');
  if (raw.mode !== undefined && !MODES.has(raw.mode)) issue(null, 'Choose all or any question conditions.');
  const mode = raw.mode === 'any' ? 'any' : 'all';
  if (raw.questions !== undefined && !Array.isArray(raw.questions)) issue(null, 'Question conditions must be a list.');
  const entries = Array.isArray(raw.questions) ? raw.questions : [];
  if (entries.length > ANSWER_FILTER_LIMITS.questions) issue(null, `Use at most ${ANSWER_FILTER_LIMITS.questions} question conditions.`);
  const known = Array.isArray(questions) ? new Map(questions.map((question) => [idOf(question?.id), question])) : null;
  const found = new Map();
  for (const entry of entries.slice(0, ANSWER_FILTER_LIMITS.questions)) {
    const id = idOf(entry?.id);
    if (!record(entry) || !id) { issue(null, 'A question condition has an invalid ID.'); continue; }
    if (Object.keys(entry).some((key) => !['id', 'optionMatch', 'options', 'states'].includes(key))) issue(id, 'A question condition contains an unknown setting.');
    if (known && !known.has(id)) { issue(id, 'This question is no longer available.'); continue; }
    if (found.has(id)) issue(id, 'A question can have only one condition.');
    if (entry.optionMatch !== undefined && !MODES.has(entry.optionMatch)) issue(id, 'Choose all or any option rules.');
    const optionMatch = entry.optionMatch === 'any' ? 'any' : 'all';
    const question = known?.get(id);
    // The compact matrix has no options. Bounds can be checked only after the
    // actual question has loaded; otherwise a valid pending rule would vanish.
    const limit = question && (question.type === 'short' || question.manualGrading) ? 0
      : question && Array.isArray(question.options) ? question.options.length : null;
    if (entry.options !== undefined && !record(entry.options)) issue(id, 'Option rules must be an object.');
    const values = record(entry.options) ? Object.entries(entry.options) : [];
    if (values.length > ANSWER_FILTER_LIMITS.options) issue(id, `Use at most ${ANSWER_FILTER_LIMITS.options} option rules per question.`);
    const options = {};
    for (const [key, rule] of values.slice(0, ANSWER_FILTER_LIMITS.options)) {
      if (rule === 'ignore' || rule === null || rule === undefined) continue;
      const index = optionIndex(key);
      if (index === null || !OPTION_RULES.has(rule)) { issue(id, 'An option rule is invalid.'); continue; }
      if (limit !== null && index >= limit) { issue(id, `Option ${index + 1} is no longer available.`); continue; }
      options[index] = rule;
    }
    if (entry.states !== undefined && !Array.isArray(entry.states)) issue(id, 'Outcomes must be a list.');
    if (Array.isArray(entry.states) && entry.states.length > 32) issue(id, 'There are too many outcome choices.');
    const wanted = new Set();
    for (const value of Array.isArray(entry.states) ? entry.states.slice(0, 32) : []) {
      const state = value === '.' ? 'N' : value;
      if (state === 'any') { wanted.add('any'); continue; }
      if (!STATES.has(state)) issue(id, 'An outcome is invalid.');
      else wanted.add(state);
    }
    const states = wanted.has('any') || wanted.size === STATES.size ? [] : ANSWER_FILTER_STATES.map(({ id: state }) => state).filter((state) => wanted.has(state));
    if (Object.keys(options).length || states.length) found.set(id, { id, optionMatch, options, states });
    else found.delete(id);
  }
  return { filters: { mode, questions: [...found.values()] }, issues };
}

/** Inactive clauses are removed. A supplied question list is authoritative;
 * option bounds are checked only for questions with their loaded options. */
export function sanitizeAnswerFilters(raw, questions = null) { return inspected(raw, questions).filters; }

/** Parse a URLSearchParams value (JSON, not a whole URL). Strict server callers
 * reject malformed/stale rules instead of silently broadening their selection. */
export function parseAnswerFilters(raw, { questions = null, strict = false } = {}) {
  let value = raw;
  const fail = (message) => { if (strict) throw invalid(message); return empty(); };
  if (typeof value === 'string') {
    if (!value.trim()) return empty();
    if (value.length > ANSWER_FILTER_LIMITS.urlLength) return fail('The answer filter link is too long.');
    try { value = JSON.parse(value); } catch { return fail('The answer filter link is invalid.'); }
    if (!record(value)) return fail('The answer filter link must contain an object.');
  }
  const result = inspected(value, questions);
  if (strict && result.issues.length) throw invalid(result.issues[0].message);
  return result.filters;
}

export const decodeAnswerFilters = (value, questions = null) => parseAnswerFilters(value, { questions, strict: true });
/** The compact JSON goes directly into URLSearchParams.set('af', value).
 * Do not call encodeURIComponent again. An empty filter needs no URL value. */
export function encodeAnswerFilters(filters, questions = null) {
  const clean = sanitizeAnswerFilters(filters, questions);
  if (!clean.questions.length) return '';
  const value = JSON.stringify(clean);
  if (value.length > ANSWER_FILTER_LIMITS.urlLength) throw invalid('The answer filter link is too long.');
  return value;
}

/** Both the caller's cohort and each lookup must be complete: null means this
 * submitted student's paper did NOT contain the question, never "not loaded".
 * State and option expressions are ANDed; outcome choices are ORed. */
export function matchesAnswerFilters(filters, getResponseById) {
  const clauses = filters?.questions || [];
  if (!clauses.length) return true;
  const matches = (clause) => {
    const row = getResponseById(clause.id);
    const state = row == null ? 'N' : row.state === '.' ? 'N' : row.state;
    if (!STATES.has(state)) throw invalid('A question response is unavailable.', 'ANSWER_FILTER_DATA_INVALID');
    if (clause.states.length && !clause.states.includes(state)) return false;
    const options = Object.entries(clause.options);
    if (!options.length) return true;
    // Not on a paper is NOT an unselected option. Blank received questions do
    // have no selected options; unmarked received answers keep their picks.
    if (state === 'N') return false;
    if (state !== 'B' && !Array.isArray(row.picks)) throw invalid('Option selections are unavailable.', 'ANSWER_FILTER_DATA_INVALID');
    const picks = new Set(state === 'B' ? [] : row.picks.map(optionIndex).filter((index) => index !== null));
    const test = ([index, rule]) => rule === 'selected' ? picks.has(Number(index)) : !picks.has(Number(index));
    return clause.optionMatch === 'any' ? options.some(test) : options.every(test);
  };
  return filters.mode === 'any' ? clauses.some(matches) : clauses.every(matches);
}

const detailOf = (details, id) => details instanceof Map ? details.get(id) : record(details) && own(details, id) ? details[id] : undefined;
const errorText = (problem) => String(problem?.message || problem || 'Question responses could not be loaded.').slice(0, 300);

/** Match matrix students/IDs against lazy question replies. Missing/error data
 * returns ids:null, so callers can display loading/error without presenting a
 * fabricated empty selection. The cohort must contain submitted students only.
 * details: Map/object of qid -> {question,responses}, {data}, {loading:true},
 * {status:'loading'|'error',error}, or {error}. No network work happens here. */
export function evaluateAnswerFilters(raw, students, details) {
  const cohort = [...new Set(Array.from(students || [], (student) => idOf(record(student) ? student.id : student)).filter(Boolean))];
  const initial = inspected(raw);
  const result = { status: 'idle', ids: cohort, filters: initial.filters, active: initial.filters.questions.length, pending: [], errors: [], ignored: [...initial.issues] };
  if (initial.issues.length) {
    result.status = 'error'; result.ids = null; result.active = Math.max(1, result.active);
    result.errors = [...initial.issues];
    return result;
  }
  if (!result.active) return result;
  const cohortIds = new Set(cohort);
  const questions = [];
  const responses = new Map();
  for (const clause of initial.filters.questions) {
    const held = detailOf(details, clause.id);
    if (held?.error || held?.status === 'error') {
      result.errors.push({ id: clause.id, message: errorText(held.error) }); continue;
    }
    if (!held || held.loading || held.status === 'loading' || (own(held, 'data') && held.data == null && held.status !== 'ready')) { result.pending.push(clause.id); continue; }
    const data = held.data ?? held;
    if (!record(data.question) || String(data.question.id) !== clause.id || !Array.isArray(data.question.options) || !Array.isArray(data.responses)) {
      result.errors.push({ id: clause.id, message: 'Question responses are incomplete. Please try again.' }); continue;
    }
    questions.push(data.question);
    const rows = new Map();
    let malformed = false;
    for (const row of data.responses) {
      const id = idOf(row?.id);
      if (!record(row) || !id) { malformed = true; continue; }
      if (cohortIds.has(id)) rows.set(id, row);
    }
    const needsPicks = Object.keys(clause.options).some((index) => Number(index) < optionCount(data.question));
    for (const row of rows.values()) {
      const state = row.state === '.' ? 'N' : row.state;
      if (!STATES.has(state) || (needsPicks && !['B', 'N'].includes(state) && !Array.isArray(row.picks))) malformed = true;
    }
    if (malformed) result.errors.push({ id: clause.id, message: 'Some question responses are incomplete. Please try again.' });
    responses.set(clause.id, rows);
  }
  if (result.errors.length || result.pending.length) {
    result.status = result.errors.length ? 'error' : 'loading'; result.ids = null;
    return result;
  }
  const checked = inspected(initial.filters, questions);
  result.ignored.push(...checked.issues);
  if (checked.issues.length) {
    result.status = 'error'; result.ids = null; result.errors = [...checked.issues];
    return result;
  }
  result.filters = checked.filters;
  result.active = checked.filters.questions.length;
  if (!result.active) return result;
  result.status = 'ready';
  result.ids = cohort.filter((id) => matchesAnswerFilters(checked.filters, (questionId) => responses.get(questionId).get(id) ?? null));
  return result;
}
