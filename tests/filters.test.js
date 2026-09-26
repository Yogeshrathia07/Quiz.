import assert from 'node:assert/strict';
import test from 'node:test';
import { allOptionIds, applyFilters, optionCounts } from '../client/src/lib/filters.js';
import { RESULT_FILTERS, STUDENT_FILTERS, VENUE_FILTERS, paperState, studentFilters } from '../client/src/screens/admin/student-filters.js';
import { ATTENDANCE_FILTERS } from '../client/src/screens/attendance/attendance-filters.js';
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
  ]
});

const RESULTS = product({
  marking: [{ manualTotal: 0, manualGraded: 0 }, { manualTotal: 3, manualGraded: 1 }, { manualTotal: 3, manualGraded: 3 }],
  finish: [{ submittedBy: 'student' }, { submittedBy: 'time' }, { submittedBy: 'admin' }, { submittedBy: 'teacher' }, { submittedBy: null }]
}).map((row) => ({ ...row, attemptStatus: 'submitted' }));

const MARKS = product({
  status: [{ status: 'present' }, { status: 'pending' }, { status: 'rejected' }],
  account: [{ isGuest: false }, { isGuest: true }],
  added: [{ addedByTeacher: false }, { addedByTeacher: true }]
});

const ACCOUNTS = product({
  role: [{ role: 'student' }, { role: 'faculty' }],
  signin: [{ hasPassword: true }, { hasPassword: false }]
});

const LISTS = [
  ['students', studentFilters({ locationRequired: true }), STUDENTS],
  ['results', RESULT_FILTERS, RESULTS],
  ['attendance', ATTENDANCE_FILTERS, MARKS],
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

test('students: the venue group is offered only on a test with a venue check', () => {
  assert.deepEqual(studentFilters({ locationRequired: false }), STUDENT_FILTERS);
  assert.ok(studentFilters({ locationRequired: true }).includes(VENUE_FILTERS));
});

test('results: marking and how it ended', () => {
  const pick = (...ids) => applyFilters(RESULTS, RESULT_FILTERS, ids);
  assert.ok(pick('marking:awaiting').every((row) => row.manualGraded < row.manualTotal));
  assert.equal(pick('marking:done').length, RESULTS.length * (2 / 3), 'no short answers counts as fully marked');
  assert.ok(pick('finish:unknown').every((row) => row.submittedBy === null));
  assert.ok(RESULT_FILTERS.flatMap((group) => group.options).find((option) => option.id === 'finish:unknown').rare, 'hidden until needed');
});
