import { onLiveEvent } from '../coordination/index.js';

// These maps describe who may receive a refresh signal. They deliberately
// contain only response streams, never user details, questions or answers.
const adminsByTest = new Map();
const studentsByTest = new Map();
const studentsByAttempt = new Map();
const studentsByRegistration = new Map();
const clients = new Set();

const HEARTBEAT_MS = 25_000;
const SLOW_CLIENT_GRACE_MS = 45_000;
const RETRY_MESSAGE = 'retry: 1000\n\n';
const RESYNC_MESSAGE = 'event: update\ndata: {"kind":"resync"}\n\n';

// A stream is a small idle socket, not an active application request. Keep a
// finite, independently configurable per-worker ceiling so a bad client or
// accidental reconnect loop cannot consume unlimited memory/file descriptors.
const liveStreamLimit = () => {
  const requested = Number(process.env.LIVE_STREAM_LIMIT);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(50_000, Math.floor(requested)))
    : 10_000;
};

const counters = {
  rejected: 0,
  backpressure: 0,
  coalesced: 0,
  slowClosed: 0,
  disconnected: 0
};

let heartbeat = null;

const add = (map, key, client) => {
  const members = map.get(key) || new Set();
  members.add(client);
  map.set(key, members);
};

const remove = (map, key, client) => {
  const members = map.get(key);
  if (!members) return;
  members.delete(client);
  if (!members.size) map.delete(key);
};

const streamIsGone = (client) => client.closed || client.res.destroyed || client.res.writableEnded;

