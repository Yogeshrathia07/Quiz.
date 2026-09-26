import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EJSON } from 'bson';

/**
 * A complete copy of a database in backups/<database>-<label>-<time>/: every
 * collection as canonical Extended JSON (dates, ids and number types kept
 * exactly), with its indexes, plus a manifest of counts. Each file is read
 * straight back and compared before the next is written, so a backup that
 * reports success can be restored. `node scripts/db-restore.js <folder>` puts
 * it back.
 */
export async function backupDatabase(db, { label = 'manual', root = 'backups' } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = join(root, `${db.databaseName}-${label}-${stamp}`);
  mkdirSync(folder, { recursive: true });
  const counts = {};
  for (const { name } of await db.listCollections().toArray()) {
    const docs = await db.collection(name).find({}).toArray();
    const indexes = await db.collection(name).indexes();
    const file = join(folder, `${name}.json`);
    writeFileSync(file, EJSON.stringify({ docs, indexes }, { relaxed: false }));
    const again = EJSON.parse(readFileSync(file, 'utf8'), { relaxed: false });
    if (EJSON.stringify(again.docs) !== EJSON.stringify(docs)) throw new Error(`The backup of ${name} does not read back identically.`);
    counts[name] = docs.length;
  }
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ database: db.databaseName, label, takenAt: new Date().toISOString(), counts }, null, 2));
  return { folder, counts };
}
