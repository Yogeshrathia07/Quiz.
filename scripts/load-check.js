/**
 * A whole class at once, over real HTTP.
 *
 * Boots the server and seats STUDENTS students (default 200) on one test, the
 * way a real exam goes: everyone registers, waits on the join page polling for
 * the start, begins the moment the admin presses Start, answers the paper
 * while the background refresh ticks and some of them leave and come back,
 * and then, as time runs out, everyone saves a last answer and presses Submit
 * in the same instant.
 *
 * It then checks the database, not just the responses: every paper submitted,
 * every answer the student sent is the one stored, every mark matches the
 * answer key, and every departure is on the record. It prints response times
 * per phase so a slow machine or database shows up as numbers.
 *
 *   npm run check:load                 # 200 students
 *   STUDENTS=100 npm run check:load
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeDatabase, initializeDatabase, portalSessions, registrations, studentProfiles, tests } from '../src/db/index.js';
import { testDocByCode } from '../src/data/test-repository.js';
import { createTest } from '../src/services/test-service.js';
import { bulkDecision, startTest } from '../src/services/admin-service.js';

const STUDENTS = Number(process.env.STUDENTS || 200);
const QUESTIONS = Number(process.env.QUESTIONS || 20);
// Large focused runs can prepare students in bounded batches while still
// firing the answer and submit phases in one true simultaneous burst.
const SETUP_CONCURRENCY = Math.max(1, Number(process.env.SETUP_CONCURRENCY || STUDENTS));
const RESULT_CONCURRENCY = Math.max(1, Number(process.env.RESULT_CONCURRENCY || STUDENTS));
const WAITING_ROUNDS = Math.max(0, Number(process.env.WAITING_ROUNDS ?? 3));
const BACKGROUND_POLLING = process.env.BACKGROUND_POLLING !== '0';
const ANSWER_JITTER_MS = Math.max(0, Number(process.env.ANSWER_JITTER_MS ?? 2000));
const PORT = Number(process.env.LOAD_CHECK_PORT || 3997);
const BASE = `http://127.0.0.1:${PORT}`;
const run = `${Date.now()}`;
const admin = { portalUser: { email: `load-${run}@ddn.upes.ac.in`, displayName: 'Load Admin', role: 'admin' } };

/* ---------------------------------------------------------------- plumbing */

function jar() {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
    take(response) {
      for (const line of response.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        store.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }
  };
}

const timings = new Map();
const failures = new Map();
const retries = new Map();
function note(phase, ms, ok, detail) {
  if (!timings.has(phase)) timings.set(phase, []);
  timings.get(phase).push(ms);
  if (!ok) {
    const list = failures.get(phase) || [];
    list.push(detail);
    failures.set(phase, list);
  }
}

