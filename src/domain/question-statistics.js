import { earnedMarks } from './marks.js';

/** Same outcomes used by the Analysis matrix, including teacher-given marks. */
export function answerState(marks, given, worth) {
  if (!given) return 'B';
  if (marks === null) return 'Q';
  if (marks >= worth) return 'O';
  return marks > 0 ? 'P' : 'W';
}

/** One student's final submitted response. No names, email or written answer. */
export function questionResponse(question, registration, worth) {
  const attempt = registration.attempt;
  if (attempt?.status !== 'submitted') return null;
  const id = String(question.id);
  // Legacy duplicates are resolved exactly as the matrix: last record wins.
  const answer = (attempt.answers || []).filter((entry) => String(entry.questionId) === id).at(-1);
  if (!answer && !(attempt.questions || []).some((entry) => String(entry.questionId) === id)) return null;
  const given = Boolean(answer?.answeredAt);
  const choice = !question.manualGrading && question.type !== 'short';
  const picks = choice && given ? [...new Set((answer.selectedOptions || [])
    .filter((value) => /^\d+$/.test(String(value)))
    .map(Number).filter((index) => Number.isSafeInteger(index) && index < (question.options || []).length))].sort((a, b) => a - b) : [];
  return { id: registration.id, state: answerState(earnedMarks(answer), given, worth), picks };
}
