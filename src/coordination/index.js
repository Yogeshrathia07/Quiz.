import Redis from 'ioredis';
import Redlock, { ExecutionError, ResourceLockedError } from 'redlock';
import { config } from '../config.js';
import { PublicTestError } from '../lib/errors.js';

// MongoDB remains the source of truth. Redis holds only short-lived lock keys
// that let several Node processes take the same turns the old in-process queue
// provided. With no REDIS_URL a single development process keeps using the
// local queue, so Redis is not needed for ordinary local work or unit tests.
const localQueues = new Map();
const localCache = new Map();
const cacheLoads = new Map();
let redisClient = null;
let redisSubscriber = null;
let redlock = null;
let lastRedisLogAt = 0;
const cacheCounters = { hits: 0, misses: 0, errors: 0 };

const clusteredProcess = () => process.env.QUIZ_CLUSTERED === 'true'
  || Number(process.env.WEB_CONCURRENCY || 1) > 1;

const lockKey = (resource) => `${config.redis.keyPrefix}:lock:${encodeURIComponent(String(resource))}`;
const cacheKey = (resource) => `${config.redis.keyPrefix}:cache:${encodeURIComponent(String(resource))}`;
const cacheInvalidationChannel = () => `${config.redis.keyPrefix}:cache-invalidations`;
const extensionThreshold = () => Math.max(500, Math.min(5_000, Math.floor(config.redis.lockTtlMs / 3)));
const retryCount = () => Math.max(0, Math.ceil(config.redis.lockWaitMs / 100));

const reportRedisError = (error) => {
  if (error instanceof ResourceLockedError) return;
  // A disconnected Redis client can emit the same error for every waiting
  // request. Keep the log useful without printing thousands of copies.
  if (Date.now() - lastRedisLogAt < 10_000) return;
  lastRedisLogAt = Date.now();
  console.error('Redis coordination:', error?.message || error);
};

