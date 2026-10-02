import { useEffect, useState } from 'react';
import { post } from './api.js';

/**
 * What this browser can say about the device it runs on, for tests that
 * allow only phones or only laptops. The server weighs it (src/domain/device.js)
 * and decides: this file only reads.
 *
 * - `pointer`: what the student mainly points with - 'fine' (mouse or
 *   trackpad), 'coarse' (a finger), 'none' - from the `pointer` media feature.
 * - The screen's size in CSS pixels (not the window's, which can be resized).
 * - The browser's own words: its user agent, Chrome's device hints, the system.
 */
const matches = (query) => {
  try { return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : null; } catch { return null; }
};

export function readDeviceSignals() {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null;
  const hints = navigator.userAgentData;
  const pointer = matches('(pointer: fine)') ? 'fine' : matches('(pointer: coarse)') ? 'coarse' : matches('(pointer: none)') ? 'none' : null;
  return {
    ua: navigator.userAgent || '',
    platform: navigator.platform || '',
    chPlatform: hints?.platform || '',
    chMobile: typeof hints?.mobile === 'boolean' ? hints.mobile : null,
    pointer,
    anyFine: matches('(any-pointer: fine)'),
    hover: matches('(hover: hover)'),
    touchPoints: Number(navigator.maxTouchPoints) || 0,
    screenW: Math.round(window.screen?.width || 0) || null,
    screenH: Math.round(window.screen?.height || 0) || null,
    dpr: window.devicePixelRatio || null
  };
}

/**
 * May this device sit the test? `stage` is 'join' (before Begin) or 'paper'.
 * Resolves to the server's { rule, allowed, fits, override, device }.
 */
export const checkTestDevice = (code, stage) => post(`/api/tests/${encodeURIComponent(code)}/device`, { stage, device: readDeviceSignals() });

/** What the check page shows: the verdict, every signal, every disagreement. */
export const checkThisDevice = () => post('/api/device-check', { device: readDeviceSignals() });

/**
 * The server's answer for this page, asked again whenever `refreshKey`
 * changes. null while asking; { failed: true } when it could not be asked
 * (offline) - then the page lets the student on, and Begin decides.
 */
export function useDeviceCheck(code, { stage = 'join', enabled = true, refreshKey = '' } = {}) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    checkTestDevice(code, stage)
      .then((result) => { if (live) setCheck(result); })
      .catch(() => { if (live) setCheck((current) => current ?? { failed: true }); });
    return () => { live = false; };
  }, [code, stage, enabled, refreshKey]);
  return enabled ? check : null;
}

/** Whether a check turns this device away: only a clear "no" does. */
export const deviceRefused = (check) => Boolean(check && !check.failed && check.allowed === false);

export const DEVICE_WORDS = { phone: 'phone', tablet: 'tablet', laptop: 'laptop', unknown: 'device we could not identify' };
export const RULE_WANTS = { phone: 'a phone or tablet', laptop: 'a laptop or desktop computer' };
