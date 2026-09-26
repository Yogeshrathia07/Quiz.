/** What the attendance list can be filtered by (see client/src/lib/filters.js). */
export const ATTENDANCE_FILTERS = [
  { id: 'status', title: 'Status', options: [
    { id: 'present', label: 'Present', test: (mark) => mark.status === 'present' },
    { id: 'pending', label: 'Pending', test: (mark) => mark.status === 'pending' },
    { id: 'rejected', label: 'Removed', test: (mark) => mark.status === 'rejected' }
  ] },
  { id: 'account', title: 'Account', options: [
    { id: 'college', label: 'College student', test: (mark) => !mark.isGuest },
    { id: 'guest', label: 'Guest', test: (mark) => mark.isGuest }
  ] },
  { id: 'added', title: 'Marked by', options: [
    { id: 'self', label: 'Scanned the QR', test: (mark) => !mark.addedByTeacher },
    { id: 'teacher', label: 'Added by you', test: (mark) => mark.addedByTeacher }
  ] }
];
