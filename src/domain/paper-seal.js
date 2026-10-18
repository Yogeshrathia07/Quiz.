import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Questions sent ahead, sealed
 * ----------------------------
 * A timed one-way paper (a timer on each question, no Next button) used to send
 * each question only when it opened, so every change waited on a trip to the
 * server. Now the next few questions travel ahead while the student works -
 * sealed: each encrypted (AES-256-GCM) with a key of its own, so its words are
 * unreadable on the device, even with the page's code open. Only in the last
 * moments of the open question (KEY_EARLY_MS) does the server give the key to
 * the next one, so the change is instant and no question can be read more than
 * that early. Answers are still taken only for the open question.
 *
 * Each key comes from the server's secret, the paper and the question
 * (HMAC-SHA256): nothing is stored, a restart changes nothing, and one
 * student's key never opens another student's copy.
 */

/** How many questions travel ahead of the open one. */
export const AHEAD_COUNT = 3;
/** How long before the open question's end the next question's key is given. */
export const KEY_EARLY_MS = 1_500;

/** The key that seals this question of this paper (32 bytes). */
export function questionKey(secret, attemptId, questionId) {
  return createHmac('sha256', String(secret)).update(`paper-seal:v1:${attemptId}:${questionId}`).digest();
}

/**
 * The question as it travels ahead: its view (what the paper shows) as JSON,
 * encrypted with `key` under a fresh nonce. `data` is the ciphertext followed
 * by the 16-byte tag, as the browser's Web Crypto expects for AES-GCM.
 */
export function sealQuestion(key, view) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(view), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
}
