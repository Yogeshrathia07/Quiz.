import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { SESSION_ENDED_EVENT, api, isOffline, isRetryable, isServerUnreachable, post } from './lib/api.js';
import { useAppUpdate, useExamInProgress } from './lib/useAppUpdate.js';
import { clearCache, dropCached } from './lib/cache.js';
import { prefetchRoute, preloadScreens, rememberRole, rememberedRole, watchLinks } from './lib/prefetch.js';
import { reloadFresh } from './lib/app-shell.js';
import { ViewerContext, setNavigator } from './lib/people.js';
import { lazyScreen, screens } from './screens/loaders.js';
import { SiteHeader } from './components/SiteHeader.jsx';
import { HoverTips } from './components/HoverTips.jsx';
import { ServerOffline } from './components/ServerOffline.jsx';
import { TOAST_FADE_MS, Toast, toastDuration } from './components/Toast.jsx';
import { pageTitle } from './brand.js';
import { adminAreaOf } from './lib/admin-navigation.js';

// Each area is downloaded only when it is opened - most students never need
// the creator, attendance admin and spreadsheet UI, and keeping them out of
// the first bundle matters on a classroom phone - and fetched ahead in quiet
// moments once the first page is up (lib/prefetch.js preloadScreens).
const ChangePasswordModal = lazyScreen(screens.changePassword, 'ChangePasswordModal');
const AdminScreen = lazyScreen(screens.admin, 'AdminScreen');
const HomeScreen = lazyScreen(screens.home, 'HomeScreen');
const MyResultsScreen = lazyScreen(screens.myResults, 'MyResultsScreen');
const ResultDetailScreen = lazyScreen(screens.resultDetail, 'ResultDetailScreen');
const StudentScreen = lazyScreen(screens.student, 'StudentScreen');
const AttendanceScreen = lazyScreen(screens.attendance, 'AttendanceScreen');
const WindowCheckScreen = lazyScreen(screens.windowCheck, 'WindowCheckScreen');

/** Who is signed in, as one string: when it changes, nothing held for the last account may show. */
const accountOf = (status) => (status?.user ? `${status.user.role}:${status.user.email || status.user.name || ''}` : '');

/**
 * A screen whose code could not be downloaded (no connection, or a file an
 * update removed and the one reload did not bring back): a way to try again
 * instead of a blank page.
 */
class ScreenBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidUpdate(previous) {
    if (this.state.failed && previous.route !== this.props.route) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card empty empty-state">
        <strong>This page did not load</strong>
        <p>Check your connection, then try again.</p>
        <button className="button button-primary" type="button" onClick={() => { void reloadFresh(); }}>Try again</button>
      </section>
    );
  }
}

const SESSION_SIGNAL = 'test-portal-session-changed';

function currentRoute() {
  const query = new URLSearchParams(window.location.search);
  return {
    test: query.get('test')?.toUpperCase() || null,
    attend: query.get('attend')?.toUpperCase() || null,
    admin: query.get('admin') || null,
    tab: query.get('tab') || null,
    rview: query.get('rview') || null,
    view: query.get('view') || null,
    filter: query.get('filter') || null,
    af: query.get('af') || null,
    page: query.get('page') || null,
    // One handed-in test's result, found by the account (ResultDetailScreen).
    result: query.get('result')?.toUpperCase() || null
  };
}

