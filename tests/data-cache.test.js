import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../client/src/lib/cache.js';
import { routeData, routeScreens } from '../client/src/lib/prefetch.js';
import { screens } from '../client/src/screens/loaders.js';

/** A server whose replies arrive when the test says. */
function slowServer() {
  const calls = [];
  const fetcher = (url) => new Promise((resolve, reject) => { calls.push({ url, resolve, reject }); });
  return { calls, fetcher };
}
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test('one request at a time per address: a second asker shares it', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const first = cache.load('/api/me/results');
  const second = cache.load('/api/me/results');
  assert.equal(server.calls.length, 1);
  server.calls[0].resolve({ results: [1] });
  assert.deepEqual(await first, { results: [1] });
  assert.deepEqual(await second, { results: [1] });
  assert.deepEqual(cache.peek('/api/me/results'), { results: [1] });
});

test('a recent answer is used as it is; an older one is asked again', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const loading = cache.load('/api/admin/tests');
  server.calls[0].resolve({ tests: [] });
  await loading;
  await cache.load('/api/admin/tests', { maxAgeMs: 60_000 });
  assert.equal(server.calls.length, 1, 'fresh enough: no request');
  cache.load('/api/admin/tests', { maxAgeMs: 0 });
  assert.equal(server.calls.length, 2, 'stale: asked again');
});

test('an older reply landing after a newer request never paints over it', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const older = cache.load('/x');
  const newer = cache.load('/x', { force: true });
  server.calls[1].resolve('new');
  await newer;
  server.calls[0].resolve('old');
  await older;
  assert.equal(cache.peek('/x'), 'new');
});

test('written by hand (an action shown at once): a reply already on its way is thrown away', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const first = cache.load('/class');
  server.calls[0].resolve({ status: 'pending' });
  await first;
  const refresh = cache.load('/class', { force: true });
  cache.update('/class', (held) => ({ ...held, status: 'approved' }));
  server.calls[1].resolve({ status: 'pending' });
  await refresh;
  assert.deepEqual(cache.peek('/class'), { status: 'approved' });
});

test('a failed check keeps what was held, and says why', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const first = cache.load('/x');
  server.calls[0].resolve('kept');
  await first;
  const again = cache.load('/x', { force: true }).catch((error) => error);
  server.calls[1].reject(new Error('No connection'));
  await again;
  assert.equal(cache.entry('/x').data, 'kept');
  assert.equal(cache.entry('/x').error.message, 'No connection');
});

test('another account: everything forgotten, and replies still on their way thrown away', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  const seen = [];
  cache.subscribe('/api/me/results', () => seen.push(cache.peek('/api/me/results')));
  const loading = cache.load('/api/me/results');
  cache.clear();
  server.calls[0].resolve({ results: ['the last student\'s'] });
  await loading;
  assert.equal(cache.peek('/api/me/results'), undefined);
  assert.deepEqual(seen, [undefined], 'the page was told to forget');
});

test('dropped by prefix: the next page asks and waits', async () => {
  const cache = createCache(async (url) => url);
  await cache.load('/api/admin/tests');
  await cache.load('/api/admin/home');
  await cache.load('/api/me/results');
  cache.drop('/api/admin/');
  assert.equal(cache.peek('/api/admin/tests'), undefined);
  assert.equal(cache.peek('/api/admin/home'), undefined);
  assert.equal(cache.peek('/api/me/results'), '/api/me/results');
});

test('fetching ahead never throws and skips what is fresh or on its way', async () => {
  const server = slowServer();
  const cache = createCache(server.fetcher);
  cache.prefetch('/r');
  cache.prefetch('/r');
  assert.equal(server.calls.length, 1);
  server.calls[0].reject(new Error('offline'));
  await settle();
  assert.equal(cache.peek('/r'), undefined);
});

test('what each page reads first - and never anything for a test or a register', () => {
  const origin = 'https://quiz.example';
  const data = (href, role) => routeData(href, role, origin);
  assert.deepEqual(data('/?page=results', 'student'), ['/api/me/results', '/api/student/profile']);
  assert.deepEqual(data('/?result=test-abc', 'student'), ['/api/me/results', '/api/me/results/TEST-ABC/responses']);
  assert.deepEqual(data('/?admin=tests', 'admin'), ['/api/admin/tests', '/api/me/results']);
  assert.deepEqual(data('/?admin=tests&view=taken', 'admin'), ['/api/admin/tests', '/api/me/results']);
  assert.deepEqual(data('/?admin=quizzes', 'admin'), ['/api/admin/tests']);
  assert.deepEqual(data('/?admin=results', 'admin'), ['/api/admin/tests', '/api/me/results']);
  assert.deepEqual(data('/?admin=results&view=taken', 'admin'), ['/api/admin/tests', '/api/me/results']);
  assert.deepEqual(data('/?admin=test-abc&tab=responses', 'admin'), ['/api/admin/tests/TEST-ABC?section=students&page=1&pageSize=200']);
  assert.deepEqual(data('/', 'admin'), ['/api/admin/home', '/api/admin/tests', '/api/admin/attendance']);
  assert.deepEqual(data('/', 'student'), ['/api/me/results', '/api/student/profile']);
  assert.deepEqual(data('/', null), [], 'no guess without a remembered account kind');
  assert.deepEqual(data('/?result=test-abc', null), [], 'a results link opened signed out (from an email) reads nothing before sign-in');
  assert.deepEqual(data('/?admin=test-abc', null), []);
  assert.deepEqual(data('/?admin=quizzes', null), []);
  assert.deepEqual(data('/?admin=results', null), []);
  assert.deepEqual(data('/?test=TEST-ABC', 'student'), []);
  assert.deepEqual(data('/?attend=ATT-1', 'student'), []);
  assert.deepEqual(data('/?admin=edit&code=TEST-ABC', 'admin'), [], 'an editor always reads the paper fresh');
  assert.deepEqual(data('https://elsewhere.example/?page=results', 'student'), []);
});

test('the canonical quiz and result lists preload their shared screen, never a RESULTS or QUIZZES dashboard', () => {
  const origin = 'https://quiz.example';
  for (const admin of ['quizzes', 'results', 'tests']) {
    assert.deepEqual(routeScreens(`/?admin=${admin}`, 'admin', origin), [screens.admin, screens.testList]);
  }
  assert.deepEqual(routeScreens('/?admin=TEST-ABC&tab=analysis', 'admin', origin), [screens.admin, screens.dashboard]);
  assert.deepEqual(routeScreens('https://elsewhere.example/?admin=results', 'admin', origin), []);
});
