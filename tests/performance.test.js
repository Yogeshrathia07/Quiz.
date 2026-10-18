import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { cachedJson, invalidateCached } from '../src/coordination/index.js';
import { dashboardCounts, paginateDashboard } from '../src/services/admin-service.js';
import { config } from '../src/config.js';
import { isLiveStreamRequest, isPollableRequest, trafficMiddleware } from '../src/services/traffic.js';
import { closeExportWorkers, runExportJob } from '../src/export/worker-pool.js';
import { attemptRevision, compactAnswerResponse } from '../src/domain/attempt-sync.js';

after(() => closeExportWorkers());

test('read-through cache collapses a burst, returns copies and invalidates', async () => {
  const key = `unit:${Date.now()}:${Math.random()}`;
  let loads = 0;
  const load = async () => { loads += 1; return { nested: { value: loads } }; };
  const burst = await Promise.all(Array.from({ length: 30 }, () => cachedJson(key, load, 5_000)));
  assert.equal(loads, 1);
  burst[0].nested.value = 99;
  assert.equal((await cachedJson(key, load, 5_000)).nested.value, 1, 'a caller cannot mutate the cached copy');
  await invalidateCached(key);
  assert.equal((await cachedJson(key, load, 5_000)).nested.value, 2);
  assert.equal(loads, 2);
});

const rows = Array.from({ length: 260 }, (_unused, index) => ({
  id: `r${index}`,
  name: index === 259 ? 'Needle Student' : `Student ${index}`,
  email: index % 2 ? `guest-${index}@guest.test` : `student-${index}@stu.upes.ac.in`,
  sapId: String(700000000 + index),
  accountType: index % 2 ? 'guest' : 'student',
  status: index % 3 === 0 ? 'pending' : 'approved',
  attemptStatus: index % 4 === 0 ? 'submitted' : index % 4 === 1 ? 'in_progress' : null,
  isLocked: index % 12 === 1,
  isPaused: index % 20 === 1,
  submittedBy: index % 8 === 0 ? 'student' : 'time',
  manualTotal: index % 4 === 0 ? 2 : 0,
  manualGraded: index % 16 === 0 ? 1 : 2,
  extraMs: 0
}));
const dashboard = { test: { code: 'TEST-PAGE' }, registrations: rows };

test('dashboard pagination bounds payloads and reports whole-class counts', () => {
  const page = paginateDashboard(dashboard, { section: 'students', page: 2, pageSize: 100 });
  assert.equal(page.registrations.length, 100);
  assert.deepEqual(page.pagination, { page: 2, pageSize: 100, total: 260, unfilteredTotal: 260, pages: 3, section: 'students' });
  assert.deepEqual(page.counts, dashboardCounts(rows));
  assert.equal(dashboard.registrations.length, 260, 'pagination does not mutate the source dashboard');
});

test('dashboard server search and grouped filters compose correctly', () => {
  const found = paginateDashboard(dashboard, { section: 'students', search: 'needle', pageSize: 100 });
  assert.deepEqual(found.registrations.map((row) => row.id), ['r259']);

  const filtered = paginateDashboard(dashboard, {
    section: 'students', pageSize: 200,
    filters: ['pending', 'approved', 'guest', 'paper:locked']
  });
  assert.ok(filtered.registrations.length > 0);
  assert.ok(filtered.registrations.every((row) => (
    ['pending', 'approved'].includes(row.status) && row.accountType === 'guest'
      && row.attemptStatus === 'in_progress' && row.isLocked && !row.isPaused
  )));

  const results = paginateDashboard(dashboard, { section: 'responses', pageSize: 100, filters: 'marking:awaiting' });
  assert.ok(results.registrations.every((row) => row.attemptStatus === 'submitted' && row.manualTotal > row.manualGraded));
  assert.equal(results.pagination.unfilteredTotal, rows.filter((row) => row.attemptStatus === 'submitted').length);
});

test('only safe repeatable GET routes are classified as pollable', () => {
  assert.equal(isPollableRequest('GET', '/api/tests/TEST-X'), true);
  assert.equal(isPollableRequest('GET', '/api/tests/TEST-X/attempt'), true);
  assert.equal(isPollableRequest('GET', '/api/admin/tests/TEST-X'), true);
  assert.equal(isPollableRequest('POST', '/api/test-attempts/a/answer'), false);
  assert.equal(isPollableRequest('POST', '/api/test-attempts/a/submit'), false);
  // Questions ahead and the next one's key: a paper moves on without them, only less quickly.
  assert.equal(isPollableRequest('GET', '/api/test-attempts/a/ahead'), true);
  assert.equal(isPollableRequest('POST', '/api/test-attempts/a/next-key'), true);
  assert.equal(isPollableRequest('POST', '/api/test-attempts/a/next'), false);
  assert.equal(isPollableRequest('GET', '/api/me/results'), false);
  assert.equal(isLiveStreamRequest('GET', '/api/tests/TEST-X/events'), true);
  assert.equal(isLiveStreamRequest('GET', '/api/admin/tests/TEST-X/events'), true);
  assert.equal(isLiveStreamRequest('POST', '/api/tests/TEST-X/events'), false);
  assert.equal(isLiveStreamRequest('GET', '/api/tests/TEST-X/attempt'), false);
});

