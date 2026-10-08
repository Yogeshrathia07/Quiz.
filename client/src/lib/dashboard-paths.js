/**
 * The addresses a test's dashboard reads, in one place, so a page fetched
 * ahead (the quiz list, the home page) and the dashboard itself ask for -
 * and find - the very same thing.
 */

/** The most rows the server sends in one reply: a class this size or smaller comes whole. */
export const WHOLE_CLASS = 200;

const testPath = (code) => `/api/admin/tests/${encodeURIComponent(code)}`;

/** One page of a list, narrowed on the server - for a class bigger than one reply. */
export function dashboardPath(code, { section = 'test', page = 1, pageSize = 100, search = '', filters = '', sort = '' } = {}) {
  const params = new URLSearchParams({ section, page: String(page), pageSize: String(pageSize) });
  if (search) params.set('search', search);
  if (filters) params.set('filters', filters);
  if (sort) params.set('sort', sort);
  return `${testPath(code)}?${params}`;
}

/** The whole class at once (when it fits): every tab, search, filter and order is then worked out in the browser. */
export const wholeClassPath = (code) => dashboardPath(code, { section: 'students', pageSize: WHOLE_CLASS });

/** The Test tab's overview: the whole class at a glance (services/overview-service.js). */
export const overviewPath = (code) => `${testPath(code)}/overview`;
/** The Analysis tab: every submitted paper against every question. */
export const matrixPath = (code) => `${testPath(code)}/matrix`;

/** One student's record on a test: `/analysis` for the log and readings, `/record.xlsx` to download. */
export const recordPath = (code, registrationId) => `${testPath(code)}/registrations/${encodeURIComponent(registrationId)}`;
