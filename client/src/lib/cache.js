import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api.js';

/**
 * Replies the portal has already had from the server, kept while this tab is
 * open, so a page seen once opens at once: it shows what it had and asks the
 * server again behind it, updating when the answer lands (stale while
 * revalidating). Pages fetched ahead of a click (prefetch.js) land here too,
 * so they are waiting when the click comes.
 *
 * Only in memory - never written to the device - and emptied when the
 * account changes (App.jsx). Nothing a paper being sat depends on is read
 * from here: the test page always asks the server.
 *
 * Each address is one entry: `{ data, at, error }`, replaced (never changed)
 * on every write, so React sees a new snapshot. A reply that started before
 * a newer request - or before the entry was written by hand or dropped -
 * is discarded when it lands, so an older answer never paints over a newer.
 */
const MAX_ENTRIES = 160;

export function createCache(fetcher) {
  // url -> { entry, seq, promise }
  const state = new Map();
  const listeners = new Map();
  let epoch = 0;

  const notify = (url) => listeners.get(url)?.forEach((listener) => listener());
  const write = (url, entry, seq) => {
    state.set(url, { entry, seq, promise: null });
    notify(url);
    if (state.size > MAX_ENTRIES) trim();
  };
  // The oldest entries nobody is showing go first.
  const trim = () => {
    const idle = [...state.entries()]
      .filter(([url, slot]) => !listeners.get(url)?.size && !slot.promise)
      .sort((a, b) => (a[1].entry?.at || 0) - (b[1].entry?.at || 0));
    for (const [url] of idle.slice(0, state.size - MAX_ENTRIES)) state.delete(url);
  };
  const matcher = (which) => (typeof which === 'function' ? which : (url) => url === which || url.startsWith(which));

  /** What is held for `url` now: `{ data, at, error }`, or undefined. */
  const entry = (url) => state.get(url)?.entry;
  const peek = (url) => state.get(url)?.entry?.data;

  /**
   * The server's answer for `url`. One request at a time per address: a
   * second caller shares the one on its way. `maxAgeMs`: an answer this
   * recent is used as it is. `force`: ask again whatever is held or on its way.
   */
  function load(url, { force = false, maxAgeMs = 0, priority } = {}) {
    const slot = state.get(url);
    if (!force && slot?.promise) return slot.promise;
    if (!force && slot?.entry?.data !== undefined && Date.now() - slot.entry.at < maxAgeMs) return Promise.resolve(slot.entry.data);
    const seq = (slot?.seq || 0) + 1;
    const started = epoch;
    const current = () => {
      const now = state.get(url);
      return started === epoch && now?.seq === seq;
    };
    const promise = fetcher(url, priority ? { priority } : {}).then(
      (data) => {
        if (current()) write(url, { data, at: Date.now(), error: null }, seq);
        return data;
      },
      (error) => {
        if (current()) write(url, { ...(state.get(url)?.entry || { data: undefined, at: 0 }), error }, seq);
        throw error;
      }
    );
    state.set(url, { entry: slot?.entry, seq, promise });
    return promise;
  }

  /** Fetched ahead, quietly: nothing if a recent answer is held or one is on its way. */
  function prefetch(url, { maxAgeMs = 20_000 } = {}) {
    if (!url) return;
    load(url, { maxAgeMs, priority: 'low' }).catch(() => {});
  }

  /** Written by hand - an action's result - and newer than anything still on its way. */
  function set(url, data) {
    write(url, { data, at: Date.now(), error: null }, (state.get(url)?.seq || 0) + 1);
  }
  function update(url, change) {
    const held = state.get(url)?.entry?.data;
    if (held === undefined) return;
    set(url, change(held));
  }

  /** Forgotten: the next page to show it asks the server and waits. An address, a prefix or a test. */
  function drop(which) {
    const matches = matcher(which);
    for (const url of [...state.keys()]) {
      if (!matches(url)) continue;
      state.delete(url);
      notify(url);
    }
  }

  /** Everything forgotten - another account - and replies still on their way thrown away. */
  function clear() {
    epoch += 1;
    const urls = [...state.keys()];
    state.clear();
    urls.forEach(notify);
  }

  function subscribe(url, listener) {
    if (!listeners.has(url)) listeners.set(url, new Set());
    listeners.get(url).add(listener);
    return () => {
      listeners.get(url)?.delete(listener);
      if (!listeners.get(url)?.size) listeners.delete(url);
    };
  }

  return { entry, peek, load, prefetch, set, update, drop, clear, subscribe };
}

const cache = createCache((url, options) => api(url, options));

export const peekCached = cache.peek;
export const loadCached = cache.load;
export const prefetch = cache.prefetch;
export const setCached = cache.set;
export const updateCached = cache.update;
export const dropCached = cache.drop;
export const clearCache = cache.clear;

/**
 * A server reply for a page: what is held shows at once, and the server is
 * asked again behind it - unless the answer is under `freshMs` old (fetched
 * ahead a moment ago). `url` null: nothing yet. Returns `{ data, error }`;
 * `data` stays undefined until the first answer, and an error alongside held
 * data means only that the latest check failed.
 */
export function useCached(url, { freshMs = 3_000 } = {}) {
  const subscribe = useCallback((listener) => (url ? cache.subscribe(url, listener) : () => {}), [url]);
  const snapshot = useCallback(() => (url ? cache.entry(url) : undefined), [url]);
  const held = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (url) cache.load(url, { maxAgeMs: freshMs }).catch(() => {});
  }, [url, freshMs]);
  return { data: held?.data, error: held?.error || null };
}
