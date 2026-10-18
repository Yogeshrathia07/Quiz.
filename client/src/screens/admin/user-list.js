import { sortBy } from '../../lib/filters.js';

export const USUAL_USER_SORT = 'created-desc';
export const USER_SORTS = [
  { id: 'created', label: 'Created', directions: [{ id: 'desc', label: 'Newest first' }, { id: 'asc', label: 'Oldest first' }] },
  { id: 'login', label: 'Last login', directions: [{ id: 'desc', label: 'Most recent' }, { id: 'asc', label: 'Earliest first' }] },
  { id: 'name', label: 'Name', directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] }
];

export const userEmail = (value) => String(value || '').trim().toLowerCase();

/** Join for display only: a block survives account deletion, and may predate
 * an account. Never merge names/roles from a block or change the API's data. */
export function mergeUserRows(accounts = [], blocked = []) {
  const people = new Map();
  for (const account of accounts) {
    const email = userEmail(account.email);
    if (!email || people.has(email)) continue;
    people.set(email, { ...account, email, name: account.name || email, hasAccount: true, blocked: Boolean(account.blocked), block: null });
  }
  for (const entry of blocked) {
    const email = userEmail(entry.email);
    if (!email) continue;
    const current = people.get(email) || {
      email, name: email, role: null, sapId: null, createdAt: null,
      lastSignInAt: null, hasPassword: false, hasAccount: false
    };
    // Duplicate legacy spellings of the same address: keep its latest block.
    if (current.block && (time(current.block.blockedAt) ?? -Infinity) >= (time(entry.blockedAt) ?? -Infinity)) continue;
    people.set(email, { ...current, blocked: true, block: { ...entry, email } });
  }
  return [...people.values()];
}

const time = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};

/** Missing dates stay last in either direction, including email-only blocks. */
export function sortUsers(rows, sort = USUAL_USER_SORT) {
  return sortBy(rows, sort, {
    created: (row) => time(row.hasAccount === false ? row.block?.blockedAt : row.createdAt),
    login: (row) => time(row.lastSignInAt),
    name: (row) => String(row.name || row.email).toLowerCase()
  });
}
