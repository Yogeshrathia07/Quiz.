import { lazy, Suspense } from 'react';

const namedLazy = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));
const CreatorScreen = namedLazy(() => import('../creator/CreatorScreen.jsx'), 'CreatorScreen');
const DashboardScreen = namedLazy(() => import('./DashboardScreen.jsx'), 'DashboardScreen');
const TestListScreen = namedLazy(() => import('./TestListScreen.jsx'), 'TestListScreen');
const FacultyHome = namedLazy(() => import('./FacultyHome.jsx'), 'FacultyHome');
const UsersScreen = namedLazy(() => import('./UsersScreen.jsx'), 'UsersScreen');
const AttendanceListScreen = namedLazy(() => import('../attendance/AttendanceAdminScreens.jsx'), 'AttendanceListScreen');
const AttendanceSessionScreen = namedLazy(() => import('../attendance/AttendanceAdminScreens.jsx'), 'AttendanceSessionScreen');

/**
 * `code` is the admin route: 'portal' for the home page, 'tests' for the quiz
 * list, 'create' for the creator, 'users' for account management, or a test
 * code for that test's dashboard.
 */
export function AdminScreen({ code, auth, go, showToast }) {
  if (auth.user?.role !== 'admin') {
    return (
      <section className="card empty">
        <h1>Faculty access required</h1>
        <p>Sign in with the faculty email that created this test.</p>
      </section>
    );
  }
  // A new test opens straight on its dashboard, where its QR and link already
  // are; a short "Test created" note says it worked, then fades.
  let screen;
  if (code === 'create') {
    screen = <CreatorScreen onCreated={({ test }) => go(`/?admin=${encodeURIComponent(test.code)}`)} showToast={showToast}/>;
  } else if (code === 'edit') {
    const editCode = new URLSearchParams(window.location.search).get('code');
    screen = <CreatorScreen key={editCode} editCode={editCode} go={go} showToast={showToast}/>;
  } else if (code === 'portal') {
    // Home: the way into each section, nothing of any one of them.
    screen = <FacultyHome user={auth.user} go={go}/>;
  } else if (code === 'tests') {
    screen = <TestListScreen go={go} showToast={showToast}/>;
  } else if (code === 'attendance') {
    const session = new URLSearchParams(window.location.search).get('session');
    screen = session
      ? <AttendanceSessionScreen key={session} code={session.toUpperCase()} go={go} showToast={showToast}/>
      : <AttendanceListScreen go={go} showToast={showToast}/>;
  } else if (code === 'users') {
    screen = <UsersScreen currentEmail={auth.user.email} canManage={auth.user.canManageUsers} showToast={showToast}/>;
  } else {
    // Keyed: each test opens with its own search and filters, never the last test's.
    screen = <DashboardScreen key={code.toUpperCase()} code={code.toUpperCase()} go={go} showToast={showToast}/>;
  }
  return <Suspense fallback={<div className="empty card">Loading…</div>}>{screen}</Suspense>;
}
