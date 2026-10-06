/**
 * The dashboard's Students and Results lists, worked out from the rows
 * themselves: search, the filters, the orders, a page, and the counts.
 *
 * Pure - no database - so the server (services/admin-service.js) and the
 * browser (screens/admin/DashboardScreen.jsx) run the very same rules. The
 * server sorts and filters big classes in MongoDB; a class that fits in one
 * reply is sent whole, and the browser narrows it here as the teacher types
 * or ticks, without asking the server again. The regression check holds the
 * two ways to the same rows.
 */

/** Waiting for a decision first, then approved, then the rest. */
export const rankRegistration = (status) => (status === 'pending' ? 0 : status === 'approved' ? 1 : 2);

export const FILTER_GROUPS = {
  pending: 'registration', approved: 'registration', rejected: 'registration',
  'paper:not_started': 'paper', 'paper:in_progress': 'paper', 'paper:paused': 'paper', 'paper:locked': 'paper', 'paper:submitted': 'paper',
  verified: 'account', guest: 'account',
  'venue:in_range': 'venue', 'venue:out_of_range': 'venue', 'venue:exception': 'venue', 'venue:not_checked': 'venue',
  'device:phone': 'device', 'device:tablet': 'device', 'device:laptop': 'device', 'device:unknown': 'device',
  'devicecheck:ok': 'devicecheck', 'devicecheck:disagree': 'devicecheck', 'devicecheck:exception': 'devicecheck',
  'marking:awaiting': 'marking', 'marking:done': 'marking',
  'finish:student': 'finish', 'finish:time': 'finish', 'finish:admin': 'finish', 'finish:teacher': 'finish', 'finish:unknown': 'finish'
};

/**
 * The orders the Students and Results lists can be read in: a field and a
 * direction, each either way round. The usual one, 'order-asc', is waiting
 * for a decision first, then as they registered. A big class is sorted in
 * the database, so the order holds across every page, not just the one shown.
 */
export const RESULT_SORTS = ['order-asc', 'order-desc', 'submitted-desc', 'submitted-asc', 'score-desc', 'score-asc', 'name-asc', 'name-desc'];
export const STUDENT_SORTS = ['order-asc', 'order-desc', 'name-asc', 'name-desc', 'sap-asc', 'sap-desc', 'answered-desc', 'answered-asc'];
/** Links saved before an order could be reversed. */
const LEGACY_SORTS = { order: 'order-asc', latest: 'submitted-desc', 'score-high': 'score-desc', 'score-low': 'score-asc', name: 'name-asc' };
export const resultSort = (raw) => (RESULT_SORTS.includes(raw) ? raw : LEGACY_SORTS[raw] || 'order-asc');
export const sortFor = (section, raw) => (section === 'responses' ? resultSort(raw)
  : section === 'students' && STUDENT_SORTS.includes(raw) ? raw : 'order-asc');

export function dashboardFilter(row, id) {
  if (['pending', 'approved', 'rejected'].includes(id)) return row.status === id;
  if (id === 'paper:not_started') return !row.attemptStatus;
  if (id === 'paper:submitted') return row.attemptStatus === 'submitted';
  if (id === 'paper:paused') return row.attemptStatus === 'in_progress' && row.isPaused;
  if (id === 'paper:locked') return row.attemptStatus === 'in_progress' && !row.isPaused && row.isLocked;
  if (id === 'paper:in_progress') return row.attemptStatus === 'in_progress' && !row.isPaused && !row.isLocked;
  if (id === 'guest') return row.accountType === 'guest' || String(row.email || '').endsWith('@guest.test');
  if (id === 'verified') return !dashboardFilter(row, 'guest');
  if (id === 'venue:exception') return row.locationOverride;
  if (id === 'venue:in_range') return !row.locationOverride && Boolean(row.locationVerifiedAt);
  if (id === 'venue:out_of_range') return !row.locationOverride && !row.locationVerifiedAt && row.locationDistanceMeters !== null && row.locationDistanceMeters !== undefined;
  if (id === 'venue:not_checked') return !row.locationOverride && !row.locationVerifiedAt && (row.locationDistanceMeters === null || row.locationDistanceMeters === undefined);
  if (id.startsWith('device:')) return (row.device?.kind || 'unknown') === id.slice(7);
  if (id === 'devicecheck:exception') return row.deviceOverride;
  if (id === 'devicecheck:disagree') return !row.deviceOverride && Boolean(row.device?.suspicious);
  if (id === 'devicecheck:ok') return !row.deviceOverride && !row.device?.suspicious;
  if (id === 'marking:awaiting') return row.manualTotal > row.manualGraded;
  if (id === 'marking:done') return row.manualTotal <= row.manualGraded;
  if (id.startsWith('finish:')) {
    const value = id.slice(7);
    return value === 'unknown'
      ? !['student', 'time', 'admin', 'teacher'].includes(row.submittedBy)
      : row.submittedBy === value;
  }
  return true;
}

