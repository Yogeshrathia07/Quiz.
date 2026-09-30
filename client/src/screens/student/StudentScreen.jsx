import { useCallback, useEffect, useState } from 'react';
import { detectWindowKind } from '../../lib/private-mode.js';
import { PrivateWindowRequired } from './PrivateWindowRequired.jsx';
import { api } from '../../lib/api.js';
import { liveEventsFromPayload, useLiveUpdate } from '../../lib/live-updates.js';
import { AttemptScreen } from './AttemptScreen.jsx';
import { useKeepAwake } from '../../lib/keep-awake.js';
import { RegistrationForm } from './RegistrationForm.jsx';
import { SignInScreen } from './SignInScreen.jsx';
import { TestLaunch } from './TestLaunch.jsx';
import {
  GuestsNotAllowed, RegistrationPending, RegistrationRejected, TestClosed,
  TestTimeOver, WaitingForStart
} from './StatusScreens.jsx';

/**
 * The test taker's whole journey - students and faculty alike - in the order it happens: sign in, register, wait
 * for approval, wait for Start, begin, sit the paper.
 */
export function StudentScreen({ code, auth, refreshAuth, go, showToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // The Start response is a complete paper. Keep it briefly while this parent
  // still has the pre-start `attemptId: null` state, rather than asking the
  // server for the same paper again.
  const [startedAttempt, setStartedAttempt] = useState(null);
  // undefined while checking, then 'private' | 'normal' | 'mobile' | 'unknown'
  // (see private-mode.js), or 'declared' once a student says the check got
  // their Incognito window wrong. Sent with Begin, so the admin sees it.
  const [windowKind, setWindowKind] = useState(undefined);
  useEffect(() => { detectWindowKind().then((result) => setWindowKind(result)); }, []);

  // Waiting to be let in, or for Start: the screen stays on, so the student
  // sees the test open. The paper keeps it on from there (AttemptScreen).
  useKeepAwake(Boolean(data?.registration && data.registration.status !== 'rejected' && !data.attemptId && !data.test?.isClosed));

  const reload = useCallback(async () => {
    try { setData(await api(`/api/tests/${encodeURIComponent(code)}`)); setError(''); }
    catch (requestError) { setError(requestError.message); }
  }, [code]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setStartedAttempt(null); }, [code]);
  // Waiting students learn about approval and Start immediately instead of
  // relying on a timer. Once they have an attempt, AttemptScreen owns it.
  const applyWaitingUpdate = useCallback((payload) => {
    const events = liveEventsFromPayload(payload);
    // A reconnect/resync has no compact patch, so one ordinary GET restores
    // the exact state. Normal approval/Start messages update this small
    // waiting view in place and avoid a 5,000-student reload burst.
    const needsReload = events.some((event) => !event?.test && !event?.registration);
    setData((current) => {
      if (!current) return current;
      return events.reduce((next, event) => {
        if (!event) return next;
        const test = event.test ? { ...next.test, ...event.test } : next.test;
        const registration = event.registration
          ? {
            ...next.registration,
            status: event.registration.status ?? next.registration?.status,
            requestedAt: event.registration.requestedAt ?? next.registration?.requestedAt,
            expiresAt: event.registration.expiresAt ?? next.registration?.expiresAt
          }
          : next.registration;
        return {
          ...next,
          ...(event.serverTime ? { serverTime: event.serverTime } : {}),
          ...(test !== next.test ? { test } : {}),
          ...(registration !== next.registration ? { registration } : {})
        };
      }, current);
    });
    if (needsReload) void reload();
  }, [reload]);
  useLiveUpdate(
    data?.registration && !data?.attemptId ? `/api/tests/${encodeURIComponent(code)}/events` : null,
    applyWaitingUpdate,
    Boolean(data?.registration && !data?.attemptId)
  );

  // After signing in (by email code or as a guest) there is a new account and a
  // new view of the test to pick up before the next screen can be chosen.
  const onSignedIn = useCallback(async () => { await refreshAuth(); await reload(); }, [refreshAuth, reload]);

  if (error) {
    return (
      <section className="join-card card">
        <h1>Test unavailable</h1>
        <p>{error}</p>
        <button className="button button-secondary" onClick={() => go('/')}>Home</button>
      </section>
    );
  }
  if (!data) return <div className="empty card">Loading test…</div>;

  const { test, registration, attemptId } = data;
  if (test.isClosed && !attemptId && !startedAttempt) return <TestClosed test={test}/>;
  // The test's creator may preview from anywhere; everyone who sits it -
  // students, guests and other faculty - needs a private window. A browser
  // that gives no signal either way is let through.
  const privateExempt = Boolean(test.isOwner);
  if (test.requirePrivateWindow && !privateExempt) {
    if (windowKind === undefined) return <div className="empty card">Checking your browser…</div>;
    if (windowKind === 'normal') return <PrivateWindowRequired test={test} showToast={showToast} onDeclare={() => setWindowKind('declared')}/>;
  }
  if (!auth.user) {
    return (
      <SignInScreen test={test} code={code} auth={auth} onSignedIn={onSignedIn} showToast={showToast}/>
    );
  }
  if (auth.user.isGuest && !test.allowGuests) return <GuestsNotAllowed test={test}/>;
  if (!registration) return <RegistrationForm test={test} user={auth.user} code={code} reload={reload} showToast={showToast}/>;
  if (registration.status === 'pending') return <RegistrationPending test={test} registration={registration} reload={reload}/>;
  if (registration.status === 'rejected') return <RegistrationRejected test={test}/>;
  if (!test.isStarted) return <WaitingForStart test={test} serverTime={data.serverTime} reload={reload}/>;
  // Nobody may pick up a fresh paper once the time is up; say so rather than
  // offering a Begin button that the server will refuse.
  if (!attemptId && !startedAttempt && !test.untimed && Date.parse(test.endsAt) <= Date.now()) return <TestTimeOver test={test} reload={reload}/>;
  if (!attemptId && !startedAttempt) {
    return <TestLaunch test={test} code={code} reload={reload} onStarted={setStartedAttempt} showToast={showToast} windowKind={windowKind}/>;
  }
  return (
    <AttemptScreen
      code={code}
      initialAttempt={startedAttempt}
      microsoft={auth.microsoft}
      showToast={showToast}
      onPaperGone={() => {
        setStartedAttempt(null);
        showToast('Your instructor restarted the test. Begin again for a new paper.');
        reload();
      }}
      windowKind={windowKind}
      privateExempt={privateExempt}
      onDeclareWindow={() => setWindowKind('declared')}
    />
  );
}
