import crypto from 'node:crypto';

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const hmac = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('hex');

/** Whether two secrets (signatures, keys) are equal, taking the same time however much of them matches. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Deterministic shuffle: the same seed always produces the same order, so a
 * student who reloads mid-test sees their questions and options unchanged.
 */
export function stableSort(items, seed, key = (item) => item.id) {
  return [...items].sort((a, b) => hmac(`${seed}:${key(a)}`, seed).localeCompare(hmac(`${seed}:${key(b)}`, seed)));
}

export const asInteger = (value, min, max) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};
