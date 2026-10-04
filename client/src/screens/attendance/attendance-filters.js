/**
 * What the attendance lists can be filtered and sorted by (see
 * client/src/lib/filters.js). Each group sorts every row into exactly one of
 * its options, so ticking a whole group - or everything - still shows
 * everyone (tests/filters.test.js).
 */
import { sortBy, whenOf } from '../../lib/filters.js';

export { whenOf };

/** `rare`: left out of the menu while nothing matches it. */
const option = (id, label, test, { rare = false } = {}) => ({ id, label, test, rare });

/* ------------------------------------------------- one session: its marks */

/** Where the student was, by the distance check: 'inside', 'uncertain' (weak GPS) or 'unchecked'. */
export const venueOf = (mark) => (!mark.location ? 'unchecked' : mark.location.status === 'inside' ? 'inside' : 'uncertain');

/** The phone check: 'shared' (known to be one phone), 'similar' (looks like one) or 'clear'. */
export const phoneOf = (mark) => (mark.sameDeviceAs?.length ? 'shared' : mark.similarDeviceAs?.length ? 'similar' : 'clear');

const STATUS = { id: 'status', title: 'Status', options: [
  option('present', 'Present', (mark) => mark.status === 'present'),
  option('pending', 'Pending', (mark) => mark.status === 'pending'),
  option('rejected', 'Removed', (mark) => mark.status === 'rejected')
] };
const ROUND = { id: 'round', title: 'Round', options: [
  option('ontime', 'On time', (mark) => !mark.late),
  option('late', 'Late', (mark) => Boolean(mark.late))
] };
const VENUE = { id: 'venue', title: 'Distance', options: [
  option('inside', 'In the classroom', (mark) => venueOf(mark) === 'inside'),
  option('uncertain', 'Weak GPS', (mark) => venueOf(mark) === 'uncertain'),
  option('unchecked', 'Not checked', (mark) => venueOf(mark) === 'unchecked')
] };
const PHONE = { id: 'phone', title: 'Phone check', options: [
  option('shared', 'Same phone', (mark) => phoneOf(mark) === 'shared'),
  option('similar', 'Possibly same phone', (mark) => phoneOf(mark) === 'similar', { rare: true }),
  option('clear', 'Nothing found', (mark) => phoneOf(mark) === 'clear')
] };
const ACCOUNT = { id: 'account', title: 'Account', options: [
  option('college', 'College student', (row) => !row.isGuest),
  option('guest', 'Guest', (row) => Boolean(row.isGuest))
] };
const ADDED = { id: 'added', title: 'Marked by', options: [
  option('self', 'Scanned the QR', (mark) => !mark.addedByTeacher),
  option('teacher', 'Added by you', (mark) => Boolean(mark.addedByTeacher))
] };

/** Every group a session's list can have. */
export const ATTENDANCE_FILTERS = [STATUS, ROUND, VENUE, PHONE, ACCOUNT, ADDED];

/** The groups this session offers: Round once it has been taken again, Distance with the check on. */
export const attendanceFilters = (session) => [
  STATUS,
  ...((session.rounds?.length || 0) > 1 ? [ROUND] : []),
  ...(session.locationRequired ? [VENUE] : []),
  PHONE, ACCOUNT, ADDED
];

/** The options that pick out marks the phone check flagged. */
export const PHONE_FLAG_IDS = ['shared', 'similar'];

/* ------------------------------------------------ one session: who is absent */

/** Colleges commonly require this much attendance. */
export const MIN_SHARE = 0.75;

export const ABSENT_FILTERS = [
  { id: 'absent-account', title: 'Account', options: [
    option('absent:college', 'College student', (person) => !person.isGuest),
    option('absent:guest', 'Guest', (person) => Boolean(person.isGuest))
  ] },
  { id: 'record', title: 'Their attendance', options: [
    option('record:regular', `${MIN_SHARE * 100}% or more`, (person) => person.share >= MIN_SHARE),
    option('record:short', `Under ${MIN_SHARE * 100}%`, (person) => person.share < MIN_SHARE)
  ] }
];

/** People on the class roster with no mark on this session, each with their share of the class's other sessions. */
export function absentees(roster, marks) {
  if (!roster?.people?.length) return [];
  const here = new Set(marks.map((mark) => mark.key));
  return roster.people
    .filter((person) => !here.has(person.key))
    .map((person) => ({ ...person, share: roster.sessionCount ? person.seen / roster.sessionCount : 0 }));
}

/* ---------------------------------------------------------------- sorting */

const byText = (value) => String(value || '').toLocaleLowerCase();

const MARK_FIELDS = {
  time: (mark) => Date.parse(mark.markedAt) || 0,
  name: (mark) => byText(mark.name),
  sap: (mark) => mark.sapId || '',
  distance: (mark) => mark.location?.distanceMeters ?? null
};
const ABSENT_FIELDS = {
  sap: (person) => person.sapId || '',
  name: (person) => byText(person.name),
  share: (person) => person.share,
  seen: (person) => Date.parse(person.lastSeenAt) || 0
};
const SESSION_FIELDS = {
  date: (session) => Date.parse(session.createdAt) || 0,
  title: (session) => byText(session.title),
  present: (session) => session.presentCount
};

export const sortMarks = (marks, sort) => sortBy(marks, sort, MARK_FIELDS);
export const sortAbsent = (people, sort) => sortBy(people, sort, ABSENT_FIELDS);
export const sortSessions = (sessions, sort) => sortBy(sessions, sort, SESSION_FIELDS);

/* --------------------------------------------------- the list of sessions */

/** The list's groups: a Class group once there are two classes to choose between. */
export function sessionFilters(sessions, now = new Date()) {
  const titles = [...new Set(sessions.map((session) => session.title))].sort((a, b) => a.localeCompare(b));
  return [
    { id: 'state', title: 'State', options: [
      option('open', 'Open', (session) => session.isOpen),
      option('closed', 'Closed', (session) => !session.isOpen)
    ] },
    { id: 'when', title: 'When', options: [
      option('when:today', 'Today', (session) => whenOf(session, now) === 'today'),
      option('when:week', 'Earlier this week', (session) => whenOf(session, now) === 'week', { rare: true }),
      option('when:month', 'Earlier this month', (session) => whenOf(session, now) === 'month', { rare: true }),
      option('when:older', 'Before this month', (session) => whenOf(session, now) === 'older', { rare: true })
    ] },
    ...(titles.length > 1 ? [{ id: 'class', title: 'Class', options: titles.map((title) => option(`class:${title}`, title, (session) => session.title === title)) }] : []),
    { id: 'flags', title: 'Phone check', options: [
      option('flagged', 'Phones flagged', (session) => session.flaggedCount > 0),
      option('unflagged', 'Nothing found', (session) => !session.flaggedCount)
    ] }
  ];
}
