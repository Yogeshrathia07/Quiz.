import { config } from '../config.js';
import { asInteger } from '../lib/crypto.js';
import { PublicTestError } from '../lib/errors.js';

/**
 * A question's picture: `{ id, width, height, ext }` on the stored question,
 * the bytes kept apart (services/question-image-service.js). Added in the
 * editor only - never from a JSON import, which carries text.
 */
export const IMAGE_ID = /^[A-Za-z0-9_-]{16,40}$/;
const MAX_SIDE = 4000;
/** Each kind of picture kept, and the ending its address has. */
export const IMAGE_EXTENSIONS = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const EXTENSIONS = new Set(Object.values(IMAGE_EXTENSIONS));
const IMAGE_FILE = /^([A-Za-z0-9_-]{16,40})(?:\.(?:webp|jpg|png))?$/;

/**
 * Where a question's picture is served from (by its id, which no one can
 * guess). Its ending (.webp, .jpg, .png) lets Cloudflare keep a copy near the
 * students - its free plan keeps files by their ending - so a whole class
 * asking for it in the same second is served from there, not by this
 * server's upload. A picture whose kind is not known has no ending.
 */
export const imageUrl = (id, ext) => `/api/question-images/${encodeURIComponent(id)}${EXTENSIONS.has(ext) ? `.${ext}` : ''}`;

/** The picture's id from the last part of its address, with or without its ending; null if it is not one. */
export const imageIdOf = (file) => IMAGE_FILE.exec(String(file || ''))?.[1] ?? null;

/** The picture as a paper or a review shows it: where to fetch it, and its size so the page keeps room for it. */
export const imageView = (image) => (image?.id ? { url: imageUrl(image.id, image.ext), width: image.width, height: image.height } : null);

/** A question's picture as the editor sends it - checked, or null for none. */
export function imageField(raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = String(raw?.id || '');
  const width = asInteger(raw?.width, 1, MAX_SIDE);
  const height = asInteger(raw?.height, 1, MAX_SIDE);
  if (!IMAGE_ID.test(id) || width === null || height === null) throw new PublicTestError(400, `${label}'s picture is not valid. Add it again.`);
  return EXTENSIONS.has(raw?.ext) ? { id, width, height, ext: raw.ext } : { id, width, height };
}

const questionWithId = (test, questionId) => (test?.questions || []).find((question) => question.id === questionId);
/** Whether this question of the test has a picture. */
export const questionHasImage = (test, questionId) => Boolean(questionWithId(test, questionId)?.image);
/** Whether any question on this paper has a picture. */
export const paperHasImages = (test, attempt) => (attempt?.questions || []).some((assigned) => questionHasImage(test, assigned.questionId));

/**
 * How long after sending a paper (or a question) the student's device may say
 * it is on screen, and have its clock start then. A picture can take longer
 * to arrive than text, and its clock should not run while it does: a
 * question with one waits up to `imageShownGraceSeconds` (30 s unless set),
 * any other the usual `shownGraceSeconds` (10 s).
 */
export function shownGraceMs(withImage = false) {
  const usual = Math.max(0, Number(config.shownGraceSeconds) || 0);
  const seconds = withImage ? Math.max(usual, Number(config.imageShownGraceSeconds) || 0) : usual;
  return seconds * 1000;
}
