import { Binary } from 'mongodb';
import { questionImages } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { randomId } from '../lib/crypto.js';
import { now } from '../lib/time.js';
import { adminEmail } from '../data/test-repository.js';
import { IMAGE_ID, imageUrl } from '../domain/question-image.js';

/**
 * Pictures on questions. The editor shrinks every picture before it is sent
 * (client/src/lib/image-compress.js: its longest side 1600 px, about 500 KB at
 * most), so a paper with pictures still opens quickly on a weak phone
 * connection. They are added in the editor only - a JSON import carries text.
 * Each is kept once, here, and a question holds only `{ id, width, height }`.
 */
export const MAX_IMAGE_BYTES = 700 * 1024;
const MAX_SIDE = 4000;
/** What a picture's first bytes must be, for each type it may say it is. */
const SIGNATURES = {
  'image/jpeg': (data) => data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF,
  'image/png': (data) => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
  'image/webp': (data) => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP'
};

const side = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_SIDE ? number : null;
};

/**
 * A picture the editor sends: its bytes as the body, its type as the
 * request's, and its width and height (as drawn) in the address. Refused if
 * it is not really a picture of that type, or bigger than MAX_IMAGE_BYTES.
 */
export async function saveQuestionImage(req, body, raw = {}) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const looksRight = SIGNATURES[contentType];
  const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  if (!looksRight) throw new PublicTestError(415, 'Add a JPEG, PNG or WebP picture.');
  if (!data.length) throw new PublicTestError(400, 'The picture was empty.');
  if (data.length > MAX_IMAGE_BYTES) throw new PublicTestError(413, 'This picture is still too large after shrinking. Try a smaller one, or crop it.');
  if (!looksRight(data)) throw new PublicTestError(415, 'That file is not the picture it says it is.');
  const width = side(raw.width);
  const height = side(raw.height);
  if (!width || !height) throw new PublicTestError(400, 'The picture\'s size is missing.');
  const id = randomId(18);
  await questionImages().insertOne({ _id: id, ownerEmail: adminEmail(req), contentType, bytes: data.length, width, height, data: new Binary(data), createdAt: now() });
  return { image: { id, width, height, bytes: data.length, url: imageUrl(id) } };
}

/** One picture, to send. Null when there is none by that id. */
export async function questionImage(id) {
  if (!IMAGE_ID.test(String(id || ''))) return null;
  return questionImages().findOne({ _id: String(id) }, { projection: { contentType: 1, data: 1, bytes: 1 } });
}

/** Refuses a test whose questions point at pictures that do not exist. */
export async function requireImages(questions = []) {
  const ids = [...new Set(questions.map((question) => question.image?.id).filter(Boolean))];
  if (!ids.length) return;
  const found = await questionImages().find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  if (found.length !== ids.length) throw new PublicTestError(400, 'A question\'s picture could not be found. Add it again.');
}
