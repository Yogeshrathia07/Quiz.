import { config } from '../config.js';

/*
 * The server's own defences, in one place: the headers every response
 * carries, refusing state-changing requests from other sites, refusing
 * request bodies shaped to reach the database's operators, cookie flags,
 * and a small per-address limiter for the routes a script would hammer.
 */

const DEFAULT_SECRET = 'development-secret-change-me';

/**
 * A deployed server (production, or a public https address) must sign its
 * cookies with a real secret: refuse to start without one. A local copy only
 * warns, so trying the app needs no setup.
 */
export function requireRealSecret() {
  const secret = String(config.sessionSecret || '');
  if (secret !== DEFAULT_SECRET && secret.length >= 32) return;
  const deployed = process.env.NODE_ENV === 'production' || config.publicBaseUrl.startsWith('https://');
  const message = 'SESSION_SECRET must be set to a random value of at least 32 characters (for example: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))").';
  if (deployed) throw new Error(message);
  console.warn(`Warning: ${message} Using a development secret.`);
}

/** Cookies are sent only over https whenever the request came over https (behind the tunnel too), or in production. */
export const cookieIsSecure = (req) => Boolean(req?.secure) || process.env.NODE_ENV === 'production';

/*
 * What the page may load: only this site's own scripts (no inline script, no
 * eval), its own styles (React sets some inline), pictures, fonts and the
 * keep-awake video from this site or data:/blob: URLs, and requests only to
 * this site. Nothing may frame it, and forms post only here.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

// Location for the venue check, fullscreen for the paper; nothing else.
const PERMISSIONS_POLICY = 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self), fullscreen=(self)';

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': req.secure ? `${CONTENT_SECURITY_POLICY}; upgrade-insecure-requests` : CONTENT_SECURITY_POLICY,
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  // Once a browser has reached the site over https, it never tries plain http again.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/**
 * A change - an answer, a mark, a Close - is taken only from this site's own
 * pages. The session cookie is SameSite=Lax already; this also refuses a
 * sibling subdomain, or an older browser that sends cookies anyway. Browsers
 * say where a request came from (Sec-Fetch-Site, else Origin); a request
 * that says neither is not a browser riding someone's cookies.
 */
export function sameOriginWrites(req, res, next) {
  if (!WRITES.has(req.method)) return next();
  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  const origin = req.get('origin');
  let allowed = true;
  if (site) allowed = site === 'same-origin' || site === 'none';
  else if (origin) {
    const from = hostOf(origin);
    allowed = Boolean(from) && (from === String(req.get('host') || '').toLowerCase() || (config.publicBaseUrl && from === hostOf(config.publicBaseUrl)));
  }
  if (allowed) return next();
  return res.status(403).json({ error: 'This request did not come from the portal itself, so it was refused.' });
}

/**
 * Request bodies never carry keys starting with "$" (database operators) or
 * "__proto__": refusing them outright closes operator injection and
 * prototype pollution, whatever a handler later does with the body.
 */
export function rejectDangerousKeys(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return next();
  const stack = [[body, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > 32) return res.status(400).json({ error: 'The request is nested too deeply.' });
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key === '__proto__') return res.status(400).json({ error: 'The request contains a field that is not allowed.' });
      const child = value[key];
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return next();
}

/**
 * A fixed-window counter per key (usually a network address), in this
 * process's memory. With several processes each counts on its own, so a
 * limit is per process - still enough to stop a script.
 */
export function createLimiter({ windowMs, max, maxKeys = 50_000 }) {
  const hits = new Map();
  let sweptAt = Date.now();
  const sweep = (now) => {
    if (now - sweptAt < windowMs && hits.size < maxKeys) return;
    sweptAt = now;
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    // Still full of live keys: drop the oldest rather than grow without end.
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  };
  const entryFor = (key, now) => {
    const entry = hits.get(key);
    return entry && entry.resetAt > now ? entry : null;
  };
  return {
    /** Seconds until this key may try again, or 0 when it may now. */
    waitFor(key) {
      const now = Date.now();
      const entry = entryFor(key, now);
      return entry && entry.count >= max ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
    },
    /** Counts one more for this key. */
    hit(key) {
      const now = Date.now();
      sweep(now);
      const entry = entryFor(key, now) || { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      hits.set(key, entry);
      return entry.count;
    },
    reset(key) { hits.delete(key); }
  };
}

const waitWords = (seconds) => (seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`);

/** Middleware: at most `max` requests per address per window. */
export function limitPerAddress({ windowMs, max, message }) {
  const limiter = createLimiter({ windowMs, max });
  return (req, res, next) => {
    const key = String(req.ip || '');
    const wait = limiter.waitFor(key);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `${message} Try again in ${waitWords(wait)}.` });
    }
    limiter.hit(key);
    return next();
  };
}

export { waitWords };
