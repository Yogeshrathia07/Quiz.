import { Suspense } from 'react';
import { lazyScreen, screens } from '../loaders.js';

const CreatorScreen = lazyScreen(screens.creator, 'CreatorScreen');
const DashboardScreen = lazyScreen(screens.dashboard, 'DashboardScreen');
const TestListScreen = lazyScreen(screens.testList, 'TestListScreen');
const FacultyHome = lazyScreen(screens.facultyHome, 'FacultyHome');
const UsersScreen = lazyScreen(screens.users, 'UsersScreen');
const AttendanceListScreen = lazyScreen(screens.attendanceList, 'AttendanceListScreen');
const AttendanceSessionScreen = lazyScreen(screens.attendanceSession, 'AttendanceSessionScreen');

/**
 * `code` is the admin route: 'portal' for the home page, 'tests' for the quiz
 * list, 'create' for the creator, 'users' for account management, or a test
 * code for that test's dashboard.
 */
export function AdminScreen({ code, area = 'quizzes', navigation, auth, go, showToast }) {
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
    screen = <CreatorScreen go={go} onCreated={({ test }) => go(`/?admin=${encodeURIComponent(test.code)}`)} showToast={showToast}/>;
  } else if (code === 'edit') {
    const editCode = new URLSearchParams(window.location.search).get('code');
    screen = <CreatorScreen key={editCode} editCode={editCode} go={go} showToast={showToast}/>;
  } else if (code === 'portal') {
    // Home: the way into each section, nothing of any one of them.
    screen = <FacultyHome user={auth.user} go={go}/>;
  } else if (['tests', 'quizzes', 'results'].includes(code)) {
    const listArea = code === 'results' || area === 'results' ? 'results' : 'quizzes';
    const address = new URLSearchParams(window.location.search);
    const listView = address.get('view') === 'taken' ? 'taken' : 'created';
    screen = <TestListScreen key={`${listArea}-${listView}-${address.get('filter') || ''}`} area={listArea} navigation={navigation} go={go} showToast={showToast}/>;
  } else if (code === 'attendance') {
    const session = new URLSearchParams(window.location.search).get('session');
    screen = session
      ? <AttendanceSessionScreen key={session} code={session.toUpperCase()} go={go} showToast={showToast}/>
      : <AttendanceListScreen go={go} showToast={showToast}/>;
  } else if (code === 'users') {
    screen = <UsersScreen currentEmail={auth.user.email} canManage={auth.user.canManageUsers} showToast={showToast}/>;
  } else {
    // Keyed: each test opens with its own search and filters, never the last test's.
    const answerFilter = navigation?.af || '';
    screen = <DashboardScreen key={`${code.toUpperCase()}-${area}-${answerFilter}`} code={code.toUpperCase()} area={area} answerFilter={answerFilter} navigation={navigation} go={go} showToast={showToast}/>;
  }
  return <Suspense fallback={<div className="empty card">Loading…</div>}>{screen}</Suspense>;
}
