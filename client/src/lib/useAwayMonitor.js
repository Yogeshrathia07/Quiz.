import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Whether this browser will really open fullscreen. iPhone Safari and the
 * browsers built into apps (a link opened from WhatsApp or Instagram) may
 * have the function and still refuse every time; `fullscreenEnabled` says
 * so up front.
 */
export const fullscreenSupported = () => typeof document !== 'undefined'
  && Boolean(document.documentElement?.requestFullscreen) && document.fullscreenEnabled !== false;

export const inFullscreen = () => typeof document !== 'undefined' && Boolean(document.fullscreenElement);

export const requestTestFullscreen = () => document.documentElement
  .requestFullscreen({ navigationUI: 'hide' })
  .then(() => true, () => false);

/**
 * Split screen, a pop-up window, a half-width laptop window: the test is only
 * using part of the screen, so something else can sit beside it. Judged by
 * the window's size against the screen's, whichever way the device is held.
 * Skipped while a text field has focus - on some phones the on-screen keyboard
 * shrinks the window just like a split would.
 */
export function isSplitScreen() {
  if (typeof window === 'undefined' || !window.screen) return false;
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return false;
  const long = Math.max(window.screen.availWidth || 0, window.screen.availHeight || 0);
  const short = Math.min(window.screen.availWidth || 0, window.screen.availHeight || 0);
  if (!long || !short) return false;
  // The window's outer size is in the same units as the screen's whatever the
  // page zoom, so zooming in on a laptop is never mistaken for a split.
  const width = window.outerWidth || window.innerWidth;
  const height = window.outerHeight || window.innerHeight;
  const portrait = height >= width;
  const expectedWidth = portrait ? short : long;
  const expectedHeight = portrait ? long : short;
  return width < expectedWidth * 0.8 || height < expectedHeight * 0.65;
}

/**
 * Our own confirm dialogs ("Submit your test?") take focus from the page. That
 * is not the student leaving, so blur is ignored while one is open.
 */
let pausedDepth = 0;
export function withoutAwayCheck(run) {
  pausedDepth += 1;
  const resume = () => window.setTimeout(() => { pausedDepth -= 1; }, 400);
  let result;
  try { result = run(); } catch (error) { resume(); throw error; }
  // A browser prompt stays up until it is answered, not for a fixed moment.
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(resume);
  resume();
  return result;
}

/**
 * The student just pressed Begin on this page. The paper may open before the
 * browser has granted fullscreen (or a location prompt took it away); that
 * is not leaving the test, so it is asked for again without being counted.
 * Set only in memory: a reload forgets it, and a reload still counts.
 */
let beganAt = 0;
export const markBegan = () => { beganAt = Date.now(); };
// The paper was just unlocked. Wherever the student is at that moment - in
// another tab waiting for the teacher, out of fullscreen, on a reloaded page -
// is not a fresh departure: the absence that locked them was forgiven by the
// unlock. Only leaving again once back on the paper counts.
let resumedAt = 0;
export const markResumed = () => { resumedAt = Date.now(); };
const RESUME_GRACE_MS = 5_000;
const BEGIN_GRACE_MS = 30_000;
/**
 * The window losing focus for a blink is not the student leaving: a phone's
 * keyboard switching, the browser's own fullscreen notice, a permission
 * bubble. Only focus lost for longer than this counts - and then from the
 * moment it was lost, so the time away is all there.
 */
export const BLUR_GRACE_MS = 1_000;

/**
 * Notices when a student leaves the test, by any route a phone or a laptop
 * offers: leaving fullscreen, switching tab or app, locking the screen, the
 * window losing focus (split screen, a floating app, another window), or the
 * page being put away or reloaded.
 *
 * Away is one state, not one per source: pressing Home on Android fires both a
 * visibility change and a fullscreen exit, and that is one departure, not two.
 *
 * Where the browser has fullscreen, the student is only back once they are
 * back IN fullscreen. Pressing Home and returning drops a phone out of
 * fullscreen; before, the page counted that as "returned" and let the student
 * carry on outside it. Now the time until fullscreen is restored counts as
 * time away, and `away` stays true so the paper can be covered until then.
 *
 * `serverAway` says the server already holds an open departure for this
 * attempt (the page was closed or reloaded while away). The monitor then
 * starts away without reporting a second departure, and reports the return.
 */
