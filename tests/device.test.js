import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDevice, describeBrowser, deviceFits, deviceRuleOf, deviceVerdict, readSignals, requestSignals, userAgentKind
} from '../src/domain/device.js';
import { buildTest } from '../src/domain/test-builder.js';

const UA = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  desktopSite: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

/** A page's report, as client/src/lib/device.js sends it. */
const page = (overrides) => readSignals({
  ua: '', platform: '', chPlatform: '', chMobile: null, pointer: 'fine', anyFine: true, hover: true,
  touchPoints: 0, screenW: 1536, screenH: 864, dpr: 1.25, ...overrides
});
const same = (signals) => ({ ua: signals.ua, mobile: signals.chMobile, platform: signals.chPlatform });

test('the browser\'s name alone', () => {
  assert.equal(userAgentKind(UA.iPhone), 'phone');
  assert.equal(userAgentKind(UA.android), 'phone');
  assert.equal(userAgentKind(UA.androidTablet), 'tablet', 'an Android without "Mobile" is a tablet');
  assert.equal(userAgentKind(UA.desktopSite), 'computer');
  assert.equal(userAgentKind(UA.windowsChrome), 'computer');
  assert.equal(userAgentKind(UA.chromebook), 'computer');
  assert.equal(userAgentKind(''), null);
  assert.equal(describeBrowser(UA.iPhone), 'iPhone · Safari');
  assert.equal(describeBrowser(UA.iPhoneChrome), 'iPhone · Chrome');
  assert.equal(describeBrowser(UA.samsung), 'Android · Samsung Internet');
  assert.equal(describeBrowser(UA.windowsEdge), 'Windows · Edge');
  assert.equal(describeBrowser(UA.windowsFirefox), 'Windows · Firefox');
  assert.equal(describeBrowser(UA.mac, 5), 'iPad · Safari', 'a Mac with a touch screen is an iPad');
  assert.equal(describeBrowser(UA.chromebook), 'Chromebook · Chrome');
});

test('phones and tablets: a finger, and the screen\'s short side', () => {
  const iPhone = page({ ua: UA.iPhone, platform: 'iPhone', pointer: 'coarse', anyFine: false, hover: false, touchPoints: 5, screenW: 390, screenH: 844, dpr: 3 });
  assert.deepEqual([classifyDevice(iPhone, same(iPhone)).kind, classifyDevice(iPhone, same(iPhone)).notes], ['phone', []]);
  const android = page({ ua: UA.android, platform: 'Linux armv8l', chPlatform: 'Android', chMobile: true, pointer: 'coarse', anyFine: false, touchPoints: 5, screenW: 412, screenH: 915 });
  assert.deepEqual([classifyDevice(android, same(android)).kind, classifyDevice(android, same(android)).notes], ['phone', []]);
  // Sideways: the short side is the same.
  const sideways = { ...android, screenW: 915, screenH: 412 };
  assert.equal(classifyDevice(sideways, same(sideways)).kind, 'phone');
  // An iPad calls itself a Mac: its touch screen and size make it a tablet, with nothing odd to report.
  const iPad = page({ ua: UA.mac, platform: 'MacIntel', pointer: 'coarse', anyFine: false, touchPoints: 5, screenW: 820, screenH: 1180, dpr: 2 });
  const iPadSeen = classifyDevice(iPad, same(iPad));
  assert.deepEqual([iPadSeen.kind, iPadSeen.label, iPadSeen.notes], ['tablet', 'iPad · Safari', []]);
  const tablet = page({ ua: UA.androidTablet, chPlatform: 'Android', chMobile: false, pointer: 'coarse', anyFine: false, touchPoints: 10, screenW: 800, screenH: 1280 });
  assert.equal(classifyDevice(tablet, same(tablet)).kind, 'tablet');
});

test('a phone asking for the desktop site is still a phone - noted, not suspicious', () => {
  const desktopMode = page({ ua: UA.desktopSite, platform: 'Linux armv8l', chPlatform: 'Android', chMobile: false, pointer: 'coarse', anyFine: false, touchPoints: 5, screenW: 412, screenH: 915 });
  const seen = classifyDevice(desktopMode, same(desktopMode));
  assert.equal(seen.kind, 'phone');
  assert.deepEqual(seen.notes, ['desktop_site']);
  assert.equal(seen.suspicious, false);
});

test('laptops: a mouse or trackpad decides, whatever the screen reports', () => {
  const laptop = page({ ua: UA.windowsChrome, platform: 'Win32', chPlatform: 'Windows', chMobile: false });
  assert.deepEqual([classifyDevice(laptop, same(laptop)).kind, classifyDevice(laptop, same(laptop)).notes], ['laptop', []]);
  // 1366×768 at 150% scaling reports 910×512 - a phone's size - and is a laptop.
  const scaled = { ...laptop, screenW: 910, screenH: 512, dpr: 1.5 };
  assert.equal(classifyDevice(scaled, same(scaled)).kind, 'laptop');
  // Firefox zoomed to 300% reports a third of the screen.
  const zoomed = page({ ua: UA.windowsFirefox, platform: 'Win32', screenW: 640, screenH: 360, dpr: 3 });
  assert.equal(classifyDevice(zoomed, same(zoomed)).kind, 'laptop');
  // A touch-screen laptop: its trackpad is the main pointer.
  const touchLaptop = { ...laptop, touchPoints: 10 };
  assert.equal(classifyDevice(touchLaptop, same(touchLaptop)).kind, 'laptop');
  const mac = page({ ua: UA.mac, platform: 'MacIntel', screenW: 1440, screenH: 900, dpr: 2 });
  assert.deepEqual([classifyDevice(mac, same(mac)).kind, classifyDevice(mac, same(mac)).label], ['laptop', 'Mac · Safari']);
});

