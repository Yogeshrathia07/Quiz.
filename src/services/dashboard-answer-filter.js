import { parseAnswerFilters, matchesAnswerFilters } from '../domain/answer-filters.js';
import { questionResponse } from '../domain/question-statistics.js';
import { questionMarks } from '../domain/marks.js';
import { PublicTestError } from '../lib/errors.js';

// Never fetch names, contacts, written answers, answer keys, or event logs
// while resolving a cohort. The ordinary bounded dashboard query loads only
// the rows on the requested page after these matching IDs are known.
export const ANSWER_FILTER_REGISTRATION_PROJECTION = {
  _id: 0, id: 1, 'attempt.status': 1, 'attempt.questions.questionId': 1,
  'attempt.answers.questionId': 1, 'attempt.answers.answeredAt': 1,
  'attempt.answers.isCorrect': 1, 'attempt.answers.selectedOptions': 1
};

// A query with this many UUIDs stays comfortably below MongoDB's 16 MiB BSON
// limit. Never truncate a class to an arbitrary first page: fail explicitly
// and ask for a narrower cohort instead if this exceptional limit is met.
export const MAX_ANSWER_FILTER_MATCHES = 100_000;

/** Indexed final answers avoid rescanning a long paper for every condition. */
export function answerFilterResponses(test, registration, filter, byId = new Map((test.questions || []).map((question) => [String(question.id), question]))) {
  const attempt = registration.attempt;
  if (attempt?.status !== 'submitted') return null;
  const answers = new Map((attempt.answers || []).map((answer) => [String(answer.questionId), answer]));
  const assigned = new Set((attempt.questions || []).map((entry) => String(entry.questionId)));
  const responses = new Map();
  for (const condition of filter.questions) {
    const question = byId.get(String(condition.id));
    const answer = answers.get(String(condition.id));
    // Delegate marks, blank answers, final duplicate precedence and choice
    // validity to the exact adapter used by the question statistics popup.
    const response = questionResponse(question, {
      id: registration.id,
      attempt: {
        status: attempt.status,
        answers: answer ? [answer] : [],
        questions: assigned.has(String(condition.id)) ? [{ questionId: question.id }] : []
      }
    }, questionMarks(test, question));
    responses.set(String(condition.id), response || { state: 'N', picks: [] });
  }
  return responses;
}

/** Must only be called after requireOwnedTest has authorised the test. */
export async function dashboardAnswerFilter(collection, test, raw) {
  if (raw === undefined) return null;
  let filter;
  try { filter = parseAnswerFilters(raw, { questions: test.questions || [], strict: true }); }
  catch (error) {
    throw new PublicTestError(400, error.message || 'This answer filter is not valid.', 'ANSWER_FILTER_INVALID');
  }
  // All ignored controls mean no cohort constraint, exactly as no `af`.
  if (!filter.questions.length) return null;
  const cursor = collection.find({ testCode: test.code, 'attempt.status': 'submitted' }, {
    projection: ANSWER_FILTER_REGISTRATION_PROJECTION
  });
  cursor.batchSize?.(500);
  const ids = [];
  const byId = new Map((test.questions || []).map((question) => [String(question.id), question]));
  let totalSubmitted = 0;
  try {
    for await (const registration of cursor) {
      // The query already enforces this; keep the adapter safe for imported
      // fixtures and unusual cursors rather than matching an unfinished paper.
      if (registration.attempt?.status !== 'submitted') continue;
      totalSubmitted += 1;
      const responses = answerFilterResponses(test, registration, filter, byId);
      if (!matchesAnswerFilters(filter, (questionId) => responses.get(String(questionId)))) continue;
      if (registration.id !== null && registration.id !== undefined) ids.push(registration.id);
      if (ids.length > MAX_ANSWER_FILTER_MATCHES) {
        throw new PublicTestError(400, 'This answer filter matches too many students. Narrow it before opening the list.', 'ANSWER_FILTER_TOO_BROAD');
      }
    }
  } finally { await cursor.close?.(); }
  return {
    match: { id: { $in: ids }, 'attempt.status': 'submitted' },
    metadata: { filter, matched: ids.length, totalSubmitted }
  };
}
