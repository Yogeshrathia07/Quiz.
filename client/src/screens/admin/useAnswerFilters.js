import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { decodeAnswerFilters, encodeAnswerFilters, evaluateAnswerFilters, sanitizeAnswerFilters } from './answer-filters.js';

const EMPTY = { mode: 'all', questions: [] };

/** Lazy, bounded response reads shared by the editor and the active cohort.
 * Missing data must never look like a valid empty (or unfiltered) result.
 */
export function useAnswerFilters({ code, questions, students, revision, raw = '', onChange }) {
  const parse = useCallback((value) => {
    try { return { value: decodeAnswerFilters(value, questions), error: '' }; }
    catch (error) { return { value: EMPTY, error: error.message || 'This answer filter is not valid. Clear it and try again.' }; }
  }, [questions]);
  const initial = useMemo(() => parse(raw), [parse, raw]);
  const [value, setValue] = useState(initial.value);
  const [addressError, setAddressError] = useState(initial.error);
  const [store, setStore] = useState({});
  const generation = useRef(null);
  const scope = `${code}|${revision || ''}`;
  if (generation.current?.scope !== scope) generation.current = { scope, active: 0, queue: [], requests: new Map(), data: {} };
  const current = generation.current;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setValue(initial.value); setAddressError(initial.error); }, [initial]);
  useEffect(() => { setStore({}); }, [scope]);

  const load = useCallback((id, { force = false } = {}) => {
    id = String(id);
    const state = generation.current;
    if (!questions.some((question) => String(question.id) === id)) return Promise.resolve(null);
    if (state.requests.has(id)) return state.requests.get(id);
    if (!force && state.data[id]?.responses) return Promise.resolve(state.data[id]);
    const publish = (entry) => {
      state.data[id] = entry;
      if (alive.current && generation.current === state) setStore({ ...state.data });
    };
    publish({ loading: true });
    let finish;
    const promise = new Promise((resolve) => { finish = resolve; });
    state.requests.set(id, promise);
    const pump = () => {
      while (state.active < 3 && state.queue.length) {
        const run = state.queue.shift(); state.active += 1; void run();
      }
    };
    state.queue.push(async () => {
      try {
        if (!alive.current || generation.current !== state) { finish(null); return; }
        const reply = await api(`/api/admin/tests/${encodeURIComponent(code)}/questions/${encodeURIComponent(id)}/statistics`);
        if (!reply?.question || String(reply.question.id) !== id || !Array.isArray(reply.question.options) || !Array.isArray(reply.responses)) {
          throw new Error('These responses could not be loaded. Please try again.');
        }
        publish(reply); finish(reply);
      } catch (error) { publish({ error: error.message || 'Could not load responses.' }); finish(null); }
      finally { state.requests.delete(id); state.active -= 1; pump(); }
    });
    pump();
    return promise;
  }, [code, questions]);

  // A new matrix invalidates old outcomes/picks. Requests from the previous
  // revision may finish, but cannot paint this revision's results.
  const liveStore = current.data;
  const details = useMemo(() => Object.fromEntries(Object.entries(liveStore).filter(([, entry]) => Array.isArray(entry.responses))), [store, current]);
  // Kept the same objects until a reply lands, so nothing that reads them works itself out again on every draw.
  const errors = useMemo(() => Object.fromEntries(Object.entries(liveStore).filter(([, entry]) => entry.error).map(([id, entry]) => [id, entry.error])), [store, current]);
  const loadingIds = useMemo(() => new Set(Object.entries(liveStore).filter(([, entry]) => entry.loading).map(([id]) => id)), [store, current]);
  const result = useMemo(() => evaluateAnswerFilters(value, students, liveStore), [value, students, store, current]);
  const shared = useMemo(() => (addressError
    ? { ...result, active: true, status: 'error', ids: null, errors: [{ message: addressError }], pending: [] }
    : { ...result, active: Boolean(result.active) }), [result, addressError]);
  useEffect(() => {
    if (addressError) return;
    for (const id of result.pending) if (!current.data[id]) void load(id);
  }, [addressError, result.pending.join('|'), current, load]);
  const apply = (next) => {
    const normalized = sanitizeAnswerFilters(next, questions);
    const encoded = encodeAnswerFilters(normalized, questions);
    setValue(normalized); setAddressError('');
    onChange?.(encoded);
  };
  return { value, apply, clear: () => apply(EMPTY), addressError, details, errors, loadingIds, load, result: shared };
}
