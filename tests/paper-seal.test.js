import assert from 'node:assert/strict';
import test from 'node:test';
import { questionKey, sealQuestion } from '../src/domain/paper-seal.js';
import { canOpenSealed, openSealed } from '../client/src/lib/paper-seal.js';

const view = { id: 7, number: 3, type: 'mcq', prompt: 'Which <b>one</b>? “quotes” and ünïcödé', options: [{ id: '2', text: 'Third' }, { id: '0', text: 'First' }], selectedOptions: [], answered: false, timeSeconds: 45 };

test('a question sealed on the server opens on the device with its key, exactly as it was', async () => {
  assert.ok(canOpenSealed(), 'Web Crypto is there (Node, like a secure page)');
  const key = questionKey('a-secret-of-at-least-thirty-two-characters', 'attempt-1', 7);
  const sealed = sealQuestion(key, view);
  assert.ok(!sealed.data.includes('Which') && !Buffer.from(sealed.data, 'base64').toString('utf8').includes('Which'), 'the words do not travel in the clear');
  assert.deepEqual(await openSealed(sealed, key.toString('base64')), view);
});

test('every question of every paper has its own key: one key never opens another copy', async () => {
  const secret = 'a-secret-of-at-least-thirty-two-characters';
  const key = questionKey(secret, 'attempt-1', 7);
  assert.notDeepEqual(key, questionKey(secret, 'attempt-1', 8), 'the next question of the same paper');
  assert.notDeepEqual(key, questionKey(secret, 'attempt-2', 7), 'the same question on another student\'s paper');
  assert.notDeepEqual(key, questionKey('another-secret-of-at-least-thirty-two-chars', 'attempt-1', 7), 'another server');
  assert.deepEqual(key, questionKey(secret, 'attempt-1', 7), 'the same each time: nothing to store, a restart changes nothing');
  const sealed = sealQuestion(questionKey(secret, 'attempt-2', 7), view);
  await assert.rejects(() => openSealed(sealed, key.toString('base64')), 'the wrong key fails, it never yields the question');
});

test('sealing the same question twice gives different bytes (a fresh nonce each time)', () => {
  const key = questionKey('a-secret-of-at-least-thirty-two-characters', 'attempt-1', 7);
  assert.notEqual(sealQuestion(key, view).data, sealQuestion(key, view).data);
});
