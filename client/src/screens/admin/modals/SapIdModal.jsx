import { useState } from 'react';
import { post } from '../../../lib/api.js';
import { Modal } from '../../../components/Modal.jsx';

export function SapIdModal({ code, registration, onClose, onSaved, showToast }) {
  const [sapId, setSapId] = useState(registration.sapId || '');
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await post(`/api/admin/tests/${encodeURIComponent(code)}/registrations/${encodeURIComponent(registration.id)}/sap-id`, { sapId });
      showToast('SAP ID updated.');
      onSaved(updated);
      onClose();
    } catch (error) { setSaving(false); showToast(error.message); }
  };

  return (
    <Modal label="Edit student SAP ID" onClose={onClose}>
      <h1>Edit SAP ID</h1>
      <p>Use exactly nine digits. This updates the student profile and this test registration.</p>
      <form onSubmit={save}>
        <label className="field-label">SAP ID</label>
        <input
          className="text-input"
          required
          inputMode="numeric"
          pattern="[0-9]{9}"
          minLength="9"
          maxLength="9"
          value={sapId}
          onChange={(event) => setSapId(event.target.value.replace(/\D/g, '').slice(0, 9))}
        />
        <div className="modal-actions">
          <button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save SAP ID'}</button>
        </div>
      </form>
    </Modal>
  );
}
