import { PenLine } from 'lucide-react';
import { durationLabel, shortDateTime } from '../../lib/format.js';
import { Detail, ExpandableRow, Issue, StudentIdentity } from './StudentRow.jsx';

/** One submitted result: marks and answer review only; live controls belong under Students. */
export function ResponseRow({ registration, openAnalysis, isBusy, columns }) {
  const awaiting = registration.manualTotal > registration.manualGraded;

  return (
    <ExpandableRow
      columns={columns}
      label={registration.name}
      cells={<>
        <td data-label="Student"><StudentIdentity registration={registration}/></td>
        <td data-label="Answered" className="cell-num col-answered">{registration.answeredCount}/{registration.totalQuestions}</td>
        <td data-label="Score" className="cell-num">
          <div className="cell-row">
            <strong>{registration.score ?? '—'}</strong>
            {awaiting && <Issue icon={PenLine} label={`${registration.manualTotal - registration.manualGraded} short answer(s) to mark`}>{registration.manualTotal - registration.manualGraded}</Issue>}
          </div>
        </td>
        <td data-label="Finished" className="cell-muted">{shortDateTime(registration.submittedAt)}</td>
      </>}
      details={<>
        <Detail label="Email">{registration.email}</Detail>
        <Detail label="Finished">{shortDateTime(registration.submittedAt)}</Detail>
        {registration.timeTakenSeconds !== null && registration.timeTakenSeconds !== undefined && <Detail label="Time taken">{durationLabel(registration.timeTakenSeconds)}</Detail>}
        <Detail label="Score">{registration.score ?? 'Awaiting marking'} / {registration.totalQuestions}</Detail>
        {registration.manualTotal > 0 && <Detail label="Short answers">{awaiting ? `${registration.manualTotal - registration.manualGraded} to mark` : 'All marked'}</Detail>}
      </>}
      actions={<>
        <button className="button button-secondary button-small" disabled={isBusy} onClick={() => openAnalysis(registration)}>{awaiting ? 'Review & mark' : 'View result'}</button>
      </>}
    />
  );
}
