import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocationCheck, locationReading } from '../src/services/attempt-service.js';

const venue = { locationLatitude: 0, locationLongitude: 0, locationRadiusMeters: 250 };

test('a reliable reading near the venue is in range', () => {
  assert.equal(classifyLocationCheck(venue, {
    latitude: 0, longitude: 0.001, accuracyMeters: 20
  }).status, 'inRange');
});

test('a reliable reading clearly beyond the accuracy-aware boundary is out of range', () => {
  assert.equal(classifyLocationCheck(venue, {
    latitude: 0, longitude: 0.01, accuracyMeters: 30
  }).status, 'outOfRange');
});

test('poor accuracy and a reading crossing the boundary are inconclusive', () => {
  assert.equal(classifyLocationCheck(venue, {
    latitude: 0, longitude: 0, accuracyMeters: 250
  }).status, 'inconclusive');
  assert.equal(classifyLocationCheck(venue, {
    latitude: 0, longitude: 0.003, accuracyMeters: 50
  }).status, 'inconclusive');
});

test('missing coordinates are inconclusive rather than outside', () => {
  assert.equal(classifyLocationCheck(venue, {}).status, 'inconclusive');
});

test('each reading keeps where the device was, for the teacher', () => {
  const at = new Date('2026-10-05T04:30:00Z');
  const raw = { latitude: 0.0012345678, longitude: 0.001, accuracyMeters: 19.6 };
  assert.deepEqual(locationReading(raw, classifyLocationCheck(venue, raw), at, 'question'), {
    at, trigger: 'question', status: 'inRange', latitude: 0.001235, longitude: 0.001, accuracyMeters: 20, distanceMeters: 177
  });
});

test('a check with no reading is kept, without coordinates', () => {
  const at = new Date('2026-10-05T04:31:00Z');
  assert.deepEqual(locationReading({}, classifyLocationCheck(venue, {}), at, 'timer'), {
    at, trigger: 'timer', status: 'inconclusive', latitude: null, longitude: null, accuracyMeters: null, distanceMeters: null
  });
  // Out-of-range numbers are not a place.
  assert.equal(locationReading({ latitude: 95, longitude: 0, accuracyMeters: 5 }, { status: 'inconclusive', distanceMeters: null }, at, 'timer').latitude, null);
});
