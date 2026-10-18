import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionFlight, retrySubmission } from '../client/src/screens/student/submission-progress.js';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test('double taps and the deadline share one final submission request', async () => {
  const sendOnce = createSubmissionFlight();
  const request = deferred();
  let calls = 0;
  const send = () => { calls += 1; return request.promise; };
  const first = sendOnce('paper-1', send);
  const repeated = sendOnce('paper-1', send);
  assert.equal(first, repeated);
  await Promise.resolve();
  assert.equal(calls, 1);
  const submitted = { attempt: { status: 'submitted' } };
  request.resolve(submitted);
  assert.equal(await first, submitted);
  assert.equal(await repeated, submitted);
  assert.equal(await sendOnce('paper-1', () => 'checked again'), 'checked again');
});

test('a failed final request releases the flight so an explicit retry can run', async () => {
  const sendOnce = createSubmissionFlight();
  await assert.rejects(sendOnce('paper-1', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await sendOnce('paper-1', () => 'submitted'), 'submitted');
});

test('final submissions for a new attempt never join an old attempt request', async () => {
  const sendOnce = createSubmissionFlight();
  const old = deferred();
  const first = sendOnce('old-paper', () => old.promise);
  assert.equal(await sendOnce('new-paper', () => 'new submitted'), 'new submitted');
  old.resolve('old submitted');
  assert.equal(await first, 'old submitted');
});

const retryOptions = (extra = {}) => ({
  shouldRetry: (error) => error.transient === true,
  pause: async () => {}, retryWait: () => 0,
  ...extra
});

test('temporary submission failures announce retries and then return real confirmation', async () => {
  let calls = 0;
  const retries = [];
  const delays = [];
  const reply = await retrySubmission(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('busy'), { transient: true });
    return { attempt: { status: 'submitted' } };
  }, retryOptions({ onRetry: (_error, round) => retries.push(round), retryWait: (round) => round + 1, pause: async (ms) => delays.push(ms) }));
  assert.equal(reply.attempt.status, 'submitted');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [0, 1]);
  assert.deepEqual(delays, [1, 2]);
});

test('a permanent refusal is surfaced immediately without a retry', async () => {
  let calls = 0;
  await assert.rejects(retrySubmission(async () => { calls += 1; throw new Error('locked'); }, retryOptions()), /locked/);
  assert.equal(calls, 1);
});

test('bounded retries report an unconfirmed submission instead of claiming success', async () => {
  let calls = 0;
  await assert.rejects(retrySubmission(async () => {
    calls += 1; throw Object.assign(new Error('offline'), { transient: true });
  }, retryOptions({ retries: 2 })), /offline/);
  assert.equal(calls, 3);
});

test('cancellation or a submitted live update stops the next retry', async () => {
  let active = true;
  let calls = 0;
  const result = await retrySubmission(async () => {
    calls += 1; throw Object.assign(new Error('offline'), { transient: true });
  }, retryOptions({ active: () => active, pause: async () => { active = false; } }));
  assert.equal(result, null);
  assert.equal(calls, 1);
});
