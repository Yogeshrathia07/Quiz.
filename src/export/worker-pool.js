import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { PublicTestError } from '../lib/errors.js';

const workers = [];
const queue = [];
let nextId = 1;
let closing = false;
const counters = { completed: 0, failed: 0, peakQueued: 0 };

function startSlot() {
  const slot = { worker: new Worker(new URL('./export-worker.js', import.meta.url)), job: null };
  slot.worker.on('message', ({ id, buffer, error, stack }) => {
    const job = slot.job;
    if (!job || job.id !== id) return;
    slot.job = null;
    if (error) {
      counters.failed += 1;
      const failure = new Error(error);
      failure.stack = stack || failure.stack;
      job.reject(failure);
    } else {
      counters.completed += 1;
      job.resolve(Buffer.from(buffer));
    }
    dispatch();
  });
  slot.worker.on('error', (error) => {
    if (slot.job) { counters.failed += 1; slot.job.reject(error); slot.job = null; }
  });
  slot.worker.on('exit', (code) => {
    const index = workers.indexOf(slot);
    if (index >= 0) workers.splice(index, 1);
    if (slot.job) {
      counters.failed += 1;
      slot.job.reject(new Error(`Export worker stopped with code ${code}.`));
      slot.job = null;
    }
    if (!closing) { workers.push(startSlot()); dispatch(); }
  });
  return slot;
}

function ensureWorkers() {
  while (!closing && workers.length < config.performance.exportWorkers) workers.push(startSlot());
}

function dispatch() {
  ensureWorkers();
  for (const slot of workers) {
    if (slot.job || !queue.length) continue;
    slot.job = queue.shift();
    slot.worker.postMessage({ id: slot.job.id, type: slot.job.type, data: slot.job.data, options: slot.job.options });
  }
}

/** Excel generation runs outside the HTTP event loop in a bounded queue. */
export function runExportJob(type, data, options = {}) {
  if (queue.length >= config.performance.exportQueueLimit) {
    throw new PublicTestError(503, 'Too many reports are being prepared. Try the download again shortly.', 'EXPORT_BUSY');
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, type, data, options, resolve, reject });
    counters.peakQueued = Math.max(counters.peakQueued, queue.length);
    dispatch();
  });
}

export const exportWorkerStats = () => ({
  workers: workers.length,
  busy: workers.filter((slot) => slot.job).length,
  queued: queue.length,
  ...counters
});

export async function closeExportWorkers() {
  closing = true;
  const error = new Error('Server is shutting down.');
  while (queue.length) queue.shift().reject(error);
  await Promise.all(workers.splice(0).map((slot) => slot.worker.terminate()));
}

