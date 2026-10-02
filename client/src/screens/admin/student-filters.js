/**
 * What the dashboard's Students and Results lists can be filtered by. Each
 * group sorts every row into exactly one of its options, so ticking a whole
 * group - or everything - still shows everyone (see tests/filters.test.js).
 */

export const isGuest = (registration) => registration.accountType === 'guest'
  || String(registration.email || '').toLowerCase().endsWith('@guest.test');

export function venueStatus(registration) {
  if (registration.locationOverride) return 'exception';
  if (registration.locationVerifiedAt) return 'in_range';
  if (registration.locationDistanceMeters !== null && registration.locationDistanceMeters !== undefined) return 'out_of_range';
  return 'not_checked';
}

/** Where a student's paper stands. A paused or locked paper is not also "in progress". */
export function paperState(registration) {
  if (!registration.attemptStatus) return 'not_started';
  if (registration.attemptStatus === 'submitted') return 'submitted';
  if (registration.isPaused) return 'paused';
  return registration.isLocked ? 'locked' : 'in_progress';
}

/** `rare`: left out of the menu while nothing matches it. */
const option = (id, label, test, { rare = false } = {}) => ({ id, label, test, rare });

export const STUDENT_FILTERS = [
  { id: 'registration', title: 'Registration', options: [
    option('pending', 'Pending', (row) => row.status === 'pending'),
    option('approved', 'Approved', (row) => row.status === 'approved'),
    option('rejected', 'Rejected', (row) => row.status === 'rejected')
  ] },
  { id: 'paper', title: 'Paper', options: [
    option('paper:not_started', 'Not started', (row) => paperState(row) === 'not_started'),
    option('paper:in_progress', 'In progress', (row) => paperState(row) === 'in_progress'),
    option('paper:paused', 'Paused', (row) => paperState(row) === 'paused', { rare: true }),
    option('paper:locked', 'Locked', (row) => paperState(row) === 'locked'),
    option('paper:submitted', 'Submitted', (row) => paperState(row) === 'submitted')
  ] },
  { id: 'account', title: 'Account', options: [
    option('verified', 'College account', (row) => !isGuest(row)),
    option('guest', 'Guest', (row) => isGuest(row))
  ] }
];

/** Offered only on tests with a venue check. */
export const VENUE_FILTERS = { id: 'venue', title: 'Venue', options: [
  option('venue:in_range', 'In range', (row) => venueStatus(row) === 'in_range'),
  option('venue:out_of_range', 'Out of range', (row) => venueStatus(row) === 'out_of_range'),
  option('venue:exception', 'Exception granted', (row) => venueStatus(row) === 'exception'),
  option('venue:not_checked', 'Not checked yet', (row) => venueStatus(row) === 'not_checked')
] };

/** The device a student last reported (src/domain/device.js); 'unknown' before any report. */
export const deviceKind = (registration) => (['phone', 'tablet', 'laptop'].includes(registration.device?.kind) ? registration.device.kind : 'unknown');

/** One per student, like the venue: an exception first, then signals that disagree. */
export function deviceCheckStatus(registration) {
  if (registration.deviceOverride) return 'exception';
  return registration.device?.suspicious ? 'disagree' : 'ok';
}

export const DEVICE_FILTERS = { id: 'device', title: 'Device', options: [
  option('device:phone', 'Phone', (row) => deviceKind(row) === 'phone'),
  option('device:tablet', 'Tablet', (row) => deviceKind(row) === 'tablet', { rare: true }),
  option('device:laptop', 'Laptop', (row) => deviceKind(row) === 'laptop'),
  option('device:unknown', 'Not known yet', (row) => deviceKind(row) === 'unknown', { rare: true })
] };

export const DEVICE_CHECK_FILTERS = { id: 'devicecheck', title: 'Device check', options: [
  option('devicecheck:ok', 'Nothing unusual', (row) => deviceCheckStatus(row) === 'ok'),
  option('devicecheck:disagree', 'Signals disagree', (row) => deviceCheckStatus(row) === 'disagree', { rare: true }),
  option('devicecheck:exception', 'Device allowed by you', (row) => deviceCheckStatus(row) === 'exception', { rare: true })
] };

export const studentFilters = (test) => [
  ...STUDENT_FILTERS,
  ...(test.locationRequired ? [VENUE_FILTERS] : []),
  DEVICE_FILTERS,
  DEVICE_CHECK_FILTERS
];

/** Short answers still to mark. */
export const awaitingMarking = (row) => row.manualTotal > row.manualGraded;

/** Results rows are submitted papers only. */
export const RESULT_FILTERS = [
  { id: 'marking', title: 'Marking', options: [
    option('marking:awaiting', 'Awaiting marking', (row) => awaitingMarking(row)),
    option('marking:done', 'Fully marked', (row) => !awaitingMarking(row))
  ] },
  { id: 'finish', title: 'How it ended', options: [
    option('finish:student', 'Submitted by student', (row) => row.submittedBy === 'student'),
    option('finish:time', 'Time ran out', (row) => row.submittedBy === 'time'),
    option('finish:admin', 'Closed by you', (row) => row.submittedBy === 'admin'),
    option('finish:teacher', 'Handed in by you', (row) => row.submittedBy === 'teacher', { rare: true }),
    // Papers handed in before the portal recorded how.
    option('finish:unknown', 'Not recorded', (row) => !['student', 'time', 'admin', 'teacher'].includes(row.submittedBy), { rare: true })
  ] }
];
