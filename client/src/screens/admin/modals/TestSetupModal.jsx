import { useState } from 'react';
import { api } from '../../../lib/api.js';
import { dateTime, localDateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { InfoTip } from '../../../components/InfoTip.jsx';
import { EndChoice, LIVE_END_OPTIONS } from '../../../components/TestWindowFields.jsx';
import { nowValue } from '../../../components/DateTimeField.jsx';
import { Stepper } from '../../../components/FormControls.jsx';
import { EndTimeField } from '../../../components/EndTimeField.jsx';

/**
 * "Extend time" on a running test: when it ends, and nothing else - every
 * other setting, and the questions, are changed with Edit test. The quick
 * "+15 min" picks and the exact time come from the same end-time editor.
 */
export function TestSetupModal(props) {
  return props.test.endMode === 'each' ? <OwnTimeModal {...props}/> : <EndTimeModal {...props}/>;
}

/**
 * Each student's own time has no end to move: more minutes go to everyone
 * still writing, from their own end (or from now, if theirs has passed). A
 * student who begins later gets the whole duration anyway.
 */
function OwnTimeModal({ code, test, onClose, onSaved, showToast }) {
  const [minutes, setMinutes] = useState(10);
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await api(`/api/admin/tests/${encodeURIComponent(code)}/end-time`, {
        method: 'POST',
        body: JSON.stringify({ addMinutes: Number(minutes) })
      });
      onSaved(updated);
      const count = updated.affectedCount || 0;
      showToast(count ? `${count} student${count === 1 ? '' : 's'} got ${minutes} more minute${Number(minutes) === 1 ? '' : 's'}.` : 'Nobody is writing right now.');
      onClose();
    } catch (error) { setSaving(false); showToast(error.message); }
  };

  return (
    <Modal label="Give more time" onClose={onClose}>
      <p className="eyebrow">{test.code}</p>
      <div className="page-heading">
        <h1>Give more time</h1>
        <InfoTip label="About giving more time">
          Each student has their own {test.durationMinutes} minutes from their Begin, so there is no end time to move. The minutes
          go to everyone still writing - from their own end, or from now if theirs has already passed. Someone who begins later
          gets the whole {test.durationMinutes} minutes anyway. For one student only, reopen or pause their paper.
        </InfoTip>
      </div>
      <div className="time-now">
        <div><span>Each student</span><strong>{test.durationMinutes} min from their own Begin</strong></div>
      </div>
      <form className="setup-form" onSubmit={save}>
        <Stepper id="own-more" label="More time for everyone still writing" value={minutes} min={1} max={24 * 60} step={5} unit="min"
          onChange={setMinutes} presets={[[5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min']]}/>
        <div className="modal-actions">
          <button className="button button-primary" disabled={saving || !(Number(minutes) >= 1)}>{saving ? 'Saving…' : `Give ${minutes} more min`}</button>
        </div>
      </form>
    </Modal>
  );
}

function EndTimeModal({ code, test, onClose, onSaved, showToast }) {
  // While it runs, a duration has become a real end time.
  const [endMode, setEndMode] = useState(test.untimed ? 'manual' : 'at');
  // No end yet (closed by hand): offer "30 minutes from now" if one is added.
  const [endsAt, setEndsAt] = useState(test.endsAt ? localDateTime(test.endsAt) : nowValue(30));
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    const endsAtMs = new Date(endsAt).getTime();
    if (endMode === 'at' && !Number.isFinite(endsAtMs)) return showToast('Choose the end time.');
    setSaving(true);
    try {
      const updated = await api(`/api/admin/tests/${encodeURIComponent(code)}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ endMode, ...(endMode === 'at' ? { endsAt: new Date(endsAtMs).toISOString() } : {}) })
      });
      onSaved(updated);
      showToast(endMode === 'at' ? `The test now ends at ${dateTime(endsAtMs)}.` : 'The test now ends when you close it.');
      onClose();
    } catch (error) { setSaving(false); showToast(error.message); }
  };

  return (
    <Modal label="Change the end time" onClose={onClose}>
      <p className="eyebrow">{test.code}</p>
      <div className="page-heading">
        <h1>Change the end time</h1>
        <InfoTip label="About changing the end time">Every student sees the new end time at once. To change questions or other settings, use Edit test.</InfoTip>
      </div>
      <div className="time-now">
        {test.untimed
          ? <div><span>Ends</span><strong>When you close it</strong></div>
          : <div><span>Ends automatically</span><strong>{dateTime(test.endsAt)}</strong></div>}
        {!test.untimed && new Date(test.endsAt).getTime() <= Date.now() && <span className="pill danger">Time is up — submitting papers</span>}
      </div>
      <form className="setup-form" onSubmit={save}>
        <EndChoice value={endMode} onChange={setEndMode} idPrefix="live" options={LIVE_END_OPTIONS}/>
        {endMode === 'at' && (
          <EndTimeField opensAt={test.startedAt || test.opensAt} endsAt={endsAt} savedEndsAt={test.endsAt} onChange={setEndsAt} idPrefix="live"/>
        )}
        <div className="modal-actions">
          <button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save end time'}</button>
        </div>
      </form>
    </Modal>
  );
}
