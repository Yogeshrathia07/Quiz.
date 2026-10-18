import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';

/** How long typing settles before the draft is sent. */
const SAVE_DELAY_MS = 1_500;
/** A page being closed sends what is left with keepalive, which browsers cap near 64 KB. */
const KEEPALIVE_CHARS = 60_000;
/** What is sent when nothing is worth keeping any more: the kept draft goes too. */
const CLEARED = '';

const sendDraft = (json, options = {}) => (json === CLEARED
  ? api('/api/admin/draft', { method: 'DELETE', ...options })
  : api('/api/admin/draft', { method: 'PUT', body: `{"draft":${json}}`, ...options }));

/**
 * The Create page's draft, kept on the server for its teacher
 * (src/services/draft-service.js), never on the device: it holds answer keys.
 * Fetched once as the page opens - `onRestore` gets it - then sent a moment
 * after each change while `snapshot` has something worth keeping (null:
 * nothing - everything typed was cleared - and then the kept draft is thrown
 * away). Whatever is still waiting goes as the page is left.
 *
 * `status`: 'off' (editing a test), 'loading', 'idle', 'saving', 'saved',
 * 'error' (not reached) or 'too-big' (over MAX_DRAFT_BYTES on the server). `pause()` sends what is waiting, waits for it and stops sending -
 * Create (the server throws the draft away once the test exists); `resume()`
 * starts again if creating failed. `discard()` starts the page afresh.
 */
export function useCreatorDraft({ enabled, snapshot, onRestore }) {
  const [state, setState] = useState(() => ({ status: enabled ? 'loading' : 'off', savedAt: null, restoredAt: null }));
  const restore = useRef(onRestore);
  restore.current = onRestore;
  // What the server holds now (CLEARED: nothing), and what is still to go (null: nothing).
  const lastSent = useRef(CLEARED);
  const waiting = useRef(null);
  const timer = useRef(null);
  const inFlight = useRef(Promise.resolve());
  const paused = useRef(!enabled);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    api('/api/admin/draft').then((reply) => {
      if (cancelled) return;
      const draft = reply?.draft && typeof reply.draft === 'object' ? reply.draft : null;
      if (draft) {
        restore.current(draft);
        lastSent.current = JSON.stringify(draft);
      }
      setState({ status: draft ? 'saved' : 'idle', savedAt: draft ? reply.savedAt : null, restoredAt: draft ? reply.savedAt : null });
    }, () => {
      // Not reachable now: the page still works, and the next change is kept.
      if (!cancelled) setState({ status: 'idle', savedAt: null, restoredAt: null });
    });
    return () => { cancelled = true; };
  }, [enabled]);

  const send = useCallback((json) => {
    waiting.current = null;
    const before = lastSent.current;
    lastSent.current = json;
    setState((current) => ({ ...current, status: 'saving' }));
    // One at a time, in order: a slow save never lands after a newer one.
    const job = inFlight.current.then(() => sendDraft(json)).then(
      (reply) => setState((current) => (json === CLEARED
        ? { ...current, status: 'idle', savedAt: null }
        : { ...current, status: 'saved', savedAt: reply?.savedAt || current.savedAt })),
      (error) => {
        // Not kept: the next change sends it again (and a clear that failed, the clear).
        lastSent.current = json === CLEARED ? before : null;
        setState((current) => ({ ...current, status: error?.status === 413 ? 'too-big' : 'error' }));
      }
    );
    inFlight.current = job;
    return job;
  }, []);

  const json = snapshot ? JSON.stringify(snapshot) : CLEARED;
  useEffect(() => {
    if (paused.current || state.status === 'loading') return undefined;
    // Back to what the server holds (Clear, or a change undone): nothing is waiting any more.
    if (json === lastSent.current) {
      waiting.current = null;
      return undefined;
    }
    waiting.current = json;
    const pending = window.setTimeout(() => send(json), SAVE_DELAY_MS);
    timer.current = pending;
    return () => window.clearTimeout(pending);
  }, [json, state.status, send]);

  // Leaving the page - another screen, or closing the tab - sends what is still waiting.
  useEffect(() => {
    const flush = () => {
      const left = waiting.current;
      if (left === null || paused.current) return;
      waiting.current = null;
      window.clearTimeout(timer.current);
      lastSent.current = left;
      sendDraft(left, { keepalive: left.length < KEEPALIVE_CHARS, timeoutMs: 0 }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // Before Create: what is waiting goes now, so a test that cannot be created yet loses nothing.
  const pause = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (waiting.current !== null && !paused.current) send(waiting.current);
    paused.current = true;
    await inFlight.current;
  }, [send]);
  const resume = useCallback(() => { if (enabled) paused.current = false; }, [enabled]);
  const discard = useCallback(async () => {
    window.clearTimeout(timer.current);
    waiting.current = null;
    await inFlight.current;
    lastSent.current = CLEARED;
    await api('/api/admin/draft', { method: 'DELETE' }).catch(() => {});
    setState({ status: 'idle', savedAt: null, restoredAt: null });
  }, []);

  return { ...state, pause, resume, discard };
}
