/**
 * The device's location, for the venue check - and, when it cannot be had,
 * why not, in steps the student can follow on their own phone.
 *
 * Ways it used to go wrong:
 *  - It could wait forever. The browser's own timeout only starts once
 *    permission is given, so a prompt nobody answered - or one the phone
 *    never showed - left the request hanging, and with it every check after.
 *  - Indoors a GPS fix may never come; the network's position is tried then.
 *  - "Permission was denied" was all a student was told, whatever the cause.
 *  - An iPhone never asks again once "Don't Allow" was tapped, or while
 *    location is off for Safari or Chrome: it refuses at once, with no
 *    question on screen. The way back is in Safari's own website settings as
 *    often as in the phone's Settings, so both are given, for the browser the
 *    student is actually using.
 *  - A link opened inside another app (Gmail, Outlook, Teams, Instagram, the
 *    Google app...) is shown by that app, which cannot share location at all.
 *    It is recognised before anything is asked, not after it fails.
 */

const HIGH_ACCURACY_MS = 12_000;
const NETWORK_MS = 8_000;
/** However the phone behaves, the answer comes within this. */
export const LOCATION_PATIENCE_MS = 20_000;
/** As the server: a reading vaguer than this cannot place anyone in a room. */
export const IMPRECISE_METERS = 200;
/** A refusal quicker than a person can answer means no question was shown. */
const ANSWERED_MS = 800;

const agent = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
const KNOWN_APPS = /; wv\)|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|LinkedInApp|TeamsMobile|MSTeams|Twitter|GSA\/|Outlook|KAKAOTALK|Pinterest|musical_ly|TikTok/i;

/** Which phone and browser this is - so the steps name the right buttons. */
export function browserInfo() {
  const ua = agent();
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  // Added to the Home Screen: a real browser, even without "Safari" in its name.
  const homeScreen = typeof navigator !== 'undefined' && (navigator.standalone === true
    || (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches));
  // On an iPhone every browser names Safari; a view inside another app does not.
  const inApp = KNOWN_APPS.test(ua) || (ios && !homeScreen && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua));
  const app = inApp ? 'inapp'
    : /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge'
      : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
        : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
          : /CriOS|Chrome\//.test(ua) ? 'Chrome'
            : ios ? 'Safari' : 'your browser';
  return { ios, android, inApp, app };
}
/** Opened inside another app: no location there. */
export const inAppBrowser = () => browserInfo().inApp;

/** What to do, step by step, on this phone and in this browser. */
function guidance(reason, { asked, accuracyMeters } = {}) {
  const { ios, android, app } = browserInfo();
  const browser = app === 'inapp' ? (ios ? 'Safari' : 'Chrome') : app;
  const reloadStep = 'Come back to this page, reload it, and try again. When your phone asks, choose Allow.';
  if (reason === 'inapp') {
    return {
      title: 'This page is open inside another app, which cannot share your location',
      steps: [
        ios ? 'Tap ⋯ or the share button (↗) in this app, then choose "Open in Safari".' : 'Tap ⋮ in this app, then choose "Open in Chrome" or "Open in browser".',
        `Or copy the link below and paste it into ${ios ? 'Safari' : 'Chrome'}.`,
        'Sign in there and carry on from the same page.'
      ],
      copyLink: true
    };
  }
  if (reason === 'denied') {
    // Refused faster than anyone could answer: nothing was asked on screen.
    const title = asked === false ? `Your phone did not ask for your location - it is switched off for ${browser}`
      : asked === true ? 'Location was not allowed' : 'Location is blocked for this page';
    if (ios && browser === 'Safari') {
      return { title, steps: [
        'In Safari, tap aA (or the page menu ☰) at the left of the address bar → Website Settings → Location → Allow.',
        'Still not asked? Open Settings → Privacy & Security → Location Services: turn it on, then Safari Websites → While Using the App, with Precise Location on.',
        reloadStep
      ] };
    }
    if (ios) {
      return { title, steps: [
        'Open Settings → Privacy & Security → Location Services and turn it on.',
        `In that same list, open ${browser} → While Using the App, with Precise Location on.`,
        reloadStep
      ] };
    }
    if (android) {
      return { title, steps: [
        `In ${browser}, tap the icon at the left of the address bar → Permissions → Location → Allow (or Reset permissions).`,
        `Never asked? Open Settings → Apps → ${browser} → Permissions → Location → Allow only while using the app, with Use precise location on.`,
        'Make sure Location is on in your quick settings (swipe down from the top), then reload this page and try again.'
      ] };
    }
    return { title, steps: ['Allow location for this site in your browser\'s settings (the icon at the left of the address bar).', reloadStep] };
  }
  if (reason === 'imprecise') {
    return {
      title: `Your phone shared only an approximate location (±${Math.round(accuracyMeters || 0)} m)`,
      steps: [
        ios
          ? `Open Settings → Privacy & Security → Location Services → ${browser === 'Safari' ? 'Safari Websites' : browser} → turn on Precise Location.`
          : `Open Settings → Apps → ${browser} → Permissions → Location → turn on Use precise location.`,
        android ? 'Also turn on Settings → Location → Location services → Google Location Accuracy.' : 'Stay near a window or out in the open for a moment.',
        'Then check again.'
      ]
    };
  }
  if (reason === 'unavailable' || reason === 'timeout') {
    return {
      title: reason === 'timeout' ? 'Finding your location took too long' : 'Your phone could not find its location',
      steps: [
        ios ? 'Open Settings → Privacy & Security → Location Services and make sure it is on.' : 'Turn on Location in your quick settings (swipe down from the top of the screen).',
        ios ? 'Precise Location should be on for your browser in that same list.' : 'In Settings → Location, turn on Google Location Accuracy (or Improve accuracy).',
        'Move near a window or out of the basement, then try again.'
      ]
    };
  }
  if (reason === 'insecure') return { title: 'Location only works on the secure link', steps: ['Open the test from its https:// address.'] };
  return { title: 'This browser cannot share your location', steps: [`Open the link in ${ios ? 'Safari' : 'Chrome'} instead.`] };
}

