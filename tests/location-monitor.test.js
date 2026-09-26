import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocationCheck } from '../src/services/attempt-service.js';

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
