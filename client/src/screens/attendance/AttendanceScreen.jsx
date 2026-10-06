import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../../lib/api.js';
import { readDeviceSignals } from '../../lib/device.js';
import { dateTime } from '../../lib/format.js';
import { LocationProblem } from '../../lib/geo.js';
import { LocationPanel, useLocationCheck } from '../../components/LocationCheck.jsx';
import { OpenInBrowser, useInAppGate } from '../../components/OpenInBrowser.jsx';
import { Check, Clock3, X } from 'lucide-react';
import { AuthForm } from '../../components/AuthForm.jsx';

const SAP_ID_LENGTH = 9;
const digits = (value) => value.replace(/\D/g, '').slice(0, SAP_ID_LENGTH);

/**
 * One id per phone, kept in its storage, so the teacher can see when a
 * single phone marked attendance for several students. Clearing storage
 * gives a new one - so the server keeps an id of its own in a cookie too.
 */
function deviceId() {
  try {
    let id = window.localStorage.getItem('attendance-device');
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem('attendance-device', id);
    }
    return id;
  } catch { return null; }
}

/**
 * What the phone says it is - model, system, screen, hardware - for the
 * teacher's "possibly the same phone" (src/domain/attendance.js). A private
 * tab reads the same; nothing here is a lock.
 */
async function phoneTraits() {
  const signals = readDeviceSignals() || {};
  let model = '';
  let platformVersion = '';
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']);
    model = values?.model || '';
    platformVersion = values?.platformVersion || '';
  } catch { /* not offered: no model, no fingerprint */ }
  return {
    model, platformVersion, chPlatform: signals.chPlatform || '', screenW: signals.screenW, screenH: signals.screenH, dpr: signals.dpr,
    cores: navigator.hardwareConcurrency || null, memory: navigator.deviceMemory || null
  };
}

function Header({ session }) {
  return (
    <>
      <p className="att-kicker">Attendance{session.round > 1 ? ` · round ${session.round}` : ''}</p>
      <h1>{session.title}</h1>
    </>
  );
}

function MarkStatus({ mark }) {
  if (mark.status === 'present') {
    return (
      <div className="att-result is-present" role="status">
        <span className="att-result-icon" aria-hidden="true"><Check size={28} strokeWidth={3}/></span>
        <strong>You are marked present</strong>
        <span>{dateTime(mark.confirmedAt)}{mark.late ? ' · late' : ''}</span>
      </div>
    );
  }
  if (mark.status === 'rejected') {
    return (
      <div className="att-result is-rejected" role="status">
        <span className="att-result-icon" aria-hidden="true"><X size={28} strokeWidth={3}/></span>
        <strong>Removed by your teacher</strong>
        <span>Speak to them if this is wrong.</span>
      </div>
    );
  }
  return (
    <div className="att-result is-pending" role="status">
      <span className="att-result-icon" aria-hidden="true"><Clock3 size={28} strokeWidth={2.6}/></span>
      <strong>Marked — pending</strong>
      <span>Marked at {new Date(mark.markedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{mark.late ? ' · late' : ''}. It becomes final when your teacher closes attendance.</span>
    </div>
  );
}

function GuestForm({ code, onSignedIn, showToast }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post('/api/auth/guest', { name, attendanceCode: code });
      await onSignedIn();
    } catch (error) { showToast(error.message); setBusy(false); }
  };
  return (
    <div className="att-guest">
      <p className="att-or"><span>or continue as a guest</span></p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="att-guest-name">Your name</label>
        <input id="att-guest-name" className="text-input" required minLength="2" maxLength="100"
          value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Asha Verma"/>
        <button className="button button-secondary button-wide att-guest-button" disabled={busy} type="submit">{busy ? 'Continuing…' : 'Continue as guest'}</button>
      </form>
    </div>
  );
}

function MarkForm({ code, session, user, onMarked, onScanAgain, showToast }) {
  // A UPES student's SAP ID is on their profile; ask only when it is not.
  const needsProfile = !user.isGuest && user.role === 'student';
  const [profileSapId, setProfileSapId] = useState(needsProfile ? undefined : null);
  const [sapId, setSapId] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  // Asked as its own step, and any problem kept on the page with its steps.
  const location = useLocationCheck(Boolean(session.locationRequired));
  const traits = useRef(null);
  useEffect(() => { phoneTraits().then((value) => { traits.current = value; }, () => {}); }, []);

  useEffect(() => {
    if (!needsProfile) return;
    api('/api/student/profile').then((data) => setProfileSapId(data.profile?.sapId || null), () => setProfileSapId(null));
  }, [needsProfile]);

  const asksSapId = user.isGuest || (needsProfile && profileSapId === null);

  const mark = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      let point = {};
      if (session.locationRequired) {
        setStep('Checking your location…');
        point = location.fresh() || await location.request();
      }
      setStep('Marking…');
      const data = await post(`/api/attendance/${encodeURIComponent(code)}/mark`, {
        ...point, ...(asksSapId ? { sapId } : {}), deviceId: deviceId(), phone: traits.current
      });
      onMarked(data.session);
    } catch (error) {
      // A pass spent or run out: the page goes back to "scan the QR".
      if (error.code === 'SCAN_AGAIN') onScanAgain();
      // A location problem is already on the page, with what to do.
      if (!(error instanceof LocationProblem)) showToast(error.message);
      setBusy(false);
      setStep('');
    }
  };

  if (profileSapId === undefined) return <p className="help">Loading your profile…</p>;
  return (
    <form className="att-mark-form" onSubmit={mark}>
      <p>Signed in as <strong>{user.name.replace(/^Guest:\s*/, '')}</strong>{profileSapId ? <> · SAP ID <strong>{profileSapId}</strong></> : null}</p>
      {asksSapId && (
        <>
          <label className="field-label" htmlFor="att-sap">SAP ID</label>
          <input id="att-sap" className="text-input" required inputMode="numeric" autoFocus
            pattern={`[0-9]{${SAP_ID_LENGTH}}`} minLength={SAP_ID_LENGTH} maxLength={SAP_ID_LENGTH}
            placeholder="e.g. 500123456" value={sapId} onChange={(event) => setSapId(digits(event.target.value))}/>
          {!user.isGuest && <p className="help">Saved to your account; after that only an administrator can change it.</p>}
        </>
      )}
      {session.locationRequired && <LocationPanel check={location} intro="Your location is checked once, to confirm you are in the classroom."/>}
      <button className="button button-primary button-wide att-mark-button" type="submit"
        disabled={busy || (asksSapId && sapId.length !== SAP_ID_LENGTH)}>
        {busy ? step || 'Marking…' : 'Mark my attendance'}
      </button>
    </form>
  );
}

