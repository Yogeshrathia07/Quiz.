/**
 * Keeping a paper answerable through a bad connection.
 *
 * Every answer is written to the server, but a phone on campus Wi-Fi drops out.
 * So each answer is also held here: applied to the screen at once, kept in this
 * device's storage, and re-sent until the server confirms it. A reload while
 * offline still finds the paper and the unsent answers.
 *
 * The server stays the authority. Anything it rejects - a frozen question, a
 * closed test - is dropped from the queue and its answer reverts to whatever
 * the server says. This never invents an answer the server refused.
 */

const KEY = (attemptId) => `quiz-offline:${attemptId}`;
const LATEST_KEY = (code) => `quiz-offline-latest:${String(code || '').toUpperCase()}`;
const DB_NAME = 'campus-quiz-offline';
const DB_VERSION = 1;
const STORE = 'attempts';

/** localStorage throws in private windows and when full; never break the exam for it. */
function safely(run, fallback = null) {
  try { return run(); } catch { return fallback; }
}

export function loadCache(storage, attemptId) {
  return safely(() => {
    const raw = storage?.getItem(KEY(attemptId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.attempt) return null;
    return { attempt: parsed.attempt, pending: new Map(parsed.pending || []) };
  });
}

/** Finds the most recent paper for this test after an offline page reload. */
export function loadCacheForCode(storage, code) {
  return safely(() => {
    const wanted = String(code || '').toUpperCase();
    const pointed = storage?.getItem(LATEST_KEY(wanted));
    if (pointed) {
      const cached = loadCache(storage, pointed);
      if (cached) return cached;
    }
    let newest = null;
    for (let index = 0; index < (storage?.length || 0); index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith('quiz-offline:') || key.startsWith('quiz-offline-latest:')) continue;
      const parsed = safely(() => JSON.parse(storage.getItem(key) || 'null'));
      if (String(parsed?.attempt?.code || '').toUpperCase() !== wanted) continue;
      if (!newest || String(parsed.savedAt || '') > String(newest.savedAt || '')) newest = parsed;
    }
    return newest?.attempt ? { attempt: newest.attempt, pending: new Map(newest.pending || []) } : null;
  });
}

export function saveCache(storage, attemptId, attempt, pending) {
  safely(() => {
    storage?.setItem(KEY(attemptId), JSON.stringify({
      attempt,
      pending: [...(pending || new Map())],
      savedAt: new Date().toISOString()
    }));
    if (attempt?.code) storage?.setItem(LATEST_KEY(attempt.code), attemptId);
  });
}

/** Called once the paper is submitted: the answers are the server's now. */
export function clearCache(storage, attemptId) {
  if (!attemptId) return;
  safely(() => {
    const cached = loadCache(storage, attemptId);
    storage?.removeItem(KEY(attemptId));
    if (cached?.attempt?.code && storage?.getItem(LATEST_KEY(cached.attempt.code)) === attemptId) {
      storage.removeItem(LATEST_KEY(cached.attempt.code));
    }
  });
}

/** Drops any cache belonging to an attempt other than this one. */
export function clearOtherCaches(storage, attemptId) {
  safely(() => {
    const stale = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith('quiz-offline:') && !key.startsWith('quiz-offline-latest:') && key !== KEY(attemptId)) stale.push(key);
    }
    stale.forEach((key) => {
      const parsed = safely(() => JSON.parse(storage.getItem(key) || 'null'));
      storage.removeItem(key);
      if (parsed?.attempt?.code) storage.removeItem(LATEST_KEY(parsed.attempt.code));
    });
  });
}

function openOfflineDb(indexedDb) {
  if (!indexedDb?.open) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'code' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function idbRequest(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

/** IndexedDB is the durable copy; every operation degrades to a no-op safely. */
export async function loadDurableCache(indexedDb, code) {
  const database = await openOfflineDb(indexedDb);
  if (!database) return null;
  try {
    const record = await idbRequest(database.transaction(STORE, 'readonly').objectStore(STORE).get(String(code || '').toUpperCase()));
    return record?.attempt ? { attempt: record.attempt, pending: new Map(record.pending || []) } : null;
  } catch { return null; }
  finally { database.close(); }
}

export async function saveDurableCache(indexedDb, code, attempt, pending) {
  const database = await openOfflineDb(indexedDb);
  if (!database) return false;
  try {
    const request = database.transaction(STORE, 'readwrite').objectStore(STORE).put({
      code: String(code || attempt?.code || '').toUpperCase(),
      attemptId: attempt?.id,
      attempt,
      pending: [...(pending || new Map())],
      savedAt: new Date().toISOString()
    });
    await idbRequest(request);
    return !request.error;
  } catch { return false; }
  finally { database.close(); }
}

export async function clearDurableCache(indexedDb, code) {
  const database = await openOfflineDb(indexedDb);
  if (!database) return false;
  try {
    const request = database.transaction(STORE, 'readwrite').objectStore(STORE).delete(String(code || '').toUpperCase());
    await idbRequest(request);
    return !request.error;
  } catch { return false; }
  finally { database.close(); }
}

const hasContent = (payload) => (payload.answerText !== undefined
  ? payload.answerText.trim().length > 0
  : (payload.selectedOptions || []).length > 0);

/**
 * The paper as the student should see it: the server's questions with anything
 * still queued on this device laid over the top, flagged so the UI can say so.
 */
export function applyPending(questions, pending) {
  if (!pending || pending.size === 0) return questions || [];
  return (questions || []).map((question) => {
    const payload = pending.get(question.id);
    if (!payload) return question;
    return {
      ...question,
      selectedOptions: payload.selectedOptions ?? question.selectedOptions,
      answerText: payload.answerText ?? question.answerText,
      answered: hasContent(payload),
      unsent: true
    };
  });
}

export const answeredCountWith = (questions) => questions.filter((question) => question.answered).length;

/** Merge a small server state update without replacing the paper it omitted. */
export function mergeAttemptState(current, response) {
  if (response?.attempt) return response.attempt;
  if (!current || !response?.state) return current;
  const next = { ...current, ...response.state };
  if (next.status === 'submitted' || next.isLocked || next.paused) delete next.questions;
  return next;
}

/** Apply the one answer echoed by a compact acknowledgement. */
export function mergeAnswerAcknowledgement(current, response) {
  const next = mergeAttemptState(current, response);
  if (!next || !response?.answer || !next.questions) return next;
  return {
    ...next,
    questions: next.questions.map((question) => (question.id === response.answer.questionId
      ? { ...question, ...response.answer, id: question.id }
      : question))
  };
}

/** Exponential backoff with full jitter, capped so reconnection never feels abandoned. */
export function retryDelay(round, random = Math.random()) {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, Number(round) || 0));
  return Math.max(500, Math.round(ceiling * (0.5 + random * 0.5)));
}

/** A rejection the server will keep making: retrying it would loop forever. */
export const isPermanentRejection = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;
