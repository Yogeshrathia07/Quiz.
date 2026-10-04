import { useCallback, useEffect, useState } from 'react';
import { detectWindowKind } from '../../lib/private-mode.js';
import { PrivateWindowRequired } from './PrivateWindowRequired.jsx';
import { DeviceNotAllowed } from './DeviceNotAllowed.jsx';
import { deviceRefused, useDeviceCheck } from '../../lib/device.js';
import { api, isRetryable } from '../../lib/api.js';
import { loadCacheForCode, loadDurableCache } from '../../lib/offline-answers.js';
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
  // No connection, but this device holds the paper: it opens from here (the
  // page was reloaded mid-test, or the phone put it away and reopened it).
  const [offlinePaper, setOfflinePaper] = useState(null);
  // The Start response is a complete paper. Keep it briefly while this parent
  // still has the pre-start `attemptId: null` state, rather than asking the
  // server for the same paper again.
  const [startedAttempt, setStartedAttempt] = useState(null);
  // undefined while checking, then 'private' | 'normal' | 'mobile' | 'unknown'
  // (see private-mode.js), or 'declared' once a student says the check got
  // their Incognito window wrong. Sent with Begin, so the admin sees it.
  const [windowKind, setWindowKind] = useState(undefined);
  useEffect(() => { detectWindowKind().then((result) => setWindowKind(result)); }, []);

  // Phones only or laptops only: whether this device may sit it, asked of the
  // server (lib/device.js) - again when the rule changes, once they have
  // registered (so their teacher sees the device), and when the teacher allows
  // this device. On any test, a registered student's device is reported too.
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [registerAnyway, setRegisterAnyway] = useState(false);
  const deviceRule = data?.test?.devices || 'any';
  const registered = Boolean(data?.registration);
  const deviceCheck = useDeviceCheck(code, {
    stage: 'join',
    enabled: Boolean(data) && !data?.attemptId && !startedAttempt && (deviceRule !== 'any' || registered),
    refreshKey: `${deviceRule}:${registered}:${deviceRefresh}`
  });

  // Waiting to be let in, or for Start: the screen stays on, so the student
  // sees the test open. The paper keeps it on from there (AttemptScreen).
  useKeepAwake(Boolean(data?.registration && data.registration.status !== 'rejected' && !data.attemptId && !data.test?.isClosed));

  const reload = useCallback(async () => {
    try { setData(await api(`/api/tests/${encodeURIComponent(code)}`)); setError(''); }
    catch (requestError) {
      if (isRetryable(requestError)) {
        let cached = null;
        try { cached = loadCacheForCode(window.localStorage, code) || await loadDurableCache(window.indexedDB, code); } catch { /* storage blocked */ }
        if (cached?.attempt && cached.attempt.status !== 'submitted') {
          setOfflinePaper(cached.attempt);
          setError('');
          return;
        }
      }
      setError(requestError.message);
    }
  }, [code]);

  useEffect(() => { reload(); }, [reload]);
  // Opened offline: try again as soon as the connection is back, and every so often.
  // Until the account is known again too, or the paper would give way to the sign-in page for a moment.
  const openedOffline = Boolean(offlinePaper) && (!data || Boolean(auth.offline));
  useEffect(() => {
    if (!openedOffline) return undefined;
    const retry = () => { void reload(); };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [openedOffline, reload]);
  useEffect(() => { setStartedAttempt(null); }, [code]);
  // Waiting students learn about approval and Start immediately instead of
  // relying on a timer. Once they have an attempt, AttemptScreen owns it.
  const applyWaitingUpdate = useCallback((payload) => {
    const events = liveEventsFromPayload(payload);
    // A reconnect/resync has no compact patch, so one ordinary GET restores
    // the exact state. Normal approval/Start messages update this small
    // waiting view in place and avoid a 5,000-student reload burst.
    const needsReload = events.some((event) => !event?.test && !event?.registration);
    if (events.some((event) => event?.kind === 'device_override')) setDeviceRefresh((value) => value + 1);
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

  // The same element as the paper further down, so when the connection comes
  // back it carries on as it is, unsent answers and all.
  if (openedOffline) {
    return (
      <AttemptScreen
        code={code}
        initialAttempt={offlinePaper}
        microsoft={auth.microsoft}
        showToast={showToast}
        onPaperGone={() => { setOfflinePaper(null); reload(); }}
        windowKind={windowKind}
        privateExempt={false}
        onDeclareWindow={() => setWindowKind('declared')}
      />
    );
  }
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
  // A device that does not fit is told so before signing in - a guest's seat
  // cannot follow them to another device - unless they say the check is wrong.
  const deviceBlocked = deviceRule !== 'any' && deviceRefused(deviceCheck);
  const deviceCard = (stage) => (
    <DeviceNotAllowed test={test} rule={deviceRule} check={deviceCheck} stage={stage} guest={Boolean(auth.user?.isGuest)}
      showToast={showToast} onRegisterAnyway={() => setRegisterAnyway(true)}/>
  );
  if (!registration && deviceRule !== 'any' && !test.isOwner && !registerAnyway) {
    if (deviceCheck === null) return <div className="empty card">Checking your device…</div>;
    if (deviceBlocked) return deviceCard('join');
  }
  const withDeviceCard = (screen) => (deviceBlocked ? <div className="join-stack">{deviceCard('waiting')}{screen}</div> : screen);
  if (!auth.user) {
    return (
      <SignInScreen test={test} code={code} auth={auth} onSignedIn={onSignedIn} showToast={showToast}/>
    );
  }
  if (auth.user.isGuest && !test.allowGuests) return <GuestsNotAllowed test={test}/>;
  if (!registration) return <RegistrationForm test={test} user={auth.user} code={code} reload={reload} showToast={showToast}/>;
  if (registration.status === 'pending') return withDeviceCard(<RegistrationPending test={test} registration={registration} reload={reload}/>);
  if (registration.status === 'rejected') return <RegistrationRejected test={test}/>;
  if (!test.isStarted) return withDeviceCard(<WaitingForStart test={test} serverTime={data.serverTime} reload={reload}/>);
  // Nobody may pick up a fresh paper once the time is up; say so rather than
  // offering a Begin button that the server will refuse.
  if (!attemptId && !startedAttempt && !test.untimed && Date.parse(test.endsAt) <= Date.now()) return <TestTimeOver test={test} reload={reload}/>;
  if (!attemptId && !startedAttempt) {
    return (
      <TestLaunch test={test} code={code} reload={reload} onStarted={setStartedAttempt} showToast={showToast} windowKind={windowKind}
        deviceBlock={deviceBlocked ? deviceCard('launch') : null} deviceChecking={deviceRule !== 'any' && deviceCheck === null}
        onDeviceRefused={() => setDeviceRefresh((value) => value + 1)}/>
    );
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
