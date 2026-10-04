import { useEffect, useState } from 'react';
import { InfoTip } from './InfoTip.jsx';
import { post } from '../lib/api.js';

function MicrosoftMark() {
  return (
    <svg className="microsoft-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#f35325" d="M1 1h10v10H1z"/>
      <path fill="#81bc06" d="M13 1h10v10H13z"/>
      <path fill="#05a6f0" d="M1 13h10v10H1z"/>
      <path fill="#ffba08" d="M13 13h10v10H13z"/>
    </svg>
  );
}

function MicrosoftButton({ microsoft, returnTo, divider = true, compactLabel = false }) {
  if (!microsoft) return null;
  return (
    <div className="microsoft-option">
      {divider && <span className="microsoft-divider">or</span>}
      <a className="button button-secondary button-wide microsoft-button" href={`/auth/microsoft?returnTo=${encodeURIComponent(returnTo)}`}>
        <MicrosoftMark/>
        {compactLabel ? <><span className="microsoft-label-full">Sign in with Microsoft</span><span className="microsoft-label-short">Microsoft</span></> : <span>Sign in with Microsoft</span>}
      </a>
    </div>
  );
}

function PasswordFields({ password, setPassword, confirm, setConfirm, label = 'Password' }) {
  return (
    <>
      <label className="field-label" htmlFor="auth-new-password">{label}</label>
      <input
        id="auth-new-password"
        className="text-input"
        type="password"
        required
        minLength="8"
        maxLength="128"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="At least 8 characters"
      />
      <label className="field-label" htmlFor="auth-confirm-password">Confirm password</label>
      <input
        id="auth-confirm-password"
        className="text-input"
        type="password"
        required
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
    </>
  );
}

const TITLES = { login: 'Log in', signup: 'Create your account', reset: 'Reset your password' };

/**
 * Email + password login, with account creation and password reset. Both of
 * those first email a 6-digit code to prove the address. Anyone with a UPES
 * Microsoft account can use Microsoft instead.
 */
export function AuthForm({ microsoft = null, returnTo = '/', onSignedIn, showToast, compact = false, sideBySide = false }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const switchTo = (next) => {
    setMode(next);
    setCodeSent(false);
    setCode('');
    setPassword('');
    setConfirm('');
  };

  const run = async (action) => {
    setBusy(true);
    try { await action(); } catch (error) { showToast(error.message); }
    setBusy(false);
  };

  const sendCode = (event) => {
    event?.preventDefault();
    return run(async () => {
      const data = await post('/api/auth/code', { email, purpose: mode });
      setCodeSent(true);
      setResendIn(data.resendInSeconds || 60);
      showToast(`A code was sent to ${data.email}.`);
    });
  };

  const submit = (event) => {
    event.preventDefault();
    if (mode !== 'login' && password !== confirm) { showToast('The two passwords do not match.'); return; }
    run(async () => {
      if (mode === 'login') await post('/api/auth/login', { email, password });
      if (mode === 'signup') await post('/api/auth/signup', { email, code, name, password });
      if (mode === 'reset') await post('/api/auth/reset-password', { email, code, password });
      await onSignedIn();
    });
  };

  const emailField = (
    <>
      <label className="field-label" htmlFor="auth-email">College email</label>
      <input
        id="auth-email"
        className="text-input"
        type="email"
        required
        autoComplete="username"
        readOnly={mode !== 'login' && codeSent}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Your college email"
      />
    </>
  );

  return (
    <div className={`auth-form${compact ? ' is-compact' : ''}`}>
      <h2 className="auth-title">{TITLES[mode]}</h2>

      {mode === 'login' && (
        <form className="email-sign-in" onSubmit={submit}>
          {emailField}
          <label className="field-label" htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            className="text-input"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {sideBySide ? (
            <div className={`auth-login-actions${microsoft ? ' has-microsoft' : ''}`}>
              <button className="button button-primary button-wide" disabled={busy} type="submit">{busy ? 'Logging in…' : 'Log in'}</button>
              <MicrosoftButton microsoft={microsoft} returnTo={returnTo} divider={false} compactLabel/>
            </div>
          ) : (
            <button className="button button-primary button-wide" disabled={busy} type="submit">{busy ? 'Logging in…' : 'Log in'}</button>
          )}
          <div className="email-sign-in-links">
            <button className="link-button" type="button" onClick={() => switchTo('reset')}>Forgot password?</button>
            <button className="link-button" type="button" onClick={() => switchTo('signup')}>Create an account</button>
          </div>
          {!sideBySide && <MicrosoftButton microsoft={microsoft} returnTo={returnTo}/>} 
        </form>
      )}

      {mode !== 'login' && !codeSent && (
        <form className="email-sign-in" onSubmit={sendCode}>
          {emailField}
          <button className="button button-primary button-wide" disabled={busy} type="submit">
            {busy ? 'Sending…' : mode === 'signup' ? 'Send verification code' : 'Send reset code'}
          </button>
          <div className="email-sign-in-links">
            <button className="link-button" type="button" onClick={() => switchTo('login')}>Back to log in</button>
          </div>
        </form>
      )}

      {mode !== 'login' && codeSent && (
        <form className="email-sign-in" onSubmit={submit}>
          {emailField}
          <span className="field-label-row">
            <label className="field-label" htmlFor="auth-code">Code from the email</label>
            <InfoTip label="No code yet?">
              Not there yet? Check Junk or Spam: the email can take a few minutes. If you press Resend, the code from either email works.
            </InfoTip>
          </span>
          <input
            id="auth-code"
            className="text-input otp-input"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength="6"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
          />
          {mode === 'signup' && (
            <>
              <label className="field-label" htmlFor="auth-name">Full name</label>
              <input
                id="auth-name"
                className="text-input"
                required
                minLength="2"
                maxLength="120"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </>
          )}
          <PasswordFields
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
            label={mode === 'reset' ? 'New password' : 'Password'}
          />
          <button className="button button-primary button-wide" disabled={busy || code.length !== 6} type="submit">
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Reset password and log in'}
          </button>
          <div className="email-sign-in-links">
            <button className="link-button" type="button" disabled={busy || resendIn > 0} onClick={() => sendCode()}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <button className="link-button" type="button" onClick={() => switchTo('login')}>Back to log in</button>
          </div>
          {/* Still waiting for the email? A college Microsoft account needs none. */}
          <MicrosoftButton microsoft={microsoft} returnTo={returnTo}/>
        </form>
      )}
    </div>
  );
}
