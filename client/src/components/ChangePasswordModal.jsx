import { useEffect, useState } from 'react';
import { api, post } from '../lib/api.js';
import { Modal } from './Modal.jsx';

/**
 * A signed-in user changes their own password. The current one is asked for
 * unless the account has none yet (it has only used Microsoft). Other devices
 * are signed out; this one stays signed in.
 */
export function ChangePasswordModal({ onClose, showToast }) {
  const [hasPassword, setHasPassword] = useState(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/auth/password').then((data) => setHasPassword(data.hasPassword)).catch((error) => { showToast(error.message); onClose(); });
  }, [onClose, showToast]);

  const save = async (event) => {
    event.preventDefault();
    if (next !== confirm) { showToast('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      await post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      showToast(hasPassword ? 'Password changed. Other devices were signed out.' : 'Password set. You can now log in with it.');
      onClose();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <Modal label="Change password" onClose={onClose}>
      <h1>{hasPassword === false ? 'Set a password' : 'Change password'}</h1>
      {hasPassword === null ? (
        <p>Loading…</p>
      ) : (
        <form className="email-sign-in" onSubmit={save}>
          {hasPassword ? (
            <>
              <label className="field-label" htmlFor="current-password">Current password</label>
              <input id="current-password" className="text-input" type="password" required autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)}/>
            </>
          ) : (
            <p className="help">Your account has no password yet (you signed in with Microsoft). Set one to also log in with your email.</p>
          )}
          <label className="field-label" htmlFor="new-password">New password</label>
          <input id="new-password" className="text-input" type="password" required minLength="8" maxLength="128" autoComplete="new-password" placeholder="At least 8 characters" value={next} onChange={(event) => setNext(event.target.value)}/>
          <label className="field-label" htmlFor="confirm-new-password">Confirm new password</label>
          <input id="confirm-new-password" className="text-input" type="password" required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)}/>
          <div className="modal-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}</button>
          </div>
          {hasPassword && <p className="help">Forgot it? Log out and use “Forgot password?” on the login page.</p>}
        </form>
      )}
    </Modal>
  );
}
