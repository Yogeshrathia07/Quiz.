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
 * Each item's HMAC is worked out once, not on both sides of every comparison:
 * the same order, at a fraction of the cost when a whole class begins at once.
 */
export function stableSort(items, seed, key = (item) => item.id) {
  return items
    .map((item) => [hmac(`${seed}:${key(item)}`, seed), item])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, item]) => item);
}

export const asInteger = (value, min, max) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};
