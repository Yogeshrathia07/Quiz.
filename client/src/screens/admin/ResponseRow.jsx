import { PenLine } from 'lucide-react';
import { shortDateTime } from '../../lib/format.js';
import { initialsOf } from './review.js';
import { isGuest } from './student-filters.js';

const isFaculty = (registration) => registration.accountType === 'faculty';

/**
 * One handed-in paper in the Results list: who, how much they answered, their
 * marks (and how many short answers still wait), when they finished. The whole
 * row opens the review at their paper (modals/ResultReviewModal.jsx).
 */
export function ResponseRow({ registration, onReview, isBusy, frozen = false }) {
  const toMark = Math.max(0, (registration.manualTotal || 0) - (registration.manualGraded || 0));
  const open = () => { if (!isBusy) onReview(registration); };
  return (
    <tr className="result-row" tabIndex={0} aria-label={`${registration.name}: review`}
      onClick={(event) => { if (!event.target.closest('button, a')) open(); }}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); open(); } }}>
      <td data-label="Student">
        <div className="person">
          <span className={`person-avatar${isGuest(registration) ? ' is-guest' : ''}`} aria-hidden="true">{initialsOf(registration.name)}</span>
          <div className="person-detail">
            <strong>{registration.name}</strong>
            <span className="table-subtext">{isFaculty(registration) ? 'Faculty' : registration.sapId}</span>
          </div>
        </div>
      </td>
      <td data-label="Answered" className="cell-num col-answered">{registration.answeredCount}/{registration.totalQuestions}</td>
      <td data-label="Marks" className="cell-num">
        <span className="result-score"><strong>{registration.score ?? '—'}</strong>{registration.totalMarks ? <span className="cell-of">/{registration.totalMarks}</span> : null}</span>
        {toMark > 0 && !frozen && <span className="result-to-mark" title={`${toMark} short answer${toMark === 1 ? '' : 's'} to mark`}><PenLine size={12} aria-hidden="true"/>{toMark}</span>}
      </td>
      <td data-label="Finished" className="cell-muted">{shortDateTime(registration.submittedAt)}</td>
      <td data-label="Actions" className="result-action">
        <button className="button button-secondary button-small" type="button" disabled={isBusy} onClick={open}>{toMark > 0 && !frozen ? 'Mark' : 'Review'}</button>
      </td>
    </tr>
  );
}