export function dashboardCounts(rows, perStudent = false) {
  const ends = rows.filter((row) => row.attemptStatus === 'in_progress' && row.ownDeadlineAt).map((row) => Date.parse(row.ownDeadlineAt));
  return {
    writing: rows.filter((row) => row.attemptStatus === 'in_progress').length,
    lastOwnEndAt: perStudent && ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    total: rows.length,
    pending: rows.filter((row) => row.status === 'pending').length,
    started: rows.filter((row) => row.attemptStatus).length,
    submitted: rows.filter((row) => row.attemptStatus === 'submitted').length,
    awaitingMarking: rows.filter((row) => row.attemptStatus === 'submitted' && row.manualTotal > row.manualGraded).length,
    owedTime: rows.filter((row) => row.attemptStatus === 'in_progress' && (row.isPaused || row.extraMs > 0)).length,
    handedInByClose: rows.filter((row) => row.attemptStatus === 'submitted' && row.submittedBy === 'admin').length
  };
}

/** Server-side search/filter/page: the browser receives at most one table page. */
export function paginateDashboard(dashboard, raw = {}) {
  const all = dashboard.registrations || [];
  const section = raw.section === 'responses' ? 'responses' : raw.section === 'students' ? 'students' : 'test';
  const pageSize = Math.min(200, Math.max(25, Number(raw.pageSize) || 100));
  const search = String(raw.search || '').trim().toLowerCase().slice(0, 120);
  const selected = [...new Set(Array.isArray(raw.filters) ? raw.filters : String(raw.filters || '').split(',').filter(Boolean))]
    .filter((id) => FILTER_GROUPS[id]);
  const base = section === 'responses' ? all.filter((row) => row.attemptStatus === 'submitted') : section === 'students' ? all : [];
  const searched = search
    ? base.filter((row) => `${row.name || ''} ${row.sapId || ''} ${row.email || ''}`.toLowerCase().includes(search))
    : base;
  const groups = Object.values(selected.reduce((result, id) => {
    (result[FILTER_GROUPS[id]] ||= []).push(id);
    return result;
  }, {}));
  const filtered = groups.length
    ? searched.filter((row) => groups.every((ids) => ids.some((id) => dashboardFilter(row, id))))
    : searched;
  const sort = sortFor(section, raw.sort);
  if (sort !== 'order-asc') {
    const [field, way] = sort.split('-');
    const direction = way === 'desc' ? -1 : 1;
    const submitted = (row) => Date.parse(row.submittedAt || 0) || 0;
    const orders = {
      order: (a, b) => rankRegistration(a.status) - rankRegistration(b.status) || (Date.parse(a.requestedAt || 0) - Date.parse(b.requestedAt || 0)) * direction,
      sap: (a, b) => String(a.sapId || '').localeCompare(String(b.sapId || '')) * direction,
      answered: (a, b) => ((Number(a.answeredCount) || 0) - (Number(b.answeredCount) || 0)) * direction || (Date.parse(b.requestedAt || 0) - Date.parse(a.requestedAt || 0)) * direction,
      submitted: (a, b) => (submitted(a) - submitted(b)) * direction,
      name: (a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()) * direction,
      score: (a, b) => ((Number(a.score) || 0) - (Number(b.score) || 0)) * direction || (submitted(b) - submitted(a)) * direction
    };
    filtered.sort(orders[field]);
  }
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(raw.page) || 1));
  const start = (page - 1) * pageSize;
  const relevantIds = section === 'responses'
    ? Object.keys(FILTER_GROUPS).filter((id) => id.startsWith('marking:') || id.startsWith('finish:'))
    : Object.keys(FILTER_GROUPS).filter((id) => !id.startsWith('marking:') && !id.startsWith('finish:'));
  return {
    ...dashboard,
    registrations: filtered.slice(start, start + pageSize),
    counts: dashboardCounts(all, dashboard.test?.endMode === 'each'),
    filterCounts: Object.fromEntries(relevantIds.map((id) => [id, searched.filter((row) => dashboardFilter(row, id)).length])),
    pagination: { page, pageSize, total: filtered.length, unfilteredTotal: base.length, pages, section }
  };
}