export async function initializeCoordination() {
  if (redisClient) return;
  if (!config.redis.url) {
    if (clusteredProcess()) {
      throw new Error('REDIS_URL is required when more than one Node process is running. Refusing unsafe cluster startup.');
    }
    console.log('Coordination: local queue (single Node process).');
    return;
  }

  const client = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: config.redis.connectTimeoutMs,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(2_000, attempt * 100)
  });
  client.on('error', reportRedisError);
  const subscriber = client.duplicate({ lazyConnect: true });
  subscriber.on('error', reportRedisError);

  let timeout;
  try {
    await Promise.race([
      Promise.all([client.connect(), subscriber.connect()]),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Redis did not become ready within ${config.redis.connectTimeoutMs} ms.`)), config.redis.connectTimeoutMs);
      })
    ]);
  } catch (error) {
    client.disconnect(false);
    subscriber.disconnect(false);
    throw new Error(`Could not start Redis coordination: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const manager = new Redlock([client], {
    driftFactor: 0.01,
    retryCount: retryCount(),
    retryDelay: 50,
    retryJitter: 100,
    automaticExtensionThreshold: extensionThreshold()
  });
  manager.on('error', reportRedisError);
  try {
    await subscriber.subscribe(cacheInvalidationChannel());
  } catch (error) {
    subscriber.disconnect(false);
    client.disconnect(false);
    throw new Error(`Could not start Redis cache invalidation: ${error.message}`);
  }
  subscriber.on('message', (channel, resource) => {
    if (channel === cacheInvalidationChannel()) localCache.delete(resource);
  });
  redisClient = client;
  redisSubscriber = subscriber;
  redlock = manager;
  console.log('Coordination: Redis distributed locks enabled.');
}

export const coordinationMode = () => (redlock ? 'redis' : 'local');

export async function closeCoordination() {
  const client = redisClient;
  const subscriber = redisSubscriber;
  redisClient = null;
  redisSubscriber = null;
  redlock = null;
  localCache.clear();
  cacheLoads.clear();
  if (!client) return;
  if (subscriber) {
    try { await subscriber.quit(); }
    catch { subscriber.disconnect(false); }
  }
  try {
    await client.quit();
  } catch {
    client.disconnect(false);
  }
}

const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Small read-through JSON cache shared by every worker when Redis is present,
 * and in memory for single-process development. Cache failures never make an
 * exam fail: MongoDB remains the source of truth and is used immediately.
 */
export async function cachedJson(resource, load, ttlMs = config.redis.testCacheMs) {
  if (ttlMs <= 0) return load();
  const key = String(resource);
  const nowMs = Date.now();
  const local = localCache.get(key);
  if (local && local.expiresAt > nowMs) {
    cacheCounters.hits += 1;
    return cloneJson(local.value);
  }
  if (local) localCache.delete(key);

  if (redisClient) {
    try {
      const stored = await redisClient.get(cacheKey(key));
      if (stored !== null) {
        const value = JSON.parse(stored);
        localCache.set(key, { value, expiresAt: nowMs + Math.min(ttlMs, 1_000) });
        cacheCounters.hits += 1;
        return cloneJson(value);
      }
    } catch (error) {
      cacheCounters.errors += 1;
      reportRedisError(error);
    }
  }

  cacheCounters.misses += 1;
  // Collapse a same-worker burst to one MongoDB read.
  if (cacheLoads.has(key)) return cloneJson(await cacheLoads.get(key));
  const pending = Promise.resolve().then(load);
  cacheLoads.set(key, pending);
  try {
    const value = await pending;
    const json = cloneJson(value);
    localCache.set(key, { value: json, expiresAt: Date.now() + ttlMs });
    if (localCache.size > 5_000) localCache.delete(localCache.keys().next().value);
    if (redisClient) {
      try { await redisClient.set(cacheKey(key), JSON.stringify(json), 'PX', ttlMs); }
      catch (error) { cacheCounters.errors += 1; reportRedisError(error); }
    }
    return cloneJson(json);
  } finally {
    cacheLoads.delete(key);
  }
}

/** Invalidate locally and in Redis after a test-setting mutation. */
export async function invalidateCached(resource) {
  const key = String(resource);
  localCache.delete(key);
  if (!redisClient) return;
  try {
    await redisClient.multi().del(cacheKey(key)).publish(cacheInvalidationChannel(), key).exec();
  }
  catch (error) { cacheCounters.errors += 1; reportRedisError(error); }
}

export const coordinationStats = () => ({
  mode: coordinationMode(),
  queues: localQueues.size,
  cacheEntries: localCache.size,
  cacheLoads: cacheLoads.size,
  cache: { ...cacheCounters }
});

const unavailable = (error) => {
  const wrapped = new PublicTestError(
    503,
    'The test server is busy coordinating another update. Your device will retry; please stay on this page.',
    'SERVER_BUSY'
  );
  wrapped.cause = error;
  return wrapped;
};

async function distributed(resource, run, settings = {}) {
  if (!redlock) return run(new AbortController().signal);
  try {
    return await redlock.using(
      [lockKey(resource)],
      settings.ttlMs || config.redis.lockTtlMs,
      { retryCount: settings.retryCount ?? retryCount() },
      async (signal) => {
        if (signal.aborted) throw signal.error;
        const value = await run(signal);
        if (signal.aborted) throw signal.error;
        return value;
      }
    );
  } catch (error) {
    if (error instanceof ExecutionError) throw unavailable(error);
    throw error;
  }
}

/**
 * Runs writes for one resource in order in this process and, when configured,
 * under the matching Redis lock across every process. The small local queue
 * prevents requests on one worker from fighting each other in Redis.
 */
export function serializeWrite(resource, run, settings = {}) {
  const key = String(resource);
  const previous = localQueues.get(key) || Promise.resolve();
  const result = previous.then(() => distributed(key, run, settings), () => distributed(key, run, settings));
  const tail = result.then(() => undefined, () => undefined);
  localQueues.set(key, tail);
  tail.then(() => { if (localQueues.get(key) === tail) localQueues.delete(key); });
  return result;
}

/**
 * Scheduler ticks do not wait behind another server's tick. Exactly one wins;
 * the rest skip this pass and try again on their next timer interval.
 */
export async function runAsLeader(resource, run, ttlMs = config.redis.lockTtlMs) {
  if (!redlock) return { acquired: true, value: await run(new AbortController().signal) };
  let entered = false;
  try {
    const value = await redlock.using(
      [lockKey(`leader:${resource}`)],
      ttlMs,
      { retryCount: 0 },
      async (signal) => {
        entered = true;
        if (signal.aborted) throw signal.error;
        const result = await run(signal);
        if (signal.aborted) throw signal.error;
        return result;
      }
    );
    return { acquired: true, value };
  } catch (error) {
    if (!entered && error instanceof ExecutionError) return { acquired: false, value: undefined };
    if (error instanceof ExecutionError) throw unavailable(error);
    throw error;
  }
}
