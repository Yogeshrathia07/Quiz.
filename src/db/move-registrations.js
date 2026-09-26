import { ObjectId } from 'mongodb';
import { backupDatabase } from './backup.js';

/**
 * Tests once kept every student inside the test document itself - their
 * registration, paper, answers and log - so every answer rewrote the whole
 * class's record, one write at a time. Each student now has their own
 * document in `registrations`. This moves any test still in the old shape,
 * once, when the server starts, before it serves a single request.
 *
 * Before the first change, the whole database is written to a backup folder
 * (backups/<database>-before-student-documents-<time>/, restorable with
 * scripts/db-restore.js). Then, in this order, for every such test:
 *   1. an untouched copy of the embedded list is kept in
 *      `registrationsMigrationBackup` (never overwritten once written);
 *   2. each student is copied into `registrations` - an upsert on the test
 *      and registration id, so running it again never makes duplicates;
 *   3. every copied student is compared, field by field, with the original;
 *   4. only if all of them match is the list taken off the test document.
 * If anything does not match, it stops and the server does not start:
 * nothing is removed, and the old list is still where it was.
 */

/** A stable text form of a value, whatever order its keys were written in. */
export function canonical(value) {
  if (value instanceof Date) return `D:${value.toISOString()}`;
  if (value instanceof ObjectId) return `O:${value.toHexString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.toHexString === 'function') return `O:${value.toHexString()}`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function moveRegistrationsOut(db, { log = console.log, backupRoot = process.env.MIGRATION_BACKUP_DIR || 'backups' } = {}) {
  const tests = db.collection('tests');
  const registrations = db.collection('registrations');
  const backup = db.collection('registrationsMigrationBackup');
  let movedTests = 0;
  let movedStudents = 0;

  const pending = await tests.find({ registrations: { $exists: true } }, { projection: { code: 1, registrations: 1 } }).toArray();
  if (!pending.length) return { movedTests: 0, movedStudents: 0 };
  const { folder } = await backupDatabase(db, { label: 'before-student-documents', root: backupRoot });
  log(`Backed up the whole database to ${folder} before moving students into their own documents.`);
  for (const test of pending) {
    const list = Array.isArray(test.registrations) ? test.registrations : [];
    const ids = list.map((entry) => entry?.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error(`Test ${test.code}: its students do not all have distinct ids, so they were not moved. Nothing was changed.`);
    }

    // 1. The untouched original, kept however many times this runs.
    await backup.updateOne(
      { testCode: test.code },
      { $setOnInsert: { testCode: test.code, registrations: list, savedAt: new Date() } },
      { upsert: true }
    );

    // 2. One document per student. The ids are made here, in list order, so
    //    reading them back sorted by _id gives the original order.
    if (list.length) {
      await registrations.bulkWrite(list.map((entry) => ({
        updateOne: {
          filter: { testCode: test.code, id: entry.id },
          update: { $setOnInsert: { ...entry, _id: new ObjectId(), testCode: test.code } },
          upsert: true
        }
      })), { ordered: true });
    }

    // 3. Every student, compared with the original.
    const stored = await registrations.find({ testCode: test.code }, { projection: { _id: 0, testCode: 0 } }).toArray();
    const byId = new Map(stored.map((entry) => [entry.id, entry]));
    for (const entry of list) {
      const copy = byId.get(entry.id);
      if (!copy || canonical(copy) !== canonical(entry)) {
        throw new Error(`Test ${test.code}: student ${entry.id} did not copy exactly, so the test was left as it was. Nothing was removed.`);
      }
    }

    // 4. Only now does the list leave the test document.
    await tests.updateOne({ code: test.code, registrations: { $exists: true } }, { $unset: { registrations: '' } });
    movedTests += 1;
    movedStudents += list.length;
  }
  if (movedTests) log(`Moved ${movedStudents} student record(s) out of ${movedTests} test(s) into their own documents (original lists kept in registrationsMigrationBackup).`);
  return { movedTests, movedStudents };
}
