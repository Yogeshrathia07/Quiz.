import { useState } from 'react';
import { post } from '../../lib/api.js';
import { AuthForm } from '../../components/AuthForm.jsx';
import { TestHeader } from './StatusScreens.jsx';

function GuestForm({ code, onSignedIn, showToast }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const continueAsGuest = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post('/api/auth/guest', { name, testCode: code });
      await onSignedIn();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <div className="guest-sign-in">
      <h2 className="auth-title">Continue as guest</h2>
      <p className="help">Use a temporary name. Approval is still required, and signing out submits your test.</p>
      <form onSubmit={continueAsGuest}>
        <label className="field-label" htmlFor="guest-name">Display name</label>
        <input
          id="guest-name"
          className="text-input"
          required
          minLength="2"
          maxLength="100"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Test Student"
        />
        <button className="button button-secondary button-wide" disabled={busy} type="submit">
          {busy ? 'Starting…' : 'Continue as guest'}
        </button>
      </form>
    </div>
  );
}

/**
 * The door into a test. Logging in is always offered; the guest form
 * appears only when this test's admin ticked "Allow guest registrations".
 */
export function SignInScreen({ test, code, auth, onSignedIn, showToast }) {
  const [method, setMethod] = useState('account');
  return (
    <section className="join-card card test-sign-in-card">
      <TestHeader test={test} showInstructions={false}/>
      <div className="notice sign-in-note">{test.allowGuests ? 'Choose an account or guest access to register for this test.' : 'Log in with your college account to register for this test.'}</div>
      {test.allowGuests && (
        <div className="sign-in-methods" role="tablist" aria-label="Sign-in method">
          <button type="button" role="tab" aria-selected={method === 'account'} className={method === 'account' ? 'is-on' : ''} onClick={() => setMethod('account')}>College account</button>
          <button type="button" role="tab" aria-selected={method === 'guest'} className={method === 'guest' ? 'is-on' : ''} onClick={() => setMethod('guest')}>Guest</button>
        </div>
      )}
      <div role="tabpanel">
        {method === 'account' ? (
          <AuthForm
            microsoft={auth.microsoft}
            returnTo={`/?test=${encodeURIComponent(test.code)}`}
            onSignedIn={onSignedIn}
            showToast={showToast}
            compact
            sideBySide
          />
        ) : (
          <GuestForm code={code} onSignedIn={onSignedIn} showToast={showToast}/>
        )}
      </div>
    </section>
  );
}
