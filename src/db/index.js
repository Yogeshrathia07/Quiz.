import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { addImageEndings } from './add-image-endings.js';
import { moveRegistrationsOut } from './move-registrations.js';
import { repairAttendanceNames } from './repair-attendance-names.js';

const client = new MongoClient(config.mongoUri, {
  maxPoolSize: config.mongoMaxPoolSize,
  maxConnecting: config.mongoMaxConnecting,
  // Never wait forever: a stuck call fails, its request answers, the device retries (config.js).
  socketTimeoutMS: config.mongoSocketTimeoutMs,
  waitQueueTimeoutMS: config.mongoWaitQueueTimeoutMs,
  serverSelectionTimeoutMS: config.mongoServerSelectionTimeoutMs
});
let database = null;

// This app runs against a standalone mongod (no replica set), so multi-document
// transactions are not available. Every write is a single atomic update on one
// document: a test's own settings and questions live in its "tests" document,
// and each student's registration - with their paper, answers and log - is its
// own document in "registrations". A whole class writing at once then touches
// a thousand small documents side by side instead of queueing on one huge one.
export async function initializeDatabase() {
  await client.connect();
  database = client.db();
  await database.collection('tests').createIndexes([
    { key: { code: 1 }, unique: true },
    { key: { ownerEmail: 1, createdAt: -1 } }
  ]);
  await database.collection('registrations').createIndexes([
    // One registration id per test, and one seat per email per test - held by
    // the database itself, so no race can ever make a second.
    { key: { testCode: 1, id: 1 }, unique: true },
    { key: { testCode: 1, collegeEmail: 1 }, unique: true },
    { key: { 'attempt.id': 1 }, sparse: true },
    { key: { collegeEmail: 1 } },
    { key: { testCode: 1, sapId: 1 } },
    // Dashboard pages first narrow to one test and then commonly filter by
    // registration/attempt state. These keep the 25–100 row browser pages
    // from walking an entire large class before aggregation applies its page.
    // (The second also serves { testCode, attempt.status } alone, as its prefix,
    // so an index on just those two is retired below.)
    { key: { testCode: 1, status: 1, requestedAt: 1 } },
    { key: { testCode: 1, 'attempt.status': 1, requestedAt: 1 } },
    { key: { testCode: 1, requestedAt: 1 } },
    // The scheduler's sweep for requests nobody approved in time: only the
    // pending ones are indexed, so it stays small however many students there are.
    { key: { requestedAt: 1 }, partialFilterExpression: { status: 'pending' }, name: 'pending_requests_by_age' }
  ]);
  // Retired: { testCode, attempt.status } on its own. The compound index above
  // starts with the same two fields and serves every query it did; keeping both
  // only made each answer saved update one index more.
  const registrationIndexes = await database.collection('registrations').indexes().catch(() => []);
  if (registrationIndexes.some((index) => index.name === 'testCode_1_attempt.status_1')) {
    await database.collection('registrations').dropIndex('testCode_1_attempt.status_1');
  }
  // Tests from before each student had a document of their own are moved over
  // once, here, before a single request is served (see move-registrations.js).
  await moveRegistrationsOut(database);
  // Their old per-student indexes on the tests collection have nothing left to index.
  const testIndexes = await database.collection('tests').indexes().catch(() => []);
  for (const index of testIndexes.filter((entry) => Object.keys(entry.key).some((key) => key.startsWith('registrations.')))) {
    await database.collection('tests').dropIndex(index.name);
  }
  await database.collection('portalSessions').createIndexes([
    { key: { tokenHash: 1 }, unique: true },
    { key: { email: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ]);
  // Accounts are permanent (email + password). They once deleted themselves
  // 24 hours after sign-up: drop that expiry so existing accounts stay.
  const accountIndexes = await database.collection('accounts').indexes().catch(() => []);
  if (accountIndexes.some((index) => index.name === 'expiresAt_1')) await database.collection('accounts').dropIndex('expiresAt_1');
  await database.collection('accounts').updateMany({ expiresAt: { $exists: true } }, { $unset: { expiresAt: '' } });
  // Early sign-ups were saved without a creation time; the first login is the
  // closest thing to it.
  await database.collection('accounts').updateMany(
    { createdAt: { $exists: false } },
    [{ $set: { createdAt: { $ifNull: ['$lastSignInAt', '$$NOW'] } } }]
  );
  await database.collection('accounts').createIndex({ createdAt: -1 });
  // Blocks are kept apart from accounts, so deleting an account never lifts
  // a block and a blocked person cannot sign up again and walk back in.
  await database.collection('blockedEmails').createIndex({ blockedAt: -1 });
  await database.collection('portalOauthStates').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection('otpCodes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection('otpSends').createIndexes([
    { key: { createdAt: 1 }, expireAfterSeconds: 24 * 60 * 60 },
    { key: { email: 1, createdAt: -1 } },
    { key: { ip: 1, createdAt: -1 } }
  ]);
  // One entry per results email sent, kept a day: what today's allowance has used.
  await database.collection('resultMailSends').createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
  // Results emails waiting to go, or going (result-mail-service.js).
  await database.collection('registrations').createIndex({ 'resultMail.status': 1, 'resultMail.queuedAt': 1 }, { sparse: true });
  // One document per attendance session, its marks embedded, so marking and
  // closing are single atomic writes like everything else here.
  await database.collection('attendanceSessions').createIndexes([
    { key: { code: 1 }, unique: true },
    { key: { ownerEmail: 1, createdAt: -1 } }
  ]);
  await database.collection('studentProfiles').createIndexes([
    { key: { email: 1 }, unique: true },
    { key: { sapId: 1 }, unique: true }
  ]);
  await repairAttendanceNames(database);
  await addImageEndings(database);
}

export const tests = () => database.collection('tests');
// One document per student per test: { testCode, id, fullName, collegeEmail, sapId, status, attempt, ... }.
export const registrations = () => database.collection('registrations');
export const portalSessions = () => database.collection('portalSessions');
export const accounts = () => database.collection('accounts');
export const blockedEmails = () => database.collection('blockedEmails');
export const portalOauthStates = () => database.collection('portalOauthStates');
export const otpCodes = () => database.collection('otpCodes');
export const otpSends = () => database.collection('otpSends');
export const studentProfiles = () => database.collection('studentProfiles');
export const attendanceSessions = () => database.collection('attendanceSessions');
// Pictures on questions, one document each: { _id, ownerEmail, contentType, bytes, width, height, data } (services/question-image-service.js).
export const questionImages = () => database.collection('questionImages');
// One document: the server's heartbeat, so a restart can tell how long it was down.
export const serverState = () => database.collection('serverState');
// A test being written on the Create page and not created yet, one per teacher: { _id: their email, json, bytes, savedAt } (services/draft-service.js).
export const creatorDrafts = () => database.collection('creatorDrafts');
export const resultMailSends = () => database.collection('resultMailSends');

export async function closeDatabase() {
  await client.close();
  database = null;
}
