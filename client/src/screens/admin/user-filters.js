/**
 * What the Users list can be filtered by (see client/src/lib/filters.js).
 * Each group sorts every account into exactly one of its options.
 */
export const USER_FILTERS = [
  { id: 'role', title: 'Role', options: [
    { id: 'student', label: 'Students', test: (account) => account.role === 'student' },
    { id: 'faculty', label: 'Faculty', test: (account) => account.role !== 'student' }
  ] },
  { id: 'signin', title: 'Sign-in', options: [
    { id: 'password', label: 'Has password', test: (account) => Boolean(account.hasPassword) },
    { id: 'microsoft', label: 'Microsoft only', test: (account) => !account.hasPassword }
  ] }
];
