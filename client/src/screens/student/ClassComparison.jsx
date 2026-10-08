import { durationLabel } from '../../lib/format.js';

/*
 * How a student's paper stands against the class, on their result page - sent
 * by the server only once the test is closed and their marks are released
 * (registration-service myResponseView), as numbers: never another student's
 * name. Their place, their marks beside the class average and the highest,
 * their time beside the typical one, each kind of question, and the questions
 * worth another look (most of the class got them right) or worth a smile (few
 * did, and they did).
 */

const TYPE_SHORT = { mcq: 'MCQ', msq: 'MSQ', short: 'Short' };
const percent = (value) => (value === null || value === undefined ? '—' : `${Math.round(value)}%`);
/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function ordinal(value) {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  return `${value}${{ 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] || 'th'}`;
}

/** Their share of the marks on each kind of question, from their own marked answers. */
function ownTypes(answers) {
  const types = {};
  for (const answer of answers || []) {
    if (answer.marks === null) continue;
    const entry = types[answer.type] || (types[answer.type] = { marks: 0, worth: 0 });
    entry.marks += Number(answer.marks) || 0;
    entry.worth += Number(answer.maxMarks) || 0;
  }
  return Object.fromEntries(Object.entries(types).map(([type, entry]) => [type, entry.worth ? (entry.marks / entry.worth) * 100 : null]));
}

export function ClassComparison({ comparison, answers }) {
  if (!comparison) return null;
  const { you, class: room, rank, papers, betterThanPercent } = comparison;
  const bars = [
    ['you', 'You', you.percent],
    ['average', 'Class average', room.averagePercent],
    ['highest', 'Highest', room.highestPercent]
  ];
  const mine = ownTypes(answers);
  const types = Object.keys(mine).filter((type) => comparison.types?.[type] !== undefined);
  const known = (answers || []).filter((answer) => answer.classPercentRight !== null && answer.classPercentRight !== undefined && answer.marks !== null);
  const revisit = known.filter((answer) => !answer.isCorrect && answer.classPercentRight >= 60)
    .sort((a, b) => b.classPercentRight - a.classPercentRight).slice(0, 3);
  const proud = known.filter((answer) => answer.isCorrect && answer.classPercentRight <= 40)
    .sort((a, b) => a.classPercentRight - b.classPercentRight).slice(0, 3);
  return (
    <section className="result-compare" aria-label="How you did against the class">
      <h2>How you did</h2>
      <p className="result-rank">
        <strong>{ordinal(rank)}</strong> of {papers}
        {betterThanPercent !== null && betterThanPercent !== undefined && <span> · better than {betterThanPercent}% of the class</span>}
      </p>
      <ul className="result-compare-bars">
        {bars.map(([id, label, value]) => (
          <li key={id} className={`is-${id}`}>
            <span className="result-compare-name">{label}</span>
            <span className="result-compare-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }}/></span>
            <strong className="result-compare-value">{percent(value)}</strong>
          </li>
        ))}
      </ul>
      {you.seconds !== null && room.medianSeconds !== null && (
        <p className="result-compare-time">You took <strong>{durationLabel(you.seconds)}</strong> · the class typically took {durationLabel(room.medianSeconds)}</p>
      )}
      {types.length > 1 && (
        <ul className="result-compare-types">
          {types.map((type) => (
            <li key={type}><span>{TYPE_SHORT[type] || type}</span>you {percent(mine[type])} · class {percent(comparison.types[type])}</li>
          ))}
        </ul>
      )}
      {revisit.length > 0 && (
        <div className="result-compare-list">
          <h3>Worth another look</h3>
          <ul>{revisit.map((answer) => <li key={answer.questionNumber}><strong>Q{answer.questionNumber}</strong> {answer.classPercentRight}% of the class got it right</li>)}</ul>
        </div>
      )}
      {proud.length > 0 && (
        <div className="result-compare-list is-good">
          <h3>Well done</h3>
          <ul>{proud.map((answer) => <li key={answer.questionNumber}><strong>Q{answer.questionNumber}</strong> only {answer.classPercentRight}% of the class got it right</li>)}</ul>
        </div>
      )}
    </section>
  );
}