async function call(phase, cookies, method, path, body, { deferFailure = false } = {}) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookies.header() },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    note(phase, performance.now() - started, deferFailure, `network: ${error.message} (${error.cause?.code || error.cause?.message || "no cause"})`);
    throw error;
  }
  cookies.take(response);
  const data = await response.json().catch(() => null);
  const ok = response.ok;
  note(phase, performance.now() - started, ok || deferFailure, `${response.status} ${data?.error || ''}`.trim());
  if (!ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${data?.error || ''}`), { status: response.status });
  return data;
}

/** Mirrors the browser: queued answers and idempotent submits retry a burst. */
async function retryCall(phase, cookies, method, path, body, rounds = 6) {
  const started = performance.now();
  let last;
  for (let round = 0; round <= rounds; round += 1) {
    try {
      const data = await call(phase, cookies, method, path, body, { deferFailure: true });
      note(`${phase} eventual`, performance.now() - started, true, '');
      return data;
    } catch (error) {
      last = error;
      if (round >= rounds || (error.status && error.status < 500 && error.status !== 408 && error.status !== 429)) break;
      retries.set(phase, (retries.get(phase) || 0) + 1);
      await pause(Math.min(4_000, 200 * (2 ** round)) * (0.5 + Math.random()));
    }
  }
  note(`${phase} eventual`, performance.now() - started, false, last?.message || 'failed after retries');
  throw last;
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] || 0;
};
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function mapConcurrent(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

let server = null;
let serverExit = null;
let polling = false;
async function startServer() {
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 25_000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('running at')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
  });
}

/* -------------------------------------------------------------- the paper */

const questions = Array.from({ length: QUESTIONS }, (_value, index) => (index % 4 === 3
  ? { prompt: `Load question ${index + 1}: pick every even number.`, type: 'msq', options: ['1', '2', '3', '4'], correctOptions: ['1', '3'] }
  : { prompt: `Load question ${index + 1}: which option is B?`, type: 'mcq', options: ['A', 'B', 'C', 'D'], correctOptions: ['1'] }));

const payload = {
  title: `Load check ${run}`,
  instructions: 'A whole class at once.',
  opensAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  questionMix: { mcq: questions.filter((q) => q.type === 'mcq').length, msq: questions.filter((q) => q.type === 'msq').length, short: 0 },
  allowGuests: true,
  shuffleQuestions: true,
  resultReleaseMode: 'instant',
  // No lock, so every departure below must still be counted, not acted on.
  fullscreenExitLimit: 0,
  fullscreenAbsenceLimitSeconds: 0,
  questions
};

/* ---------------------------------------------------------------- the run */

let code = null;
const emails = [];
await initializeDatabase();
try {
  code = (await createTest(admin, payload)).test.code;
  await startServer();
  const wall = performance.now();

  // 1. Everyone signs in as a guest and registers.
  const students = Array.from({ length: STUDENTS }, (_value, index) => ({
    index, cookies: jar(), sapId: String(700_000_000 + (Number(run.slice(-6)) * 7 + index) % 299_999_999), sent: new Map(), leaves: 0
  }));
  await mapConcurrent(students, SETUP_CONCURRENCY, async (student) => {
    const guest = await call('register', student.cookies, 'POST', '/api/auth/guest', { testCode: code, name: `Load student ${student.index}` });
    student.email = guest.user.email;
    emails.push(student.email);
    await call('register', student.cookies, 'POST', `/api/tests/${code}/register`, { sapId: student.sapId });
  });
  await bulkDecision(admin, code, 'approve');

  // 2. The waiting room: everyone polls the join page.
  for (let round = 0; round < WAITING_ROUNDS; round += 1) {
    await mapConcurrent(students, SETUP_CONCURRENCY, (student) => call('waiting poll', student.cookies, 'GET', `/api/tests/${code}`));
  }

  // 3. The admin presses Start and every student begins in the same instant.
  await startTest(admin, code);
  // The simulator's administrator runs in this parent process, unlike a real
  // administrator request. Let the child server's local test cache expire;
  // Redis deployments invalidate the shared key immediately in real use.
  await pause(Number(process.env.REDIS_TEST_CACHE_MS || 5_000) + 100);
  await mapConcurrent(students, SETUP_CONCURRENCY, async (student) => {
    student.attempt = (await call('start', student.cookies, 'POST', `/api/tests/${code}/start`, {})).attempt;
  });

  // Like a real paper, every student's page checks in every 10-15 s from the
  // moment it opens until it is submitted - also while they wait for the rest.
  polling = BACKGROUND_POLLING;
  const pollers = BACKGROUND_POLLING ? students.map((student) => (async () => {
    while (polling) {
      await pause(10_000 + Math.random() * 5_000);
      if (polling && !student.submitted) await call('background poll', student.cookies, 'GET', `/api/tests/${code}/attempt`).catch(() => {});
    }
  })()) : [];

  // 4. Sitting the paper: answers, background refreshes, leaving and coming back.
  const keyByPrompt = new Map(questions.map((question) => [question.prompt, question]));
  await mapConcurrent(students, SETUP_CONCURRENCY, async (student) => {
    if (ANSWER_JITTER_MS) await pause(Math.random() * ANSWER_JITTER_MS);
    for (const [position, question] of student.attempt.questions.entries()) {
      const source = keyByPrompt.get(question.prompt);
      // Aim for a varied score: the correct option by option TEXT, or a wrong one.
      const wantCorrect = (student.index + position) % 3 !== 0;
      const pick = source.type === 'msq'
        ? question.options.filter((option) => (wantCorrect ? ['2', '4'] : ['1']).includes(option.text)).map((option) => option.id)
        : [question.options.find((option) => option.text === (wantCorrect ? 'B' : 'C')).id];
      await call('answer', student.cookies, 'POST', `/api/test-attempts/${student.attempt.id}/answer`, { questionId: question.id, selectedOptions: pick, compact: true });
      student.sent.set(question.id, [...pick].sort());
      if (position % 5 === 4) await call('refresh', student.cookies, 'GET', `/api/tests/${code}/attempt`);
      if (student.index % 4 === 0 && position % 7 === 3) {
        await call('leave/return', student.cookies, 'POST', `/api/test-attempts/${student.attempt.id}/events`, {
          events: [{ type: 'exit', detail: 'tab_switch' }, { type: 'return', durationMs: 1_500 }]
        });
        student.leaves += 1;
      }
    }
  });

  // 5. Time is up: every page saves its last answer in the same instant (the
  // paper flushes what it still holds before submitting), then everyone
  // presses Submit in the same instant.
  const answerBurstOutcomes = await Promise.allSettled(students.map((student) => {
    const [questionId, pick] = [...student.sent.entries()].pop();
    return retryCall('answer burst', student.cookies, 'POST', `/api/test-attempts/${student.attempt.id}/answer`, { questionId, selectedOptions: pick, compact: true });
  }));
  const submitStarted = performance.now();
  const submitOutcomes = await Promise.allSettled(students.map(async (student) => {
    await retryCall('submit', student.cookies, 'POST', `/api/test-attempts/${student.attempt.id}/submit`);
    student.submitted = true;
  }));
  const submitWallMs = performance.now() - submitStarted;
  polling = false;
  await mapConcurrent(students.filter((student) => student.submitted), RESULT_CONCURRENCY, (student) => call('result', student.cookies, 'GET', `/api/test-attempts/${student.attempt.id}/result`));
  const wallMs = performance.now() - wall;
  const answerBurstFailed = answerBurstOutcomes.filter((outcome) => outcome.status === 'rejected').length;
  const submitFailed = submitOutcomes.filter((outcome) => outcome.status === 'rejected').length;
  if (answerBurstFailed || submitFailed) {
    throw new Error(`${answerBurstFailed} simultaneous answers and ${submitFailed} simultaneous submissions failed`);
  }

  // 6. What actually landed in the database.
  const doc = await testDocByCode(code);
  const bank = new Map(doc.questions.map((question) => [question.id, question]));
  let checked = 0;
  for (const student of students) {
    const registration = doc.registrations.find((entry) => entry.collegeEmail === student.email);
    assert.ok(registration?.attempt, `student ${student.index} has an attempt`);
    const { attempt } = registration;
    assert.equal(attempt.status, 'submitted', `student ${student.index} is submitted`);
    for (const answer of attempt.answers) {
      assert.deepEqual([...answer.selectedOptions].sort(), student.sent.get(answer.questionId), `student ${student.index} q${answer.questionId} kept the answer sent`);
      const key = [...bank.get(answer.questionId).correctOptions].map(String).sort();
      const expected = Number(key.length === answer.selectedOptions.length && key.every((value, i) => value === [...answer.selectedOptions].sort()[i]));
      assert.equal(answer.isCorrect, expected, `student ${student.index} q${answer.questionId} is marked right`);
      checked += 1;
    }
    assert.equal(attempt.integrity.leaveCount, student.leaves, `student ${student.index} departures are all recorded`);
  }
  // Each student is their own document; the 16 MB limit applies to each one.
  const largest = Math.max(...doc.registrations.map((entry) => JSON.stringify(entry).length));

  /* ------------------------------------------------------------- report */
  console.log(`\n  ${STUDENTS} students, ${QUESTIONS} questions each, in ${(wallMs / 1000).toFixed(1)} s`);
  console.log(`  All ${STUDENTS} submitted in the same instant; the last confirmation came after ${(submitWallMs / 1000).toFixed(2)} s.\n`);
  console.log('  phase            requests    p50      p95      max');
  for (const [phase, values] of timings) {
    const row = [phase.padEnd(16), String(values.length).padStart(8),
      `${percentile(values, 50).toFixed(0)} ms`.padStart(8), `${percentile(values, 95).toFixed(0)} ms`.padStart(8),
      `${Math.max(...values).toFixed(0)} ms`.padStart(8)];
    console.log(`  ${row.join(' ')}`);
  }
  console.log(`\n  Verified ${checked} stored answers and marks, and every departure.`);
  if (retries.size) console.log(`  Transient burst retries: ${[...retries].map(([phase, count]) => `${phase} ${count}`).join(', ')}.`);
  console.log(`  Largest student document: ${(largest / 1024).toFixed(1)} KB of MongoDB's 16 MB limit per document.`);
  const failed = [...failures.values()].flat();
  if (failed.length) {
    console.log(`\n  ${failed.length} requests failed:`);
    for (const [phase, list] of failures) console.log(`    ${phase}: ${list.slice(0, 5).join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('  No request failed.\n');
  }
} catch (error) {
  console.error(`\n  Load check failed: ${error.message}`);
  if (serverExit) console.error(`    server exited: code ${serverExit.code ?? 'none'}, signal ${serverExit.signal ?? 'none'}`);
  else console.error('    server process was still running when the failure was observed.');
  if (timings.size) {
    console.error('\n  phase            requests    p50      p95      max');
    for (const [phase, values] of timings) {
      const row = [phase.padEnd(16), String(values.length).padStart(8),
        `${percentile(values, 50).toFixed(0)} ms`.padStart(8), `${percentile(values, 95).toFixed(0)} ms`.padStart(8),
        `${Math.max(...values).toFixed(0)} ms`.padStart(8)];
      console.error(`  ${row.join(' ')}`);
    }
  }
  const failed = [...failures.entries()];
  for (const [phase, list] of failed) console.error(`    ${phase}: ${list.length} failed, e.g. ${list.slice(0, 3).join('; ')}`);
  process.exitCode = 1;
} finally {
  polling = false;
  server?.kill();
  if (code) {
    await tests().deleteMany({ code });
    await registrations().deleteMany({ testCode: code });
  }
  if (emails.length) {
    await studentProfiles().deleteMany({ email: { $in: emails } });
    await portalSessions().deleteMany({ email: { $in: emails } });
  }
  await closeDatabase();
}
