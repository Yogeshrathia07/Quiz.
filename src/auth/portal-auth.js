import { config } from '../config.js';
import { portalSessions } from '../db/index.js';
import { hash, randomId } from '../lib/crypto.js';
import { now } from '../lib/time.js';
import { mailConfigured } from '../lib/mailer.js';
import { cookieIsSecure } from '../lib/security.js';

/**
 * Who someone is comes from their email: they log in with email + password
 * (account-login.js) or with Microsoft (microsoft-login.js). @stu.upes.ac.in
 * is a student, any other UPES address is faculty. The one exception is a
 * guest session, which carries no verified identity and is issued only for a
 * test whose admin ticked "Allow guest registrations" - see
 * `beginGuestSession` in the registration service.
 */
const cookieName = 'test_portal_session';
export const GUEST_EMAIL_DOMAIN = 'guest.test';
const GUEST_SESSION_HOURS = 12;
const afterHours = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000);

export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
export const isGuestAccount = (email) => normalizeEmail(email).endsWith(`@${GUEST_EMAIL_DOMAIN}`);

const domainOf = (email) => normalizeEmail(email).split('@')[1] || '';
export const isAllowedEmail = (email) => {
  const address = normalizeEmail(email);
  const domain = domainOf(address);
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(address)
    && (domain === config.allowedDomain || domain.endsWith(`.${config.allowedDomain}`));
};

/** 'student', 'admin' (faculty), or null for an address that may not sign in. */
export function roleForEmail(email) {
  if (!isAllowedEmail(email)) return null;
  return domainOf(email) === config.studentDomain ? 'student' : 'admin';
}

export const microsoftConfigured = () => Boolean(config.microsoft.clientId && config.microsoft.clientSecret);

export const canManageUsers = (user) => Boolean(user && user.role === 'admin' && !isGuestAccount(user.email) && (
  config.userManagers.length === 0 || config.userManagers.includes(normalizeEmail(user.email))
));

const publicAccount = (user) => (user
  ? {
    email: user.email,
    name: user.displayName,
    role: user.role,
    isGuest: isGuestAccount(user.email),
    canManageUsers: canManageUsers(user)
  }
  : null);

/** Whether signing this account in must end its sessions everywhere else. */
const singleLoginApplies = (account) => !isGuestAccount(account.email)
  && (config.singleLogin === 'all' || (config.singleLogin === 'students' && account.role === 'student'));

export const SIGNED_IN_ELSEWHERE = 'signed_in_elsewhere';

const accountSessionEnd = () => new Date(Date.now() + (Number(config.sessionDays) || 30) * 24 * 60 * 60 * 1000);

// Secure whenever the page came over https (lib/security.js), so the cookie never travels in clear.
const cookieOptions = (req, expiresAt) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: cookieIsSecure(req),
  signed: true,
  maxAge: Math.max(0, new Date(expiresAt).getTime() - Date.now())
});

/**
 * Starts a session. A real account's session lasts `config.sessionDays` and is
 * extended on every visit (see the middleware). Under one-login-at-a-time
 * (`config.singleLogin`) this sign-in ends the account's sessions on every
 * other device, marked so that device can be told why. A guest session is
 * short and fixed.
 */
export async function issueSession(res, account, expiresAt = null) {
  const token = randomId();
  const sessionId = randomId(18);
  const guest = isGuestAccount(account.email);
  const endsAt = expiresAt || (guest ? afterHours(GUEST_SESSION_HOURS) : accountSessionEnd());
  if (singleLoginApplies(account)) {
    await portalSessions().updateMany(
      { email: normalizeEmail(account.email), revokedAt: null },
      { $set: { revokedAt: now(), revokedReason: SIGNED_IN_ELSEWHERE } }
    );
  }
  await portalSessions().insertOne({
    _id: sessionId,
    tokenHash: hash(token),
    email: account.email,
    displayName: account.name,
    role: account.role,
    createdAt: now(),
    lastSeenAt: now(),
    expiresAt: endsAt,
    revokedAt: null
  });
  res.cookie(cookieName, token, cookieOptions(res.req, endsAt));
}

/**
 * Signs someone out everywhere - used when an account is deleted or blocked,
 * and on a password change (keeping `exceptTokenOf`, the device making it).
 */
