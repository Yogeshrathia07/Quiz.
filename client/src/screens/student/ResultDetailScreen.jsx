import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useCached } from '../../lib/cache.js';
import { dateTime, durationLabel } from '../../lib/format.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { AnswerReview, DownloadResponses, TypeBreakdown, useMyResponses } from './ResultScreen.jsx';
import { MarksGauge } from '../../components/MarksGauge.jsx';
import { ClassComparison } from './ClassComparison.jsx';

const roundMarks = (value) => Math.round(value * 100) / 100;
const questionsWord = (count) => `${count} question${count === 1 ? '' : 's'}`;
const marksWord = (value) => `${value} mark${value === 1 ? '' : 's'}`;

/**
 * How the questions went, in the gauge's three colours and its order: Right
 * (blue), still to mark (yellow), Wrong - with part marks and blanks, as the
 * answer filter counts them (red). A pointer resting on one gives its marks.
 * Beside the gauge (`stacked`), one under the other and all three always, one
 * for each of its parts; elsewhere still to mark only while there are some.
 */
function Tally({ summary, answers, stacked = false }) {
  const marked = (answers || []).filter((answer) => answer.marks !== null);
  const sum = (list, value) => roundMarks(list.reduce((total, answer) => total + (Number(value(answer)) || 0), 0));
  const right = marked.filter((answer) => answer.isCorrect === true);
  const wrong = marked.filter((answer) => answer.isCorrect !== true);
  const waiting = (answers || []).filter((answer) => answer.marks === null);
  const wrongCount = summary.incorrect + summary.partial + summary.unanswered;
  const items = [
    ['right', 'Right', summary.correct, answers && `${questionsWord(summary.correct)} right: ${marksWord(sum(right, (answer) => answer.marks))} earned`],
    (summary.ungraded > 0 || stacked) && ['pending', 'Unmarked', summary.ungraded, answers && (summary.ungraded > 0
      ? `${questionsWord(summary.ungraded)} to be marked, worth ${marksWord(sum(waiting, (answer) => answer.maxMarks))}`
      : 'Nothing left to mark')],
    ['wrong', 'Wrong', wrongCount, answers && `${questionsWord(wrongCount)} wrong, part-marked or blank: ${marksWord(sum(wrong, (answer) => answer.maxMarks - answer.marks))} lost`]
  ].filter(Boolean);
  return (
    <dl className={`result-tally${stacked ? ' is-stack' : ''}`}>
      {items.map(([id, label, value, tip]) => (
        <div key={id} className={`is-${id}`} data-tip={tip || undefined}><dt>{label}</dt><dd>{value || 0}</dd></div>
      ))}
    </dl>
  );
}

/**
 * One handed-in test, opened from My results (or a teacher's Taken, under Tests):
 * the score as a ring, how many right and wrong, the Excel as a round green
 * button, and every answer with the right one and its marks - read on the
 * page, no download needed. Beside the answers on a laptop, above them on a
 * phone or tablet. Found by the signed-in account, not the device the test
 * was taken on, so it opens on any phone or laptop.
 */
export function ResultDetailScreen({ code, go, showToast, isStudent = true }) {
  // The row as My results last had it (shown at once), checked again behind;
  // the answers are asked for at the same time, not once the row is in.
  const list = useCached('/api/me/results');
  const row = list.data
    ? (list.data.results || []).find((entry) => entry.code === code && entry.attemptStatus === 'submitted') || null
    : list.error ? null : undefined;
  const told = useRef(null);
  useEffect(() => {
    if (list.error && !list.data && told.current !== list.error) { told.current = list.error; showToast(list.error.message); }
  }, [list.error, list.data, showToast]);
  const review = useMyResponses(code, row === undefined || Boolean(row?.canDownload));
  const back = isStudent ? '/' : '/?admin=tests&view=taken';
  const backLabel = `Back to ${isStudent ? 'My results' : 'Taken'}`;
  // A round arrow inside the card, not a link above it.
  const backButton = (
    <button className="result-back" type="button" onClick={() => go(back)} aria-label={backLabel} title={backLabel}>
      <ArrowLeft size={18} aria-hidden="true"/>
    </button>
  );
  const total = row ? row.totalMarks ?? row.totalQuestions : 0;
  const summary = review.data?.summary;
  const answers = review.data?.answers;
  // The marks still to be marked: from the list (pendingMarks), else counted from the answers.
  const pendingMarks = row?.pendingMarks
    || roundMarks((answers || []).filter((answer) => answer.marks === null).reduce((sum, answer) => sum + (Number(answer.maxMarks) || 0), 0));

  return (
    <section className="result-page">
      {row === undefined ? (
        <Skeleton rows={3} label="Loading your result"/>
      ) : row === null ? (
        <div className="card empty empty-state result-missing">
          {backButton}
          <strong>No handed-in paper here</strong>
          <p>This test is not among the ones you have submitted.</p>
        </div>
      ) : (
        <div className={`result-layout${row.canDownload ? ' has-review' : ''}`}>
          <aside className="card result-side">
            <div className="result-side-top">
              {backButton}
              <p className={`result-state ${row.released ? 'is-out' : 'is-waiting'}`}>{row.released ? 'Marks released' : 'Marks pending'}</p>
              <DownloadResponses result={row}/>
            </div>
            <div className="result-side-head">
              <h1 className="result-heading">{row.title}</h1>
              <p className="result-when">
                {dateTime(row.submittedAt)}{row.timeTakenSeconds !== null ? ` · ${durationLabel(row.timeTakenSeconds)}` : ''}
              </p>
            </div>
            {row.released ? (
              <div className="result-gauge-card">
                <MarksGauge score={row.score} total={total} pending={pendingMarks}
                  caption={row.pendingManual > 0 ? <><b>{row.pendingManual}</b> to mark</> : 'all marked'}/>
                {summary && <Tally summary={summary} answers={answers} stacked/>}
              </div>
            ) : (
              <>
                <p className="result-pending">{row.message || 'Your marks are not available yet.'}</p>
                {summary && <Tally summary={summary} answers={answers}/>}
              </>
            )}
            {review.data && <TypeBreakdown answers={review.data.answers}/>}
            {review.data?.comparison && <ClassComparison comparison={review.data.comparison} answers={review.data.answers}/>}
            {/* Pending, the message above already says so; released, it qualifies the score. */}
            {row.released && row.pendingManual > 0 && (
              <p className="notice">
                {row.pendingManual} short answer{row.pendingManual === 1 ? ' is' : 's are'} not marked yet. The score counts only what is marked so far.
              </p>
            )}
            {row.released && !row.canDownload && <p className="help">Your answers and the correct ones show here once your teacher closes the test.</p>}
          </aside>
          {row.canDownload && <div className="card result-main"><AnswerReview code={code} review={review}/></div>}
        </div>
      )}
    </section>
  );
}
