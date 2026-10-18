import { IMAGE_EXTENSIONS } from '../domain/question-image.js';

/**
 * A question's picture once held only its id and size, so its address had no
 * ending - and Cloudflare, which keeps files by their ending, sent every
 * student's request on to this server. This writes each picture's kind onto
 * the questions that show it when the server starts, from the picture itself,
 * so its address ends in .webp, .jpg or .png (domain/question-image.js). A
 * picture that cannot be found is left as it is, and a second run finds
 * nothing more to do.
 */
export async function addImageEndings(database) {
  const tests = database.collection('tests');
  const missing = { $elemMatch: { 'image.id': { $exists: true }, 'image.ext': { $exists: false } } };
  const found = await tests.find({ questions: missing }, { projection: { 'questions.image': 1 } }).toArray();
  const ids = [...new Set(found.flatMap((test) => (test.questions || [])
    .map((question) => question.image)
    .filter((image) => image?.id && !image.ext)
    .map((image) => image.id)))];
  if (!ids.length) return;
  const pictures = await database.collection('questionImages').find({ _id: { $in: ids } }, { projection: { contentType: 1 } }).toArray();
  for (const picture of pictures) {
    const ext = IMAGE_EXTENSIONS[picture.contentType];
    if (!ext) continue;
    await tests.updateMany(
      { 'questions.image.id': picture._id },
      { $set: { 'questions.$[shown].image.ext': ext } },
      { arrayFilters: [{ 'shown.image.id': picture._id, 'shown.image.ext': { $exists: false } }] }
    );
  }
}
