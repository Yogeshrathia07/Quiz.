import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTest, startTimeMs } from '../src/domain/test-builder.js';
import { PublicTestError } from '../src/lib/errors.js';

const questions = [
  { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['1'] },
  { prompt: 'Which structure is LIFO?', type: 'mcq', options: ['Stack', 'Queue'], correctOptions: ['0'] },
  { prompt: 'Explain a queue.', type: 'short' }
];
const payload = (overrides = {}) => ({
  title: 'Data Structures',
  opensAt: '2026-09-20T10:00:00.123Z',
  questionMix: { mcq: 1, msq: 0, short: 1 },
  questions,
  ...overrides
});

test('the start time keeps its milliseconds whether it arrives as a string or a Date', () => {
  const iso = '2026-09-20T10:00:00.123Z';
  assert.equal(startTimeMs(iso), Date.parse(iso));
  assert.equal(startTimeMs(new Date(iso)), Date.parse(iso));
  assert.throws(() => startTimeMs('not a date'), PublicTestError);
  assert.throws(() => startTimeMs(null), PublicTestError);
});

test('re-validating stored Date times does not shift the window', () => {
  const first = buildTest(payload());
  const second = buildTest(payload({ opensAt: first.opensAt, endsAt: first.endsAt }));
  assert.equal(second.opensAt.getTime(), first.opensAt.getTime());
  assert.equal(second.endsAt.getTime(), first.endsAt.getTime());
});

test('the estimate prices the requested mix', () => {
  const built = buildTest(payload());
  // One MCQ (60s) and one short answer (120s).
  assert.equal(built.estimatedSeconds, 60 + 120);
  assert.equal(built.questionCount, 2);
});

test('with no end time given the window defaults to the estimate', () => {
  const built = buildTest(payload());
  assert.equal(built.endsAt.getTime() - built.opensAt.getTime(), 180_000);
  assert.equal(built.windowSeconds, 180);
});

test('the question layout is a per-test choice, defaulting to one at a time', () => {
  assert.equal(buildTest(payload()).questionLayout, 'one');
  assert.equal(buildTest(payload({ questionLayout: 'all' })).questionLayout, 'all');
  assert.equal(buildTest(payload({ questionLayout: 'nonsense' })).questionLayout, 'one');
});

test('an explicit end time is kept, long or short, and is what defines the window', () => {
  const generous = buildTest(payload({ endsAt: '2026-09-20T11:00:00.123Z' }));
  assert.equal(generous.windowSeconds, 3_600);
  assert.equal(generous.estimatedSeconds, 180, 'the estimate is unchanged by the window');

  // Shorter than the estimate is allowed: the admin is told, not blocked.
  const tight = buildTest(payload({ endsAt: '2026-09-20T10:01:00.000Z' }));
  assert.equal(tight.windowSeconds, 60);
  assert.equal(tight.estimatedSeconds, 180);
});

test('an end time at or before the start is rejected', () => {
  assert.throws(() => buildTest(payload({ endsAt: '2026-09-20T10:00:00.123Z' })), PublicTestError);
  assert.throws(() => buildTest(payload({ endsAt: '2026-09-20T09:00:00.000Z' })), PublicTestError);
  assert.throws(() => buildTest(payload({ endsAt: 'not a date' })), PublicTestError);
  assert.throws(() => buildTest(payload({ endsAt: '2026-12-31T00:00:00.000Z' })), PublicTestError, 'over 30 days');
});

test('a question mix that asks for more than the bank holds is rejected', () => {
  assert.throws(() => buildTest(payload({ questionMix: { mcq: 5, msq: 0, short: 0 } })), PublicTestError);
  assert.throws(() => buildTest(payload({ questionMix: { mcq: 0, msq: 0, short: 0 } })), PublicTestError);
});
