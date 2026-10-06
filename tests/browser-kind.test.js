import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneWithoutExtensions } from '../client/src/lib/browser-kind.js';
import { FLAG_REASONS, integrityCells, integrityHeaders, integritySummary, keptEvents } from '../src/domain/integrity.js';

const android = (browser) => `Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}`;
const iphone = (browser) => `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;

test('phone browsers with no extensions skip the private-window check', () => {
  assert.equal(phoneWithoutExtensions(android('Chrome/128.0.0.0 Mobile Safari/537.36'), ['Chromium', 'Google Chrome', 'Not;A=Brand']), true, 'Chrome for Android');
  assert.equal(phoneWithoutExtensions(android('SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'), []), true, 'Samsung Internet');
  assert.equal(phoneWithoutExtensions(android('Chrome/128.0.0.0 Mobile Safari/537.36 OPR/84.0.0'), []), true, 'Opera for Android');
  assert.equal(phoneWithoutExtensions(android('Chrome/128.0.0.0 Mobile Safari/537.36'), ['Chromium', 'Brave']), true, 'Brave for Android');
  assert.equal(phoneWithoutExtensions(iphone('CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1')), true, 'Chrome on iPhone');
  assert.equal(phoneWithoutExtensions(iphone('FxiOS/129.0 Mobile/15E148 Safari/605.1.15')), true, 'Firefox on iPhone');
});

test('browsers that can run extensions are still checked', () => {
  assert.equal(phoneWithoutExtensions(iphone('Version/17.5 Mobile/15E148 Safari/604.1')), false, 'Safari on iPhone');
  assert.equal(phoneWithoutExtensions(android('Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.0.0'), ['Chromium', 'Microsoft Edge']), false, 'Edge for Android');
  assert.equal(phoneWithoutExtensions('Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0', []), false, 'Firefox for Android');
  assert.equal(phoneWithoutExtensions(android('Chrome/128.0.0.0 Mobile Safari/537.36'), ['Chromium', 'Not;A=Brand']), false, 'an unbranded Chromium (Kiwi and the like)');
  assert.equal(phoneWithoutExtensions('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', ['Google Chrome']), false, 'Chrome on a laptop');
});

test('the checks that were guesses (an extension seen, text all at once) count nowhere, even on old papers', () => {
  assert.equal(FLAG_REASONS.extension, undefined);
  assert.equal(FLAG_REASONS.text_burst, undefined);
  const summary = integritySummary({ integrity: { leaveCount: 0, flags: { extension: 2, text_burst: 3, copy: 1 } } });
  assert.deepEqual([summary.flags.extension, summary.flags.text_burst, summary.flagCount], [undefined, undefined, 1]);
  assert.equal(integrityHeaders.length, integrityCells(summary).length);
  assert.ok(!integrityHeaders.some((header) => /extension|all at once/i.test(header)), 'no column for them in the report');
  const events = [
    { type: 'integrity_flag', detail: 'extension', note: 'div' },
    { type: 'integrity_flag', detail: 'text_burst', questionId: 1, chars: 40 },
    { type: 'integrity_flag', detail: 'copy' },
    { type: 'fullscreen_exit', detail: 'tab_switch' }
  ];
  assert.deepEqual(keptEvents(events).map((event) => event.detail), ['copy', 'tab_switch'], 'left out of the log');
  assert.deepEqual(keptEvents(undefined), []);
});
