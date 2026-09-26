/**
 * Two real Node processes contend for one Redis write lock and one scheduler
 * leader lock. Run with a disposable Redis database:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run check:redis
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { closeCoordination, initializeCoordination, runAsLeader, serializeWrite } from '../src/coordination/index.js';

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const url = String(process.env.REDIS_URL || '').trim();
if (!url) throw new Error('Set REDIS_URL to a disposable Redis service before running check:redis.');

const runId = process.env.REDIS_CHECK_RUN || `${Date.now()}-${process.pid}`;
const scriptPath = fileURLToPath(import.meta.url);
const prefix = `campus-quiz-check:${runId}`;
const keys = {
  ready: `${prefix}:ready`,
  active: `${prefix}:active`,
  overlaps: `${prefix}:overlaps`,
  leaderReady: `${prefix}:leader-ready`,
  leaders: `${prefix}:leaders`
};

async function waitFor(redis, key, count) {
  const until = Date.now() + 10_000;
  while (Number(await redis.get(key) || 0) < count) {
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${key}.`);
    await wait(20);
  }
}

async function child() {
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  await initializeCoordination();
  try {
    await redis.incr(keys.ready);
    await waitFor(redis, keys.ready, 2);
    await serializeWrite(`integration:${runId}`, async () => {
      const active = await redis.incr(keys.active);
      if (active > 1) await redis.incr(keys.overlaps);
      await wait(300);
      await redis.decr(keys.active);
    });

    await redis.incr(keys.leaderReady);
    await waitFor(redis, keys.leaderReady, 2);
    await runAsLeader(`integration:${runId}`, async () => {
      await redis.incr(keys.leaders);
      await wait(300);
    }, 5_000);
  } finally {
    await closeCoordination();
    await redis.quit();
  }
}

function startWorker() {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [scriptPath, '--child'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REDIS_CHECK_RUN: runId,
        REDIS_KEY_PREFIX: prefix
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    worker.stdout.on('data', (chunk) => { output += chunk; });
    worker.stderr.on('data', (chunk) => { output += chunk; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Redis check worker exited ${code}:\n${output}`));
    });
  });
}

async function parent() {
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    await redis.del(...Object.values(keys));
    await Promise.all([startWorker(), startWorker()]);
    assert.equal(Number(await redis.get(keys.overlaps) || 0), 0, 'the shared write never overlaps');
    assert.equal(Number(await redis.get(keys.active) || 0), 0, 'the shared write counter returns to zero');
    assert.equal(Number(await redis.get(keys.leaders) || 0), 1, 'exactly one scheduler leader runs');
    console.log('Redis coordination check passed: two processes serialized one write and elected one scheduler leader.');
  } finally {
    await redis.del(...Object.values(keys));
    await redis.quit();
  }
}

if (process.argv.includes('--child')) await child();
else await parent();
