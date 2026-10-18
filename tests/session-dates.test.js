import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { applyFilters } from '../client/src/lib/filters.js';
import { sessionFilters, sortSessions } from '../client/src/screens/attendance/attendance-filters.js';
import { EMPTY_SESSION_DATES, localDateKey, sessionDateFilter } from '../client/src/screens/attendance/session-dates.js';

const session = (date, fields = {}) => ({ createdAt: new Date(`${date}T12:00:00`).toISOString(), title: 'Sample', isOpen: false, ...fields });
const datesOf = (rows, value) => rows.filter(sessionDateFilter(value).test).map((row) => localDateKey(row.createdAt));

test('session dates: all dates, clearing a picker and unknown modes do not hide sessions', () => {
  const rows = [session('2026-10-01'), { createdAt: null }, {}];
  for (const value of [EMPTY_SESSION_DATES, {}, null, { mode: 'unknown' }, { mode: 'month' }, { mode: 'day' }, { mode: 'range' }]) {
    const filter = sessionDateFilter(value);
    assert.equal(filter.active, 0);
    assert.equal(filter.error, null);
    assert.equal(rows.filter(filter.test).length, rows.length);
  }
  for (const value of ['', null, undefined, 'not a date']) assert.equal(localDateKey(value), null);
});

test('session dates: month and year match, single month includes its entire last day', () => {
  const rows = ['2025-10-01', '2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01'].map((day) => session(day));
  const lastMinute = { createdAt: new Date(2026, 9, 31, 23, 59, 59, 999).toISOString() };
  const filter = sessionDateFilter({ mode: 'month', month: '2026-10' });
  assert.deepEqual(datesOf(rows, { mode: 'month', month: '2026-10' }), ['2026-10-01', '2026-10-31']);
  assert.equal(filter.label, 'Oct 2026');
  assert.equal(filter.test(lastMinute), true);
  assert.equal(filter.test({ createdAt: null }), false);
  assert.equal(filter.test({}), false);
});

test('session dates: month ranges cross December into January, both months included', () => {
  const rows = ['2025-11-30', '2025-12-01', '2025-12-31', '2026-01-31', '2026-02-01'].map((day) => session(day));
  const value = { mode: 'month', month: '2025-12', throughMonth: '2026-01' };
  assert.deepEqual(datesOf(rows, value), ['2025-12-01', '2025-12-31', '2026-01-31']);
  assert.equal(sessionDateFilter(value).label, 'Dec 2025 – Jan 2026');
  assert.equal(sessionDateFilter({ mode: 'month', month: '2026-01', throughMonth: '2026-01' }).label, 'Jan 2026');
});

test('session dates: a day uses local midnight to midnight, including leap day', () => {
  const filter = sessionDateFilter({ mode: 'day', day: '2024-02-29' });
  const row = (date) => ({ createdAt: date.toISOString() });
  assert.equal(filter.test(row(new Date(2024, 1, 28, 23, 59, 59, 999))), false);
  assert.equal(filter.test(row(new Date(2024, 1, 29, 0, 0, 0))), true);
  assert.equal(filter.test(row(new Date(2024, 1, 29, 23, 59, 59, 999))), true);
  assert.equal(filter.test(row(new Date(2024, 2, 1, 0, 0, 0))), false);
});

test('session dates: inclusive date ranges, same-day ranges and open ends', () => {
  const rows = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((day) => session(day));
  assert.deepEqual(datesOf(rows, { mode: 'range', from: '2026-09-30', to: '2026-10-01' }), ['2026-09-30', '2026-10-01']);
  assert.deepEqual(datesOf(rows, { mode: 'range', from: '2026-10-01', to: '2026-10-01' }), ['2026-10-01']);
  assert.deepEqual(datesOf(rows, { mode: 'range', from: '2026-10-01' }), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(datesOf(rows, { mode: 'range', to: '2026-09-30' }), ['2026-09-29', '2026-09-30']);
});

test('session dates: reversed ranges, impossible dates and malformed months give a visible validation error', () => {
  const bad = [
    { mode: 'month', month: '2026-13' }, { mode: 'month', month: '0000-01' },
    { mode: 'month', month: '2026-10', throughMonth: '2026-09' },
    { mode: 'month', throughMonth: '2026-10' },
    { mode: 'range', from: '2026-10-10', to: '2026-10-09' },
    { mode: 'range', from: '2026-02-29' }, { mode: 'range', to: '2026-04-31' },
    { mode: 'day', day: '2026-02-29' }, { mode: 'day', day: '2026-01-00' },
    { mode: 'day', day: '<script>' }
  ];
  for (const value of bad) {
    const filter = sessionDateFilter(value);
    assert.equal(filter.active, 1);
    assert.ok(filter.error, JSON.stringify(value));
    assert.equal(filter.test(session('2026-10-01')), false);
  }
});

test('session dates: calendar combines with state and search; sorting never changes source rows and missing dates stay last', () => {
  const rows = [session('2026-10-01', { title: 'DBMS', isOpen: true }), session('2026-10-02', { title: 'DBMS' }), session('2026-10-03', { title: 'Networks', isOpen: true }), session('2026-09-01', { title: 'DBMS', isOpen: true })];
  const copy = structuredClone(rows);
  const date = sessionDateFilter({ mode: 'month', month: '2026-10' });
  const searched = rows.filter((row) => row.title === 'DBMS').filter(date.test);
  assert.deepEqual(applyFilters(searched, sessionFilters(), ['open']).map((row) => localDateKey(row.createdAt)), ['2026-10-01']);
  assert.equal(applyFilters(searched, sessionFilters(), ['open', 'closed']).length, 2);
  sortSessions(rows, 'date-desc');
  assert.deepEqual(rows, copy);
  const undated = { title: 'No date' };
  for (const order of ['date-asc', 'date-desc']) assert.equal(sortSessions([undated, ...rows], order).at(-1), undated);
  assert.equal(sessionDateFilter(EMPTY_SESSION_DATES).active, 0, 'Reset removes all calendar restrictions');
});

test('session dates: UTC offsets and daylight-saving days use the displayed local date, not UTC or a fixed 24-hour cutoff', () => {
  const moduleUrl = new URL('../client/src/screens/attendance/session-dates.js', import.meta.url).href;
  const run = (tz, source) => execFileSync(process.execPath, ['--input-type=module', '-e', `import {sessionDateFilter,localDateKey} from ${JSON.stringify(moduleUrl)}; ${source}`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
  assert.equal(run('Asia/Kolkata', `console.log(localDateKey('2026-09-30T18:30:00Z'))`), '2026-10-01');
  assert.equal(run('UTC', `console.log(localDateKey('2026-09-30T18:30:00Z'))`), '2026-09-30');
  assert.equal(run('America/New_York', `const f=sessionDateFilter({mode:'day',day:'2026-03-08'});console.log(['2026-03-08T04:59:59Z','2026-03-08T05:00:00Z','2026-03-09T03:59:59Z','2026-03-09T04:00:00Z'].map(createdAt=>f.test({createdAt})).join(','))`), 'false,true,true,false');
});
