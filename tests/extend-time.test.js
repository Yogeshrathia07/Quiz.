import assert from 'node:assert/strict';
import test from 'node:test';
import { extendedEndMs } from '../client/src/lib/quiz.js';

const now = Date.parse('2026-09-20T10:30:00.000Z');
const minutes = (n) => n * 60_000;

test('extending a live test counts from its current end time', () => {
  const end = now + minutes(20);
  assert.equal(extendedEndMs(end, 10, now), end + minutes(10));
});

test('extending a lapsed test counts from now, so the minutes are real', () => {
  const end = now - minutes(45);
  assert.equal(extendedEndMs(end, 10, now), now + minutes(10));
});

test('an extension at the exact deadline counts from that instant', () => {
  assert.equal(extendedEndMs(now, 15, now), now + minutes(15));
});

test('a missing or empty minute count leaves the end time where it is', () => {
  const end = now + minutes(5);
  assert.equal(extendedEndMs(end, '', now), end);
  assert.equal(extendedEndMs(end, undefined, now), end);
});

test('the preview accepts a numeric string from the input field', () => {
  const end = now + minutes(5);
  assert.equal(extendedEndMs(end, '30', now), end + minutes(30));
});
