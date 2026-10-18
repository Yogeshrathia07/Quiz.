import { creatorDrafts } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { iso, now } from '../lib/time.js';
import { adminEmail } from '../data/test-repository.js';

/**
 * The Create page's draft: a test being written and not created yet, kept on
 * the server for its teacher - one each - so leaving the page, closing the tab
 * or moving to another device loses nothing. Never on the device itself: it
 * holds answer keys, and the portal writes nothing of a teacher's to the
 * device (client/src/lib/cache.js).
 *
 * Kept as the page's own JSON and opaque here: it is only ever handed back to
 * the same teacher, and it becomes a test only through createTest, which
 * checks everything. Creating the test throws the draft away.
 */

/** Under the request limit (server.js), with room for the envelope. */
export const MAX_DRAFT_BYTES = 240 * 1024;

const ownerOf = (req) => {
  const email = adminEmail(req);
  if (!email) throw new PublicTestError(401, 'Sign in again to keep your draft.');
  return email;
};

export async function getDraft(req) {
  const doc = await creatorDrafts().findOne({ _id: ownerOf(req) });
  if (!doc) return { draft: null, savedAt: null };
  let draft = null;
  try { draft = JSON.parse(doc.json); } catch { /* unreadable: as good as none */ }
  return { draft, savedAt: iso(doc.savedAt) };
}

export async function saveDraft(req, raw = {}) {
  const draft = raw.draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new PublicTestError(400, 'Send the draft to keep.');
  const json = JSON.stringify(draft);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_DRAFT_BYTES) throw new PublicTestError(413, 'This draft is too big to keep. Create the test, or shorten it.');
  const savedAt = now();
  await creatorDrafts().updateOne({ _id: ownerOf(req) }, { $set: { json, bytes, savedAt } }, { upsert: true });
  return { savedAt: iso(savedAt) };
}

export async function discardDraft(req) {
  await creatorDrafts().deleteOne({ _id: ownerOf(req) });
  return { ok: true };
}
