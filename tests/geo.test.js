import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { LocationProblem, getBrowserLocation } from '../client/src/lib/geo.js';

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

/** A phone whose location service answers each request with the next of `replies`. */
function phone(replies, { userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile', secure = true } = {}) {
  const asked = [];
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: secure }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent,
      maxTouchPoints: 5,
      geolocation: {
        getCurrentPosition(ok, fail, options) {
          asked.push(options);
          const reply = replies.shift();
          if (reply === 'never') return; // a prompt nobody answers: no callback at all
          if (reply.code) setTimeout(() => fail(reply), 0);
          else setTimeout(() => ok({ coords: reply }), 0);
        }
      }
    }
  });
  return asked;
}

afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator;
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow); else delete globalThis.window;
});

test('a location request that never answers gives up instead of hanging', async () => {
  phone(['never']);
  const started = Date.now();
  await assert.rejects(getBrowserLocation({ patienceMs: 50 }), (error) => error instanceof LocationProblem && error.reason === 'timeout');
  assert.ok(Date.now() - started < 1_000);
});

test('no GPS fix indoors: the network position is used instead', async () => {
  const asked = phone([{ code: 3 }, { latitude: 30.3, longitude: 78.0, accuracy: 120 }]);
  assert.deepEqual(await getBrowserLocation({ patienceMs: 1_000 }), { latitude: 30.3, longitude: 78.0, accuracyMeters: 120 });
  assert.equal(asked[0].enableHighAccuracy, true);
  assert.equal(asked[1].enableHighAccuracy, false);
});

test('blocked permission says how to allow it on this phone', async () => {
  phone([{ code: 1 }]);
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'denied' && /Android/.test(error.message) && /Allow/.test(error.message));
  phone([{ code: 1 }], { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1' });
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'denied' && /Location Services/.test(error.message) && /Precise/.test(error.message));
});

test('a link opened inside another app says to open it in the browser', async () => {
  phone([{ code: 1 }], { userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit Chrome/128 Instagram 300.0' });
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'inapp' && /Open in browser/.test(error.message));
});

test('location switched off, and a page not on https', async () => {
  phone([{ code: 2 }, { code: 2 }]);
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'unavailable' && /Turn on Location/.test(error.message));
  phone([], { secure: false });
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'insecure');
});
