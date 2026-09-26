/**
 * A complete copy of the database, restorable exactly: every collection is
 * written as canonical Extended JSON (dates, ids and numbers keep their types)
 * with its indexes, into backups/<database>-manual-<time>/.
 *
 *   npm run db:backup                         # backs up MONGODB_URI's database
 *   npm run db:restore -- backups/<folder>    # puts it back (server stopped)
 */
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';
import { backupDatabase } from '../src/db/backup.js';

const client = new MongoClient(config.mongoUri);
await client.connect();
try {
  const { folder, counts } = await backupDatabase(client.db());
  console.log(`Backed up ${client.db().databaseName} to ${folder}`);
  console.log(counts);
} finally {
  await client.close();
}
