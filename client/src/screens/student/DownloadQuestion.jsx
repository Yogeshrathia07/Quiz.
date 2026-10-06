import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';

/** What a download of one's own answers holds, said once before it starts (My results, the result page). */
export function DownloadQuestion({ result, onConfirm, onCancel }) {
  return (
    <ConfirmDialog title="Download your answers?" onConfirm={onConfirm} onCancel={onCancel}>
      An Excel file of {result.title ? `“${result.title}”` : 'this test'}: your answers, the correct ones and your marks
      {result.pendingManual ? ' (short answers not marked yet show as unmarked)' : ''}.
    </ConfirmDialog>
  );
}
