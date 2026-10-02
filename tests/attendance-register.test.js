import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  attendanceRegister, buildAttendanceRegisterSpreadsheet, buildAttendanceSpreadsheet, classesToReach, registerKey
} from '../src/export/attendance-sheet.js';

const mark = (name, overrides = {}) => ({
  id: `${name}-${Math.random()}`, name, sapId: null, email: null, isGuest: false, status: 'present', round: 1, late: false,
  markedAt: '2026-09-01T04:00:00Z', confirmedAt: null, location: null, addedByTeacher: false, sameDeviceAs: [], ...overrides
});
const session = (code, day, marks, title = 'Data Structures') => ({
  code, title, createdAt: `2026-09-${day}T04:00:00Z`, presentCount: marks.filter((entry) => entry.status === 'present').length,
  pendingCount: marks.filter((entry) => entry.status === 'pending').length, rejectedCount: marks.filter((entry) => entry.status === 'rejected').length,
  rounds: [{ number: 1, openedAt: `2026-09-${day}T04:00:00Z`, closedAt: `2026-09-${day}T04:10:00Z` }], marks
});

const asha = { email: 'asha@stu.upes.ac.in', sapId: '500100002' };
const bala = { email: 'bala@stu.upes.ac.in', sapId: '500100001' };
// Listed newest first, as the attendance list is: the register puts them in date order.
const SESSIONS = [
  session('ATT-C', '03', [mark('Asha', asha), mark('Bala', { ...bala, status: 'pending' })]),
  session('ATT-B', '02', [mark('Asha', { ...asha, round: 2, late: true }), mark('Guest Gita', { isGuest: true, sapId: '500999999' })]),
  session('ATT-A', '01', [
    mark('Asha', asha), mark('Bala', { ...bala, status: 'rejected' }), mark('Guest Gita', { isGuest: true, sapId: '500999999' }),
    mark('Walk-in', { addedByTeacher: true })
  ])
];

test('the register: one row per student, their standing in each session, and totals', () => {
  const { sessions, rows } = attendanceRegister(SESSIONS);
  assert.deepEqual(sessions.map((entry) => entry.code), ['ATT-A', 'ATT-B', 'ATT-C'], 'oldest session first');
  const row = (name) => rows.find((entry) => entry.name === name);
  assert.deepEqual(row('Asha').cells, ['present', 'late', 'present']);
  assert.deepEqual([row('Asha').present, row('Asha').absent, row('Asha').share], [3, 0, 1], 'a late mark is still present');
  // Removed counts against them; not closed yet counts neither way.
  assert.deepEqual(row('Bala').cells, ['rejected', 'absent', 'pending']);
  assert.deepEqual([row('Bala').present, row('Bala').absent, row('Bala').pending, row('Bala').share], [0, 2, 1, 0]);
  // A guest across sessions is the same row by SAP ID; someone with nothing to go by, by name.
  assert.deepEqual(row('Guest Gita').cells, ['present', 'present', 'absent']);
  assert.equal(Math.round(row('Guest Gita').share * 100), 67);
  assert.deepEqual(row('Walk-in').cells, ['present', 'absent', 'absent']);
  // In roll order: by SAP ID, then those without one.
  assert.deepEqual(rows.map((entry) => entry.name), ['Bala', 'Asha', 'Guest Gita', 'Walk-in']);
  assert.equal(registerKey({ email: 'X@stu.upes.ac.in', isGuest: false }), 'email:x@stu.upes.ac.in');
});

test('the workbook: the register, the sessions, and every mark', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildAttendanceRegisterSpreadsheet({ sessions: SESSIONS, exportedAt: '2026-09-30T10:00:00Z' }));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Register', 'Below 75%', 'Sessions', 'All marks']);
  const register = workbook.getWorksheet('Register');
  const headings = register.getRow(4).values.slice(1);
  assert.deepEqual(headings.slice(0, 5), ['No.', 'Name', 'SAP ID', 'Email', 'Account']);
  assert.match(headings[5], /^Data Structures\n01 Sep 2026, 09:30$/, 'each session: its title and when, in Indian time');
  assert.deepEqual(headings.slice(8), ['Present', 'Absent', 'Not closed', 'Attendance']);
  const line = (name) => register.getRows(5, 4).find((row) => row.getCell(2).value === name);
  assert.deepEqual(line('Asha').values.slice(1), [2, 'Asha', '500100002', 'asha@stu.upes.ac.in', 'College', 'P', 'L', 'P', 3, 0, 0, 1]);
  assert.deepEqual(line('Bala').values.slice(6, 9), ['R', 'A', '?']);
  assert.equal(line('Walk-in').getCell(5).value, 'No account');
  assert.equal(line('Guest Gita').getCell(5).value, 'Guest');
  // Under 75%, the total is in red; the cells for absence too.
  assert.equal(line('Bala').getCell(12).font?.color?.argb, 'FFB42318');
  assert.equal(line('Asha').getCell(12).font?.color?.argb, undefined);
  assert.equal(line('Bala').getCell(7).font?.color?.argb, 'FFB42318');
  assert.equal(line('Asha').getCell(12).numFmt, '0%');
  assert.deepEqual(workbook.getWorksheet('Sessions').getColumn(3).values.slice(2), ['ATT-A', 'ATT-B', 'ATT-C']);
  assert.equal(workbook.getWorksheet('All marks').rowCount, 1 + 8, 'a heading, and each of the eight marks');
});