export const revokeSessionsFor = (email, exceptTokenOf = null) => {
  const filter = { email: normalizeEmail(email), revokedAt: null };
  const keep = exceptTokenOf?.signedCookies?.[cookieName];
  if (keep) filter.tokenHash = { $ne: hash(keep) };
  return portalSessions().updateMany(filter, { $set: { revokedAt: now() } });
};

/** Whether a guest still holds a live session - i.e. has not left yet. */
export async function hasLiveSession(email) {
  return Boolean(await portalSessions().findOne({ email: normalizeEmail(email), revokedAt: null, expiresAt: { $gt: now() } }));
}

export async function portalSessionMiddleware(req, res, next) {
  try {
    const token = req.signedCookies?.[cookieName];
    if (!token) return next();
    const session = await portalSessions().findOne({ tokenHash: hash(token), revokedAt: null, expiresAt: { $gt: now() } });
    if (!session) {
      // The browser still holds a session that has ended. Say why, so an open
      // exam page can keep its answers and ask the student to sign in again
      // rather than treating every save as refused for good.
      const ended = await portalSessions().findOne({ tokenHash: hash(token) }, { projection: { revokedReason: 1 } });
      req.sessionEnded = ended?.revokedReason === SIGNED_IN_ELSEWHERE ? SIGNED_IN_ELSEWHERE : 'ended';
    }
    if (session) {
      req.portalUser = session;
      // Every request of every student passes through here. Writing "last
      // seen" on each one doubled the database load during a test for a value
      // nothing needs to the second, so it is refreshed at most once a minute.
      // The same refresh keeps a real account signed in: its expiry, and the
      // browser cookie's, move a full session length ahead again.
      if (!session.lastSeenAt || Date.now() - new Date(session.lastSeenAt).getTime() > 60_000) {
        const update = { lastSeenAt: now() };
        if (!isGuestAccount(session.email)) {
          update.expiresAt = accountSessionEnd();
          res.cookie(cookieName, token, cookieOptions(req, update.expiresAt));
        }
        await portalSessions().updateOne({ _id: session._id }, { $set: update });
      }
    }
    next();
  } catch (error) { next(error); }
}

/** A 401 with code SIGNED_OUT when this browser's session has ended, so the page can ask to sign in again. */
function refuse(req, res, message) {
  if (!req.portalUser && req.sessionEnded) {
    return res.status(401).json({
      code: 'SIGNED_OUT',
      error: req.sessionEnded === SIGNED_IN_ELSEWHERE
        ? 'Your account was signed in on another device, so you were signed out here. Sign in again to continue.'
        : 'Your session has ended. Sign in again to continue.'
    });
  }
  return res.status(403).json({ error: message });
}

export const requireAdmin = (req, res, next) => (req.portalUser?.role === 'admin'
  ? next()
  : refuse(req, res, 'Faculty access is required.'));

/** Students and faculty both sit tests; guests do too, on tests that allow them. */
export const requireTestTaker = (req, res, next) => (['student', 'admin'].includes(req.portalUser?.role)
  ? next()
  : refuse(req, res, 'Sign in with your college email to access tests.'));

/** A real, verified account - never a guest. */
export const requireAccount = (req, res, next) => (req.portalUser && !isGuestAccount(req.portalUser.email)
  ? next()
  : refuse(req, res, 'Sign in with your college email to see this page.'));

export const requireUserManager = (req, res, next) => (canManageUsers(req.portalUser)
  ? next()
  : res.status(403).json({ error: 'You are not allowed to manage user accounts.' }));

export function authStatus(req) {
  return {
    configured: mailConfigured() || process.env.NODE_ENV !== 'production',
    allowedDomain: config.allowedDomain,
    microsoft: microsoftConfigured() ? {} : null,
    user: publicAccount(req.portalUser),
    signedOutElsewhere: !req.portalUser && req.sessionEnded === SIGNED_IN_ELSEWHERE
  };
}

export async function logout(req, res) {
  const token = req.signedCookies?.[cookieName];
  if (token) await portalSessions().updateOne({ tokenHash: hash(token), revokedAt: null }, { $set: { revokedAt: now() } });
  // Same path/security attributes as the issued cookie, without a positive
  // maxAge, so every browser removes the signed session reliably.
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: cookieIsSecure(req), path: '/' });
  res.status(204).end();
}