/** What a student sees after scanning the class QR. */
export function AttendanceScreen({ code, auth, refreshAuth, go, showToast }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  // Inside another app's built-in browser the location check cannot work.
  const inAppGate = useInAppGate();

  const load = useCallback(async (key) => {
    try {
      const data = await api(`/api/attendance/${encodeURIComponent(code)}${key ? `?k=${encodeURIComponent(key)}` : ''}`);
      setSession(data.session);
      setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [code]);

  // The code in the scanned link, read once as the page opens - so loading
  // again (React does, in development) still has it after it leaves the address bar.
  const [linkKey] = useState(() => new URLSearchParams(window.location.search).get('k'));
  useEffect(() => {
    // The code in the link is spent once read: a copied address bar is no
    // way in for someone outside the room.
    const query = new URLSearchParams(window.location.search);
    if (query.has('k')) {
      query.delete('k');
      window.history.replaceState({}, '', `/?${query.toString()}`);
    }
    load(linkKey);
  }, [load, linkKey]);

  // A pending mark turns into present when the teacher closes attendance.
  const waiting = session?.myMark?.status === 'pending';
  useEffect(() => {
    if (!waiting) return undefined;
    let timer;
    const tick = async () => {
      try { if (!document.hidden) await load(); }
      finally { timer = window.setTimeout(tick, 10_000 + Math.round(Math.random() * 5_000)); }
    };
    timer = window.setTimeout(tick, 10_000 + Math.round(Math.random() * 5_000));
    return () => window.clearTimeout(timer);
  }, [waiting, load]);

  const onSignedIn = useCallback(async () => { await refreshAuth(); await load(); }, [refreshAuth, load]);

  if (error) {
    return (
      <section className="card att-student">
        <h1>Attendance unavailable</h1>
        <p>{error}</p>
        <button className="button button-secondary" onClick={() => go('/')}>Home</button>
      </section>
    );
  }
  if (!session) return <div className="empty card">Loading…</div>;
  // Only where location is checked: elsewhere an app's browser marks attendance just as well.
  if (inAppGate.show && session.locationRequired && session.isOpen && !session.myMark) {
    // The scanned code goes with the link, while it lasts.
    const url = new URL(window.location.href);
    if (linkKey) url.searchParams.set('k', linkKey);
    return (
      <OpenInBrowser url={url.toString()} onContinue={inAppGate.stay}
        note="If it then says the code has expired, scan the QR again with your Camera app."/>
    );
  }

  let body;
  if (session.myMark) {
    body = <MarkStatus mark={session.myMark}/>;
  } else if (!session.isOpen) {
    body = <p className="att-message"><strong>Attendance is closed.</strong> Late? Ask your teacher to take it again, then scan the new QR.</p>;
  } else if (!session.hasPass) {
    body = <p className="att-message"><strong>Scan the QR code on the screen.</strong> This link has expired: the code changes every few seconds, and each scan marks one person.</p>;
  } else if (!auth.user) {
    body = (
      <>
        <p className="att-lead">Sign in with your college account to mark attendance.</p>
        <AuthForm microsoft={auth.microsoft} returnTo={`/?attend=${encodeURIComponent(code)}`} onSignedIn={onSignedIn} showToast={showToast} compact/>
        {session.allowGuests && <GuestForm code={code} onSignedIn={onSignedIn} showToast={showToast}/>}
      </>
    );
  } else if (auth.user.isGuest && !session.allowGuests) {
    body = <p className="att-message">This class accepts only college accounts. Sign out, then sign in with your college email.</p>;
  } else {
    body = <MarkForm code={code} session={session} user={auth.user} onMarked={setSession} onScanAgain={() => load()} showToast={showToast}/>;
  }

  return (
    <section className="card att-student">
      <Header session={session}/>
      {body}
    </section>
  );
}
