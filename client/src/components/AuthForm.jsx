import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
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

/** The new password twice, with a way to see what was typed and a word when the two differ. */
function PasswordFields({ password, setPassword, confirm, setConfirm, label = 'Password' }) {
  const [shown, setShown] = useState(false);
  const differ = confirm.length > 0 && confirm !== password;
  return (
    <>
      <span className="field-label-row">
        <label className="field-label" htmlFor="auth-new-password">{label}</label>
        <button className="link-button auth-show" type="button" aria-pressed={shown} onClick={() => setShown((value) => !value)}>
          {shown ? <EyeOff size={15} aria-hidden="true"/> : <Eye size={15} aria-hidden="true"/>}{shown ? 'Hide' : 'Show'}
        </button>
      </span>
      <input
        id="auth-new-password"
        className="text-input"
        type={shown ? 'text' : 'password'}
        required
        autoFocus
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
        type={shown ? 'text' : 'password'}
        required
        autoComplete="new-password"
        aria-invalid={differ}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {differ && <p className="auth-hint is-bad" role="status">The two passwords do not match yet.</p>}
    </>
  );
}

const TITLES = { login: 'Log in', signup: 'Create your account', reset: 'Reset your password' };

/**
 * Email + password login, with account creation and password reset. Those two
 * go one step at a time, so a student only ever sees what to do next: the
 * email; then the 6-digit code it was sent, with Resend right beside it; and
 * only once the code is right, the new password (and, signing up, their name).
 * Anyone with a college Microsoft account can use Microsoft instead.
 */
export function AuthForm({ microsoft = null, returnTo = '/', onSignedIn, showToast, compact = false, sideBySide = false }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  // The code was checked and is right: on to the password.
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  // A code typed in full is checked once by itself; this remembers which.
  const checkedCode = useRef('');
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const switchTo = (next) => {
    setMode(next);
    setCodeSent(false);
    setVerified(false);
    setCode('');
    setPassword('');
    setConfirm('');
    checkedCode.current = '';
  };
  // Back to the email step, to correct the address or start again.
  const changeEmail = () => { setCodeSent(false); setVerified(false); setCode(''); checkedCode.current = ''; };

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

  // Step two: is the code right? Only then is the password asked for.
  const checkCode = (event) => {
    event?.preventDefault();
    if (code.length !== 6 || busy) return undefined;
    checkedCode.current = code;
    return run(async () => {
      await post('/api/auth/check-code', { email, purpose: mode, code });
      setVerified(true);
    });
  };
  // Typed (or pasted, or filled in by the phone) in full: checked straight away.
  useEffect(() => {
    if (mode !== 'login' && codeSent && !verified && code.length === 6 && checkedCode.current !== code) checkCode();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <p className="auth-step">Step 1 of 3</p>
          {emailField}
          <button className="button button-primary button-wide" disabled={busy} type="submit">
            {busy ? 'Sending…' : mode === 'signup' ? 'Send verification code' : 'Send reset code'}
          </button>
          <div className="email-sign-in-links">
            <button className="link-button" type="button" onClick={() => switchTo('login')}>Back to log in</button>
          </div>
        </form>
      )}

      {mode !== 'login' && codeSent && !verified && (
        <form className="email-sign-in" onSubmit={checkCode}>
          <p className="auth-step">Step 2 of 3</p>
          <p className="auth-sent">
            <span>Code sent to <strong>{email}</strong></span>
            <button className="link-button" type="button" onClick={changeEmail}>Change</button>
          </p>
          <span className="field-label-row">
            <label className="field-label" htmlFor="auth-code">Code from the email</label>
            <InfoTip label="No code yet?">
              Not there yet? Check Junk or Spam, and the Other tab in Outlook: the email can take a few minutes. If you press Resend, the code from either email works.
            </InfoTip>
          </span>
          <div className="otp-row">
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
            <button className="button button-secondary otp-resend" type="button" disabled={busy || resendIn > 0} onClick={() => sendCode()}>
              {resendIn > 0 ? `Resend ${resendIn}s` : 'Resend'}
            </button>
          </div>
          <button className="button button-primary button-wide" disabled={busy || code.length !== 6} type="submit">
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <div className="email-sign-in-links">
            <button className="link-button" type="button" onClick={() => switchTo('login')}>Back to log in</button>
          </div>
        </form>
      )}

      {mode !== 'login' && codeSent && verified && (
        <form className="email-sign-in" onSubmit={submit}>
          <p className="auth-step">Step 3 of 3</p>
          <p className="auth-sent is-verified"><Check size={15} aria-hidden="true"/><span>Email verified · <strong>{email}</strong></span></p>
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
          <button className="button button-primary button-wide" disabled={busy || !password || password !== confirm} type="submit">
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Save password and log in'}
          </button>
          <div className="email-sign-in-links">
            <button className="link-button" type="button" onClick={() => switchTo('login')}>Back to log in</button>
          </div>
        </form>
      )}
    </div>
  );
}
