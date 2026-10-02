/**
 * Which device a student is on - a phone, a tablet or a laptop (desktop
 * computers count as laptops) - for tests that allow only one kind, and for
 * the teacher to see on every test. No one signal can be trusted, so several
 * are read and weighed (the page gathers them: client/src/lib/device.js):
 *
 * - What the student points with, the browser's `pointer` media feature: a
 *   finger on a phone or tablet, a mouse or trackpad on a laptop - a
 *   touch-screen laptop included. This decides laptop or not. Display scaling
 *   and page zoom change the size a screen reports; they never change this.
 * - The screen's short side in CSS pixels, for a finger device: under 600 is a
 *   phone, 600 or more a tablet. The screen, not the window: a laptop's window
 *   can be narrowed to phone size, its screen cannot; a phone turned sideways
 *   keeps its short side.
 * - What the browser says it is: its user agent (as the page reads it and as
 *   it reached the server), Chrome's own "mobile" hint, and the system below.
 *   These decide only when the page sent nothing to weigh (an old page).
 *
 * Where they disagree - a browser calling itself an iPhone on a Windows
 * computer, or a "phone" driven by a mouse - the teacher is told, in words.
 * A determined student can still fake every signal (a laptop's developer
 * tools pretend to be a phone); the teacher's own look is the backstop.
 */

/** A test's rule: 'any' device, or 'phone' (phones and tablets), or 'laptop' (laptops and desktops). */
export const DEVICE_RULES = ['any', 'phone', 'laptop'];
export const deviceRuleOf = (test) => (DEVICE_RULES.includes(test?.devices) ? test.devices : 'any');

export const DEVICE_KINDS = ['phone', 'tablet', 'laptop'];
/** Where a report came from: before Begin, at Begin, or from the paper itself. */
export const DEVICE_STAGES = ['join', 'begin', 'paper'];

/** A finger device with a screen shorter than this (CSS pixels) is a phone. */
export const PHONE_SHORT_SIDE = 600;

const KIND_WORDS = { phone: 'phone', tablet: 'tablet', laptop: 'laptop', unknown: 'device we could not identify' };
export const kindWord = (kind) => KIND_WORDS[kind] || KIND_WORDS.unknown;

/** What the browser's name says it is: 'phone', 'tablet', 'computer', or null. */
export function userAgentKind(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  if (/iPad/i.test(ua)) return 'tablet';
  if (/iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini/i.test(ua)) return 'phone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'phone' : 'tablet';
  if (/Tablet|Silk\/|Kindle|PlayBook/i.test(ua)) return 'tablet';
  if (/Mobi/i.test(ua)) return 'phone';
  if (/Windows NT|Macintosh|Mac OS X|CrOS|X11|Linux/i.test(ua)) return 'computer';
  return null;
}

/** "iPhone · Safari", "Windows · Edge" - the system and browser, as far as the name tells. */
export function describeBrowser(userAgent, touchPoints = 0) {
  const ua = String(userAgent || '');
  const system = /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'Chromebook'
          : /Windows/.test(ua) ? 'Windows'
            : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
              : /Linux|X11/.test(ua) ? 'Linux' : null;
  const browser = /EdgA?\/|EdgiOS\//.test(ua) ? 'Edge'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
      : /OPR\/|OPiOS\/|Opera/.test(ua) ? 'Opera'
        : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
          : /CriOS\/|Chrome\/|Chromium\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : null;
  return [system, browser].filter(Boolean).join(' · ') || 'Unknown browser';
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const flag = (value) => (value === true || value === false ? value : null);
const whole = (value, max) => {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) && number >= 0 ? Math.min(max, Math.round(number)) : null;
};

/** The page's report, as sent: everything checked, nothing trusted beyond its type. */
export function readSignals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const dpr = Number(raw.dpr);
  return {
    ua: text(raw.ua, 400),
    platform: text(raw.platform, 40),
    chPlatform: text(raw.chPlatform, 40),
    chMobile: flag(raw.chMobile),
    pointer: ['fine', 'coarse', 'none'].includes(raw.pointer) ? raw.pointer : null,
    anyFine: flag(raw.anyFine),
    hover: flag(raw.hover),
    touchPoints: whole(raw.touchPoints, 64),
    screenW: whole(raw.screenW, 20_000),
    screenH: whole(raw.screenH, 20_000),
    dpr: Number.isFinite(dpr) && dpr > 0 ? Math.min(10, Math.round(dpr * 100) / 100) : null
  };
}

