import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { accounts, blockedEmails, otpCodes, otpSends } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { hmac } from '../lib/crypto.js';
import { createLimiter, waitWords } from '../lib/security.js';
import { now } from '../lib/time.js';
import { sendMail } from '../lib/mailer.js';
import { cleanText } from '../domain/test-builder.js';
import { issueSession, normalizeEmail, revokeSessionsFor, roleForEmail } from './portal-auth.js';

/**
 * Email + password accounts. The email is the username. Creating an account
 * and resetting a forgotten password both start with a six-digit code mailed
 * through Brevo, which proves the address belongs to the person; codes are
 * stored only as a keyed hash and passwords only as a salted scrypt hash.
 */
const scrypt = promisify(crypto.scrypt);
const PURPOSES = ['signup', 'reset'];
/** How many codes sent before the newest one still work (each until its own expiry). */
const EARLIER_CODES_KEPT = 3;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_MINUTES = 15;
// Wrong passwords from one network, across every account. A whole class signs
// in from one campus address, so this is generous - it stops a script trying
// password after password across the college, not a class mistyping.
const failedFromNetwork = createLimiter({ windowMs: 15 * 60_000, max: 100 });
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000);
const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);
const codeHash = (email, purpose, code) => hmac(`${email}:${purpose}:${code}`, config.sessionSecret);
const sameText = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Compared against when there is no account, so "no such account" takes as long as a wrong password. */
let decoyHash = null;
const decoy = async () => { decoyHash ||= await hashPassword(crypto.randomBytes(18).toString('base64url')); return decoyHash; };

async function passwordMatches(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), 64);
  const wanted = Buffer.from(expected, 'base64');
  return derived.length === wanted.length && crypto.timingSafeEqual(derived, wanted);
}

function newPassword(raw) {
  const password = String(raw ?? '');
  if (password.length < 8) throw new PublicTestError(400, 'Choose a password of at least 8 characters.');
  if (password.length > 128) throw new PublicTestError(400, 'Passwords can be at most 128 characters.');
  return password;
}

function allowedEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) throw new PublicTestError(400, 'Enter your college email address.');
  const role = roleForEmail(email);
  if (!role) throw new PublicTestError(403, `Only @${config.allowedDomain} email addresses can use this portal.`);
  return { email, role };
}

export async function refuseIfBlocked(email) {
  if (await blockedEmails().findOne({ _id: email })) {
    throw new PublicTestError(403, 'This account has been blocked by the administrator. Contact your faculty if you think this is a mistake.');
  }
}

/**
 * Starts a session for an account that already proved who it is. Shared by
 * password login, a finished sign-up or reset, and Microsoft sign-in.
 */
export async function signInAccount(res, { email, name: offered, role }) {
  const signedInAt = now();
  // A name an administrator corrected stays: Microsoft's own does not replace it.
  const kept = await accounts().findOne({ _id: email, nameSetBy: { $exists: true } }, { projection: { displayName: 1 } });
  const name = kept?.displayName || offered;
  await accounts().updateOne(
    { _id: email },
    { $set: { displayName: name, role, lastSignInAt: signedInAt }, $setOnInsert: { email, createdAt: signedInAt } },
    { upsert: true }
  );
  await issueSession(res, { email, name, role });
  return { email, name, role, isGuest: false };
}

/* ------------------------------------------------------------ email codes */

/**
 * Every code sent is one of Brevo's 300 free daily emails, so sending is
 * limited per address, per network, and for the whole server.
 */
async function enforceSendLimits(email, ip) {
  const latest = await otpCodes().findOne({ _id: email });
  if (latest?.sentAt) {
    const waitSeconds = Math.ceil(config.otp.resendSeconds - (Date.now() - new Date(latest.sentAt).getTime()) / 1000);
    if (waitSeconds > 0) throw new PublicTestError(429, `A code was just sent. You can ask for another in ${waitSeconds} seconds.`);
  }
  const [perEmail, perIp, total] = await Promise.all([
    otpSends().countDocuments({ email, createdAt: { $gt: hoursAgo(24) } }),
    otpSends().countDocuments({ ip, createdAt: { $gt: hoursAgo(1) } }),
    otpSends().countDocuments({ createdAt: { $gt: hoursAgo(24) } })
  ]);
  if (perEmail >= config.otp.perEmailPerDay) throw new PublicTestError(429, 'Too many codes were requested for this email today. Try again tomorrow.');
  if (perIp >= config.otp.perIpPerHour) throw new PublicTestError(429, 'Too many codes were requested from this network. Try again in a little while.');
  if (total >= config.otp.dailyLimit) throw new PublicTestError(503, 'The portal has reached its email limit for today. Ask your faculty for help.');
}

const MAIL_TEXT = {
  signup: { subject: 'is your Quiz Portal verification code', line: 'Use this code to create your Quiz Portal account.' },
  reset: { subject: 'is your Quiz Portal password reset code', line: 'Use this code to reset your Quiz Portal password.' }
};

