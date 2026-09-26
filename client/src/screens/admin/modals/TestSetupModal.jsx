import { useState } from 'react';
import { api } from '../../../lib/api.js';
import { dateTime, localDateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { EndChoice, LIVE_END_OPTIONS } from '../../../components/TestWindowFields.jsx';
import { nowValue } from '../../../components/DateTimeField.jsx';
import { EndTimeField } from '../../../components/EndTimeField.jsx';

/**
 * "Extend time" on a running test: when it ends, and nothing else - every
 * other setting, and the questions, are changed with Edit test. The quick
 * "+15 min" picks and the exact time come from the same end-time editor.
 */
export function TestSetupModal({ code, test, onClose, onSaved, showToast }) {
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
      <h1>Change the end time</h1>
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
        <p className="help">Every student sees the new end time at once. To change questions or other settings, use Edit test.</p>
        <div className="modal-actions">
          <button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save end time'}</button>
        </div>
      </form>
    </Modal>
  );
}