export function useAwayMonitor({ enabled, enforceFullscreen, serverAway, onLeave, onReturn }) {
  const [away, setAway] = useState(false);
  const [awayReason, setAwayReason] = useState(null);
  const awaySince = useRef(null);
  const reason = useRef(null);
  const blurred = useRef(false);
  const leaveRef = useRef(onLeave);
  const returnRef = useRef(onReturn);
  const serverAwayRef = useRef(serverAway);

  leaveRef.current = onLeave;
  returnRef.current = onReturn;
  serverAwayRef.current = serverAway;
  // A departure the server never heard about has no return to report either.
  const silent = useRef(false);
  // "Look again now" for the gate's button - see the return below.
  const recheckRef = useRef(() => null);

  useEffect(() => {
    if (!enabled) return undefined;
    let splitTimer = null;
    let blurTimer = null;
    const mustBeFullscreen = enforceFullscreen && fullscreenSupported();
    const present = () => {
      // Phones do not always send `focus` on the way back from another app,
      // which left the paper covered even once back in fullscreen. Ask the
      // page directly instead of trusting the last blur for ever.
      if (blurred.current && document.hasFocus()) blurred.current = false;
      return !document.hidden && !blurred.current && !isSplitScreen() && (!mustBeFullscreen || inFullscreen());
    };

    const leave = (detail, { report = true, counted = true, since = Date.now() } = {}) => {
      if (awaySince.current) {
        if (!silent.current || !counted) return;
        // Really leaving while fullscreen was still being asked for: that one counts.
        awaySince.current = since;
        reason.current = detail;
        silent.current = false;
        setAwayReason(detail);
        if (report) leaveRef.current(detail);
        return;
      }
      awaySince.current = since;
      reason.current = detail;
      silent.current = !counted;
      setAway(true);
      setAwayReason(detail);
      if (report && counted) leaveRef.current(detail);
    };
    const settle = () => {
      if (!awaySince.current || !present()) return;
      const durationMs = Date.now() - awaySince.current;
      const detail = reason.current;
      const wasCounted = !silent.current;
      awaySince.current = null;
      reason.current = null;
      silent.current = false;
      setAway(false);
      setAwayReason(null);
      if (wasCounted) returnRef.current(durationMs, detail);
    };

    const onVisibility = () => (document.hidden ? leave('tab_switch') : settle());
    const onFullscreen = () => {
      if (!inFullscreen()) return mustBeFullscreen && leave('fullscreen');
      settle();
      // The window may not have its fullscreen size yet when the event fires
      // (slower on some phones).
      window.setTimeout(settle, 300);
      window.setTimeout(settle, 1_000);
      return undefined;
    };
    // The gate's button: the student says they are back, so take their word
    // for the focus and look again. Returns what still keeps them away, if
    // anything: 'hidden', 'split_screen', 'fullscreen' or 'focus'.
    recheckRef.current = () => {
      blurred.current = false;
      settle();
      if (!awaySince.current) return null;
      if (document.hidden) return 'hidden';
      if (isSplitScreen()) return 'split_screen';
      if (mustBeFullscreen && !inFullscreen()) return 'fullscreen';
      return 'focus';
    };
    // A tap on the page is the page having focus, whatever events were missed.
    const onTap = () => {
      if (!awaySince.current || document.hidden) return;
      blurred.current = false;
      settle();
    };
    const onBlur = () => {
      if (pausedDepth > 0 || document.hidden) return;
      blurred.current = true;
      const since = Date.now();
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        // Back already (some phones skip the focus event): nothing happened -
        // and if that blink held up a return (fullscreen coming back, say),
        // the return is settled now rather than left waiting for a tap.
        if (!blurred.current || document.hasFocus()) { blurred.current = false; settle(); return; }
        leave('focus_lost', { since });
      }, BLUR_GRACE_MS);
    };
    const onFocus = () => { window.clearTimeout(blurTimer); blurred.current = false; settle(); };
    // Safari on iOS often skips visibilitychange when the app is swiped away.
    const onPageHide = () => leave('tab_switch');
    // Entering or leaving split screen changes the window's size - but so,
    // for a moment, do the phone keyboard closing, turning the phone and
    // going fullscreen. Only a size that holds is judged a split.
    const onResize = () => {
      window.clearTimeout(splitTimer);
      if (!isSplitScreen()) { settle(); return; }
      splitTimer = window.setTimeout(() => {
        if (isSplitScreen()) leave('split_screen');
        else settle();
      }, 800);
    };

    // Opening the paper already away: the server knows about that departure
    // if it happened on a previous page load; otherwise this load IS one
    // (a reload, or a tab reopened, lands outside fullscreen).
    const justResumed = Date.now() - resumedAt < RESUME_GRACE_MS;
    if (awaySince.current) {
      // Still away from before the lock: the unlock forgave that absence,
      // so coming back from it reports nothing.
      if (justResumed) silent.current = true;
      // Still away from before the rules changed (fullscreen was given up on
      // as unavailable): come back if the new rules say we are present.
      settle();
    } else if (!present()) {
      if (justResumed) leave(mustBeFullscreen && !inFullscreen() ? 'not_fullscreen' : 'tab_switch', { counted: false });
      else if (serverAwayRef.current) leave('reload', { report: false });
      // Just pressed Begin: fullscreen was slow or refused, not left.
      else if (Date.now() - beganAt < BEGIN_GRACE_MS && !document.hidden && !isSplitScreen()) leave('begin', { counted: false });
      else if (isSplitScreen()) leave('split_screen');
      else leave(mustBeFullscreen && !inFullscreen() ? 'not_fullscreen' : 'tab_switch');
    } else if (serverAwayRef.current) {
      awaySince.current = Date.now();
      reason.current = 'reload';
      settle();
    }

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onTap, true);
    // A text field losing focus is when a keyboard-shrunk window is judged again.
    document.addEventListener('focusout', onResize);

    return () => {
      window.clearTimeout(splitTimer);
      window.clearTimeout(blurTimer);
      recheckRef.current = () => null;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onTap, true);
      document.removeEventListener('focusout', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [enabled, enforceFullscreen]);

  const recheck = useCallback(() => recheckRef.current(), []);
  return { away, awayReason, recheck };
}

