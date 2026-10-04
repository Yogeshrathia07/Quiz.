import { recordServerTime } from './server-clock.js';

/**
 * Errors carry `status` so a caller can tell a refusal from a dead connection:
 * a rejected write must not be retried, an unreachable server must be. A
 * network failure gets status 0.
 */
export class ApiError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const isOffline = (error) => error instanceof ApiError && error.status === 0;

/**
 * This browser's session ended - usually because the account signed in on
 * another device. Not a refusal of the request itself: whatever it carried
 * (an exam answer) must be kept and sent again after signing back in.
 */
export const isSignedOut = (error) => error instanceof ApiError && error.code === 'SIGNED_OUT';
export const SESSION_ENDED_EVENT = 'portal-session-ended';

/** Worth asking again: no connection, too slow, or the server momentarily overloaded. */
export const isRetryable = (error) => error instanceof ApiError
  && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);

export async function api(url, options = {}) {
  const { timeoutMs = 25_000, ...requestOptions } = options;
  const controller = !requestOptions.signal && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller && timeoutMs > 0
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  const sentAt = Date.now();
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      ...(controller ? { signal: controller.signal } : {}),
      headers: { 'content-type': 'application/json', ...(requestOptions.headers || {}) }
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('The connection is taking too long. We will try again.', 408, 'NETWORK_TIMEOUT');
    throw new ApiError('No connection. Check your network and try again.', 0);
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
  // Every reply keeps the exam's timers on the server's clock (server-clock.js).
  const stamp = response.headers?.get?.('x-server-time');
  if (stamp) recordServerTime(Number(stamp), sentAt, Date.now());
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.code === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: data.error }));
    throw new ApiError(data.error || 'Something went wrong.', response.status, data.code || null);
  }
  return data;
}

export const post = (url, body, options = {}) => api(url, { ...options, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** Sends a file as it is - a workbook for the server to read back - rather than as JSON. */
export const uploadFile = (url, file) => api(url, {
  method: 'POST', body: file, timeoutMs: 120_000,
  headers: { 'content-type': file.type || 'application/octet-stream' }
});

/** Streams a file from the server straight to the browser's downloads. */
export async function downloadFile(path, fallbackName, body) {
  // With a body, it is posted as JSON - for a request too big for an address.
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not download the spreadsheet.');
  }
  const named = /filename="?([^";]+)"?/i.exec(response.headers.get('content-disposition') || '')?.[1];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = named || fallbackName;
  link.dataset.portal = '';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const downloadSpreadsheet = (code) => downloadFile(`/api/admin/tests/${encodeURIComponent(code)}/export.xlsx`, `${code}-test-data.xlsx`);

/** A student's own answers on one closed, released test. */
export const downloadMyResponses = (code) => downloadFile(`/api/me/results/${encodeURIComponent(code)}/responses.xlsx`, `${code}-responses.xlsx`);
