import { useState } from 'react';
import { post } from '../../../lib/api.js';
import { durationLabel } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';

/** Under this, a reopened paper would be over before it began: minutes must be added. */
const MIN_LEFT_MS = 60_000;
const MAX_MINUTES = 24 * 60;
const PICKS = [5, 10, 15, 30];

/**
 * Reopen one student's handed-in paper, where they left off. On a timed test
 * it shows the time they still have; if none is left, minutes for them alone
 * must be added first. The server checks all of this again.
 */
export function ReopenPaperModal({ code, test, registration, onClose, onSaved, showToast }) {
  const endsAt = registration.ownDeadlineAt ? Date.parse(registration.ownDeadlineAt) : null;
  const timed = Number.isFinite(endsAt);
  const leftMs = timed ? endsAt - Date.now() : Infinity;
  const needsTime = timed && leftMs < MIN_LEFT_MS;
  const [text, setText] = useState(needsTime ? '10' : '');
  const [saving, setSaving] = useState(false);
  const minutes = Number(text) || 0;
  const closedByTeacher = test.isClosed && !test.closedAutomatically;
  // Closed and marked: students could download their answers with the key.
  const keyOut = test.isClosed && (test.resultReleaseMode === 'instant' || test.resultReleaseMode === 'after_quiz' || Boolean(test.resultsReleasedAt));
  const valid = minutes <= MAX_MINUTES && (!needsTime || minutes >= 1);
  const name = String(registration.name || '').replace(/^Guest:\s*/, '');

  const reopen = async (event) => {
    event.preventDefault();
    if (!valid || closedByTeacher || saving) return;
    setSaving(true);
    try {
      const updated = await post(`/api/admin/tests/${encodeURIComponent(code)}/registrations/${encodeURIComponent(registration.id)}/reopen`, { addMinutes: minutes });
      showToast(`${name}'s paper is open again${minutes ? `, with ${minutes} more min` : ''}.`, 'success');
      onSaved(updated);
      onClose();
    } catch (error) { setSaving(false); showToast(error.message); }
  };

  const status = !timed ? 'No time limit.'
    : needsTime ? 'Their time is over. Add minutes to reopen.'
      : `${durationLabel(Math.round(leftMs / 1000))} left.`;

  return (
    <Modal label="Reopen paper" onClose={onClose} className="reopen-dialog">
      <h1>Reopen {name}&apos;s paper</h1>
      {closedByTeacher ? (
        <p className="reopen-note">You closed this test. Resume it first (More → Resume test).</p>
      ) : (
        <form onSubmit={reopen}>
          <p className={`reopen-note${needsTime ? ' is-over' : ''}`}>
            {status} Answers are kept{test.isClosed ? '; the test opens for them alone' : ''}.
          </p>
          {keyOut && <p className="reopen-note is-warn">The answer key is already out to students.</p>}
          {timed && (
            <div className="reopen-minutes" role="group" aria-label="Extra minutes, for this student only">
              {PICKS.map((pick) => (
                <button key={pick} type="button" className={minutes === pick ? 'is-on' : ''} aria-pressed={minutes === pick}
                  onClick={() => setText(minutes === pick && !needsTime ? '' : String(pick))}>+{pick}</button>
              ))}
              <label className="reopen-custom">
                <input inputMode="numeric" placeholder="0" aria-label="Extra minutes" value={text} style={{ width: `${Math.max(1, text.length) + 0.4}ch` }}
                  onChange={(event) => setText(event.target.value.replace(/\D/g, '').slice(0, 4))}/>
                min
              </label>
            </div>
          )}
          <div className="modal-actions">
            <button className="button button-primary" disabled={saving || !valid}>
              {saving ? 'Reopening…' : minutes ? `Reopen · +${minutes} min` : 'Reopen'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