/**
 * Copying the question out, pasting an answer in, or long-pressing for the
 * menu. Blocked on the paper and noted for the report; never a lock.
 */
/**
 * A web page cannot stop a screenshot - the operating system takes it - so
 * this does what a page can: notice the usual keys (Print Screen, Win+Shift+S,
 * Cmd+Shift+3/4/5), report them, wipe what Print Screen put on the clipboard,
 * and hide the paper for a moment. Printing is refused outright. On phones the
 * screenshot buttons never reach the page at all, so nothing can stop them.
 */
const isScreenshotKey = (event) => event.key === 'PrintScreen'
  || (event.shiftKey && (event.metaKey || event.getModifierState?.('OS')) && ['s', 'S', '3', '4', '5'].includes(event.key));
const isPrintKey = (event) => (event.ctrlKey || event.metaKey) && ['p', 'P'].includes(event.key);

export function useClipboardGuard({ enabled, onFlag, onScreenshot }) {
  const flagRef = useRef(onFlag);
  const shotRef = useRef(onScreenshot);
  const lastSent = useRef({});
  flagRef.current = onFlag;
  shotRef.current = onScreenshot;

  useEffect(() => {
    if (!enabled) return undefined;
    const flag = (kind) => (event) => {
      event.preventDefault();
      // One report per kind every few seconds; a held key must not flood the server.
      const at = Date.now();
      if (at - (lastSent.current[kind] || 0) < 5_000) return;
      lastSent.current[kind] = at;
      flagRef.current(kind);
    };
    const screenshot = (event) => {
      if (!isScreenshotKey(event)) return;
      shotRef.current?.('capture');
      // Print Screen on Windows copies the screen: overwrite it where allowed.
      navigator.clipboard?.writeText?.('').catch(() => {});
      flag('screenshot')(event);
    };
    // Every PC and Mac screenshot shortcut starts with the Windows / Cmd key,
    // so the paper is hidden the moment it goes down - before the shortcut is
    // complete - and stays hidden briefly after it comes back up.
    let holding = false;
    const metaDown = (event) => { if (event.key === 'Meta' || event.key === 'OS') { holding = true; shotRef.current?.('hold'); } };
    const release = () => { if (holding) { holding = false; shotRef.current?.('release'); } };
    const metaUp = (event) => { if (event.key === 'Meta' || event.key === 'OS') release(); };
    // The Windows key alone opens the Start menu, and its key-up never reaches
    // the page - coming back to the window lifts the shield instead.
    const regainFocus = () => release();
    const print = (event) => { if (isPrintKey(event)) flag('print')(event); };
    const beforePrint = () => flagRef.current('print');
    const handlers = { copy: flag('copy'), cut: flag('cut'), paste: flag('paste'), drop: flag('drop'), contextmenu: flag('context_menu') };
    Object.entries(handlers).forEach(([name, handler]) => document.addEventListener(name, handler));
    // Print Screen arrives as keyup only in some browsers, so listen to both.
    document.addEventListener('keydown', screenshot, true);
    document.addEventListener('keyup', screenshot, true);
    document.addEventListener('keydown', print, true);
    document.addEventListener('keydown', metaDown, true);
    document.addEventListener('keyup', metaUp, true);
    window.addEventListener('focus', regainFocus);
    window.addEventListener('beforeprint', beforePrint);
    return () => {
      window.removeEventListener('focus', regainFocus);
      document.removeEventListener('keydown', metaDown, true);
      document.removeEventListener('keyup', metaUp, true);
      Object.entries(handlers).forEach(([name, handler]) => document.removeEventListener(name, handler));
      document.removeEventListener('keydown', screenshot, true);
      document.removeEventListener('keyup', screenshot, true);
      document.removeEventListener('keydown', print, true);
      window.removeEventListener('beforeprint', beforePrint);
    };
  }, [enabled]);
}

