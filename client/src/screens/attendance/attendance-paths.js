/** Where the attendance pages and their API live, and the small words they share. */
export const LIST_URL = '/?admin=attendance';
export const sessionUrl = (code) => `${LIST_URL}&session=${encodeURIComponent(code)}`;
export const apiPath = (code, rest = '') => `/api/admin/attendance/${encodeURIComponent(code)}${rest}`;
export const timeOnly = (value) => (value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