test('pretending: a laptop dressed up as a phone is caught by what does not fit', () => {
  // Developer tools' iPhone mode: touch and size are faked, the system underneath is not.
  const devtools = page({ ua: UA.iPhone, platform: 'Win32', chPlatform: 'Windows', pointer: 'coarse', anyFine: false, touchPoints: 1, screenW: 390, screenH: 844 });
  const seen = classifyDevice(devtools, same(devtools));
  assert.equal(seen.kind, 'phone', 'it passes for a phone...');
  assert.ok(seen.notes.includes('system_mismatch') && seen.suspicious, '...and the teacher is told');
  // The same without touch: a "phone" driven by a mouse.
  const mouse = page({ ua: UA.iPhone, platform: 'iPhone', screenW: 390, screenH: 844 });
  const mouseSeen = classifyDevice(mouse, same(mouse));
  assert.deepEqual([mouseSeen.kind, mouseSeen.suspicious], ['laptop', true]);
  assert.ok(mouseSeen.notes.includes('mouse_on_phone'));
  // A user-agent switcher that changes what the page reads, but not what the server receives.
  const switcher = page({ ua: UA.android, platform: 'Win32', chPlatform: 'Windows', chMobile: false, pointer: 'coarse', touchPoints: 1, screenW: 412, screenH: 915 });
  const switched = classifyDevice(switcher, { ua: UA.windowsChrome, mobile: false, platform: 'Windows' });
  assert.ok(['two_identities', 'hint_mismatch', 'system_mismatch'].every((note) => switched.notes.includes(note)), switched.notes.join());
  // Chrome's own device hint disagreeing with the name, on its own.
  const hint = page({ ua: UA.android, platform: 'Linux armv8l', chPlatform: 'Android', chMobile: false, pointer: 'coarse', touchPoints: 5, screenW: 412, screenH: 915 });
  assert.deepEqual(classifyDevice(hint, same(hint)).notes, ['hint_mismatch']);
});

test('no report from the page: the browser\'s name decides, and says so', () => {
  assert.deepEqual([classifyDevice(null, { ua: UA.iPhone }).kind, classifyDevice(null, { ua: UA.iPhone }).notes], ['phone', ['page_silent']]);
  assert.equal(classifyDevice(null, { ua: UA.windowsChrome }).kind, 'laptop');
  assert.equal(classifyDevice(null, { ua: '' }).kind, 'unknown');
  // No pointer feature (an old browser): its name, then its touch screen.
  assert.equal(classifyDevice(page({ ua: UA.iPhone, pointer: null, touchPoints: 5, screenW: 375, screenH: 667 }), { ua: UA.iPhone }).kind, 'phone');
  assert.equal(classifyDevice(page({ ua: 'Something', pointer: null, touchPoints: 5, screenW: 375, screenH: 667 }), { ua: 'Something' }).kind, 'phone');
});

test('the rule: phones (and tablets), laptops, or any; an exception or the teacher\'s own preview always passes', () => {
  assert.equal(deviceRuleOf({}), 'any', 'tests made before the rule existed allow any device');
  assert.equal(deviceRuleOf({ devices: 'laptop' }), 'laptop');
  assert.equal(deviceRuleOf({ devices: 'watch' }), 'any');
  assert.deepEqual(['phone', 'tablet', 'laptop'].map((kind) => deviceFits('phone', kind)), [true, true, false]);
  assert.deepEqual(['phone', 'tablet', 'laptop'].map((kind) => deviceFits('laptop', kind)), [false, false, true]);
  assert.equal(deviceFits('laptop', 'unknown'), true, 'a device that cannot be identified is let through');
  const laptopsOnly = { devices: 'laptop' };
  assert.equal(deviceVerdict(laptopsOnly, {}, { kind: 'phone' }).allowed, false);
  assert.deepEqual(deviceVerdict(laptopsOnly, { deviceOverride: true }, { kind: 'phone' }), { rule: 'laptop', fits: false, override: true, allowed: true });
  assert.equal(deviceVerdict(laptopsOnly, {}, { kind: 'phone' }, { exempt: true }).allowed, true);
  assert.equal(deviceVerdict({}, {}, { kind: 'phone' }).allowed, true);
});

test('what the page sends is checked, never trusted beyond its type', () => {
  assert.equal(readSignals(null), null);
  assert.equal(readSignals([1, 2]), null);
  const junk = readSignals({ ua: 42, pointer: 'toe', chMobile: 'yes', touchPoints: -3, screenW: 1e9, screenH: '800', dpr: 'x' });
  assert.deepEqual(junk, {
    ua: '', platform: '', chPlatform: '', chMobile: null, pointer: null, anyFine: null, hover: null,
    touchPoints: null, screenW: 20_000, screenH: 800, dpr: null
  });
  assert.equal(readSignals({ ua: 'x'.repeat(5000) }).ua.length, 400);
  assert.deepEqual(requestSignals({ 'user-agent': UA.android, 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' }), { ua: UA.android, mobile: true, platform: 'Android' });
  assert.deepEqual(requestSignals({}), { ua: '', mobile: null, platform: '' });
});

test('the test setting: any device unless the admin chooses', () => {
  const base = { title: 'Devices', questions: [{ prompt: 'One?', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'] }], questionCount: 1 };
  assert.equal(buildTest(base).devices, 'any');
  assert.equal(buildTest({ ...base, devices: 'laptop' }).devices, 'laptop');
  assert.equal(buildTest({ ...base, devices: 'phone' }).devices, 'phone');
  assert.equal(buildTest({ ...base, devices: 'toaster' }).devices, 'any');
});
