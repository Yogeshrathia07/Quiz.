import { useState } from 'react';
import { post } from '../../lib/api.js';
import { Modal } from '../../components/Modal.jsx';

const SAP_ID_LENGTH = 9;

/**
 * Asks a student who has no SAP ID on file for it. It can be saved once:
 * after that only an administrator can change it, so the form asks for it
 * twice to catch a typo.
 */
export function SapIdPrompt({ onClose, onSaved, showToast }) {
  const [sapId, setSapId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const digits = (value) => value.replace(/\D/g, '').slice(0, SAP_ID_LENGTH);

  const save = async (event) => {
    event.preventDefault();
    if (sapId !== confirm) { showToast('The two SAP IDs do not match.'); return; }
    setBusy(true);
    try {
      const data = await post('/api/student/profile/sap-id', { sapId });
      showToast('SAP ID saved.');
      onSaved(data.profile);
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <Modal label="Add your SAP ID" onClose={onClose}>
      <h1>Add your SAP ID</h1>
      <p>Your account does not have a SAP ID yet. It is used on every test you take and in your results.</p>
      <p className="notice">Check it carefully — once saved, only an administrator can change it.</p>
      <form className="email-sign-in" onSubmit={save}>
        <label className="field-label" htmlFor="own-sap-id">SAP ID</label>
        <input
          id="own-sap-id" className="text-input" required autoFocus inputMode="numeric"
          pattern={`[0-9]{${SAP_ID_LENGTH}}`} minLength={SAP_ID_LENGTH} maxLength={SAP_ID_LENGTH}
          placeholder="e.g. 500123456" value={sapId} onChange={(event) => setSapId(digits(event.target.value))}
        />
        <label className="field-label" htmlFor="own-sap-id-confirm">Confirm SAP ID</label>
        <input
          id="own-sap-id-confirm" className="text-input" required inputMode="numeric"
          pattern={`[0-9]{${SAP_ID_LENGTH}}`} minLength={SAP_ID_LENGTH} maxLength={SAP_ID_LENGTH}
          value={confirm} onChange={(event) => setConfirm(digits(event.target.value))}
        />
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>Later</button>
          <button className="button button-primary" type="submit" disabled={busy || sapId.length !== SAP_ID_LENGTH}>
            {busy ? 'Saving…' : 'Save SAP ID'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