function stopHeartbeatIfIdle() {
  if (clients.size || !heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

function detachClient(client) {
  if (client.closed) return;
  client.closed = true;
  if (client.slowTimer) clearTimeout(client.slowTimer);
  if (client.onDrain) client.res.off?.('drain', client.onDrain);
  client.req?.off?.('close', client.onClose);
  client.res.off?.('close', client.onClose);
  client.res.off?.('error', client.onClose);
  client.unsubscribe?.();
  clients.delete(client);
  stopHeartbeatIfIdle();
}

function endClient(client) {
  detachClient(client);
  try {
    if (!client.res.writableEnded && !client.res.destroyed) client.res.end();
  } catch { /* a disconnected browser needs no further work */ }
}

function waitForDrain(client) {
  if (client.waitingForDrain || client.closed) return;
  client.waitingForDrain = true;
  client.onDrain = () => {
    client.waitingForDrain = false;
    client.onDrain = null;
    if (client.slowTimer) clearTimeout(client.slowTimer);
    client.slowTimer = null;
    if (streamIsGone(client)) return detachClient(client);
    client.blocked = false;
    if (!client.needsResync) return;
    client.needsResync = false;
    writeClient(client, RESYNC_MESSAGE);
  };
  client.res.once?.('drain', client.onDrain);

  // Do not retain a response whose peer has stopped reading. Live messages are
  // non-authoritative hints, so closing it is safer than buffering an unbounded
  // event queue; EventSource reconnects and fetches the current authorised state.
  client.slowTimer = setTimeout(() => {
    if (!client.blocked || client.closed) return;
    counters.slowClosed += 1;
    endClient(client);
  }, SLOW_CLIENT_GRACE_MS);
  client.slowTimer.unref?.();
}

function markBackpressured(client, needsResync) {
  if (!client.blocked) counters.backpressure += 1;
  client.blocked = true;
  if (needsResync && !client.needsResync) {
    client.needsResync = true;
    counters.coalesced += 1;
  }
  waitForDrain(client);
}

function writeClient(client, message, { resyncOnBackpressure = true } = {}) {
  if (streamIsGone(client)) {
    detachClient(client);
    return false;
  }
  try {
    const accepted = client.res.write(message);
    // Compression is intentionally disabled for SSE, but Express still gives
    // some deployments a flush method. Calling it makes proxy delivery prompt.
    client.res.flush?.();
    if (accepted === false) markBackpressured(client, resyncOnBackpressure);
    return accepted !== false;
  } catch {
    counters.disconnected += 1;
    detachClient(client);
    return false;
  }
}

function ensureHeartbeat() {
  if (heartbeat || !clients.size) return;
  heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (!client.blocked) writeClient(client, ': keep-alive\n\n', { resyncOnBackpressure: false });
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function send(members, event, delivered = null) {
  if (!members) return;
  const message = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of [...members]) {
    if (delivered?.has(client)) continue;
    delivered?.add(client);
    // A slow peer receives one generic resync once it drains rather than every
    // intermediate event. Its next authorised fetch is always the source of truth.
    if (client.blocked) markBackpressured(client, true);
    else writeClient(client, message);
  }
}

function rejectStream(res) {
  counters.rejected += 1;
  res.status(503).set({
    'Retry-After': '2',
    'Cache-Control': 'no-store'
  }).json({
    error: 'The live-update connection limit is temporarily full. Retrying shortly.',
    code: 'LIVE_STREAM_BUSY'
  });
  return res;
}

function openStream(req, res, subscribe) {
  if (clients.size >= liveStreamLimit()) return rejectStream(res);

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // Small writes should leave Node immediately rather than wait for Nagle's
  // algorithm on a high-latency tunnel.
  res.socket?.setNoDelay?.(true);
  res.socket?.setKeepAlive?.(true, 60_000);
  res.flushHeaders?.();

  const client = {
    req,
    res,
    blocked: false,
    needsResync: false,
    waitingForDrain: false,
    slowTimer: null,
    onDrain: null,
    onClose: null,
    closed: false,
    unsubscribe: null
  };
  client.unsubscribe = subscribe(client);
  client.onClose = () => detachClient(client);
  req.once?.('close', client.onClose);
  res.once?.('close', client.onClose);
  res.once?.('error', client.onClose);
  clients.add(client);
  // Track the stream before its first write. If the peer drops between
  // flushHeaders() and this retry hint, detachClient must be able to remove
  // it from the global cap instead of leaving a closed socket counted forever.
  writeClient(client, RETRY_MESSAGE, { resyncOnBackpressure: false });
  ensureHeartbeat();
  return res;
}

export function openAdminUpdates(req, res, code) {
  return openStream(req, res, (client) => {
    add(adminsByTest, code, client);
    return () => remove(adminsByTest, code, client);
  });
}

export function openStudentUpdates(req, res, code, attemptId = null, registrationId = null) {
  return openStream(req, res, (client) => {
    add(studentsByTest, code, client);
    if (attemptId) add(studentsByAttempt, attemptId, client);
    if (registrationId) add(studentsByRegistration, registrationId, client);
    return () => {
      remove(studentsByTest, code, client);
      if (attemptId) remove(studentsByAttempt, attemptId, client);
      if (registrationId) remove(studentsByRegistration, registrationId, client);
    };
  });
}

onLiveEvent((event) => {
  if (!event?.code) return;
  // Every change in this test is useful to its owner’s dashboard.
  send(adminsByTest.get(event.code), event);
  // A test-wide lifecycle change reaches every registered student. A normal
  // answer/lock/revive reaches only that paper, never the entire class.
  if (event.broadcast) send(studentsByTest.get(event.code), event);
  else {
    // A waiting registration has no attempt yet, so approval/rejection can be
    // sent directly by registration id. If a caller supplies both ids, avoid
    // delivering duplicate update frames to a single browser stream.
    const delivered = new Set();
    if (event.attemptId) send(studentsByAttempt.get(event.attemptId), event, delivered);
    if (event.registrationId) send(studentsByRegistration.get(event.registrationId), event, delivered);
  }
});

export const liveUpdateStats = () => {
  const cap = liveStreamLimit();
  const studentStreams = [...studentsByTest.values()].reduce((total, members) => total + members.size, 0);
  const adminStreams = [...adminsByTest.values()].reduce((total, members) => total + members.size, 0);
  return {
    active: clients.size,
    cap,
    remaining: Math.max(0, cap - clients.size),
    adminStreams,
    studentStreams,
    backpressured: [...clients].filter((client) => client.blocked).length,
    heartbeat: { shared: Boolean(heartbeat), intervalMs: HEARTBEAT_MS },
    ...counters
  };
};

/** Close long-lived streams before HTTP server shutdown can complete. */
export function closeLiveUpdates() {
  for (const client of [...clients]) endClient(client);
  adminsByTest.clear();
  studentsByTest.clear();
  studentsByAttempt.clear();
  studentsByRegistration.clear();
  stopHeartbeatIfIdle();
}
