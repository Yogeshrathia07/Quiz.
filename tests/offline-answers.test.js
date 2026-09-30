import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answeredCountWith, applyPending, clearCache, clearDurableCache, clearOtherCaches, createDebouncedDurableCacheWriter, isPermanentRejection, loadCache,
  loadCacheForCode, loadDurableCache, mergeAnswerAcknowledgement, mergeAttemptState, retryDelay, saveCache, saveDurableCache
} from '../client/src/lib/offline-answers.js';

/** A stand-in for localStorage, including one that refuses to co-operate. */
function fakeStorage(broken = false) {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index],
    getItem(key) { if (broken) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (broken) throw new Error('blocked'); map.set(key, String(value)); },
    removeItem(key) { if (broken) throw new Error('blocked'); map.delete(key); }
  };
}

const paper = [
  { id: 1, index: 0, number: 1, type: 'mcq', selectedOptions: [], answerText: '', answered: false, locked: false },
  { id: 2, index: 1, number: 2, type: 'short', selectedOptions: [], answerText: '', answered: false, locked: false }
];

test('a queued answer shows on the paper and is marked unsent', () => {
  const merged = applyPending(paper, new Map([[1, { questionId: 1, selectedOptions: ['0'] }]]));
  assert.deepEqual(merged[0].selectedOptions, ['0']);
  assert.equal(merged[0].answered, true);
  assert.equal(merged[0].unsent, true);
  assert.equal(merged[1].answered, false, 'other questions are untouched');
  assert.equal(merged[1].unsent, undefined);
  assert.equal(answeredCountWith(merged), 1);
});

test('a queued answer overrides whatever the server last said', () => {
  const server = [{ ...paper[0], selectedOptions: ['1'], answered: true }];
  const merged = applyPending(server, new Map([[1, { questionId: 1, selectedOptions: ['0'] }]]));
  assert.deepEqual(merged[0].selectedOptions, ['0'], 'the newer local answer wins on screen');
});

test('a queued clear un-answers the question', () => {
  const server = [{ ...paper[0], selectedOptions: ['1'], answered: true }];
  const merged = applyPending(server, new Map([[1, { questionId: 1, selectedOptions: [] }]]));
  assert.equal(merged[0].answered, false);
  assert.equal(answeredCountWith(merged), 0);
});

test('a whitespace-only typed answer does not count as answered', () => {
  assert.equal(applyPending(paper, new Map([[2, { questionId: 2, answerText: '   ' }]]))[1].answered, false);
  assert.equal(applyPending(paper, new Map([[2, { questionId: 2, answerText: 'Because.' }]]))[1].answered, true);
});

test('an empty queue returns the paper untouched', () => {
  assert.equal(applyPending(paper, new Map()), paper);
  assert.equal(applyPending(paper, null), paper);
  assert.deepEqual(applyPending(undefined, new Map()), []);
});

test('the paper and its queue survive a reload', () => {
  const storage = fakeStorage();
  const attempt = { id: 'abc', status: 'in_progress', questions: paper };
  saveCache(storage, 'abc', attempt, new Map([[1, { questionId: 1, selectedOptions: ['0'] }]]));

  const restored = loadCache(storage, 'abc');
  assert.equal(restored.attempt.id, 'abc');
  assert.equal(restored.attempt.questions.length, 2);
  assert.equal(restored.pending.size, 1);
  assert.deepEqual(restored.pending.get(1), { questionId: 1, selectedOptions: ['0'] });
});

test('an offline reload can find its latest paper by test code', () => {
  const storage = fakeStorage();
  saveCache(storage, 'abc', { id: 'abc', code: 'NET-101', status: 'in_progress', questions: paper }, new Map([[2, { questionId: 2, answerText: 'Held here' }]]));
  const restored = loadCacheForCode(storage, 'net-101');
  assert.equal(restored.attempt.id, 'abc');
  assert.equal(restored.pending.get(2).answerText, 'Held here');
});

test('submitting clears this device of the paper', () => {
  const storage = fakeStorage();
  saveCache(storage, 'abc', { id: 'abc', questions: paper }, new Map());
  clearCache(storage, 'abc');
  assert.equal(loadCache(storage, 'abc'), null);
});

test('a previous attempt on this device is discarded', () => {
  const storage = fakeStorage();
  saveCache(storage, 'old', { id: 'old', questions: paper }, new Map());
  saveCache(storage, 'new', { id: 'new', questions: paper }, new Map());
  storage.setItem('unrelated', 'keep me');

  clearOtherCaches(storage, 'new');
  assert.equal(loadCache(storage, 'old'), null);
  assert.ok(loadCache(storage, 'new'));
  assert.equal(storage.getItem('unrelated'), 'keep me', 'other keys are left alone');
});