/** What reached the server with the request itself: the user agent and Chrome's client hints. */
export function requestSignals(headers = {}) {
  const read = (name) => {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    return typeof value === 'string' ? value : '';
  };
  const mobile = read('sec-ch-ua-mobile').trim();
  return {
    ua: read('user-agent').slice(0, 400),
    mobile: mobile === '?1' ? true : mobile === '?0' ? false : null,
    platform: read('sec-ch-ua-platform').replace(/"/g, '').trim().slice(0, 40)
  };
}

const COMPUTER_PLATFORM = /^(Win|MacIntel|Linux (x86_64|i686)|Windows|macOS|Chrome OS|Chromium OS|Linux$)/i;

/** Every disagreement the teacher is told about, in the teacher's words. */
export const DEVICE_NOTES = {
  // Strong: a browser pretending, or two answers that cannot both be true.
  system_mismatch: 'The browser says it is a phone or tablet, but the system underneath is a computer (Windows, Mac or Linux) - a sign of a laptop pretending to be a phone.',
  mouse_on_phone: 'The browser says it is a phone or tablet, but it is used with a mouse or trackpad.',
  hint_mismatch: 'The browser\'s name says phone, but Chrome\'s own device hint says it is not one.',
  two_identities: 'The page and the server saw two different browsers - something changed what this browser says it is.',
  // Soft: usual, but worth knowing.
  desktop_site: 'The browser asked for the desktop site (it says it is a computer), but it has a phone or tablet touch screen.',
  page_silent: 'The page did not report the device, so it was judged from the browser\'s name alone.'
};
const STRONG_NOTES = new Set(['system_mismatch', 'mouse_on_phone', 'hint_mismatch', 'two_identities']);

/**
 * The device, from the page's signals (`readSignals`) and the request's
 * (`requestSignals`). `kind` is 'phone', 'tablet', 'laptop' or 'unknown';
 * `notes` are DEVICE_NOTES keys; `suspicious` when any of them is a strong one.
 */
export function classifyDevice(signals, request = {}) {
  const page = signals || null;
  const ua = page?.ua || request.ua || '';
  const touchPoints = page?.touchPoints ?? 0;
  // An iPad asks for the desktop site by default and calls itself a Mac; its touch screen gives it away.
  const iPadAsMac = /Macintosh/.test(ua) && touchPoints > 1;
  const named = iPadAsMac ? 'tablet' : userAgentKind(ua);
  const short = page?.screenW && page?.screenH ? Math.min(page.screenW, page.screenH) : null;
  const notes = [];
  let kind;
  if (!page) {
    kind = named === 'computer' ? 'laptop' : named || 'unknown';
    notes.push('page_silent');
  } else if (page.pointer === 'fine') {
    kind = 'laptop';
  } else if (page.pointer === 'coarse') {
    kind = short ? (short < PHONE_SHORT_SIDE ? 'phone' : 'tablet') : named === 'tablet' ? 'tablet' : 'phone';
  } else if (named === 'computer') {
    kind = 'laptop';
  } else if (named) {
    kind = named;
  } else if (touchPoints > 1 && short) {
    kind = short < PHONE_SHORT_SIDE ? 'phone' : 'tablet';
  } else {
    kind = 'unknown';
  }

  if (page) {
    const saysMobile = named === 'phone' || named === 'tablet';
    if (saysMobile && !iPadAsMac && (COMPUTER_PLATFORM.test(page.platform) || COMPUTER_PLATFORM.test(page.chPlatform) || COMPUTER_PLATFORM.test(request.platform || ''))) {
      notes.push('system_mismatch');
    }
    if (saysMobile && kind === 'laptop') notes.push('mouse_on_phone');
    if (named === 'phone' && page.chMobile === false) notes.push('hint_mismatch');
    if ((request.ua && page.ua && request.ua !== page.ua)
      || (request.mobile !== null && request.mobile !== undefined && page.chMobile !== null && request.mobile !== page.chMobile)) {
      notes.push('two_identities');
    }
    if (named === 'computer' && (kind === 'phone' || kind === 'tablet')) notes.push('desktop_site');
  }
  return {
    kind,
    label: describeBrowser(ua, touchPoints),
    notes,
    suspicious: notes.some((note) => STRONG_NOTES.has(note)),
    facts: page ? {
      screen: short ? `${page.screenW}×${page.screenH}` : null,
      dpr: page.dpr,
      pointer: page.pointer,
      anyFine: page.anyFine,
      hover: page.hover,
      touchPoints: page.touchPoints,
      platform: page.platform || null,
      chPlatform: page.chPlatform || null,
      chMobile: page.chMobile
    } : null,
    userAgent: ua.slice(0, 300)
  };
}

/** Whether a kind of device may sit a test with this rule. One that could not be identified is let through. */
export function deviceFits(rule, kind) {
  if (rule === 'phone') return kind === 'phone' || kind === 'tablet' || kind === 'unknown';
  if (rule === 'laptop') return kind === 'laptop' || kind === 'unknown';
  return true;
}

/**
 * May this device sit the test? The teacher's own preview (`exempt`) and a
 * student they allowed this device (`deviceOverride`) always may.
 */
export function deviceVerdict(test, registration, device, { exempt = false } = {}) {
  const rule = deviceRuleOf(test);
  const fits = exempt || deviceFits(rule, device?.kind);
  const override = Boolean(registration?.deviceOverride);
  return { rule, fits, override, allowed: fits || override };
}

/** What a student is told when their device does not fit, in the server's refusal. */
export function deviceRefusal(rule, device) {
  const wanted = rule === 'phone' ? 'a phone or tablet' : 'a laptop or desktop computer';
  return `This test can only be taken on ${wanted}, and this looks like a ${kindWord(device?.kind)}. Open the test link on ${wanted}. If this is wrong, ask your teacher to allow this device.`;
}

/** One line of what the signals were, for the teacher. */
export function deviceFactLine(facts) {
  if (!facts) return '';
  const pointer = facts.pointer === 'fine' ? 'mouse or trackpad' : facts.pointer === 'coarse' ? `touch screen${facts.anyFine ? ' (a mouse too)' : ''}` : facts.pointer === 'none' ? 'no pointer' : null;
  return [
    facts.screen ? `screen ${facts.screen}${facts.dpr ? ` at ×${facts.dpr}` : ''}` : null,
    pointer,
    Number.isFinite(facts.touchPoints) ? `${facts.touchPoints} touch point${facts.touchPoints === 1 ? '' : 's'}` : null,
    facts.chMobile === true ? 'Chrome says mobile' : facts.chMobile === false ? 'Chrome says not mobile' : null,
    facts.platform || facts.chPlatform ? `system ${[facts.platform, facts.chPlatform].filter(Boolean).join(' / ')}` : null
  ].filter(Boolean).join(' · ');
}
