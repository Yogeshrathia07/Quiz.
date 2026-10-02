import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SESSION_ENDED_EVENT, api, post } from './lib/api.js';
import { useAppUpdate, useExamInProgress } from './lib/useAppUpdate.js';
import { SiteHeader } from './components/SiteHeader.jsx';
import { TOAST_FADE_MS, Toast, toastDuration } from './components/Toast.jsx';
import { pageTitle } from './brand.js';

// Each area is downloaded only when it is opened. Most students never need
// the creator, attendance admin and spreadsheet UI; keeping those modules out
// of the first bundle materially improves first load on a classroom phone.
const namedLazy = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));
const ChangePasswordModal = namedLazy(() => import('./components/ChangePasswordModal.jsx'), 'ChangePasswordModal');
const AdminScreen = namedLazy(() => import('./screens/admin/AdminScreen.jsx'), 'AdminScreen');
const HomeScreen = namedLazy(() => import('./screens/HomeScreen.jsx'), 'HomeScreen');
const MyResultsScreen = namedLazy(() => import('./screens/student/MyResultsScreen.jsx'), 'MyResultsScreen');
const StudentScreen = namedLazy(() => import('./screens/student/StudentScreen.jsx'), 'StudentScreen');
const AttendanceScreen = namedLazy(() => import('./screens/attendance/AttendanceScreen.jsx'), 'AttendanceScreen');
const WindowCheckScreen = namedLazy(() => import('./screens/WindowCheckScreen.jsx'), 'WindowCheckScreen');

const SESSION_SIGNAL = 'test-portal-session-changed';

function currentRoute() {
  const query = new URLSearchParams(window.location.search);
  return {
    test: query.get('test')?.toUpperCase() || null,
    attend: query.get('attend')?.toUpperCase() || null,
    admin: query.get('admin') || null,
    page: query.get('page') || null
  };
}

