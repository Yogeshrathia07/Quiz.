import { config } from '../config.js';
import { asInteger } from '../lib/crypto.js';
import { PublicTestError } from '../lib/errors.js';

/**
 * A question's picture: `{ id, width, height }` on the stored question, the
 * bytes kept apart (services/question-image-service.js). Added in the editor
 * only - never from a JSON import, which carries text.
 */
export const IMAGE_ID = /^[A-Za-z0-9_-]{16,40}$/;
const MAX_SIDE = 4000;

/** Where a question's picture is served from (by its id, which no one can guess). */
export const imageUrl = (id) => `/api/question-images/${encodeURIComponent(id)}`;

/** The picture as a paper or a review shows it: where to fetch it, and its size so the page keeps room for it. */
export const imageView = (image) => (image?.id ? { url: imageUrl(image.id), width: image.width, height: image.height } : null);

/** A question's picture as the editor sends it - checked, or null for none. */
export function imageField(raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = String(raw?.id || '');
  const width = asInteger(raw?.width, 1, MAX_SIDE);
  const height = asInteger(raw?.height, 1, MAX_SIDE);
  if (!IMAGE_ID.test(id) || width === null || height === null) throw new PublicTestError(400, `${label}'s picture is not valid. Add it again.`);
  return { id, width, height };
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
