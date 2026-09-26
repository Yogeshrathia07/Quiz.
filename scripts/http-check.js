/**
 * End-to-end over real HTTP. The audit and the regression check call services
 * directly, which skips everything Express does: routing, the session and
 * registration cookies, the role guards, JSON serialisation, and the error
 * handler. This boots the server and walks a student all the way through as a
 * browser would, then probes the guards from outside.
 *
 * Run with `npm run check:http`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeDatabase, initializeDatabase, registrations, studentProfiles, tests } from '../src/db/index.js';
import { testDocByCode } from '../src/data/test-repository.js';
import { createTest } from '../src/services/test-service.js';
import { decideRegistration, startTest } from '../src/services/admin-service.js';

const PORT = Number(process.env.HTTP_CHECK_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const run = `${Date.now()}`;
const admin = { portalUser: { email: `http-${run}@ddn.upes.ac.in`, displayName: 'HTTP Admin', role: 'admin' } };

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
};

/** A cookie jar, because the whole point is to exercise the real cookies. */
function jar() {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    take(response) {
      for (const line of response.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        store.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    size: () => store.size
  };
}

async function call(cookies, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookies && cookies.size() ? { cookie: cookies.header() } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (cookies) cookies.take(response);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, type: response.headers.get('content-type') || '', headers: response.headers };
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['src/server.js'], {
    // This check mutates MongoDB from its parent process rather than through
    // the HTTP server. Disable that child process's local cache so the unusual
    // two-process fixture sees those direct writes immediately.
    env: { ...process.env, PORT: String(PORT), REDIS_TEST_CACHE_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 25_000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
  });
  await ready;
}

const payload = {
  title: `HTTP check ${run}`,
  instructions: 'Walked over real HTTP.',
  opensAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  questionMix: { mcq: 1, msq: 1, short: 1 },
  allowGuests: true,
  shuffleQuestions: true,
  resultReleaseMode: 'instant',
  fullscreenExitLimit: 0,
  fullscreenAbsenceLimitSeconds: 0,
  questions: [
    { prompt: 'Which structure is FIFO?', type: 'mcq', options: ['Stack', 'Queue', 'Tree'], correctOptions: ['1'] },
    { prompt: 'Which are HTTP methods?', type: 'msq', options: ['GET', 'POST', 'FETCH'], correctOptions: ['0', '1'] },
    { prompt: 'Explain a queue.', type: 'short' }
  ]
};

const codes = [];
const emails = [];

