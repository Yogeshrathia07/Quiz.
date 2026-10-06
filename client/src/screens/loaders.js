import { createElement, lazy, useState } from 'react';
import { reloadFresh } from '../lib/app-shell.js';

/**
 * Every screen's code, downloaded when first needed - and, once the first
 * page is up, fetched ahead in a quiet moment (lib/prefetch.js), so moving to
 * a new screen never waits for a download. One list, so the screen and the
 * fetch-ahead always ask for the same file; each file is noted once it is
 * here, so its screen can be drawn straight away (lazyScreen).
 */
const here = new Map();
const noted = (load) => {
  const loader = () => load().then((module) => { here.set(loader, module); return module; });
  return loader;
};

export const screens = {
  admin: noted(() => import('./admin/AdminScreen.jsx')),
  home: noted(() => import('./HomeScreen.jsx')),
  myResults: noted(() => import('./student/MyResultsScreen.jsx')),
  resultDetail: noted(() => import('./student/ResultDetailScreen.jsx')),
  student: noted(() => import('./student/StudentScreen.jsx')),
  attendance: noted(() => import('./attendance/AttendanceScreen.jsx')),
  windowCheck: noted(() => import('./WindowCheckScreen.jsx')),
  changePassword: noted(() => import('../components/ChangePasswordModal.jsx')),
  creator: noted(() => import('./creator/CreatorScreen.jsx')),
  dashboard: noted(() => import('./admin/DashboardScreen.jsx')),
  testList: noted(() => import('./admin/TestListScreen.jsx')),
  facultyHome: noted(() => import('./admin/FacultyHome.jsx')),
  users: noted(() => import('./admin/UsersScreen.jsx')),
  attendanceList: noted(() => import('./attendance/AttendanceListScreen.jsx')),
  attendanceSession: noted(() => import('./attendance/AttendanceSessionScreen.jsx'))
};

const RELOADED = 'portal-reloaded-for-update';

/**
 * A screen's component. Its file already here (fetched ahead): drawn at once.
 * React otherwise shows "Loading…" for a moment while it checks - and, having
 * shown it, holds it at least 300 ms - so a page whose code and data were both
 * waiting still paused. Not here yet: loaded with its file, as React.lazy.
 *
 * A page opened from the saved copy just after an update can ask for a file
 * the server no longer has: the portal then reloads onto the new version -
 * once, so a dead connection is not a reload loop; the screen's error shows
 * instead (App.jsx).
 */
export function lazyScreen(load, name) {
  const Lazy = lazy(() => load().then(
    (module) => {
      try { window.sessionStorage.removeItem(RELOADED); } catch { /* storage may be blocked */ }
      return { default: module[name] };
    },
    (error) => {
      let already = true;
      try {
        already = window.sessionStorage.getItem(RELOADED) === '1';
        window.sessionStorage.setItem(RELOADED, '1');
      } catch { /* storage blocked: never reload, in case it would loop */ }
      if (!already && navigator.onLine !== false) {
        void reloadFresh();
        return new Promise(() => {});
      }
      throw error;
    }
  ));
  function Screen(props) {
    // Chosen once, as it is first drawn: switching between the two later would start the screen over.
    const [Kind] = useState(() => here.get(load)?.[name] || Lazy);
    return createElement(Kind, props);
  }
  Screen.displayName = name;
  return Screen;
}
