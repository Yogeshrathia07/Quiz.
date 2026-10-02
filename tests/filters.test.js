import assert from 'node:assert/strict';
import test from 'node:test';
import { allOptionIds, applyFilters, optionCounts, packColumns } from '../client/src/lib/filters.js';
import { DEVICE_CHECK_FILTERS, DEVICE_FILTERS, RESULT_FILTERS, STUDENT_FILTERS, VENUE_FILTERS, paperState, studentFilters } from '../client/src/screens/admin/student-filters.js';
import {
  ABSENT_FILTERS, ATTENDANCE_FILTERS, absentees, attendanceFilters, sessionFilters, sortMarks, sortSessions, whenOf
} from '../client/src/screens/attendance/attendance-filters.js';
import { USER_FILTERS } from '../client/src/screens/admin/user-filters.js';

/** Every combination of every field the filters look at. */
function product(fields) {
  return Object.entries(fields).reduce(
    (rows, [key, values]) => rows.flatMap((row) => values.map((value) => ({ ...row, ...value, [`_${key}`]: value }))),
    [{}]
  );
}

const STUDENTS = product({
  status: [{ status: 'pending' }, { status: 'approved' }, { status: 'rejected' }],
  paper: [
    { attemptStatus: null, isLocked: false },
    { attemptStatus: 'in_progress', isLocked: false },
    { attemptStatus: 'in_progress', isLocked: true },
    { attemptStatus: 'in_progress', isPaused: true },
    // Paused while locked: paused is what the teacher sees.
    { attemptStatus: 'in_progress', isLocked: true, isPaused: true },
    { attemptStatus: 'submitted', isLocked: false },
    // Closed by the admin while locked: submitted, and still flagged locked.
    { attemptStatus: 'submitted', isLocked: true }
  ],
  account: [
    { accountType: 'student', email: 'a@stu.upes.ac.in' },
    { accountType: 'faculty', email: 'f@ddn.upes.ac.in' },
    { accountType: 'guest', email: 'guest-x@guest.test' },
    // An older guest row with no account type, known only by its address.
    { accountType: undefined, email: 'guest-y@guest.test' }
  ],
  venue: [
    { locationOverride: true, locationVerifiedAt: null, locationDistanceMeters: 900 },
    { locationOverride: false, locationVerifiedAt: '2026-09-26T10:00:00Z', locationDistanceMeters: 20 },
    { locationOverride: false, locationVerifiedAt: null, locationDistanceMeters: 900 },
    { locationOverride: false, locationVerifiedAt: null, locationDistanceMeters: null }
  ],
  device: [
    // Never reported (joined before devices were recorded, or not yet).
    { device: null, deviceOverride: false },
    { device: { kind: 'phone', suspicious: false }, deviceOverride: false },
    { device: { kind: 'laptop', suspicious: true }, deviceOverride: false },
    // Allowed by the teacher, and its signals disagree too: the exception is what shows.
    { device: { kind: 'tablet', suspicious: true }, deviceOverride: true },
    { device: { kind: 'unknown', suspicious: false }, deviceOverride: false }
  ]
});

const RESULTS = product({
  marking: [{ manualTotal: 0, manualGraded: 0 }, { manualTotal: 3, manualGraded: 1 }, { manualTotal: 3, manualGraded: 3 }],
  finish: [{ submittedBy: 'student' }, { submittedBy: 'time' }, { submittedBy: 'admin' }, { submittedBy: 'teacher' }, { submittedBy: null }]
}).map((row) => ({ ...row, attemptStatus: 'submitted' }));

const MARKS = product({
  status: [{ status: 'present' }, { status: 'pending' }, { status: 'rejected' }],
  round: [{ late: false }, { late: true }],
  venue: [{ location: null }, { location: { status: 'inside', distanceMeters: 12 } }, { location: { status: 'uncertain', distanceMeters: 140 } }],
  phone: [
    { sameDeviceAs: [], similarDeviceAs: [] },
    { sameDeviceAs: ['Ben'], similarDeviceAs: [] },
    { sameDeviceAs: [], similarDeviceAs: ['Chen'] },
    // A known match and a lookalike: the known match is what shows.
    { sameDeviceAs: ['Ben'], similarDeviceAs: ['Chen'] }
  ],
  account: [{ isGuest: false }, { isGuest: true }],
  added: [{ addedByTeacher: false }, { addedByTeacher: true }]
});

