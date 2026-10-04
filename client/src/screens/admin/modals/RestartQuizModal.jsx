import { useState } from 'react';
import { downloadSpreadsheet, post } from '../../../lib/api.js';
import { dateTime, durationLabel } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { Stepper } from '../../../components/FormControls.jsx';

/**
 * Runs a started or finished test again from the beginning: every paper and
 * mark is cleared, approved students keep their place, and it starts now.
 */
export function RestartQuizModal({ code, test, counts, onClose, onSaved, showToast }) {
  // A set end time still comfortably ahead can be kept; one that has passed
  // (or is about to) needs a new length, or the test would end at once.
  const endMs = test.endsAt ? new Date(test.endsAt).getTime() : null;
  const setEnd = test.endMode === 'at';
  const endStillAhead = setEnd && endMs && endMs > Date.now() + 60_000;
  const [keepEnd, setKeepEnd] = useState(Boolean(endStillAhead));
  const [minutes, setMinutes] = useState(Math.max(5, Math.ceil((test.estimatedSeconds || 600) / 60)));
  const [busy, setBusy] = useState(false);

  const restart = async () => {
    setBusy(true);
    try {
      const body = setEnd && !keepEnd ? { addMinutes: Number(minutes) } : {};
      onSaved(await post(`/api/admin/tests/${encodeURIComponent(code)}/restart-quiz`, body));
      showToast('The quiz has restarted. Students begin again with a blank paper.');
      onClose();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  const timing = test.untimed ? 'It runs until you close it.'
    : test.endMode === 'each' ? `Each student gets ${durationLabel((test.durationMinutes || 0) * 60)} from their own Begin; it stays open until you close it.`
    : test.endMode === 'duration' ? `It runs for ${durationLabel((test.durationMinutes || 0) * 60)} from now.`
      : keepEnd ? `It ends at ${dateTime(test.endsAt)}, as set.` : `It runs for ${durationLabel(Number(minutes) * 60)} from now.`;

  return (
    <Modal label="Restart quiz" onClose={onClose}>
      <p className="eyebrow">{test.code}</p>
      <h1>Restart quiz</h1>
      <p>
        The quiz starts again <strong>now</strong>. Every student&apos;s answers and marks are cleared
        {counts.started ? <> — <strong>{counts.started} paper{counts.started === 1 ? '' : 's'}</strong></> : ''}. Approved students
        keep their place and begin again with a blank paper; anyone with the page open is taken back to Begin.
      </p>

      {setEnd && (
        <div className="restart-timing">
          {endStillAhead && (
            <label className="restart-choice">
              <input type="radio" name="restart-end" checked={keepEnd} onChange={() => setKeepEnd(true)}/>
              Keep the end time ({dateTime(test.endsAt)})
            </label>
          )}
          <label className="restart-choice">
            <input type="radio" name="restart-end" checked={!keepEnd} onChange={() => setKeepEnd(false)}/>
            {endStillAhead ? 'Run for a new length of time' : 'The end time has passed — run for:'}
          </label>
          {!keepEnd && (
            <Stepper id="restart-minutes" label="Minutes" value={minutes} min={1} max={1440} step={5} unit="min" onChange={setMinutes}
              presets={[[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 h']]}/>
          )}
        </div>
      )}
      <p className="help">{timing}</p>

      {counts.started > 0 && (
        <p className="notice">
          This cannot be undone.{' '}
          <button className="link-button" type="button" onClick={() => downloadSpreadsheet(test.code).catch((error) => showToast(error.message))}>
            Download the current results first
          </button>
        </p>
      )}

      <div className="modal-actions">
        <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="button button-danger" type="button" disabled={busy || (setEnd && !keepEnd && !(Number(minutes) >= 1))} onClick={restart}>
          {busy ? 'Restarting…' : 'Restart quiz now'}
        </button>
      </div>
    </Modal>
  );
}
