import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PASS_MS, QR_ACCEPT_MS, QR_STEP_MS, QR_STEPS_ACCEPTED, adminSessionView, classRoster, currentQrKey, isFreshQrKey, isOpen, isValidPass,
  issuePass, phoneFingerprint, readPass, registerKey, sharedDevices, similarDevices, upcomingQrKeys
} from '../src/domain/attendance.js';

const secret = 'test-secret';
const at = 1_800_000_000_000;

test('the QR code changes every 2 seconds, and a code up to about 12 seconds old still works', () => {
  assert.equal(QR_STEP_MS, 2_000);
  assert.equal(QR_STEPS_ACCEPTED, 6);
  const key = currentQrKey(secret, at);
  assert.notEqual(currentQrKey(secret, at + QR_STEP_MS), key);
  assert.equal(isFreshQrKey(secret, key, at), true);
  assert.equal(isFreshQrKey(secret, key, at + QR_ACCEPT_MS), true);
  assert.equal(isFreshQrKey(secret, key, at + QR_STEPS_ACCEPTED * QR_STEP_MS), true);
});

test('a photo of an old QR stops working, and a code from another session never works', () => {
  const key = currentQrKey(secret, at);
  assert.equal(isFreshQrKey(secret, key, at + (QR_STEPS_ACCEPTED + 1) * QR_STEP_MS), false);
  assert.equal(isFreshQrKey('other-secret', key, at), false);
  assert.equal(isFreshQrKey(secret, '', at), false);
  assert.equal(isFreshQrKey(secret, undefined, at), false);
});

test('the teacher\'s screen is sent the coming codes: each works in its own second, none before', () => {
  const { from, keys } = upcomingQrKeys(secret, at, 5);
  assert.equal(from, Math.floor(at / QR_STEP_MS));
  keys.forEach((key, index) => assert.equal(key, currentQrKey(secret, at + index * QR_STEP_MS)));
  assert.equal(isFreshQrKey(secret, keys[3], at), false, 'a code from the future is not taken early');
  assert.equal(isFreshQrKey(secret, keys[3], at + 3 * QR_STEP_MS), true);
});

test('a scan pass lasts long enough to sign in, then expires, and cannot be forged', () => {
  const pass = issuePass(secret, at);
  assert.equal(isValidPass(secret, pass, at + PASS_MS - 1), true);
  assert.equal(isValidPass(secret, pass, at + PASS_MS), false);
  const [expires, id, signature] = pass.split('.');
  assert.equal(isValidPass(secret, `${Number(expires) + 60_000}.${id}.${signature}`, at), false);
  assert.equal(isValidPass(secret, `${expires}.other-id.${signature}`, at), false, 'its id is signed too');
  assert.equal(isValidPass('other-secret', pass, at), false);
  assert.equal(isValidPass(secret, 'nonsense', at), false);
});