const ABSENT = product({
  account: [{ isGuest: false }, { isGuest: true }],
  record: [{ share: 0 }, { share: 0.5 }, { share: 0.75 }, { share: 1 }]
});

const NOW = new Date(2026, 9, 1, 11, 0); // Thursday 1 October 2026, 11:00
const SESSIONS = product({
  state: [{ isOpen: true }, { isOpen: false }],
  when: [
    { createdAt: new Date(2026, 9, 1, 9, 0).toISOString() },
    { createdAt: new Date(2026, 8, 29, 9, 0).toISOString() }, // Tuesday: earlier this week, last month
    { createdAt: new Date(2026, 8, 20, 9, 0).toISOString() },
    { createdAt: new Date(2026, 7, 1, 9, 0).toISOString() }
  ],
  title: [{ title: 'DBMS' }, { title: 'Networks' }],
  flags: [{ flaggedCount: 0 }, { flaggedCount: 2 }]
});

const ACCOUNTS = product({
  role: [{ role: 'student' }, { role: 'faculty' }],
  signin: [{ hasPassword: true }, { hasPassword: false }]
});

const LISTS = [
  ['students', studentFilters({ locationRequired: true }), STUDENTS],
  ['results', RESULT_FILTERS, RESULTS],
  ['attendance', ATTENDANCE_FILTERS, MARKS],
  ['absent', ABSENT_FILTERS, ABSENT],
  ['sessions', sessionFilters(SESSIONS, NOW), SESSIONS],
  ['users', USER_FILTERS, ACCOUNTS]
];

for (const [name, groups, rows] of LISTS) {
  test(`${name}: every group puts each row in exactly one option`, () => {
    for (const group of groups) {
      for (const row of rows) {
        const hits = group.options.filter((option) => option.test(row)).map((option) => option.id);
        assert.equal(hits.length, 1, `${group.title}: ${JSON.stringify(row)} matched ${hits.join(', ') || 'nothing'}`);
      }
    }
  });

  test(`${name}: nothing ticked, or everything ticked, shows everyone`, () => {
    assert.equal(applyFilters(rows, groups, []).length, rows.length);
    assert.equal(applyFilters(rows, groups, allOptionIds(groups)).length, rows.length);
    for (const group of groups) {
      // A whole group ticked is the same as none of it.
      assert.equal(applyFilters(rows, groups, group.options.map((option) => option.id)).length, rows.length, group.title);
    }
  });

  test(`${name}: one option shows exactly its rows, and the counts agree`, () => {
    const counts = optionCounts(rows, groups);
    for (const option of groups.flatMap((group) => group.options)) {
      const expected = rows.filter(option.test);
      assert.deepEqual(applyFilters(rows, groups, [option.id]), expected, option.id);
      assert.equal(counts[option.id], expected.length, option.id);
    }
  });

  test(`${name}: options in a group add up; groups narrow each other`, () => {
    for (const group of groups) {
      const [first, second] = group.options;
      const either = applyFilters(rows, groups, [first.id, second.id]);
      assert.equal(either.length, rows.filter(first.test).length + rows.filter(second.test).length, `${first.id} or ${second.id}`);
    }
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const [x, y] = [groups[a].options[0], groups[b].options[0]];
        assert.deepEqual(applyFilters(rows, groups, [x.id, y.id]), rows.filter((row) => x.test(row) && y.test(row)), `${x.id} and ${y.id}`);
      }
    }
  });
}