/**
 * An error whose `reason` says what went wrong, with `title` and `steps` to
 * put on screen - and a one-line `message` for anywhere only text fits.
 */
export class LocationProblem extends Error {
  constructor(reason, details = {}) {
    const help = guidance(reason, details);
    super(`${help.title}. ${help.steps.join(' ')}`);
    this.name = 'LocationProblem';
    this.reason = reason;
    this.title = help.title;
    this.steps = help.steps;
    this.copyLink = Boolean(help.copyLink);
  }
}

/** A problem to show before anything is asked, or null. */
export function knownProblem() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return new LocationProblem('insecure');
  if (browserInfo().inApp) return new LocationProblem('inapp');
  if (typeof navigator === 'undefined' || !navigator.geolocation) return new LocationProblem('unsupported');
  return null;
}

/** 'granted', 'denied', 'prompt', or 'unknown' where the browser will not say. */
export async function locationPermission() {
  try {
    const status = await navigator.permissions?.query?.({ name: 'geolocation' });
    return status?.state || 'unknown';
  } catch { return 'unknown'; }
}

function reasonFor(error) {
  if (error?.code === 1) return inAppBrowser() ? 'inapp' : 'denied';
  if (error?.code === 2) return 'unavailable';
  return 'timeout';
}

const asReading = (position) => ({
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
  accuracyMeters: position.coords.accuracy
});

const ask = (enableHighAccuracy, timeout) => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
  (position) => resolve(asReading(position)),
  reject,
  { enableHighAccuracy, timeout, maximumAge: 30_000 }
));

/** A fix this good is taken at once. */
const GOOD_ENOUGH_METERS = 50;
/** After the first fix, how long a better one is waited for. */
const SETTLE_MS = 5_000;

/**
 * The best fix the phone gives within a few seconds. A phone's first fix is
 * often rough - its last known position, or the network's guess, hundreds of
 * metres out - and a precise one follows a few seconds later. Taking the
 * first told students in the room they were outside, or only "approximate",
 * and each of those needed an exception. So the fixes are watched: a good one
 * is taken at once, otherwise the best to arrive within `settleMs` of the
 * first. `best()` is whatever is in hand; `stop()` ends the watch.
 */
function watchBestFix(settleMs) {
  let best = null;
  let watchId = null;
  let done = false;
  let settle = null;
  let noFix = null;
  let finish;
  const promise = new Promise((resolve, reject) => {
    finish = (settled, value) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      clearTimeout(noFix);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (settled === 'resolve') resolve(value); else reject(value);
    };
    // Nothing at all from the precise watch in this time: the caller tries the network's position.
    noFix = setTimeout(() => finish('reject', { code: 3 }), HIGH_ACCURACY_MS);
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const reading = asReading(position);
        if (!best || reading.accuracyMeters < best.accuracyMeters) best = reading;
        if (best.accuracyMeters <= GOOD_ENOUGH_METERS) finish('resolve', best);
        else if (!settle) settle = setTimeout(() => finish('resolve', best), settleMs);
      },
      // A fix in hand is kept whatever goes wrong after it.
      (error) => (best ? finish('resolve', best) : finish('reject', error)),
      { enableHighAccuracy: true, timeout: HIGH_ACCURACY_MS, maximumAge: 30_000 }
    );
    if (done) navigator.geolocation.clearWatch(watchId);
  });
  return { promise, best: () => best, stop: () => finish('reject', { code: 3 }) };
}

export function getBrowserLocation({ patienceMs = LOCATION_PATIENCE_MS, settleMs = SETTLE_MS } = {}) {
  const known = knownProblem();
  // Inside another app the request is still made: some apps do share it.
  if (known && known.reason !== 'inapp') return Promise.reject(known);
  const started = Date.now();
  const watch = watchBestFix(settleMs);
  let over = false;
  const reading = watch.promise.catch((error) => {
    // No GPS fix (indoors), or none at all: the network's position may do -
    // unless this check is already over and the watch was only being ended.
    if (!over && (error?.code === 2 || error?.code === 3)) return ask(false, NETWORK_MS);
    throw error;
  });
  reading.catch(() => {}); // answered below; never an unhandled rejection
  let timer;
  // Out of patience: the best fix so far if there is one, rather than nothing.
  const giveUp = new Promise((resolve, reject) => {
    timer = setTimeout(() => { const best = watch.best(); if (best) resolve(best); else reject({ code: 3 }); }, patienceMs);
  });
  return Promise.race([reading, giveUp])
    .catch((error) => { throw new LocationProblem(reasonFor(error), { asked: error?.code === 1 ? Date.now() - started >= ANSWERED_MS : undefined }); })
    .finally(() => { over = true; clearTimeout(timer); watch.stop(); });
}

/** A reading too vague to place the student in the room, as a problem to show. */
export const imprecision = (reading) => (reading && reading.accuracyMeters > IMPRECISE_METERS
  ? new LocationProblem('imprecise', { accuracyMeters: reading.accuracyMeters })
  : null);
