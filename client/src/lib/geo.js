/**
 * The device's location, for the venue check - and, when it cannot be had,
 * why not, in steps the student can follow on their own phone.
 *
 * Three ways it used to go wrong:
 *  - It could wait forever. The browser's own timeout only starts once
 *    permission is given, so a prompt nobody answered - or one the phone
 *    never showed - left the request hanging, and with it every check after.
 *  - Indoors a GPS fix may never come; the network's position is tried then.
 *  - "Permission was denied" was all a student was told, whatever the cause:
 *    the site blocked earlier, location off for the whole browser app, the
 *    link opened inside another app (which cannot share location at all).
 */

const HIGH_ACCURACY_MS = 12_000;
const NETWORK_MS = 8_000;
/** However the phone behaves, the answer comes within this. */
export const LOCATION_PATIENCE_MS = 20_000;

const agent = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
const isIos = () => /iPhone|iPad|iPod/i.test(agent()) || (/Macintosh/i.test(agent()) && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/i.test(agent());
/** Opened inside another app (Instagram, Facebook, Teams, an Android web view…): no location there. */
export const inAppBrowser = () => /; wv\)|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|LinkedInApp|TeamsMobile|MSTeams|Twitter/i.test(agent());

function allowSteps() {
  if (isIos()) {
    return 'On an iPhone: Settings → Privacy & Security → Location Services → turn it on, then open Safari Websites (or Chrome) → While Using the App, with Precise Location on. Come back and reload this page.';
  }
  if (isAndroid()) {
    return 'On Android: tap the icon at the left of the address bar → Permissions → Location → Allow. If you were never asked, also open phone Settings → Apps → Chrome → Permissions → Location → Allow, with "Use precise location" on. Then try again.';
  }
  return 'Allow location for this site in your browser settings, then try again.';
}

const MESSAGES = {
  denied: () => `Location is blocked for this page. ${allowSteps()}`,
  inapp: () => 'This page is open inside another app, which cannot share your location. Open it in Chrome or Safari: tap ⋮ or the share icon → "Open in browser", then sign in there.',
  unavailable: () => `Your phone could not find its location. Turn on Location in your phone's quick settings, then try again. ${isAndroid() ? 'Make sure "Use precise location" is on.' : ''}`.trim(),
  timeout: () => 'Finding your location took too long. Turn on Location (and Precise Location), move near a window or outside the corridor, then try again.',
  insecure: () => 'Location only works on the secure link. Open the test from its https:// address.',
  unsupported: () => 'This browser cannot share your location. Open the link in Chrome or Safari.'
};

/** An error whose `reason` says what went wrong and whose message says what to do. */
export class LocationProblem extends Error {
  constructor(reason) {
    super(MESSAGES[reason]());
    this.name = 'LocationProblem';
    this.reason = reason;
  }
}

function reasonFor(error) {
  if (error?.code === 1) return inAppBrowser() ? 'inapp' : 'denied';
  if (error?.code === 2) return 'unavailable';
  return 'timeout';
}

const ask = (enableHighAccuracy, timeout) => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
  (position) => resolve({
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: position.coords.accuracy
  }),
  reject,
  { enableHighAccuracy, timeout, maximumAge: 30_000 }
));

export function getBrowserLocation({ patienceMs = LOCATION_PATIENCE_MS } = {}) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return Promise.reject(new LocationProblem('insecure'));
  if (!navigator.geolocation) return Promise.reject(new LocationProblem(inAppBrowser() ? 'inapp' : 'unsupported'));
  const reading = ask(true, HIGH_ACCURACY_MS).catch((error) => {
    // No GPS fix (indoors), or none at all: the network's position may do.
    if (error?.code === 2 || error?.code === 3) return ask(false, NETWORK_MS);
    throw error;
  });
  let timer;
  const giveUp = new Promise((resolve, reject) => { timer = setTimeout(() => reject({ code: 3 }), patienceMs); });
  return Promise.race([reading, giveUp])
    .catch((error) => { throw new LocationProblem(reasonFor(error)); })
    .finally(() => clearTimeout(timer));
}