test('each pass has its own id, so a used one can be told apart', () => {
  const first = readPass(secret, issuePass(secret, at), at);
  const second = readPass(secret, issuePass(secret, at), at);
  assert.ok(first && second);
  assert.notEqual(first, second);
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

test('the server\'s own cookie finds the phone when its storage was cleared', () => {
  const shared = sharedDevices([
    { id: 'a', name: 'Asha', deviceId: 'phone-1', deviceCookie: 'cookie-1', status: 'present' },
    // Storage cleared: a new page id, the same cookie.
    { id: 'b', name: 'Ben', deviceId: 'phone-1-again', deviceCookie: 'cookie-1', status: 'present' },
    // Cookies cleared, storage kept.
    { id: 'c', name: 'Chen', deviceId: 'phone-1', deviceCookie: 'cookie-2', status: 'present' }
  ]);
  assert.deepEqual(shared.get('a').sort(), ['Ben', 'Chen']);
  assert.deepEqual(shared.get('b'), ['Asha']);
  assert.deepEqual(shared.get('c'), ['Asha']);
});

const pixel = { model: 'Pixel 8', platformVersion: '15.0.0', chPlatform: 'Android', screenW: 412, screenH: 915, dpr: 2.625, cores: 8, memory: 8 };

test('a phone\'s fingerprint: the same phone in a private tab or turned sideways matches; another model does not; no model, nothing', () => {
  const print = phoneFingerprint(pixel);
  assert.match(print, /^[0-9a-f]{24}$/);
  assert.equal(phoneFingerprint({ ...pixel, screenW: 915, screenH: 412 }), print, 'turned sideways');
  assert.notEqual(phoneFingerprint({ ...pixel, model: 'SM-A146B' }), print);
  assert.notEqual(phoneFingerprint({ ...pixel, memory: 4 }), print);
  assert.equal(phoneFingerprint({ ...pixel, model: '' }), null, 'an iPhone keeps its model back');
  assert.equal(phoneFingerprint(null), null);
});

test('phones that only look alike are "possibly the same", never on top of a known match', () => {
  const marks = [
    { id: 'a', name: 'Asha', deviceId: 'p1', fingerprint: 'print-1', status: 'present' },
    // A private tab on Asha's phone: a new id, the same fingerprint.
    { id: 'b', name: 'Ben', deviceId: 'p2', fingerprint: 'print-1', status: 'present' },
    // Known to be Asha's phone: a match, not a maybe.
    { id: 'c', name: 'Chen', deviceId: 'p1', fingerprint: 'print-1', status: 'present' },
    { id: 'd', name: 'Dev', deviceId: 'p4', fingerprint: 'print-2', status: 'present' }
  ];
  const shared = sharedDevices(marks);
  const similar = similarDevices(marks, shared);
  assert.deepEqual(similar.get('b').sort(), ['Asha', 'Chen']);
  assert.deepEqual(similar.get('a'), ['Ben'], 'Chen is already a known match for Asha');
  assert.equal(similar.has('d'), false);
});

test('the admin view: its QR codes and link while open, nothing once closed; a flag count; no phone ids', () => {
  const session = {
    code: 'ATT-X', title: 'DBMS', secret, createdAt: new Date(at), rounds: [{ number: 1, openedAt: new Date(at), closedAt: null }],
    marks: [
      { id: 'a', name: 'Asha', email: 'a@x', deviceId: 'p1', status: 'pending', round: 1, markedAt: new Date(at) },
      { id: 'b', name: 'Ben', email: 'b@x', deviceId: 'p1', status: 'pending', round: 1, markedAt: new Date(at + 1) }
    ]
  };
  const view = adminSessionView(session, at, { linkBase: 'https://portal.example' });
  assert.equal(view.qr.link, 'https://portal.example/?attend=ATT-X&k=');
  assert.equal(view.qr.keys[0], currentQrKey(secret, at));
  assert.equal(view.flaggedCount, 2);
  assert.equal(view.marks[0].key, 'email:a@x');
  assert.equal('deviceId' in view.marks[0], false);
  session.rounds[0].closedAt = new Date(at);
  assert.equal(adminSessionView(session, at).qr, null);
});

test('a class roster: everyone seen in its other sessions, how often and when last; a removed mark is not being there', () => {
  const roster = classRoster([
    { createdAt: '2026-09-01T04:00:00Z', marks: [
      { name: 'Asha', email: 'asha@x', status: 'present' },
      { name: 'Guest Gita', email: 'guest-1@guest.test', isGuest: true, sapId: '500999999', status: 'present' },
      { name: 'Ben', email: 'ben@x', status: 'rejected' }
    ] },
    { createdAt: '2026-09-02T04:00:00Z', marks: [
      { name: 'Asha V.', email: 'asha@x', status: 'present' },
      // The same guest, signed in afresh: known by the SAP ID.
      { name: 'Gita', email: 'guest-2@guest.test', isGuest: true, sapId: '500999999', status: 'pending' }
    ] }
  ]);
  assert.equal(roster.sessionCount, 2);
  const person = (key) => roster.people.find((entry) => entry.key === key);
  assert.deepEqual([person('email:asha@x').seen, person('email:asha@x').name], [2, 'Asha V.'], 'the latest name');
  assert.equal(person('email:asha@x').lastSeenAt, '2026-09-02T04:00:00.000Z');
  assert.equal(person('guest-sap:500999999').seen, 2);
  assert.equal(person('guest-sap:500999999').email, null, 'a guest\'s made-up address is not shown');
  assert.equal(person('email:ben@x'), undefined);
  assert.equal(registerKey({ name: 'Gita', email: 'guest-2@guest.test', isGuest: true, sapId: '500999999' }), 'guest-sap:500999999');
});