/**
 * During a test the paper is used with the mouse (or finger) and scrolling
 * only. Every key is swallowed, except plain typing inside a short-answer box
 * - and even there no shortcut (Ctrl, Alt, Cmd, function keys) gets through.
 * Middle-click, dragging and Ctrl+wheel zoom are refused as well.
 *
 * A page cannot stop keys the operating system keeps for itself (the Windows
 * key, Alt+Tab, Ctrl+Alt+Del) or browser shortcuts like Ctrl+W - except in
 * fullscreen on Chrome and Edge, where the Keyboard Lock API hands them to the
 * page. Leaving fullscreen then means holding Esc, which counts as leaving.
 */
const TYPING_KEYS = new Set(['Backspace', 'Delete', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Shift', 'CapsLock']);
export const isDevToolsKey = (event) => event.key === 'F12'
  || ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(event.key))
  || ((event.ctrlKey || event.metaKey) && event.altKey && ['i', 'I', 'j', 'J'].includes(event.key))
  || ((event.ctrlKey || event.metaKey) && ['u', 'U'].includes(event.key));

// A phone keyboard (Gboard, Samsung) reports every key as "Unidentified",
// key code 229, and a desktop IME as "Process" while it composes a word.
// Blocking those does not stop the typing - on Android it makes Chrome drop
// the word being composed, which wiped a student's answer when they tapped
// back into it with the keyboard reopened. They are typing, so they pass.
const isComposingKey = (event) => event.isComposing || event.keyCode === 229 || event.key === 'Unidentified' || event.key === 'Process';

export function typingAllowed(event) {
  const target = event.target;
  const editable = target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text')) && !target.readOnly;
  if (!editable || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 || TYPING_KEYS.has(event.key) || isComposingKey(event);
}

export function useKeyboardLockdown({ enabled, onFlag }) {
  const flagRef = useRef(onFlag);
  const lastFlag = useRef(0);
  flagRef.current = onFlag;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event) => {
      if (typingAllowed(event)) return;
      event.preventDefault();
      if (event.type === 'keydown' && isDevToolsKey(event) && Date.now() - lastFlag.current > 5_000) {
        lastFlag.current = Date.now();
        flagRef.current('devtools');
      }
    };
    const refuse = (event) => {
      const target = event.target;
      if (event.type === 'selectstart' && target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      event.preventDefault();
    };
    const onMouseDown = (event) => { if (event.button === 1) event.preventDefault(); };
    const onWheel = (event) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    // Keyboard Lock only works in fullscreen, so (re)take it whenever the page enters it.
    const lockKeys = () => {
      if (document.fullscreenElement) navigator.keyboard?.lock?.().catch(() => {});
      else navigator.keyboard?.unlock?.();
    };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('keypress', onKey, true);
    document.addEventListener('auxclick', refuse, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('dragstart', refuse, true);
    document.addEventListener('selectstart', refuse, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('fullscreenchange', lockKeys);
    lockKeys();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('keypress', onKey, true);
      document.removeEventListener('auxclick', refuse, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('dragstart', refuse, true);
      document.removeEventListener('selectstart', refuse, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('fullscreenchange', lockKeys);
      navigator.keyboard?.unlock?.();
    };
  }, [enabled]);
}
