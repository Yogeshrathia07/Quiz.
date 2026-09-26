import 'dotenv/config';

const list = (value) => String(value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
const atLeast = (value, fallback, minimum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
};
const nonNegative = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: String(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_quiz').trim(),
  // Per worker. Six workers at the defaults can use at most 300 database
  // connections, instead of the driver's 600-connection combined default.
  mongoMaxPoolSize: atLeast(process.env.MONGODB_MAX_POOL_SIZE, 50, 1),
  mongoMaxConnecting: atLeast(process.env.MONGODB_MAX_CONNECTING, 8, 1),
  redis: {
    // Optional for one local process; mandatory when PM2/WEB_CONCURRENCY starts
    // more than one. Redis stores locks only, never answers or results.
    url: String(process.env.REDIS_URL || '').trim(),
    keyPrefix: String(process.env.REDIS_KEY_PREFIX || 'campus-quiz').trim() || 'campus-quiz',
    lockTtlMs: atLeast(process.env.REDIS_LOCK_TTL_MS, 30_000, 5_000),
    lockWaitMs: atLeast(process.env.REDIS_LOCK_WAIT_MS, 15_000, 0),
    connectTimeoutMs: atLeast(process.env.REDIS_CONNECT_TIMEOUT_MS, 8_000, 1_000),
    // Shared test settings are read on nearly every student check-in. A short
    // cache removes thousands of identical MongoDB reads while invalidation
    // after a settings change keeps starts, extensions and closes immediate.
    testCacheMs: nonNegative(process.env.REDIS_TEST_CACHE_MS, 5_000)
  },
  performance: {
    // Pollable reads are shed first during an exceptional burst. Answer and
    // submit writes retain a much larger reserve and browsers retry a shed
    // poll automatically.
    softActiveRequests: atLeast(process.env.SOFT_ACTIVE_REQUESTS, 600, 10),
    hardActiveRequests: atLeast(process.env.HARD_ACTIVE_REQUESTS, 8_000, 20),
    exportWorkers: atLeast(process.env.EXPORT_WORKERS, 1, 1),
    exportQueueLimit: atLeast(process.env.EXPORT_QUEUE_LIMIT, 24, 1)
  },
  sessionSecret: process.env.SESSION_SECRET || 'development-secret-change-me',
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, ''),
  // Accounts are email + password (the email is the username). Only addresses
  // at this domain or one of its subdomains can have one.
  allowedDomain: String(process.env.ALLOWED_EMAIL_DOMAIN || 'upes.ac.in').trim().toLowerCase(),
  // Addresses here are students. Every other allowed address is faculty: they
  // get their own admin portal and may also sit tests.
  studentDomain: String(process.env.STUDENT_DOMAIN || 'stu.upes.ac.in').trim().toLowerCase(),
  // Microsoft sign-in, for any UPES account, whenever the Azure app below is
  // configured. Students' and faculty's accounts live in different Microsoft
  // tenants, so for both to work the app must be multi-tenant and
  // AZURE_TENANT_ID must be "organizations". AZURE_ALLOWED_TENANTS then limits
  // sign-in to those directories (empty = any, still UPES emails only).
  microsoft: {
    tenantId: String(process.env.AZURE_TENANT_ID || 'organizations').trim(),
    clientId: String(process.env.AZURE_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.AZURE_CLIENT_SECRET || '').trim(),
    allowedTenants: list(process.env.AZURE_ALLOWED_TENANTS)
  },
  // Faculty who may open the Users page (see and delete accounts, block
  // people). Empty means every faculty account may.
  userManagers: list(process.env.ADMIN_EMAIL),
  // A login stays signed in while it is used: every visit pushes its expiry
  // this far ahead again, so only this long without any visit logs it out.
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  // One login at a time: signing in signs the account out of every other
  // device. 'students' (default) applies it to student accounts, 'all' to
  // faculty as well, 'off' allows any number of devices at once.
  singleLogin: ['all', 'students', 'off'].includes(String(process.env.SINGLE_LOGIN || '').trim().toLowerCase())
    ? String(process.env.SINGLE_LOGIN).trim().toLowerCase()
    : 'students',
  // Venue monitoring, for tests with a venue check. The paper reports where it
  // is on this beat; this many readings in a row placing the student outside
  // closes the paper until they are back, and silence for longer than the
  // grace period does the same.
  locationCheckSeconds: Number(process.env.LOCATION_CHECK_SECONDS || 60),
  locationStrikes: Number(process.env.LOCATION_STRIKES || 2),
  locationGraceSeconds: Number(process.env.LOCATION_GRACE_SECONDS || 180),
  // A paper that has not been heard from for this long counts as having left
  // the test (one exit, the whole gap as time away).
  offlineSeconds: Number(process.env.OFFLINE_SECONDS || 60),
  // Going past a test's switch or time-away allowance locks the attempt. The
  // lock waits for the admin's Revive: LOCK_WAIT_SECONDS=0 means no automatic
  // unlock, and LOCK_ON_EXIT=false switches locking off altogether.
  lockOnExit: process.env.LOCK_ON_EXIT !== 'false',
  lockWaitSeconds: Number(process.env.LOCK_WAIT_SECONDS || 0),
  // When the server was down mid-test, running tests get the lost time back -
  // for outages up to this long. A longer one is recorded but not given back.
  outageExtendMaxMinutes: Number(process.env.OUTAGE_EXTEND_MAX_MINUTES || 30),
  brevo: {
    apiKey: String(process.env.BREVO_API_KEY || '').trim(),
    senderEmail: String(process.env.MAIL_FROM_EMAIL || '').trim(),
    senderName: String(process.env.MAIL_FROM_NAME || 'Quiz Portal').trim()
  },
  otp: {
    minutesValid: 10,
    maxAttempts: 5,
    resendSeconds: 60,
    perEmailPerDay: 8,
    // A whole class shares one campus Wi-Fi address, so this is generous.
    perIpPerHour: 300,
    // Brevo's free plan sends 300 emails a day; stop just short of it so the
    // last codes of the day are refused here, clearly, not lost at Brevo.
    dailyLimit: Number(process.env.OTP_DAILY_LIMIT || 295)
  }
};
