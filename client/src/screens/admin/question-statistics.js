const OUTCOMES = [
  { id: 'O', label: 'Correct', tone: 'correct' },
  { id: 'W', label: 'Incorrect', tone: 'incorrect' },
  { id: 'P', label: 'Partial credit', tone: 'partial' },
  { id: 'B', label: 'Unanswered', tone: 'blank' },
  { id: 'Q', label: 'Still to mark', tone: 'pending' }
];

/** Percent of submitted students who received this question, not selections.
 * A multiple-choice student's picks count once per option, not once per click. */
export function questionStatisticsOf(question, responses, studentIds = null) {
  const ids = studentIds === null ? null : new Set(Array.from(studentIds, String));
  const outcomes = new Set(OUTCOMES.map((outcome) => outcome.id));
  const rows = [...new Map((responses || [])
    .filter((row) => row.id !== null && row.id !== undefined && (!ids || ids.has(String(row.id))))
    .map((row) => [String(row.id), row])).values()].filter((row) => outcomes.has(row.state));
  const total = rows.length;
  const percent = (count) => total ? Math.round(count / total * 1000) / 10 : null;
  const counts = Object.fromEntries(OUTCOMES.map(({ id }) => [id, 0]));
  const picks = (question.options || []).map(() => 0);
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.state === 'B') continue;
    for (const index of new Set(row.picks || [])) {
      if (Number.isInteger(index) && index >= 0 && index < picks.length) picks[index] += 1;
    }
  }
  const correct = new Set((question.correctOptions || []).map(String));
  return {
    total, answered: total - counts.B,
    outcomes: OUTCOMES.map((outcome) => ({ ...outcome, count: counts[outcome.id], percent: percent(counts[outcome.id]) })),
    options: (question.options || []).map((text, index) => ({ index, text, correct: correct.has(String(index)), count: picks[index], percent: percent(picks[index]) }))
  };
}
