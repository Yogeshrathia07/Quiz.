import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTest } from '../src/domain/test-builder.js';
import { imageField, imageView, shownGraceMs } from '../src/domain/question-image.js';
import { saveQuestionImage } from '../src/services/question-image-service.js';

const picture = { id: 'AbCdEfGhIjKlMnOpQrStUv', width: 1600, height: 900 };
const paper = (image) => ({
  title: 'Pictures', opensAt: new Date().toISOString(), questionMix: { mcq: 1, msq: 0, short: 0 }, startMode: 'manual', endMode: 'manual',
  questions: [{ prompt: 'What does the circuit show?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'], image }]
});

test('a question keeps its picture: its id and size, nothing else', () => {
  const built = buildTest(paper({ ...picture, url: '/somewhere', bytes: 12 }));
  assert.deepEqual(built.questions[0].image, picture);
  assert.equal(buildTest(paper(undefined)).questions[0].image, null);
});

test('a picture that is not one the editor made is refused', () => {
  assert.throws(() => imageField({ id: '../etc/passwd', width: 10, height: 10 }, 'Question 1'), /picture is not valid/);
  assert.throws(() => imageField({ id: picture.id, width: 0, height: 10 }, 'Question 1'), /picture is not valid/);
  assert.throws(() => imageField({ id: picture.id, width: 99999, height: 10 }, 'Question 1'), /picture is not valid/);
  assert.equal(imageField(null, 'Question 1'), null);
});

test('the paper gets where to fetch the picture and its size, never more', () => {
  assert.deepEqual(imageView(picture), { url: `/api/question-images/${picture.id}`, width: 1600, height: 900 });
  assert.equal(imageView(null), null);
});

test('a question with a picture waits longer for "on screen" than one without', () => {
  assert.equal(shownGraceMs(false), 10_000);
  assert.equal(shownGraceMs(true), 30_000);
});

test('an upload must really be the picture it says it is, and small', async () => {
  const req = (type) => ({ headers: { 'content-type': type }, portalUser: { email: 'teacher@ddn.upes.ac.in' } });
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  await assert.rejects(() => saveQuestionImage(req('text/html'), png, { width: 10, height: 10 }), /JPEG, PNG or WebP/);
  await assert.rejects(() => saveQuestionImage(req('image/png'), Buffer.from('<svg onload=alert(1)>'), { width: 10, height: 10 }), /not the picture it says/);
  await assert.rejects(() => saveQuestionImage(req('image/jpeg'), png, { width: 10, height: 10 }), /not the picture it says/);
  await assert.rejects(() => saveQuestionImage(req('image/png'), Buffer.concat([png, Buffer.alloc(800 * 1024)]), { width: 10, height: 10 }), /too large/);
  await assert.rejects(() => saveQuestionImage(req('image/png'), png, { width: 'x', height: 10 }), /size is missing/);
});
