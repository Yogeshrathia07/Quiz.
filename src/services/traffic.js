import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from '../config.js';
import { coordinationStats } from '../coordination/index.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const state = {
  startedAt: new Date(), active: 0, peakActive: 0, completed: 0,
  shedPolls: 0, shedHard: 0, errors: 0, totalDurationMs: 0
};

/** Reads that are safe for the browser to retry and never carry an answer. */
export function isPollableRequest(method, path) {
  if (method !== 'GET') return false;
  return /^\/api\/tests\/[^/]+(?:\/attempt)?$/.test(path)
    || /^\/api\/admin\/tests\/[^/]+$/.test(path)
    || /^\/api\/admin\/attendance\/[^/]+$/.test(path);
}

function rejectBusy(res, hard = false) {
  if (hard) state.shedHard += 1;
  else state.shedPolls += 1;
  res.set('Retry-After', hard ? '2' : '1');
  res.status(503).json({
    error: 'The server is handling a large burst. This request will retry automatically.',
    code: 'SERVER_BUSY'
  });
}

/**
 * Reserve capacity for answers and submissions by dropping repeatable polls
 * first. The hard ceiling protects the process from an unbounded socket burst.
 */
export function trafficMiddleware(req, res, next) {
  const hard = config.performance.hardActiveRequests;
  const soft = Math.min(config.performance.softActiveRequests, hard - 1);
  if (state.active >= hard) return rejectBusy(res, true);
  if (state.active >= soft && isPollableRequest(req.method, req.path)) return rejectBusy(res, false);

  const began = performance.now();
  state.active += 1;
  state.peakActive = Math.max(state.peakActive, state.active);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    state.active = Math.max(0, state.active - 1);
    state.completed += 1;
    state.totalDurationMs += performance.now() - began;
    if (res.statusCode >= 500) state.errors += 1;
  };
  res.once('finish', done);
  res.once('close', done);
  next();
}

const millis = (nanoseconds) => Number.isFinite(nanoseconds) ? Number((nanoseconds / 1e6).toFixed(1)) : 0;

export function performanceSnapshot(extra = {}) {
  return {
    processId: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: state.startedAt.toISOString(),
    requests: {
      active: state.active,
      peakActive: state.peakActive,
      completed: state.completed,
      errors: state.errors,
      shedPolls: state.shedPolls,
      shedHard: state.shedHard,
      averageMs: state.completed ? Number((state.totalDurationMs / state.completed).toFixed(1)) : 0
    },
    eventLoop: {
      meanMs: millis(loopDelay.mean),
      p95Ms: millis(loopDelay.percentile(95)),
      p99Ms: millis(loopDelay.percentile(99)),
      maxMs: millis(loopDelay.max)
    },
    memory: Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, bytes]) => [key, Math.round(bytes / 1024 / 1024)])),
    coordination: coordinationStats(),
    ...extra
  };
}