test('storage that refuses to work never breaks the exam', () => {
  const storage = fakeStorage(true);
  assert.doesNotThrow(() => saveCache(storage, 'abc', { id: 'abc' }, new Map()));
  assert.doesNotThrow(() => clearCache(storage, 'abc'));
  assert.doesNotThrow(() => clearOtherCaches(storage, 'abc'));
  assert.equal(loadCache(storage, 'abc'), null);
  assert.equal(loadCache(null, 'abc'), null);
});

test('corrupt stored data is ignored rather than crashing the paper', () => {
  const storage = fakeStorage();
  storage.setItem('quiz-offline:abc', '{not json');
  assert.equal(loadCache(storage, 'abc'), null);
  storage.setItem('quiz-offline:abc', '{"pending":[]}');
  assert.equal(loadCache(storage, 'abc'), null, 'no attempt means nothing to restore');
});

test('only a refusal the server will repeat is dropped from the queue', () => {
  assert.equal(isPermanentRejection(409), true, 'a frozen answer must not be retried forever');
  assert.equal(isPermanentRejection(400), true);
  assert.equal(isPermanentRejection(404), true);
  assert.equal(isPermanentRejection(423), true, 'a locked attempt');

  assert.equal(isPermanentRejection(0), false, 'no connection: keep it and retry');
  assert.equal(isPermanentRejection(500), false, 'a server wobble: keep it and retry');
  assert.equal(isPermanentRejection(502), false);
  assert.equal(isPermanentRejection(408), false, 'a timeout is worth retrying');
  assert.equal(isPermanentRejection(429), false, 'so is being asked to slow down');
});

test('compact acknowledgements update one answer while preserving the paper', () => {
  const attempt = { id: 'abc', status: 'in_progress', questions: paper, answeredQuestionCount: 0 };
  const merged = mergeAnswerAcknowledgement(attempt, {
    state: { answeredQuestionCount: 1, revision: 'next' },
    answer: { questionId: 1, selectedOptions: ['0'], answerText: '', answered: true, locked: false }
  });
  assert.equal(merged.questions.length, 2);
  assert.deepEqual(merged.questions[0].selectedOptions, ['0']);
  assert.equal(merged.questions[1], paper[1]);
  assert.equal(merged.revision, 'next');
  assert.equal(merged.answeredQuestionCount, 1);
});

test('a compact lock state removes question text until a full refresh', () => {
  const merged = mergeAttemptState({ id: 'abc', questions: paper }, { state: { isLocked: true, lockReason: 'Limit reached' } });
  assert.equal(merged.questions, undefined);
  assert.equal(merged.isLocked, true);
});

test('network retry grows exponentially, jitters and stays capped', () => {
  assert.equal(retryDelay(0, 0), 500);
  assert.equal(retryDelay(1, 1), 2_000);
  assert.equal(retryDelay(10, 1), 30_000);
  assert.equal(retryDelay(10, 0), 15_000);
});

test('durable storage safely degrades where IndexedDB is unavailable', async () => {
  assert.equal(await loadDurableCache(null, 'NET-101'), null);
  assert.equal(await saveDurableCache(null, 'NET-101', { id: 'abc' }, new Map()), false);
  assert.equal(await clearDurableCache(null, 'NET-101'), false);
});

test('durable snapshots coalesce, and a clear cannot be followed by a stale write', async () => {
  const calls = [];
  const writer = createDebouncedDurableCacheWriter(null, 'NET-101', {
    delay: 20,
    save: async (_db, _code, attempt, pending) => { calls.push({ type: 'save', id: attempt.id, pending: [...pending] }); },
    clear: async () => { calls.push({ type: 'clear' }); }
  });
  writer.schedule({ id: 'older' }, new Map([[1, { answerText: 'A' }]]));
  writer.schedule({ id: 'newest' }, new Map([[1, { answerText: 'B' }]]));
  await writer.flush();
  assert.deepEqual(calls, [{ type: 'save', id: 'newest', pending: [[1, { answerText: 'B' }]] }]);

  // This queued snapshot must be cancelled before it can escape after Submit.
  writer.schedule({ id: 'stale' }, new Map());
  await writer.clear();
  await writer.dispose();
  assert.deepEqual(calls.map((call) => call.type), ['save', 'clear']);
});