/** Sends a code to create an account (`signup`) or to reset a password (`reset`). */
export async function requestCode(req, raw = {}) {
  const purpose = PURPOSES.includes(raw.purpose) ? raw.purpose : null;
  if (!purpose) throw new PublicTestError(400, 'Invalid request.');
  const { email } = allowedEmail(raw.email);
  await refuseIfBlocked(email);
  const account = await accounts().findOne({ _id: email });
  if (purpose === 'signup' && account?.passwordHash) {
    throw new PublicTestError(409, 'An account with this email already exists. Log in, or use "Forgot password".');
  }
  if (purpose === 'reset' && !account) {
    throw new PublicTestError(404, 'There is no account with this email yet. Create one first.');
  }
  const ip = String(req.ip || '');
  await enforceSendLimits(email, ip);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const sentAt = now();
  // Emails can land minutes late, and out of order. A student who pressed
  // Resend while waiting types the code from whichever email arrives first,
  // so the codes sent before this one keep working until they expire.
  const previous = await otpCodes().findOne({ _id: email });
  const earlier = previous?.purpose === purpose
    ? [...(previous.earlier || []), { codeHash: previous.codeHash, expiresAt: previous.expiresAt }]
      .filter((entry) => new Date(entry.expiresAt) > sentAt)
      .slice(-EARLIER_CODES_KEPT)
    : [];
  await otpCodes().replaceOne(
    { _id: email },
    { _id: email, purpose, codeHash: codeHash(email, purpose, code), earlier, attempts: 0, sentAt, expiresAt: minutesFromNow(config.otp.minutesValid) },
    { upsert: true }
  );
  const text = MAIL_TEXT[purpose];
  try {
    await sendMail({
      to: email,
      subject: `${code} ${text.subject}`,
      text: `${text.line} Your code is ${code}. It expires in ${config.otp.minutesValid} minutes. If you did not ask for it, ignore this email.`,
      html: `<p>${text.line}</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>`
        + `<p>It expires in ${config.otp.minutesValid} minutes. If you did not ask for it, you can ignore this email.</p>`
    });
  } catch (error) {
    // A code that never arrived must not hold the resend timer - nor cancel
    // the codes already on their way.
    if (previous) await otpCodes().replaceOne({ _id: email, sentAt }, previous);
    else await otpCodes().deleteOne({ _id: email, sentAt });
    throw error;
  }
  await otpSends().insertOne({ email, ip, createdAt: sentAt });
  return { sent: true, email, purpose, expiresInSeconds: config.otp.minutesValid * 60, resendInSeconds: config.otp.resendSeconds };
}

/**
 * Checks a code, counting the try. Throws unless it is right, fresh, and for
 * `purpose`; a wrong one uses up one of its attempts.
 */