export default function App() {
  const [auth, setAuth] = useState(null);
  const [route, setRoute] = useState(currentRoute);
  const [toast, setToast] = useState(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const closePasswordModal = useCallback(() => setChangingPassword(false), []);

  // tone: 'info' (default), 'success' after something was saved, 'warn' for a
  // warning during a test, 'error' when it failed. A title, when given, is the
  // message in a few words, with the text as its detail.
  const toastCount = useRef(0);
  const showToast = useCallback((message, tone = 'info', { title = '' } = {}) => {
    toastCount.current += 1;
    setToast({ id: toastCount.current, text: String(message), tone, title, leaving: false });
  }, []);
  const refreshAuth = useCallback(async () => setAuth(await api('/api/auth/status')), []);
  const go = useCallback((url) => {
    window.history.pushState({}, '', url);
    setRoute(currentRoute());
  }, []);
  // Tell other open tabs the account changed, then pick it up here.
  const onSignedIn = useCallback(async () => {
    try { window.localStorage.setItem(SESSION_SIGNAL, String(Date.now())); } catch { /* storage may be blocked */ }
    await refreshAuth();
  }, [refreshAuth]);
  const signOut = useCallback(async () => {
    // For a guest, leaving is final: the server submits their paper.
    if (auth?.user?.isGuest && !window.confirm('Signing out submits your test as it stands, and you will need to start again to retake it. Sign out?')) return;
    try {
      await post('/api/auth/logout');
      setAuth((current) => ({ ...current, user: null }));
      try { window.localStorage.setItem(SESSION_SIGNAL, String(Date.now())); } catch { /* storage may be blocked */ }
      go('/');
    } catch (error) { showToast(error.message); }
  }, [auth, go, showToast]);

  useEffect(() => { refreshAuth().catch((error) => showToast(error.message)); }, [refreshAuth, showToast]);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    // Another tab signed in or out: re-read the session rather than leaving a
    // stale account rendered here.
    const onStorage = (event) => {
      if (event.key === SESSION_SIGNAL) refreshAuth().catch((error) => showToast(error.message));
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('storage', onStorage);
    };
  }, [refreshAuth, showToast]);

  useEffect(() => {
    if (!toast) return undefined;
    // Fading out: gone once the fade has run (unless a new message took its place).
    if (toast.leaving) {
      const gone = window.setTimeout(() => setToast((current) => (current === toast ? null : current)), TOAST_FADE_MS);
      return () => window.clearTimeout(gone);
    }
    const dismiss = () => setToast((current) => (current === toast ? { ...current, leaving: true } : current));
    const timer = window.setTimeout(dismiss, toastDuration(toast.tone));
    // Any tap or key fades it early. The tap that caused it has already gone
    // down by now, so listening from the next tick never fades it at once.
    const arm = window.setTimeout(() => {
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(arm);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
    };
  }, [toast]);

  // The portal's look (styles/craft.css) covers every page but the test pages,
  // which keep their own. Each page also gets a title of its own; pages that
  // know more (a test's name) refine it with usePageTitle.
  useEffect(() => {
    document.body.dataset.area = route.test ? 'test' : 'portal';
    const titles = { attendance: 'Attendance', users: 'Users', tests: 'Tests', create: 'New test', edit: 'Edit test' };
    document.title = pageTitle(route.page === 'results' ? 'My results' : route.page === 'window-check' ? 'Browser check' : titles[route.admin] || (route.attend ? 'Attendance' : null));
  }, [route]);

  const { updateAvailable, applyUpdate } = useAppUpdate();

  // Signed out by a login on another device: outside a test, show the login
  // page with the reason. During a test the paper handles it itself - it must
  // stay mounted so its unsent answers are kept.
  const sittingRef = useRef(false);
  useEffect(() => {
    const onEnded = (event) => {
      if (sittingRef.current) return;
      setAuth((current) => (current?.user ? { ...current, user: null, signedOutElsewhere: /another device/.test(event.detail || '') } : current));
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  // While a paper is open there is no way out of it but Submit: the header's
  // links and buttons are hidden, Back stays on the test, and closing or
  // reloading the tab asks first. Leaving would count as an exit.
  const sitting = useExamInProgress();
  sittingRef.current = sitting;
  useEffect(() => {
    if (!sitting) return undefined;
    const examUrl = window.location.href;
    window.history.pushState({ exam: true }, '', examUrl);
    const stayOnTest = () => {
      window.history.pushState({ exam: true }, '', examUrl);
      setRoute(currentRoute());
      showToast('Finish and submit your test before leaving this page.');
    };
    const confirmLeave = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('popstate', stayOnTest);
    window.addEventListener('beforeunload', confirmLeave);
    return () => {
      window.removeEventListener('popstate', stayOnTest);
      window.removeEventListener('beforeunload', confirmLeave);
    };
  }, [sitting, showToast]);

  const screen = useMemo(() => {
    // Open to anyone: for trying the private-window check on a phone before a test.
    if (route.page === 'window-check') return <WindowCheckScreen/>;
    if (!auth) return <div className="empty card">Loading portal…</div>;
    if (route.attend) return <AttendanceScreen code={route.attend} auth={auth} refreshAuth={onSignedIn} go={go} showToast={showToast}/>;
    if (route.test) return <StudentScreen code={route.test} auth={auth} refreshAuth={onSignedIn} go={go} showToast={showToast}/>;
    if (route.page === 'results' && auth.user && !auth.user.isGuest) return <MyResultsScreen go={go} showToast={showToast} isStudent={auth.user.role === 'student'}/>;
    if (route.admin && !auth.user) return <HomeScreen auth={auth} onSignedIn={onSignedIn} go={go} showToast={showToast}/>;
    if (route.admin || auth.user?.role === 'admin') {
      return <AdminScreen code={route.admin || 'portal'} auth={auth} go={go} showToast={showToast}/>;
    }
    return <HomeScreen auth={auth} onSignedIn={onSignedIn} go={go} showToast={showToast}/>;
  }, [auth, route, onSignedIn, go, showToast]);

  // The admin's quiz list and dashboard are tables and panels that earn the
  // extra width; forms and the student's paper read better kept narrow.
  const isWideScreen = Boolean(auth?.user && !auth.user.isGuest && !route.test && !route.attend &&!['create', 'edit'].includes(route.admin));

  return (
    <>
      <div className={`shell${sitting ? ' is-exam' : ''}`}>
        {/* A test in progress has the whole screen: no header, no way out but Submit. */}
        {!sitting && (
          <SiteHeader auth={auth} route={route} go={go} onChangePassword={() => setChangingPassword(true)} onSignOut={signOut}/>
        )}
        <main className={`main${isWideScreen ? ' main-wide' : ''}`} aria-live="polite">
          <Suspense fallback={<div className="empty card">Loading…</div>}>{screen}</Suspense>
        </main>
      </div>
      {updateAvailable && (
        <div className="update-banner" role="status">
          <span>A new version of the portal is available.</span>
          <button className="button button-primary button-small" type="button" onClick={applyUpdate}>Update now</button>
        </div>
      )}
      {changingPassword && <Suspense fallback={null}><ChangePasswordModal onClose={closePasswordModal} showToast={showToast}/></Suspense>}
      {toast && <Toast key={toast.id} toast={toast}/>}
    </>
  );
}
