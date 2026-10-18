/**
 * What the Users list can be filtered by (see client/src/lib/filters.js).
 * Each group sorts every account into exactly one of its options.
 */
export const USER_FILTERS = [
  { id: 'role', title: 'Role', options: [
    { id: 'student', label: 'Students', test: (account) => account.hasAccount !== false && account.role === 'student' },
    { id: 'faculty', label: 'Faculty', test: (account) => account.hasAccount !== false && account.role !== 'student' },
    { id: 'no-account', label: 'Email only', test: (account) => account.hasAccount === false, rare: true }
  ] },
  { id: 'signin', title: 'Sign-in', options: [
    { id: 'password', label: 'Has password', test: (account) => account.hasAccount !== false && Boolean(account.hasPassword) },
    { id: 'microsoft', label: 'Microsoft only', test: (account) => account.hasAccount !== false && !account.hasPassword },
    { id: 'no-signin', label: 'No sign-in', test: (account) => account.hasAccount === false, rare: true }
  ] },
  { id: 'access', title: 'Access', options: [
    { id: 'allowed', label: 'Allowed', test: (account) => !account.blocked },
    { id: 'blocked', label: 'Blocked', test: (account) => Boolean(account.blocked) }
  ] }
];
