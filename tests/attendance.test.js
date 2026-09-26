import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PASS_MS, QR_STEP_MS, QR_STEPS_ACCEPTED, currentQrKey, isFreshQrKey, isOpen, isValidPass, issuePass, sharedDevices
} from '../src/domain/attendance.js';

const secret = 'test-secret';
const at = 1_800_000_000_000;

test('the QR code changes every step, and a code a few steps old still works', () => {
  const key = currentQrKey(secret, at);
  assert.notEqual(currentQrKey(secret, at + QR_STEP_MS), key);
  assert.equal(isFreshQrKey(secret, key, at), true);
  assert.equal(isFreshQrKey(secret, key, at + QR_STEPS_ACCEPTED * QR_STEP_MS), true);
});

test('a photo of an old QR stops working, and a code from another session never works', () => {
  const key = currentQrKey(secret, at);
  assert.equal(isFreshQrKey(secret, key, at + (QR_STEPS_ACCEPTED + 1) * QR_STEP_MS), false);
  assert.equal(isFreshQrKey('other-secret', key, at), false);
  assert.equal(isFreshQrKey(secret, '', at), false);
  assert.equal(isFreshQrKey(secret, undefined, at), false);
});

test('a scan pass lasts long enough to sign in, then expires, and cannot be forged', () => {
  const pass = issuePass(secret, at);
  assert.equal(isValidPass(secret, pass, at + PASS_MS - 1), true);
  assert.equal(isValidPass(secret, pass, at + PASS_MS), false);
  const [expires] = pass.split('.');
  assert.equal(isValidPass(secret, `${Number(expires) + 60_000}.${pass.split('.')[1]}`, at), false);
  assert.equal(isValidPass('other-secret', pass, at), false);
  assert.equal(isValidPass(secret, 'nonsense', at), false);
});

test('a session is open while its latest round has not closed', () => {
  assert.equal(isOpen({ rounds: [] }), false);
  assert.equal(isOpen({ rounds: [{ number: 1, closedAt: null }] }), true);
  assert.equal(isOpen({ rounds: [{ number: 1, closedAt: new Date() }] }), false);
  assert.equal(isOpen({ rounds: [{ number: 1, closedAt: new Date() }, { number: 2, closedAt: null }] }), true);
});

test('one phone marking for several people is pointed out, ignoring removed marks', () => {
  const shared = sharedDevices([
    { id: 'a', name: 'Asha', deviceId: 'phone-1', status: 'pending' },
    { id: 'b', name: 'Ben', deviceId: 'phone-1', status: 'present' },
    { id: 'c', name: 'Chen', deviceId: 'phone-2', status: 'pending' },
    { id: 'd', name: 'Dev', deviceId: 'phone-2', status: 'rejected' },
    { id: 'e', name: 'Esha', deviceId: null, status: 'pending' }
  ]);
  assert.deepEqual(shared.get('a'), ['Ben']);
  assert.deepEqual(shared.get('b'), ['Asha']);
  assert.equal(shared.has('c'), false);
  assert.equal(shared.has('e'), false);
});
