import { useEffect, useRef, useState } from 'react';

/** The hook batches a burst, so preserve every signal rather than losing an
 * important admin action behind a student's ordinary answer acknowledgement. */
export const liveEventsFromPayload = (payload) => (
  Array.isArray(payload?.events) ? payload.events : (payload ? [payload] : [])
);

const eventPayload = (event) => {
  try {
    const parsed = JSON.parse(event?.data || '{}');
    return parsed && typeof parsed === 'object' ? parsed : { kind: 'stream_update' };
  } catch {
    // A malformed signal must never leave a locked/closed paper stale. Its
    // contents are not trusted, but it is still safe to ask the API for truth.
    return { kind: 'stream_update' };
  }
};

/**
 * A stream the server turned away (its stream limit, or a proxy's error page
 * while the server restarts) is given up by the browser for good: it is opened
 * again after about this long - doubling, up to the last - spread out so a
 * whole class does not come back in the same second.
 */
const REOPEN_MS = [4_000, 8_000, 16_000, 30_000];
const EVENT_SOURCE_CLOSED = 2;

/**
 * Receive an inexpensive refresh signal from the server. EventSource reconnects
 * itself after a temporary network loss; the normal polling remains as a safe
 * fallback for browsers and proxies that do not support streaming. `onUpdate`
 * receives the server event payload; a quick burst is delivered as the latest
 * payload with an `events` array containing every signal in that burst.
 *
 * Returns whether the stream is open now: while it is not, a page that waits
 * on it asks the server itself more often (WaitingForStart).
 */
export function useLiveUpdate(url, onUpdate, enabled = true) {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;
  const [live, setLive] = useState(false);

  useEffect(() => {
    setLive(false);
    if (!enabled || !url || typeof EventSource === 'undefined') return undefined;
    let stream = null;
    let reopenTimer = null;
    let failures = 0;
    let timer = null;
    let opened = false;
    let signals = [];
    const refresh = (payload) => {
      signals.push(payload);
      // Use a short trailing *batch*, not a resettable debounce. A busy class
      // cannot keep the dashboard/paper waiting forever by sending updates.
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        const batch = signals;
        signals = [];
        const latest = batch.at(-1);
        callback.current?.(batch.length > 1 ? { ...latest, events: batch } : latest);
      }, 60);
    };
    const update = (event) => refresh(eventPayload(event));
    const openedStream = () => {
      failures = 0;
      setLive(true);
      // The initial data fetch already synchronises the view. Subsequent
      // opens mean EventSource recovered from a broken connection, and an
      // update might have been missed while it was disconnected.
      if (opened) refresh({ kind: 'stream_reconnected', reconnected: true });
      opened = true;
    };
    const detach = () => {
      if (!stream) return;
      stream.removeEventListener('update', update);
      stream.removeEventListener('open', openedStream);
      stream.removeEventListener('error', failed);
      stream.close();
      stream = null;
    };
    function failed() {
      setLive(false);
      // Still connecting: the browser is trying again by itself. Closed: it has given up.
      if (stream?.readyState !== EVENT_SOURCE_CLOSED) return;
      detach();
      const wait = REOPEN_MS[Math.min(failures, REOPEN_MS.length - 1)];
      failures += 1;
      reopenTimer = window.setTimeout(connect, wait + Math.round(Math.random() * wait));
    }
    function connect() {
      reopenTimer = null;
      try { stream = new EventSource(url); } catch { return; }
      stream.addEventListener('update', update);
      stream.addEventListener('open', openedStream);
      stream.addEventListener('error', failed);
    }
    connect();
    return () => {
      if (timer) window.clearTimeout(timer);
      if (reopenTimer) window.clearTimeout(reopenTimer);
      signals = [];
      detach();
    };
  }, [url, enabled]);
  return live;
}
