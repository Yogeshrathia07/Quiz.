import { useEffect, useRef } from 'react';

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
 * Receive an inexpensive refresh signal from the server. EventSource reconnects
 * itself after a temporary network loss; the normal polling remains as a safe
 * fallback for browsers and proxies that do not support streaming. `onUpdate`
 * receives the server event payload; a quick burst is delivered as the latest
 * payload with an `events` array containing every signal in that burst.
 */
export function useLiveUpdate(url, onUpdate, enabled = true) {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;

  useEffect(() => {
    if (!enabled || !url || typeof EventSource === 'undefined') return undefined;
    let stream;
    try { stream = new EventSource(url); } catch { return undefined; }
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
      // The initial data fetch already synchronises the view. Subsequent
      // opens mean EventSource recovered from a broken connection, and an
      // update might have been missed while it was disconnected.
      if (opened) refresh({ kind: 'stream_reconnected', reconnected: true });
      opened = true;
    };
    stream.addEventListener('update', update);
    stream.addEventListener('open', openedStream);
    return () => {
      if (timer) window.clearTimeout(timer);
      signals = [];
      stream.removeEventListener('update', update);
      stream.removeEventListener('open', openedStream);
      stream.close();
    };
  }, [url, enabled]);
}
