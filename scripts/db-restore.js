/**
 * Puts a backup from scripts/db-backup.js back, replacing what is there now.
 * Run it with the server STOPPED.
 *
 *   node scripts/db-restore.js backups/campus_quiz-2026-...          # into MONGODB_URI's database
 *   RESTORE_DB=campus_quiz_copy node scripts/db-restore.js <folder>  # into another database
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EJSON } from 'bson';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';

const folder = process.argv[2];
if (!folder) { console.error('Give the backup folder: node scripts/db-restore.js backups/<folder>'); process.exit(1); }
const client = new MongoClient(config.mongoUri);
await client.connect();
const db = process.env.RESTORE_DB ? client.db(process.env.RESTORE_DB) : client.db();
const counts = {};
for (const file of readdirSync(folder).filter((name) => name.endsWith('.json') && name !== 'manifest.json')) {
  const name = file.slice(0, -5);
  const { docs, indexes } = EJSON.parse(readFileSync(join(folder, file), 'utf8'), { relaxed: false });
  await db.collection(name).drop().catch(() => {});
  if (docs.length) await db.collection(name).insertMany(docs, { ordered: true });
  for (const index of indexes.filter((entry) => entry.name !== '_id_')) {
    const { key, v: _v, ns: _ns, ...options } = index;
    await db.collection(name).createIndex(key, options);
  }
  counts[name] = await db.collection(name).countDocuments();
}
await client.close();
console.log(`Restored ${folder} into ${db.databaseName}`, counts);