await initializeDatabase();
try {
  const created = await createTest(admin, payload);
  const code = created.test.code;
  codes.push(code);
  await startServer();

  /* ------------------------------------------------- guards, from outside */
  await check('an anonymous caller cannot reach the admin portal', async () => {
    assert.equal((await call(null, 'GET', '/api/admin/tests')).status, 403);
    assert.equal((await call(null, 'GET', `/api/admin/tests/${code}`)).status, 403);
    assert.equal((await call(null, 'POST', `/api/admin/tests/${code}/start`)).status, 403);
    assert.equal((await call(null, 'POST', `/api/admin/tests/${code}/end-time`, { addMinutes: 10 })).status, 403);
  });

  await check('an anonymous caller cannot reach a student route', async () => {
    assert.equal((await call(null, 'GET', `/api/tests/${code}/attempt`)).status, 403);
    assert.equal((await call(null, 'POST', `/api/tests/${code}/start`)).status, 403);
    assert.equal((await call(null, 'GET', '/api/student/profile')).status, 403);
  });

  await check('the public test view is readable without signing in, and leaks nothing', async () => {
    const { status, data } = await call(null, 'GET', `/api/tests/${code}`);
    assert.equal(status, 200);
    assert.equal(data.test.code, code);
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes('Which structure is FIFO?'), false);
    assert.equal(serialized.includes('correctOptions'), false);
    assert.equal(serialized.includes('ownerEmail'), false);
  });

  await check('unknown API routes answer JSON, not HTML', async () => {
    const missing = await call(null, 'GET', '/api/not-a-route');
    assert.equal(missing.status, 404);
    assert.match(missing.type, /application\/json/);
    assert.equal(missing.data.error, 'Endpoint not found.');
  });

  await check('the built client is served at the root', async () => {
    const page = await call(null, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(String(page.data), /<div id="root">/);
  });

  await check('hashed bundles are cacheable, the page and API are not', async () => {
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-store', 'the page must not be cached');

    const asset = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)[0];
    const bundle = await fetch(`${BASE}/${asset}`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('cache-control'), /max-age=31536000/);
    assert.match(bundle.headers.get('cache-control'), /immutable/);

    const apiResponse = await fetch(`${BASE}/api/auth/status`);
    assert.equal(apiResponse.headers.get('cache-control'), 'no-store', 'API answers must always be live');
  });

  await check('the service worker is served, uncached, and never touches the API', async () => {
    const sw = await fetch(`${BASE}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('cache-control'), 'no-store', 'so a deployment replaces it');
    const source = await sw.text();
    assert.match(source, /\/api\//, 'it names the API...');
    assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/, '...only to refuse to handle it');
  });

  await check('the QR renders as SVG', async () => {
    const qr = await call(null, 'GET', `/api/tests/${code}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.type, /image\/svg/);
  });

  /* --------------------------------------- a student, all the way through */
  const cookies = jar();
  let attemptId = null;

  await check('a guest session is issued and the cookie comes back', async () => {
    const { status, data } = await call(cookies, 'POST', '/api/auth/guest', { name: 'HTTP Walker', testCode: code });
    assert.equal(status, 201, data?.error);
    assert.equal(data.user.isGuest, true);
    emails.push(data.user.email);
    assert.ok(cookies.size() > 0, 'a session cookie was set');

    const status2 = await call(cookies, 'GET', '/api/auth/status');
    assert.equal(status2.data.user.isGuest, true, 'the cookie authenticates the next request');
  });

  await check('the student registers and is told they are pending', async () => {
    const { status, data } = await call(cookies, 'POST', `/api/tests/${code}/register`, { sapId: String(500_000_000 + (Date.now() % 90_000_000)) });
    assert.equal(status, 201);
    assert.equal(data.registration.status, 'pending');
  });

  await check('an unapproved student is refused the start', async () => {
    assert.equal((await call(cookies, 'POST', `/api/tests/${code}/start`, {})).status, 403);
  });

  await check('once approved and started, the paper arrives', async () => {
    const doc = await testDocByCode(code);
    await decideRegistration(admin, code, doc.registrations[0].id, 'approve');
    await startTest(admin, code);

    const { status, data } = await call(cookies, 'POST', `/api/tests/${code}/start`, {});
    assert.equal(status, 201, data?.error);
    attemptId = data.attempt.id;
    assert.equal(data.attempt.questions.length, 3);
    assert.equal(data.attempt.timeOver, false);
    assert.ok(data.attempt.deadlineAt, 'the deadline is published');
    assert.equal(JSON.stringify(data).includes('correctOptions'), false);
  });

  await check('answers save over HTTP and come back on the next read', async () => {
    const paper = (await call(cookies, 'GET', `/api/tests/${code}/attempt`)).data.attempt;
    const mcq = paper.questions.find((question) => question.type === 'mcq');
    const queue = mcq.options.find((option) => option.text === 'Queue');

    const saved = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, {
      questionId: mcq.id, selectedOptions: [queue.id]
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.attempt.answeredQuestionCount, 1);

    const reread = (await call(cookies, 'GET', `/api/tests/${code}/attempt`)).data.attempt;
    const stored = reread.questions.find((question) => question.id === mcq.id);
    assert.deepEqual(stored.selectedOptions, [queue.id], 'the answer survives the round trip');
  });

  await check('compact saves and revision heartbeats avoid repeating the paper', async () => {
    const full = await call(cookies, 'GET', `/api/tests/${code}/attempt`);
    const paper = full.data.attempt;
    assert.ok(paper.revision, 'the full paper carries its revision');
    assert.match(full.headers.get('content-encoding') || '', /gzip|br|deflate/, 'the full JSON paper is compressed');

    const unchanged = await call(cookies, 'GET', `/api/tests/${code}/attempt?revision=${encodeURIComponent(paper.revision)}`);
    assert.equal(unchanged.status, 204);

    const mcq = paper.questions.find((question) => question.type === 'mcq');
    const compact = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, {
      questionId: mcq.id, selectedOptions: mcq.selectedOptions, compact: true
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.data.attempt, undefined);
    assert.equal(compact.data.answer.questionId, mcq.id);
    assert.equal(compact.data.state.questions, undefined);
    assert.ok(JSON.stringify(compact.data).length < JSON.stringify(full.data).length, 'compact response is smaller even on this three-question paper');
  });

  await check('integrity reports can share one request', async () => {
    const batch = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/events`, {
      events: [{ type: 'flag', detail: 'copy' }, { type: 'flag', detail: 'context_menu' }]
    });
    assert.equal(batch.status, 200, batch.data?.error);
    assert.equal(batch.data.processed, 2);
    assert.equal(batch.data.state.questions, undefined);
    assert.ok(batch.data.state.revision);
  });

  await check('a malformed answer is rejected with a readable error', async () => {
    const paper = (await call(cookies, 'GET', `/api/tests/${code}/attempt`)).data.attempt;
    const mcq = paper.questions.find((question) => question.type === 'mcq');
    const bad = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, {
      questionId: mcq.id, selectedOptions: ['99']
    });
    assert.equal(bad.status, 400);
    assert.ok(typeof bad.data.error === 'string' && bad.data.error.length > 0);

    const foreign = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, { questionId: 9999, selectedOptions: ['0'] });
    assert.equal(foreign.status, 404);
  });

  await check('a signed-in device with no registration is turned away from the paper', async () => {
    const sessionOnly = jar();
    const guest = await call(sessionOnly, 'POST', '/api/auth/guest', { name: 'Second Device', testCode: code });
    emails.push(guest.data.user.email);

    // 401, not 404: the registration cookie is what is missing, and saying so
    // is the actionable answer for a student who registered on another device.
    // Attempt ids are 18 random bytes, so this reveals nothing enumerable.
    for (const response of [
      await call(sessionOnly, 'GET', `/api/tests/${code}/attempt`),
      await call(sessionOnly, 'POST', `/api/test-attempts/${attemptId}/answer`, { questionId: 1, selectedOptions: ['0'] }),
      await call(sessionOnly, 'POST', `/api/test-attempts/${attemptId}/submit`)
    ]) {
      assert.equal(response.status, 401, response.data?.error);
      assert.match(response.data.error, /Register on this device/);
    }
  });

  await check('submitting scores the paper and the result is released', async () => {
    const paper = (await call(cookies, 'GET', `/api/tests/${code}/attempt`)).data.attempt;
    const msq = paper.questions.find((question) => question.type === 'msq');
    const short = paper.questions.find((question) => question.type === 'short');
    const pick = (text) => msq.options.find((option) => option.text === text).id;

    await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, { questionId: msq.id, selectedOptions: [pick('GET'), pick('POST')] });
    await call(cookies, 'POST', `/api/test-attempts/${attemptId}/answer`, { questionId: short.id, answerText: 'Arrival order.' });

    const submitted = await call(cookies, 'POST', `/api/test-attempts/${attemptId}/submit`);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.attempt.status, 'submitted');
    assert.equal(submitted.data.attempt.questions, undefined, 'a submitted paper withholds its questions');

    const result = (await call(cookies, 'GET', `/api/test-attempts/${attemptId}/result`)).data.result;
    assert.equal(result.released, false, 'the short answer still needs marking');
    assert.equal(result.releaseMode, 'manual');
  });

  await check('signing out stops the session working', async () => {
    assert.equal((await call(cookies, 'POST', '/api/auth/logout')).status, 204);
    assert.equal((await call(cookies, 'GET', '/api/auth/status')).data.user, null);
    assert.equal((await call(cookies, 'GET', `/api/tests/${code}/attempt`)).status, 403);
  });
} finally {
  if (server) server.kill();
  if (codes.length) {
    await tests().deleteMany({ code: { $in: codes } });
    await registrations().deleteMany({ testCode: { $in: codes } });
  }
  if (emails.length) await studentProfiles().deleteMany({ email: { $in: emails } });
  await closeDatabase();

  const failed = results.filter((entry) => !entry.ok);
  for (const entry of results) {
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
    if (!entry.ok) console.log(`        ${entry.error.replaceAll('\n', '\n        ')}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} HTTP checks passed.`);
  if (failed.length) process.exitCode = 1;
}