test('students: the options pick the right people', () => {
  const pick = (...ids) => applyFilters(STUDENTS, studentFilters({ locationRequired: true }), ids);
  assert.ok(pick('paper:locked').every((row) => row.attemptStatus === 'in_progress' && row.isLocked));
  assert.ok(pick('paper:in_progress').every((row) => row.attemptStatus === 'in_progress' && !row.isLocked && !row.isPaused), 'a locked or paused paper is not also in progress');
  assert.ok(pick('paper:paused').every((row) => row.isPaused) && pick('paper:paused').length > 0);
  assert.ok(pick('paper:submitted').some((row) => row.isLocked), 'a paper closed while locked is submitted');
  assert.ok(pick('guest').every((row) => row.email.endsWith('@guest.test')), 'guests, with or without an account type');
  assert.equal(pick('guest').length, STUDENTS.length / 2);
  assert.ok(pick('venue:exception').every((row) => row.locationOverride), 'an exception beats a distance');
  assert.ok(pick('approved', 'paper:locked', 'venue:out_of_range').every((row) => (
    row.status === 'approved' && paperState(row) === 'locked' && !row.locationOverride && !row.locationVerifiedAt && row.locationDistanceMeters !== null
  )));
});

test('students: the venue group is offered only on a test with a venue check; the device groups always', () => {
  assert.deepEqual(studentFilters({ locationRequired: false }), [...STUDENT_FILTERS, DEVICE_FILTERS, DEVICE_CHECK_FILTERS]);
  assert.deepEqual(studentFilters({ locationRequired: true }), [...STUDENT_FILTERS, VENUE_FILTERS, DEVICE_FILTERS, DEVICE_CHECK_FILTERS]);
});

test('students: the device groups', () => {
  const pick = (...ids) => applyFilters(STUDENTS, studentFilters({ locationRequired: true }), ids);
  assert.ok(pick('device:unknown').every((row) => !row.device || row.device.kind === 'unknown'), 'never reported counts as not known');
  assert.ok(pick('devicecheck:exception').every((row) => row.deviceOverride), 'an exception beats disagreeing signals');
  assert.ok(pick('devicecheck:disagree').every((row) => row.device.suspicious && !row.deviceOverride));
  assert.equal(pick('devicecheck:disagree').length, STUDENTS.length / 5);
  assert.ok(pick('device:phone', 'devicecheck:ok').every((row) => row.device.kind === 'phone' && !row.device.suspicious));
});

test('results: marking and how it ended', () => {
  const pick = (...ids) => applyFilters(RESULTS, RESULT_FILTERS, ids);
  assert.ok(pick('marking:awaiting').every((row) => row.manualGraded < row.manualTotal));
  assert.equal(pick('marking:done').length, RESULTS.length * (2 / 3), 'no short answers counts as fully marked');
  assert.ok(pick('finish:unknown').every((row) => row.submittedBy === null));
  assert.ok(RESULT_FILTERS.flatMap((group) => group.options).find((option) => option.id === 'finish:unknown').rare, 'hidden until needed');
});

test('the filter panel packs its groups into short, balanced columns', () => {
  const ids = (columns) => columns.map((column) => column.map((group) => group.id));
  const students = studentFilters({ locationRequired: true });
  // Three across: short groups share a column; the tallest (paper, the device ones) balance the rest.
  assert.deepEqual(ids(packColumns(students, 3)), [['registration', 'venue'], ['paper', 'account'], ['device', 'devicecheck']]);
  // No column taller than it has to be.
  const tallest = (columns) => Math.max(...columns.map((column) => column.reduce((sum, group) => sum + group.options.length + 1, 0)));
  assert.equal(tallest(packColumns(students, 2)), 14);
  assert.equal(tallest(packColumns(students, 3)), 9);
  assert.equal(tallest(packColumns(students, 4)), 8);
  assert.deepEqual(ids(packColumns(students, 1)), [['registration', 'paper', 'account', 'venue', 'device', 'devicecheck']]);
  // Never more columns than groups, and every group exactly once.
  assert.deepEqual(ids(packColumns(RESULT_FILTERS, 3)), [['marking'], ['finish']]);
  for (const count of [1, 2, 3, 4]) {
    assert.deepEqual(packColumns(students, count).flat().map((group) => group.id).sort(), students.map((group) => group.id).sort());
  }
});

test('attendance: a session offers Round once taken again, and Distance only with the check on', () => {
  const ids = (session) => attendanceFilters(session).map((group) => group.id);
  assert.deepEqual(ids({ rounds: [{}], locationRequired: false }), ['status', 'phone', 'account', 'added']);
  assert.deepEqual(ids({ rounds: [{}, {}], locationRequired: true }), ['status', 'round', 'venue', 'phone', 'account', 'added']);
});

