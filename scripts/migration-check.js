/**
 * Proves, on a copy, that moving students into their own documents keeps
 * every byte of a real database - before it is ever done to the real one.
 *
 *   node scripts/db-backup.js                     # take a backup first
 *   node scripts/migration-check.js [backupDir]   # latest backup if omitted
 *
 * It restores the backup into a throw-away database (<name>_migration_check),
 * runs the server's own start-up (which moves the students), and then checks
 * what the app LOADS against the backup, field by field and in order:
 *   - every test with its whole class (what the admin's views and exports read),
 *   - every student's own view of their test (what their requests read),
 *   - every paper by its attempt id,
 *   - every person's list of tests (My results, the Users page),
 * that running the move again changes nothing, and that a move interrupted
 * half-way (some students copied, the list still on the test) finishes
 * exactly. The throw-away database is dropped at the end. The real one is
 * never opened for writing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EJSON } from 'bson';
import { MongoClient } from 'mongodb';

const folder = process.argv[2] || join('backups', readdirSync('backups').filter((name) => !name.startsWith('.')).sort().at(-1));
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const baseUri = (process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campus_quiz').replace(/\/[^/?]*(\?|$)/, '/$1');
const scratchName = `${manifest.database}_migration_check`;
// The start-up's own safety backup of the scratch copy goes to a temp folder, removed at the end.
const scratchBackups = mkdtempSync(join(tmpdir(), 'migration-check-'));
process.env.MIGRATION_BACKUP_DIR = scratchBackups;
// Everything below - the app's own modules included - talks to the scratch database only.
process.env.MONGODB_URI = baseUri.replace(/\/(\?|$)/, `/${scratchName}$1`);

const { canonical } = await import('../src/db/move-registrations.js');
const db = await import('../src/db/index.js');
const repo = await import('../src/data/test-repository.js');

// Restored with every BSON type exactly as backed up; compared as plain values,
// the way the app reads them (a stored 32-bit integer is simply a number).
const loadExact = (name) => EJSON.parse(readFileSync(join(folder, `${name}.json`), 'utf8'), { relaxed: false });
const load = (name) => EJSON.parse(readFileSync(join(folder, `${name}.json`), 'utf8'), { relaxed: true });

async function restoreScratch() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const scratch = client.db();
  assert.equal(scratch.databaseName, scratchName, 'only ever the scratch database');
  await scratch.dropDatabase();
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json') && name !== 'manifest.json')) {
    const { docs } = loadExact(file.slice(0, -5));
    if (docs.length) await scratch.collection(file.slice(0, -5)).insertMany(docs);
  }
  await client.close();
}

// A short message on a mismatch: where the two first differ, not the whole record.
function same(actual, expected, message) {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a === b) return;
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  throw new Error(`${message}: differs at character ${at}: stored "…${a.slice(Math.max(0, at - 60), at + 60)}…" vs original "…${b.slice(Math.max(0, at - 60), at + 60)}…"`);
}
const originalTests = load('tests').docs;
const withoutStudents = ({ registrations: _list, ...test }) => test;
let checks = 0;

async function verifyLoads() {
  for (const original of originalTests) {
    const list = original.registrations || [];
    // The whole class, exactly and in the original order.
    same(await repo.testDocByCode(original.code), { ...original, registrations: list }, `${original.code}: the whole test as the admin views read it`);
    checks += 1;
    for (const registration of list) {
      // A student's request: the test and only their own registration.
      const req = {
        portalUser: { email: registration.collegeEmail },
        signedCookies: { [repo.registrationCookie(original.code)]: JSON.stringify({ id: registration.id, token: 'x' }) }
      };
      same(await repo.requireTestForStudent(req, original.code), { ...withoutStudents(original), registrations: [registration] },
        `${original.code}/${registration.id}: a student's own view`);
      checks += 1;
      if (registration.attempt?.id) {
        const context = await repo.attemptContext(registration.attempt.id);
        same(context, { test: { ...withoutStudents(original), registrations: [registration] }, registration, attempt: registration.attempt },
          `${original.code}/${registration.id}: the paper by its attempt id`);
        checks += 1;
      }
    }
  }
  // Every person's tests, newest first, each carrying only their own registrations.
  const emails = [...new Set(originalTests.flatMap((test) => (test.registrations || []).map((entry) => entry.collegeEmail)))];
  for (const email of emails) {
    const expected = originalTests
      .filter((test) => (test.registrations || []).some((entry) => entry.collegeEmail === email))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((test) => ({ ...test, registrations: test.registrations.filter((entry) => entry.collegeEmail === email) }));
    same(await repo.testsForEmail(email), expected, `${email}: their list of tests`);
    checks += 1;
  }
}

async function verifyShape(expectMovedTests) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const scratch = client.db();
  const total = originalTests.reduce((sum, test) => sum + (test.registrations || []).length, 0);
  assert.equal(await scratch.collection('registrations').countDocuments(), total, 'one document per student, no more, no less');
  assert.equal(await scratch.collection('tests').countDocuments({ registrations: { $exists: true } }), 0, 'no test keeps a list inline');
  const kept = await scratch.collection('registrationsMigrationBackup').find().toArray();
  assert.equal(kept.length, expectMovedTests, 'the original list of every moved test is kept');
  for (const copy of kept) same(copy.registrations, originalTests.find((test) => test.code === copy.testCode).registrations, `${copy.testCode}: kept original`);
  // Everything that is not a test or a student is exactly as it was.
  const asSet = (docs) => docs.map(canonical).sort().join(String.fromCharCode(10));
  for (const name of Object.keys(manifest.counts).filter((entry) => entry !== 'tests' && entry !== 'serverState')) {
    same(asSet(await scratch.collection(name).find().toArray()), asSet(load(name).docs), `${name} untouched`);
  }
  // The tests themselves: everything but the list, exactly as it was.
  same(asSet(await scratch.collection('tests').find().toArray()), asSet(originalTests.map(withoutStudents)), 'tests keep every other field');
  await client.close();
  checks += 1;
}

try {
  const withStudents = originalTests.filter((test) => Array.isArray(test.registrations)).length;

  // 1. A clean move, as the server's start-up does it.
  await restoreScratch();
  await db.initializeDatabase();
  await verifyShape(withStudents);
  await verifyLoads();

  // 2. Run again: nothing to move, nothing changes.
  {
    const { moveRegistrationsOut } = await import('../src/db/move-registrations.js');
    const client = await new MongoClient(process.env.MONGODB_URI).connect();
    const again = await moveRegistrationsOut(client.db(), { log: () => {} });
    await client.close();
    assert.deepEqual(again, { movedTests: 0, movedStudents: 0 }, 'a second start moves nothing');
  }
  await verifyShape(withStudents);
  await verifyLoads();
  await db.closeDatabase();

  // 3. Interrupted half-way: some students already copied, the list still on the test.
  await restoreScratch();
  {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const scratch = client.db();
    const biggest = [...originalTests].sort((a, b) => (b.registrations || []).length - (a.registrations || []).length)[0];
    const half = (biggest.registrations || []).slice(0, Math.ceil((biggest.registrations || []).length / 2));
    if (half.length) await scratch.collection('registrations').insertMany(half.map((entry) => ({ ...entry, testCode: biggest.code })));
    await client.close();
  }
  await db.initializeDatabase();
  await verifyShape(withStudents);
  await verifyLoads();
  await db.closeDatabase();

  console.log(`\n  Migration check passed on a copy of ${manifest.database} (${folder}):`);
  console.log(`  ${originalTests.length} tests, ${originalTests.reduce((sum, test) => sum + (test.registrations || []).length, 0)} students, ${checks} exact comparisons - a clean move, a second start, and a move interrupted half-way.\n`);
} catch (error) {
  console.error(`\n  Migration check FAILED: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  if (client.db().databaseName === scratchName) await client.db().dropDatabase();
  await client.close();
  await db.closeDatabase().catch(() => {});
  rmSync(scratchBackups, { recursive: true, force: true });
}
