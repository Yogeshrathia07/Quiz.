import { createHash } from 'node:crypto';

/**
 * A paper revision deliberately ignores the server clock. The clock changes on
 * every heartbeat even when the paper does not, which would defeat conditional
 * polling. Deadlines and time-over state remain in the digest, so an actual
 * transition still produces a new revision.
 */
export function attemptRevision(attempt) {
  const { serverTime: _serverTime, revision: _revision, ...stable } = attempt || {};
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 18);
}

export function revisionedAttempt(attempt) {
  return { ...attempt, revision: attemptRevision(attempt) };
}

/**
 * An answer acknowledgement never repeats question prompts, choices, or the
 * rest of the paper. It contains just the saved value and the small attempt
 * state which may have changed while the request was in flight.
 */
export function compactAnswerResponse(attempt, questionId) {
  const revision = attemptRevision(attempt);
  const { questions: _questions, ...state } = attempt || {};
  const question = (attempt?.questions || []).find((entry) => entry.id === Number(questionId));
  return {
    state: { ...state, revision },
    answer: question ? {
      questionId: question.id,
      selectedOptions: question.selectedOptions || [],
      answerText: question.answerText || '',
      answered: Boolean(question.answered),
      locked: Boolean(question.locked)
    } : null
  };
}

/** Presence/integrity batches need the latest counters, not another paper. */
export function compactAttemptState(attempt, extra = {}) {
  const revision = attemptRevision(attempt);
  const { questions: _questions, ...state } = attempt || {};
  return { state: { ...state, revision }, ...extra };
}