test('attendance: the options pick the right marks', () => {
  const pick = (...ids) => applyFilters(MARKS, ATTENDANCE_FILTERS, ids);
  assert.ok(pick('shared').every((row) => row.sameDeviceAs.length > 0));
  assert.ok(pick('similar').every((row) => row.sameDeviceAs.length === 0 && row.similarDeviceAs.length > 0), 'a known match is not also a maybe');
  assert.ok(pick('unchecked').every((row) => row.location === null));
  assert.ok(pick('late', 'uncertain').every((row) => row.late && row.location?.status === 'uncertain'));
});

test('attendance: sorting by time, name, SAP ID or distance - those without one last, either way round', () => {
  const marks = [
    { name: 'bala', sapId: '500000002', markedAt: '2026-10-01T04:02:00Z', location: { distanceMeters: 40 } },
    { name: 'Asha', sapId: null, markedAt: '2026-10-01T04:01:00Z', location: null },
    { name: 'Chen', sapId: '500000001', markedAt: '2026-10-01T04:03:00Z', location: { distanceMeters: 5 } }
  ];
  const names = (sort) => sortMarks(marks, sort).map((mark) => mark.name);
  assert.deepEqual(names('time-asc'), ['Asha', 'bala', 'Chen']);
  assert.deepEqual(names('time-desc'), ['Chen', 'bala', 'Asha']);
  assert.deepEqual(names('name-asc'), ['Asha', 'bala', 'Chen'], 'regardless of case');
  assert.deepEqual(names('sap-asc'), ['Chen', 'bala', 'Asha']);
  assert.deepEqual(names('sap-desc'), ['bala', 'Chen', 'Asha'], 'no SAP ID still last');
  assert.deepEqual(names('distance-asc'), ['Chen', 'bala', 'Asha']);
  assert.deepEqual(names('nonsense-asc'), ['bala', 'Asha', 'Chen'], 'an unknown order leaves the list as it is');
});

test('absent: everyone on the roster with no mark here, even a removed one, with their share of the class', () => {
  const roster = { sessionCount: 4, people: [
    { key: 'email:a@x', name: 'Asha', seen: 4 }, { key: 'email:b@x', name: 'Ben', seen: 1 }, { key: 'email:c@x', name: 'Chen', seen: 2 }
  ] };
  const absent = absentees(roster, [{ key: 'email:a@x', status: 'present' }, { key: 'email:c@x', status: 'rejected' }]);
  assert.deepEqual(absent.map((person) => [person.name, person.share]), [['Ben', 0.25]]);
  assert.deepEqual(absentees(null, []), []);
});

test('sessions: when, by the calendar week and month', () => {
  const when = (date) => whenOf({ createdAt: date.toISOString() }, NOW);
  assert.equal(when(new Date(2026, 9, 1, 0, 5)), 'today');
  assert.equal(when(new Date(2026, 8, 28, 9, 0)), 'week', 'Monday');
  assert.equal(when(new Date(2026, 8, 27, 9, 0)), 'older', 'Sunday, last month');
  assert.equal(when(new Date(2026, 8, 30, 9, 0)), 'week');
  assert.equal(whenOf({ createdAt: new Date(2026, 9, 3).toISOString() }, new Date(2026, 9, 12, 10)), 'month');
});

test('sessions: a Class group only once there are two classes; sorting newest first, by class, by turnout', () => {
  assert.equal(sessionFilters([{ title: 'DBMS' }], NOW).some((group) => group.id === 'class'), false);
  const sessions = [
    { title: 'Networks', createdAt: '2026-09-02T04:00:00Z', presentCount: 30 },
    { title: 'DBMS', createdAt: '2026-09-03T04:00:00Z', presentCount: 12 }
  ];
  assert.deepEqual(sortSessions(sessions, 'date-desc').map((session) => session.title), ['DBMS', 'Networks']);
  assert.deepEqual(sortSessions(sessions, 'title-asc').map((session) => session.title), ['DBMS', 'Networks']);
  assert.deepEqual(sortSessions(sessions, 'present-desc').map((session) => session.presentCount), [30, 12]);
});
