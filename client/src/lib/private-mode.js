import { detectIncognito } from 'detectincognitojs';
import { phoneWithoutExtensions } from './browser-kind.js';

/**
 * What kind of window this is, for tests that must be taken in a private
 * (Incognito) window - where browser extensions are off. Browsers do not say
 * so on purpose; the detectincognitojs library (MIT) holds the current tricks:
 *
 * - Chrome, Edge, Brave, Opera, Samsung Internet - computer or phone: private
 *   storage lives in memory, so a write that must reach the disk costs no more
 *   than one that need not. In a normal window it costs clearly more. This
 *   replaced the old storage-quota check, which read many normal Android
 *   windows as private (their quota follows free space, not the window).
 * - Safari, on a Mac, iPhone or iPad: private windows refuse the origin private
 *   file system.
 * - Firefox: private windows refuse it too.
 *
 * Phone browsers that cannot run extensions at all (Chrome on Android and on
 * iPhone, Samsung Internet...) are not checked: there is nothing for a private
 * window to switch off, and on phones the timing check can guess wrong. Those
 * that can (Safari on iPhone, Firefox, Edge and Kiwi on Android) are checked.
 *
 * Resolves to one of:
 *   'private'  detected as a private window
 *   'normal'   detected as a normal window - the only answer that blocks
 *   'mobile'   a phone browser with no extensions, or one the check could
 *              not judge; let through
 *   'unknown'  a computer the check could not judge; let through
 */
const CHECK_TIMEOUT_MS = 5_000;
const CHROMIUM = ['Chrome', 'Edge', 'Brave', 'Opera', 'Chromium'];

export const detectWindowKind = async () => (await detectWindowDetails()).kind;

/**
 * The same check with what it saw, for the check page (?page=window-check):
 * the kind, why (for 'mobile': 'no_extensions' or 'undecided'), the browser
 * the library recognised (or null), whether this is a phone, and how long the
 * check took.
 */
export async function detectWindowDetails() {
  const nav = navigator;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const mobile = nav.userAgentData?.mobile === true
    || /android|iphone|ipad|ipod|mobile/i.test(nav.userAgent)
    || (/macintosh/i.test(nav.userAgent) && nav.maxTouchPoints > 1);
  const undecided = mobile ? 'mobile' : 'unknown';
  const started = performance.now();
  const seen = (kind, browserName = null, reason = kind === 'mobile' ? 'undecided' : null) => ({ kind, reason, browserName, mobile, ms: Math.round(performance.now() - started) });
  const brands = (nav.userAgentData?.brands || []).map((entry) => entry.brand);
  if (mobile && phoneWithoutExtensions(nav.userAgent, brands)) return seen('mobile', null, 'no_extensions');
  try {
    const timeout = new Promise((resolve) => { window.setTimeout(() => resolve(null), CHECK_TIMEOUT_MS); });
    const result = await Promise.race([detectIncognito(), timeout]);
    if (!result) return seen(undecided);
    if (result.isPrivate) return seen('private', result.browserName);
    // "Not private" is only an answer where the test could actually run: the
    // Chromium test needs IndexedDB's durability hint, and abstains without it.
    if (CHROMIUM.includes(result.browserName) && !('durability' in (window.IDBTransaction?.prototype || {}))) return seen(undecided, result.browserName);
    if (!['Safari', 'Firefox', ...CHROMIUM].includes(result.browserName)) return seen(undecided, result.browserName);
    return seen('normal', result.browserName);
  } catch {
    return seen(undecided);
  }
}