test('the register\'s minimum can be chosen: the red totals and the short list follow it', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildAttendanceRegisterSpreadsheet({ sessions: SESSIONS, exportedAt: '2026-09-30T10:00:00Z', minShare: 0.6 }));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Register', 'Below 60%', 'Sessions', 'All marks']);
  const below = workbook.getWorksheet('Below 60%');
  // Bala (0%) and Walk-in (33%) are short; Guest Gita (67%) is not, at 60%.
  const names = below.getRows(3, below.rowCount - 2).map((row) => row.getCell(2).value);
  assert.deepEqual(names, ['Bala', 'Walk-in'], 'the lowest first');
  assert.equal(below.getRow(3).getCell(9).value, 3, 'Bala: three classes in a row reach 60% (3 of 5)');
  const register = workbook.getWorksheet('Register');
  const gita = register.getRows(5, 4).find((row) => row.getCell(2).value === 'Guest Gita');
  assert.equal(gita.getCell(12).font?.color?.argb, undefined, '67% is not red at a 60% minimum');
});

test('classes needed to reach the minimum', () => {
  assert.equal(classesToReach({ present: 3, absent: 0 }, 0.75), 0);
  assert.equal(classesToReach({ present: 1, absent: 3 }, 0.75), 8, '9 of 12 is 75%');
  assert.equal(classesToReach({ present: 0, absent: 2 }, 0.6), 3);
  assert.equal(classesToReach({ present: 4, absent: 1 }, 1), null, 'never, at 100%');
  assert.equal(classesToReach({ present: 0, absent: 0 }, 0.75), 0, 'nothing counted yet');
});

const ONE = {
  ...SESSIONS[2], classSessions: 4,
  absent: [
    { key: 'email:zed@x', name: 'Zed', sapId: '500100009', email: 'zed@x', isGuest: false, seen: 3, lastSeenAt: '2026-08-30T04:00:00Z' },
    { key: 'email:amy@x', name: 'Amy', sapId: '500100003', email: 'amy@x', isGuest: false, seen: 1, lastSeenAt: '2026-08-20T04:00:00Z' }
  ]
};

test('one session\'s workbook: its marks, who was absent (in roll order, with how often they come), its rounds', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildAttendanceSpreadsheet(ONE));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Attendance', 'Absent', 'Rounds']);
  assert.equal(workbook.getWorksheet('Attendance').getRow(3).getCell(2).value, 'Name');
  const absent = workbook.getWorksheet('Absent');
  assert.deepEqual(absent.getRow(4).values.slice(1, 8), [1, 'Amy', '500100003', 'amy@x', 'College', 1, 4]);
  assert.equal(absent.getRow(5).getCell(2).value, 'Zed');
  assert.equal(absent.getRow(5).getCell(8).value, 0.75);
});

test('downloaded from a filtered list: only the rows shown, in their order, and a line saying how they were chosen', async () => {
  const shown = { ...ONE, marks: [ONE.marks[2], ONE.marks[0]], absent: [ONE.absent[0]], note: 'Filtered: Guest · Search "gita"' };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildAttendanceSpreadsheet(shown));
  const sheet = workbook.getWorksheet('Attendance');
  assert.equal(sheet.getRow(3).getCell(1).value, 'Filtered: Guest · Search "gita"');
  assert.equal(sheet.getRow(4).getCell(2).value, 'Name');
  assert.deepEqual([sheet.getRow(5).getCell(2).value, sheet.getRow(6).getCell(2).value], ['Guest Gita', 'Asha']);
  assert.equal(sheet.rowCount, 6);
  assert.equal(workbook.getWorksheet('Absent').getRow(5).getCell(2).value, 'Zed', 'the order on screen, not roll order');
  // Only absentees shown: no Attendance sheet at all.
  const onlyAbsent = new ExcelJS.Workbook();
  await onlyAbsent.xlsx.load(await buildAttendanceSpreadsheet({ ...shown, marks: [] }));
  assert.deepEqual(onlyAbsent.worksheets.map((entry) => entry.name), ['Absent', 'Rounds']);
});
