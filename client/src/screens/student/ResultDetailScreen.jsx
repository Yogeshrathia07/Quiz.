import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useCached } from '../../lib/cache.js';
import { dateTime, durationLabel } from '../../lib/format.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { AnswerReview, DownloadResponses, ScoreRing, TypeBreakdown, useMyResponses } from './ResultScreen.jsx';

/** Right, wrong and the rest, as a few numbers under the score - only those that are not zero, past the first two. */
function Tally({ summary }) {
  const items = [
    ['right', 'Right', summary.correct, true],
    ['wrong', 'Wrong', summary.incorrect, true],
    ['part', 'Part', summary.partial],
    ['blank', 'Blank', summary.unanswered],
    ['pending', 'Unmarked', summary.ungraded]
  ].filter(([, , value, always]) => always || value > 0);
  return (
    <dl className="result-tally">
      {items.map(([id, label, value]) => <div key={id} className={`is-${id}`}><dt>{label}</dt><dd>{value || 0}</dd></div>)}
    </dl>
  );
}

/**
 * One handed-in test, opened from My results (or a teacher's Taken by me):
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
  const backLabel = `Back to ${isStudent ? 'My results' : 'Taken by me'}`;
  // A round arrow inside the card, not a link above it.
  const backButton = (
    <button className="result-back" type="button" onClick={() => go(back)} aria-label={backLabel} title={backLabel}>
      <ArrowLeft size={18} aria-hidden="true"/>
    </button>
  );
  const total = row ? row.totalMarks ?? row.totalQuestions : 0;
  const summary = review.data?.summary;

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
              <div className="result-score-block">
                <ScoreRing score={row.score} total={total}/>
                {summary && <Tally summary={summary}/>}
              </div>
            ) : (
              <>
                <p className="result-pending">{row.message || 'Your marks are not available yet.'}</p>
                {summary && <Tally summary={summary}/>}
              </>
            )}
            {review.data && <TypeBreakdown answers={review.data.answers}/>}
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