test('live EventSource sockets do not consume active HTTP request capacity', () => {
  const before = { ...config.performance };
  config.performance.softActiveRequests = 1;
  config.performance.hardActiveRequests = 2;
  const response = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.set = () => res;
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => { res.body = body; res.emit('finish'); return res; };
    return res;
  };
  try {
    const stream = response();
    let streamRan = false;
    trafficMiddleware({ method: 'GET', path: '/api/tests/TEST-X/events' }, stream, () => { streamRan = true; });
    assert.equal(streamRan, true);

    const answer = response();
    let answerRan = false;
    trafficMiddleware({ method: 'POST', path: '/api/test-attempts/a/answer' }, answer, () => { answerRan = true; });
    assert.equal(answerRan, true, 'the idle live stream cannot consume an answer-write slot');
    answer.emit('finish');
  } finally {
    Object.assign(config.performance, before);
  }
});

test('overload protection sheds a poll before an answer write', () => {
  const before = { ...config.performance };
  config.performance.softActiveRequests = 1;
  config.performance.hardActiveRequests = 3;
  const response = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.set = () => res;
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => { res.body = body; res.emit('finish'); return res; };
    return res;
  };
  try {
    const held = response();
    let firstRan = false;
    trafficMiddleware({ method: 'POST', path: '/api/test-attempts/a/answer' }, held, () => { firstRan = true; });
    assert.equal(firstRan, true);

    const poll = response();
    let pollRan = false;
    trafficMiddleware({ method: 'GET', path: '/api/tests/TEST-X/attempt' }, poll, () => { pollRan = true; });
    assert.equal(pollRan, false);
    assert.equal(poll.statusCode, 503);
    assert.equal(poll.body.code, 'SERVER_BUSY');

    const answer = response();
    let answerRan = false;
    trafficMiddleware({ method: 'POST', path: '/api/test-attempts/b/answer' }, answer, () => { answerRan = true; });
    assert.equal(answerRan, true, 'critical writes use the capacity reserved above the soft threshold');
    answer.emit('finish');
    held.emit('finish');
  } finally {
    Object.assign(config.performance, before);
  }
});

test('spreadsheet generation runs in the background worker pool', async () => {
  const buffer = await runExportJob('attendance', {
    title: 'Worker check', code: 'ATT-WORK', presentCount: 0, pendingCount: 0, rejectedCount: 0,
    marks: [], rounds: [], createdAt: new Date()
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'an XLSX zip came back from the worker');
});

test('attempt revisions ignore clock-only heartbeats but detect real changes', () => {
  const first = { id: 'paper', serverTime: '2026-01-01T00:00:00.000Z', deadlineAt: '2026-01-01T01:00:00.000Z', answeredQuestionCount: 0 };
  assert.equal(attemptRevision(first), attemptRevision({ ...first, serverTime: '2026-01-01T00:00:20.000Z' }));
  assert.notEqual(attemptRevision(first), attemptRevision({ ...first, answeredQuestionCount: 1 }));
});

test('compact answer acknowledgement omits prompts and the rest of the paper', () => {
  const questions = Array.from({ length: 50 }, (_unused, index) => ({
    id: index + 1, prompt: `Long question ${index} ${'x'.repeat(200)}`, options: [{ id: '0', text: 'Choice' }],
    selectedOptions: index === 2 ? ['0'] : [], answerText: '', answered: index === 2, locked: false
  }));
  const attempt = { id: 'paper', status: 'in_progress', serverTime: new Date().toISOString(), answeredQuestionCount: 1, questions };
  const compact = compactAnswerResponse(attempt, 3);
  assert.equal(compact.answer.questionId, 3);
  assert.deepEqual(compact.answer.selectedOptions, ['0']);
  assert.equal(compact.state.questions, undefined);
  assert.ok(JSON.stringify(compact).length < JSON.stringify({ attempt }).length / 10, 'acknowledgement is at least 90% smaller');
});
