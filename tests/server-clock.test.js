import assert from 'node:assert/strict';
import test from 'node:test';
import { recordServerTime, resetServerClock, serverOffset } from '../client/src/lib/server-clock.js';

test('the server clock comes from the quickest reply, so a stuck one cannot drag the timers', () => {
  resetServerClock();
  assert.equal(serverOffset(), null, 'nothing heard yet');
  // The server is exactly 5 s ahead of this device.
  recordServerTime(1_000_000 + 5_000 + 100, 1_000_000, 1_000_200); // 200 ms round trip
  assert.equal(serverOffset(), 5_000);
  // A reply stuck for 30 s: stamped as it left, arriving much later. Taking
  // its time as "now" would put the clock up to 30 s behind.
  recordServerTime(1_100_000 + 5_000 + 200, 1_100_000, 1_130_000);
  assert.equal(serverOffset(), 5_000, 'the quick sample still decides');
});

test('a jump in the device clock starts the readings again', () => {
  resetServerClock();
  recordServerTime(2_000_000 + 100, 2_000_000, 2_000_200);
  assert.equal(serverOffset(), 0);
  // The device clock was set back a minute: every older sample is now wrong.
  recordServerTime(2_100_000 + 60_000 + 150, 2_100_000, 2_100_300);
  assert.equal(serverOffset(), 60_000);
});

test('a missing or broken stamp is ignored', () => {
  resetServerClock();
  recordServerTime(0, 1, 2);
  recordServerTime(Number.NaN, 1, 2);
  recordServerTime(5_000, 10, 5);
  assert.equal(serverOffset(), null);
});
