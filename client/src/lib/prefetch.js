import { prefetch } from './cache.js';
import { wholeClassPath } from './dashboard-paths.js';
import { screens } from '../screens/loaders.js';

/**
 * Starting a page's requests before the page itself asks: when a link is
 * pointed at or touched, when a button navigates (App.jsx go), and on the
 * first load alongside the account check - so what the page needs is on its
 * way, or already here (cache.js), by the time it draws.
 */

const ROLE_KEY = 'portal-last-role';

/**
 * Which kind of account used this browser last - 'admin' or 'student'. Only
 * a guess at what the home page will ask for while the account is checked;
 * the account itself always comes from the server.
 */
export function rememberRole(role) {
  try { window.localStorage.setItem(ROLE_KEY, role === 'admin' || role === 'student' ? role : ''); } catch { /* storage may be blocked */ }
}
export function rememberedRole() {
  try { return window.localStorage.getItem(ROLE_KEY) || null; } catch { return null; }
}

const HOME = { admin: ['/api/admin/home', '/api/admin/tests', '/api/admin/attendance'], student: ['/api/me/results', '/api/student/profile'] };

/** The server replies the page at `href` reads first. None for a test or a register: those always ask the server. */
export function routeData(href, role, origin = window.location.origin) {
  let url;
  try { url = new URL(href, origin); } catch { return []; }
  if (url.origin !== origin || url.pathname !== '/') return [];
  // No account known on this device (signed out, or never signed in here): every
  // read would be refused - a results link from an email, say - so none is started.
  if (!role) return [];
  const query = url.searchParams;
  if (query.get('test') || query.get('attend')) return [];
  const admin = query.get('admin');
  const page = query.get('page');
  const result = query.get('result');
  if (page === 'results') return role === 'student' ? HOME.student : ['/api/me/results'];
  if (result) return ['/api/me/results', `/api/me/results/${encodeURIComponent(result.toUpperCase())}/responses`];
  if (page) return [];
  if (!admin) return HOME[role] || [];
  if (admin === 'portal') return HOME.admin;
  if (admin === 'quizzes') return ['/api/admin/tests'];
  if (admin === 'results') return ['/api/admin/tests', '/api/me/results'];
  // Kept for saved addresses from before Quizzes and Results were separated.
  if (admin === 'tests') return ['/api/admin/tests', '/api/me/results'];
  if (admin === 'attendance') return query.get('session') ? [] : ['/api/admin/attendance'];
  if (admin === 'users') return ['/api/admin/users'];
  if (admin === 'create' || admin === 'edit') return [];
  const answerList = query.get('rview') !== 'analysis' && ['students', 'responses'].includes(query.get('tab'));
  return [wholeClassPath(admin.toUpperCase(), answerList ? query.get('af') || '' : '')];
}

/** The code the page at `href` is drawn with. */
export function routeScreens(href, role, origin = window.location.origin) {
  let url;
  try { url = new URL(href, origin); } catch { return []; }
  if (url.origin !== origin || url.pathname !== '/') return [];
  const query = url.searchParams;
  if (query.get('test')) return [screens.student];
  if (query.get('attend')) return [screens.attendance];
  if (query.get('page') === 'results') return [screens.myResults];
  if (query.get('page') === 'window-check') return [screens.windowCheck];
  if (query.get('result')) return [screens.resultDetail];
  const admin = query.get('admin');
  if (!admin) return role === 'admin' ? [screens.admin, screens.facultyHome] : [screens.home];
  const inside = {
    portal: screens.facultyHome, quizzes: screens.testList, results: screens.testList, tests: screens.testList,
    create: screens.creator, edit: screens.creator, users: screens.users,
    attendance: query.get('session') ? screens.attendanceSession : screens.attendanceList
  }[admin] || screens.dashboard;
  return [screens.admin, inside];
}

const quietly = (load) => { load().catch(() => {}); };

/** Everything the page at `href` will need, on its way now. */
export function prefetchRoute(href, role) {
  routeData(href, role).forEach((url) => prefetch(url));
  routeScreens(href, role).forEach(quietly);
}

/**
 * Links pointed at for a moment (a mouse resting, not passing over), touched
 * or reached with Tab start their page's requests. Each link at most every
 * ten seconds. Returns the way to stop.
 */
export function watchLinks(getRole) {
  const recent = new Map();
  let resting = null;
  const linkOf = (event) => {
    const link = event.target?.closest?.('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return null;
    const href = link.getAttribute('href');
    return href && href.startsWith('/') ? { link, href } : null;
  };
  const start = (href) => {
    const at = Date.now();
    if (at - (recent.get(href) || 0) < 10_000) return;
    recent.set(href, at);
    prefetchRoute(href, getRole());
  };
  const onDown = (event) => { const found = linkOf(event); if (found) start(found.href); };
  const onOver = (event) => {
    if (event.pointerType !== 'mouse') return;
    const found = linkOf(event);
    if (!found || resting?.link === found.link) return;
    window.clearTimeout(resting?.timer);
    resting = { link: found.link, timer: window.setTimeout(() => start(found.href), 70) };
  };
  const onOut = (event) => {
    if (resting && !resting.link.contains(event.relatedTarget)) {
      window.clearTimeout(resting.timer);
      resting = null;
    }
  };
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  document.addEventListener('focusin', onDown);
  return () => {
    window.clearTimeout(resting?.timer);
    document.removeEventListener('pointerdown', onDown, { capture: true });
    document.removeEventListener('pointerover', onOver);
    document.removeEventListener('pointerout', onOut);
    document.removeEventListener('focusin', onDown);
  };
}

/**
 * Once the first page is up, the code of the other screens this account
 * uses - one file at a time, each in a quiet moment, starting a little after
 * the page has drawn so it never competes with drawing it; the service worker
 * keeps each - so no click waits for a download later. Skipped when the
 * phone asks to save data.
 */
export function preloadScreens(role, { afterMs = 2_000 } = {}) {
  if (navigator.connection?.saveData) return;
  const list = role === 'admin'
    ? [screens.facultyHome, screens.testList, screens.dashboard, screens.myResults, screens.resultDetail, screens.creator,
      screens.attendanceList, screens.attendanceSession, screens.users, screens.changePassword]
    : [screens.home, screens.myResults, screens.resultDetail, screens.student, screens.changePassword];
  const idle = window.requestIdleCallback ? (run) => window.requestIdleCallback(run, { timeout: 4_000 }) : (run) => window.setTimeout(run, 300);
  let index = 0;
  const next = () => {
    if (index >= list.length) return;
    const load = list[index];
    index += 1;
    load().catch(() => {}).then(() => idle(next));
  };
  window.setTimeout(() => idle(next), afterMs);
}
