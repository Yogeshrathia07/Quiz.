import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { LocationProblem, browserInfo, getBrowserLocation, imprecision, knownProblem } from '../client/src/lib/geo.js';

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

/**
 * A phone whose location service answers each request - a watch or a single
 * reading - with the next of `replies`: a fix, an error ({ code }), 'never'
 * (a question nobody answers), or a list of [ms, fix or error] steps, the
 * way a watch reports fix after fix. `asked.cleared` lists the watches ended.
 */
function phone(replies, { userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile', secure = true } = {}) {
  const asked = [];
  asked.cleared = [];
  const watches = new Map();
  const play = (reply, ok, fail) => (reply === 'never' || reply === undefined ? []
    : (Array.isArray(reply) ? reply : [[0, reply]]).map(([ms, step]) => setTimeout(() => (step.code ? fail(step) : ok({ coords: step })), ms)));
  Object.defineProperty(globalThis, 'window', { value: { isSecureContext: secure }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent,
      maxTouchPoints: 5,
      geolocation: {
        getCurrentPosition(ok, fail, options) {
          asked.push({ ...options, watch: false });
          play(replies.shift(), ok, fail);
        },
        watchPosition(ok, fail, options) {
          asked.push({ ...options, watch: true });
          const id = asked.length;
          watches.set(id, play(replies.shift(), ok, fail));
          return id;
        },
        clearWatch(id) {
          asked.cleared.push(id);
          (watches.get(id) || []).forEach(clearTimeout);
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
  assert.equal(asked[0].watch, true);
  assert.equal(asked[1].enableHighAccuracy, false);
});

const ROUGH = { latitude: 30.33, longitude: 78.03, accuracy: 900 };
const FAIR = { latitude: 30.317, longitude: 78.032, accuracy: 120 };
const GOOD = { latitude: 30.3166, longitude: 78.0322, accuracy: 18 };

test('a rough first fix is not the answer: the precise one that follows is', async () => {
  const asked = phone([[[0, ROUGH], [40, GOOD]]]);
  const started = Date.now();
  const reading = await getBrowserLocation({ patienceMs: 5_000, settleMs: 2_000 });
  assert.equal(reading.accuracyMeters, 18);
  assert.ok(Date.now() - started < 1_000, 'a good fix is taken at once, without waiting out the settle time');
  assert.deepEqual(asked.cleared, [1], 'and the watch is ended');
});

test('no good fix: the best within the settle time is used', async () => {
  const asked = phone([[[0, ROUGH], [20, FAIR], [500, GOOD]]]);
  const reading = await getBrowserLocation({ patienceMs: 5_000, settleMs: 100 });
  assert.equal(reading.accuracyMeters, 120);
  assert.deepEqual(asked.cleared, [1]);
});

test('a fix in hand is kept when the watch fails after it, or patience runs out', async () => {
  phone([[[0, FAIR], [20, { code: 2 }]]]);
  assert.equal((await getBrowserLocation({ patienceMs: 5_000, settleMs: 1_000 })).accuracyMeters, 120);
  // The first fix arrives late: out of patience, it is still better than nothing.
  const asked = phone([[[30, FAIR]]]);
  assert.equal((await getBrowserLocation({ patienceMs: 80, settleMs: 5_000 })).accuracyMeters, 120);
  assert.deepEqual(asked.cleared, [1]);
});

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPHONE_IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('blocked permission says how to allow it, for this phone and browser', async () => {
  phone([{ code: 1 }]);
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'denied'
    && /Permissions → Location → Allow/.test(error.message) && /Settings → Apps → Chrome/.test(error.message));
  // Safari: its own website setting first - where "Don't Allow" is remembered - then the phone's.
  phone([{ code: 1 }], { userAgent: IPHONE_SAFARI });
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'denied' && error.steps.length === 3
    && /aA/.test(error.steps[0]) && /Website Settings → Location → Allow/.test(error.steps[0])
    && /Safari Websites → While Using the App/.test(error.steps[1]) && /Precise Location/.test(error.steps[1]));
  // Chrome on an iPhone has no site setting to change: the phone's Settings, for Chrome.
  phone([{ code: 1 }], { userAgent: IPHONE_CHROME });
  await assert.rejects(getBrowserLocation(), (error) => error.reason === 'denied'
    && /Location Services/.test(error.message) && /open Chrome → While Using the App/.test(error.message) && !/aA/.test(error.message));
});

test('refused at once means the phone never asked; refused later means the student said no', async () => {
  phone([{ code: 1 }], { userAgent: IPHONE_SAFARI });
  await assert.rejects(getBrowserLocation(), (error) => /did not ask for your location - it is switched off for Safari/.test(error.title));
  phone([[[850, { code: 1 }]]], { userAgent: IPHONE_SAFARI });
  await assert.rejects(getBrowserLocation(), (error) => error.title === 'Location was not allowed');
});

test('an iPhone app\'s built-in browser is recognised before anything is asked; a Home Screen app is not one', () => {
  phone([], { userAgent: IPHONE_IN_APP });
  assert.equal(knownProblem()?.reason, 'inapp');
  assert.equal(browserInfo().inApp, true);
  assert.ok(knownProblem().copyLink, 'offers the link to copy');
  phone([], { userAgent: IPHONE_IN_APP });
  globalThis.navigator.standalone = true;
  assert.equal(browserInfo().inApp, false);
  phone([], { userAgent: IPHONE_SAFARI });
  assert.equal(knownProblem(), null);
  assert.equal(browserInfo().app, 'Safari');
  phone([], { userAgent: IPHONE_CHROME });
  assert.equal(browserInfo().app, 'Chrome');
});

test('a vague reading (Precise Location off) is its own problem, with the setting to change', () => {
  phone([], { userAgent: IPHONE_SAFARI });
  assert.equal(imprecision({ accuracyMeters: 25 }), null);
  const vague = imprecision({ accuracyMeters: 1500 });
  assert.equal(vague.reason, 'imprecise');
  assert.match(vague.title, /±1500 m/);
  assert.match(vague.steps[0], /Safari Websites → turn on Precise Location/);
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