export default function App() {
  const [auth, setAuth] = useState(null);
  // The server could not be reached as the page opened: 'server' (off, or the tunnel answered for it) or 'device' (no connection).
  const [serverDown, setServerDown] = useState(null);
  // A game under way on that page holds it open when the server answers again: it says so, and waits for Open the page.
  const [serverBack, setServerBack] = useState(false);
  const playingOffline = useRef(false);
  const notePlaying = useCallback((on) => { playingOffline.current = on; }, []);
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
  // The account the held replies belong to (lib/cache.js): another one, and they are all forgotten.
  const account = useRef(null);
  const roleRef = useRef(rememberedRole());
  const refreshAuth = useCallback(async () => {
    const next = await api('/api/auth/status');
    const signedIn = accountOf(next);
    if (account.current !== null && account.current !== signedIn) clearCache();
    account.current = signedIn;
    roleRef.current = next?.user?.role || null;
    rememberRole(roleRef.current);
    setAuth(next);
  }, []);
  // A new page draws as soon as its code is here, the old one staying until
  // then (a thin line along the top says it is on its way), and what it needs
  // is asked for in the same moment, not after it has drawn.
  const [navigating, startNavigation] = useTransition();
  // `state` rides along in the history entry (a person opened from their name: lib/people.js).
  const go = useCallback((url, state = {}) => {
    prefetchRoute(url, roleRef.current);
    window.history.pushState(state, '', url);
    startNavigation(() => setRoute(currentRoute()));
  }, []);
  // A name in any table opens that person under Users through the same navigation.
  useEffect(() => { setNavigator(go); }, [go]);
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
      clearCache();
      account.current = '';
      setAuth((current) => ({ ...current, user: null }));
      try { window.localStorage.setItem(SESSION_SIGNAL, String(Date.now())); } catch { /* storage may be blocked */ }
      go('/');
    } catch (error) { showToast(error.message); }
  }, [auth, go, showToast]);

  // The first page's replies are asked for alongside the account check, not after it.
  useEffect(() => { prefetchRoute(window.location.href, roleRef.current); }, []);
  useEffect(() => watchLinks(() => roleRef.current), []);
  useEffect(() => {
    refreshAuth().catch((error) => {
      // Offline on a test link (a reload mid-test): the paper this device
      // holds still opens (StudentScreen); the account is asked for again
      // once the connection is back.
      if (isRetryable(error) && currentRoute().test) {
        setAuth((current) => current || { user: null, offline: true });
        showToast(error.message);
        return;
      }
      // Any other page: the Server offline page (components/ServerOffline.jsx), which asks again by itself.
      if (isServerUnreachable(error) || isOffline(error)) { setServerDown(navigator.onLine === false ? 'device' : 'server'); return; }
      showToast(error.message);
    });
  }, [refreshAuth, showToast]);
  useEffect(() => {
    if (!serverDown || serverBack) return undefined;
    const retry = () => {
      const lost = (error) => {
        if (isServerUnreachable(error) || isOffline(error)) setServerDown(navigator.onLine === false ? 'device' : 'server');
      };
      if (playingOffline.current) { api('/api/auth/status').then(() => setServerBack(true), lost); return; }
      refreshAuth().then(() => setServerDown(null), lost);
    };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 5_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [serverDown, serverBack, refreshAuth]);
  const openAfterOutage = useCallback(() => {
    refreshAuth().then(() => { setServerDown(null); setServerBack(false); }, () => setServerBack(false));
  }, [refreshAuth]);
  useEffect(() => {
    if (!auth?.offline) return undefined;
    const retry = () => { refreshAuth().catch(() => {}); };
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [auth?.offline, refreshAuth]);

  useEffect(() => {
    const onPopState = () => startNavigation(() => setRoute(currentRoute()));
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
    // Left alone it fades away; any tap (anywhere) or key takes it away at once - it never stands in the way.
    const dismissNow = () => setToast((current) => (current === toast ? null : current));
    const timer = window.setTimeout(dismiss, toastDuration(toast.tone));
    // The tap that caused it has already gone down by now, so listening from
    // the next tick never takes it away the moment it shows.
    const arm = window.setTimeout(() => {
      document.addEventListener('pointerdown', dismissNow, true);
      document.addEventListener('keydown', dismissNow, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(arm);
      document.removeEventListener('pointerdown', dismissNow, true);
      document.removeEventListener('keydown', dismissNow, true);
    };
  }, [toast]);

  // The portal's look (styles/craft.css) covers every page but the test pages,
  // which keep their own. Each page also gets a title of its own; pages that
  // know more (a test's name) refine it with usePageTitle.
  useEffect(() => {
    document.body.dataset.area = route.test ? 'test' : 'portal';
    const titles = { attendance: 'Attendance', users: 'Users', tests: 'Quizzes', quizzes: 'Quizzes', results: 'Results', create: 'Create quiz', edit: 'Edit quiz' };
    // Faculty reach the results page as their own test attempts.
    const results = auth?.user?.role === 'student' ? 'My results' : 'My test attempts';
    document.title = pageTitle(route.page === 'results' ? results : route.page === 'window-check' ? 'Browser check' : titles[route.admin] || (route.attend ? 'Attendance' : null));
  }, [route, auth?.user?.role]);

  const { updateAvailable, applyUpdate } = useAppUpdate();

  // Once someone is signed in and the first page is up: the other screens' code, in quiet moments.
  const preloadedFor = useRef('');
  const role = auth?.user?.role || '';
  useEffect(() => {
    if (!role || preloadedFor.current === role) return;
    preloadedFor.current = role;
    preloadScreens(role);
  }, [role]);

  // Opening a test or a register can change what My results says (joined,
  // begun, handed in): it is asked again, not shown from before.
  useEffect(() => {
    if (route.test || route.attend) dropCached('/api/me/results');
  }, [route.test, route.attend]);

  // Signed out by a login on another device: outside a test, show the login
  // page with the reason. During a test the paper handles it itself - it must
  // stay mounted so its unsent answers are kept.
  const sittingRef = useRef(false);
  useEffect(() => {
    const onEnded = (event) => {
      if (sittingRef.current) return;
      clearCache();
      account.current = '';
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
    if (!auth) {
      return serverDown ? <ServerOffline deviceOffline={serverDown === 'device'} back={serverBack} onOpen={openAfterOutage} onPlaying={notePlaying}/>
        : <div className="empty card">Loading portal…</div>;
    }
    if (route.attend) return <AttendanceScreen code={route.attend} auth={auth} refreshAuth={onSignedIn} go={go} showToast={showToast}/>;
    if (route.test) return <StudentScreen code={route.test} auth={auth} refreshAuth={onSignedIn} go={go} showToast={showToast}/>;
    if (route.page === 'results' && auth.user && !auth.user.isGuest) return <MyResultsScreen go={go} showToast={showToast} isStudent={auth.user.role === 'student'}/>;
    if (route.result && auth.user && !auth.user.isGuest) return <ResultDetailScreen code={route.result} go={go} showToast={showToast} isStudent={auth.user.role === 'student'}/>;
    if (route.admin && !auth.user) return <HomeScreen auth={auth} onSignedIn={onSignedIn} go={go} showToast={showToast}/>;
    if (route.admin || auth.user?.role === 'admin') {
      return <AdminScreen code={route.admin || 'portal'} area={adminAreaOf(route)} navigation={route} auth={auth} go={go} showToast={showToast}/>;
    }
    return <HomeScreen auth={auth} onSignedIn={onSignedIn} go={go} showToast={showToast}/>;
  }, [auth, serverDown, serverBack, openAfterOutage, notePlaying, route, onSignedIn, go, showToast]);

  // The admin's quiz list and dashboard are tables and panels that earn the
  // extra width; forms and the student's paper read better kept narrow.
  // The Server offline page too: its message and its game side by side.
  const isWideScreen = Boolean(auth?.user && !auth.user.isGuest && !route.test && !route.attend &&!['create', 'edit'].includes(route.admin))
    || Boolean(serverDown && !auth);

  return (
    // Who is signed in, for what a page offers them (a name opening the person: components/PersonLink.jsx).
    <ViewerContext.Provider value={auth?.user || null}>
      <div className={`nav-progress${navigating ? ' is-active' : ''}`} aria-hidden="true"/>
      <div className={`shell${sitting ? ' is-exam' : ''}`}>
        {/* A test in progress has the whole screen: no header, no way out but Submit. */}
        {/* The Server offline page stands alone: the header's links all need the server. */}
        {!sitting && !(serverDown && !auth) && (
          <SiteHeader auth={auth} route={route} go={go} onChangePassword={() => setChangingPassword(true)} onSignOut={signOut}/>
        )}
        <main className={`main${isWideScreen ? ' main-wide' : ''}`} aria-live="polite">
          <ScreenBoundary route={route}>
            <Suspense fallback={<div className="empty card">Loading…</div>}>{screen}</Suspense>
          </ScreenBoundary>
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
      <HoverTips/>
    </ViewerContext.Provider>
  );
}