async function matchCode(email, purpose, rawCode) {
  const code = String(rawCode ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new PublicTestError(400, 'Enter the 6-digit code from the email.');
  // Count the attempt before comparing, in one atomic step, so parallel
  // guesses cannot all slip in under the limit.
  const pending = await otpCodes().findOneAndUpdate(
    { _id: email, purpose, expiresAt: { $gt: now() }, attempts: { $lt: config.otp.maxAttempts } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!pending) throw new PublicTestError(400, 'That code has expired or was tried too many times. Ask for a new code.');
  const typed = codeHash(email, purpose, code);
  const atMs = Date.now();
  const matches = [pending, ...(pending.earlier || [])]
    .some((entry) => new Date(entry.expiresAt).getTime() > atMs && sameText(entry.codeHash, typed));
  if (!matches) {
    const left = config.otp.maxAttempts - pending.attempts;
    if (left <= 0) await otpCodes().deleteOne({ _id: email });
    throw new PublicTestError(400, left > 0
      ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
      : 'That code is not right. Ask for a new code.');
  }
  return pending;
}

/** Checks and spends a code - the last step, which creates the account or sets the password. */
async function useCode(email, purpose, rawCode) {
  await matchCode(email, purpose, rawCode);
  await otpCodes().deleteOne({ _id: email });
}

/**
 * The form's middle step: the code is right, so the page goes on to ask for
 * the password - and the code is kept for that last step. Its tries start
 * again (it was right), and it lasts a while longer, so choosing a password
 * never runs it out.
 */
export async function checkCode(req, raw = {}) {
  const { email } = allowedEmail(raw.email);
  await refuseIfBlocked(email);
  const purpose = PURPOSES.includes(raw.purpose) ? raw.purpose : null;
  if (!purpose) throw new PublicTestError(400, 'Invalid request.');
  await matchCode(email, purpose, raw.code);
  await otpCodes().updateOne({ _id: email, purpose }, { $set: { attempts: 0, expiresAt: minutesFromNow(config.otp.minutesValid) } });
  return { ok: true, email, purpose };
}

/* --------------------------------------------------- sign up, reset, login */

export async function signUp(req, res, raw = {}) {
  const { email, role } = allowedEmail(raw.email);
  await refuseIfBlocked(email);
  const name = cleanText(raw.name, 'Your name', 2, 120);
  const password = newPassword(raw.password);
  if ((await accounts().findOne({ _id: email }))?.passwordHash) {
    throw new PublicTestError(409, 'An account with this email already exists. Log in, or use "Forgot password".');
  }
  await useCode(email, 'signup', raw.code);
  await accounts().updateOne(
    { _id: email },
    { $set: { passwordHash: await hashPassword(password) }, $setOnInsert: { email, createdAt: now() } },
    { upsert: true }
  );
  return { user: await signInAccount(res, { email, name, role }) };
}

export async function resetPassword(req, res, raw = {}) {
  const { email, role } = allowedEmail(raw.email);
  await refuseIfBlocked(email);
  const password = newPassword(raw.password);
  const account = await accounts().findOne({ _id: email });
  if (!account) throw new PublicTestError(404, 'There is no account with this email yet. Create one first.');
  await useCode(email, 'reset', raw.code);
  await accounts().updateOne(
    { _id: email },
    { $set: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null, passwordChangedAt: now() } }
  );
  // A reset is often because someone else knew the old password: sign every
  // other device out before signing this one in.
  await revokeSessionsFor(email);
  return { user: await signInAccount(res, { email, name: account.displayName || email, role }) };
}

/**
 * A signed-in user changes their own password. They confirm the current one,
 * unless the account has none yet (it only ever used Microsoft). Every other
 * device is signed out; this one stays signed in.
 */
export async function changePassword(req, raw = {}) {
  const email = normalizeEmail(req.portalUser?.email);
  const account = await accounts().findOne({ _id: email });
  if (!account) throw new PublicTestError(404, 'Your account was not found. Sign in again.');
  const password = newPassword(raw.newPassword);
  if (account.passwordHash) {
    if (!(await passwordMatches(String(raw.currentPassword ?? ''), account.passwordHash))) {
      throw new PublicTestError(400, 'Your current password is not right.');
    }
    if (await passwordMatches(password, account.passwordHash)) {
      throw new PublicTestError(400, 'Choose a password different from your current one.');
    }
  }
  await accounts().updateOne(
    { _id: email },
    { $set: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null, passwordChangedAt: now() } }
  );
  await revokeSessionsFor(email, req);
  return { changed: true };
}

/** Whether this account already has a password, so the form knows to ask for it. */
export async function passwordStatus(req) {
  const account = await accounts().findOne({ _id: normalizeEmail(req.portalUser?.email) });
  return { hasPassword: Boolean(account?.passwordHash) };
}

export async function logIn(req, res, raw = {}) {
  const { email, role } = allowedEmail(raw.email);
  const password = String(raw.password ?? '');
  if (!password) throw new PublicTestError(400, 'Enter your password.');
  if (password.length > 128) throw new PublicTestError(401, 'Wrong email or password.');
  const network = String(req.ip || '');
  const wait = failedFromNetwork.waitFor(network);
  if (wait) throw new PublicTestError(429, `Too many wrong passwords from this network. Try again in ${waitWords(wait)}, or use "Forgot password".`);
  await refuseIfBlocked(email);
  const account = await accounts().findOne({ _id: email });
  if (account?.lockedUntil && new Date(account.lockedUntil) > new Date()) {
    const minutes = Math.ceil((new Date(account.lockedUntil) - Date.now()) / 60_000);
    throw new PublicTestError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or use "Forgot password".`);
  }
  if (account && !account.passwordHash) {
    throw new PublicTestError(400, 'This account has no password yet. Use "Forgot password" to set one, or sign in with Microsoft.');
  }
  if (!account || !(await passwordMatches(password, account ? account.passwordHash : await decoy()))) {
    failedFromNetwork.hit(network);
    if (account) {
      // Counted in one atomic step, so guesses sent all at once cannot each
      // read the same count and slip past the limit together.
      const counted = await accounts().findOneAndUpdate({ _id: email }, { $inc: { failedLogins: 1 } }, { returnDocument: 'after', projection: { failedLogins: 1 } });
      if ((counted?.failedLogins || 0) >= MAX_FAILED_LOGINS) {
        await accounts().updateOne({ _id: email }, { $set: { failedLogins: 0, lockedUntil: minutesFromNow(LOGIN_LOCK_MINUTES) } });
      }
    }
    throw new PublicTestError(401, 'Wrong email or password.');
  }
  if (account.failedLogins || account.lockedUntil) await accounts().updateOne({ _id: email }, { $set: { failedLogins: 0, lockedUntil: null } });
  return { user: await signInAccount(res, { email, name: account.displayName || email, role }) };
}
