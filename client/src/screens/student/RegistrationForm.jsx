import { useEffect, useState } from 'react';
import { api, post } from '../../lib/api.js';
import { TestHeader } from './StatusScreens.jsx';

const SAP_ID_LENGTH = 9;

const NOTICES = {
  student: 'Your verified college email will be used for registration.',
  faculty: 'You are registering with your faculty account. Faculty do not need a SAP ID.',
  guest: 'You are using a temporary guest account. Your registration still needs the administrator’s approval, and signing out submits your test as it stands.'
};

export function RegistrationForm({ test, user, code, reload, showToast }) {
  const accountType = user.isGuest ? 'guest' : user.role === 'admin' ? 'faculty' : 'student';
  const [profile, setProfile] = useState(accountType === 'student' ? undefined : null);
  const [sapId, setSapId] = useState('');
  const [busy, setBusy] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);

  useEffect(() => {
    if (accountType !== 'student') return;
    api('/api/student/profile')
      .then((data) => { setProfile(data.profile); setSapId(data.profile?.sapId || ''); })
      .catch((error) => showToast(error.message));
  }, [accountType, showToast]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post(`/api/tests/${encodeURIComponent(code)}/register`, accountType === 'faculty' ? {} : { sapId });
      await reload();
    } catch (error) {
      // Already registered from another browser - usually a closed private window.
      if (error.code === 'OTHER_DEVICE' && accountType !== 'guest') setElsewhere(true);
      else showToast(error.message);
      setBusy(false);
    }
  };

  const continueHere = async () => {
    setBusy(true);
    try {
      await post(`/api/tests/${encodeURIComponent(code)}/register`, { continueHere: true });
      showToast('Your test continues in this window.');
      await reload();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  if (elsewhere) {
    return (
      <section className="join-card card">
        <TestHeader test={test}/>
        <div className="notice">
          You already registered for this test in another browser or window — for example an Incognito window that was closed.
        </div>
        <p>Continue here to pick up where you left off. Your answers are kept, the other window stops working, and your administrator can see that you switched.</p>
        <button className="button button-primary button-wide" type="button" disabled={busy} onClick={continueHere}>
          {busy ? 'Moving your test…' : 'Continue in this window'}
        </button>
      </section>
    );
  }

  if (profile === undefined) return <div className="empty card">Loading student profile…</div>;
  const saved = Boolean(profile?.sapId);

  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <div className="notice">{NOTICES[accountType]}</div>
      <form onSubmit={submit}>
        <label className="field-label">Full name</label>
        <input className="text-input" readOnly value={user.name}/>

        <label className="field-label">{accountType === 'guest' ? 'Account type' : 'Email'}</label>
        <input className="text-input" readOnly value={accountType === 'guest' ? 'Guest test account' : user.email}/>

        {accountType !== 'faculty' && (
          <>
            <label className="field-label" htmlFor="sap-id">SAP ID</label>
            <input
              id="sap-id"
              className="text-input"
              required
              readOnly={saved}
              inputMode="numeric"
              pattern={`[0-9]{${SAP_ID_LENGTH}}`}
              minLength={SAP_ID_LENGTH}
              maxLength={SAP_ID_LENGTH}
              value={sapId}
              onChange={(event) => setSapId(event.target.value.replace(/\D/g, '').slice(0, SAP_ID_LENGTH))}
              placeholder="e.g. 500123456"
            />
            <p className="help">
              {saved ? 'Your SAP ID is saved. Only an administrator can change it.'
                : accountType === 'guest' ? 'Enter your 9-digit SAP ID. It is used for this test only.'
                  : 'Enter your 9-digit SAP ID. It will be saved to your account.'}
            </p>
          </>
        )}

        <button className="button button-primary button-wide" disabled={busy} type="submit">
          Send registration request
        </button>
      </form>
    </section>
  );
}
