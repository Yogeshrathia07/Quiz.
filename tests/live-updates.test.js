import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { publishLiveEvent } from '../src/coordination/index.js';
import { closeLiveUpdates, liveUpdateStats, openAdminUpdates, openStudentUpdates } from '../src/realtime/live-updates.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.headers = null;
    this.ended = false;
    this.statusCode = 200;
    this.writeResults = [];
  }
  status(statusCode) { this.statusCode = statusCode; return this; }
  set(headers) { this.headers = headers; return this; }
  flushHeaders() {}
  write(message) { this.messages.push(message); return this.writeResults.shift() ?? true; }
  end() { this.ended = true; }
  json(body) { this.body = body; this.emit('finish'); return this; }
}

const open = (openFor, ...args) => {
  const request = new EventEmitter();
  const response = new FakeResponse();
  openFor(request, response, ...args);
  return { request, response };
};

test('live updates target one paper, while admins see every change in their test', async () => {
  const admin = open(openAdminUpdates, 'TEST-LIVE');
  const studentOne = open(openStudentUpdates, 'TEST-LIVE', 'attempt-1');
  const studentTwo = open(openStudentUpdates, 'TEST-LIVE', 'attempt-2');
  try {
    await publishLiveEvent({ code: 'TEST-LIVE', attemptId: 'attempt-1', kind: 'answer_saved' });
    assert.match(admin.response.messages.at(-1), /answer_saved/);
    assert.match(studentOne.response.messages.at(-1), /answer_saved/);
    assert.equal(studentTwo.response.messages.some((message) => message.includes('answer_saved')), false);

    await publishLiveEvent({ code: 'TEST-LIVE', broadcast: true, kind: 'test_started' });
    assert.match(studentOne.response.messages.at(-1), /test_started/);
    assert.match(studentTwo.response.messages.at(-1), /test_started/);
  } finally {
    admin.request.emit('close');
    studentOne.request.emit('close');
    studentTwo.request.emit('close');
    closeLiveUpdates();
  }
});

test('a slow live stream coalesces refreshes and resynchronises after drain', async () => {
  const student = open(openStudentUpdates, 'TEST-SLOW', 'attempt-slow');
  try {
    // The initial retry frame is accepted; the first live event fills the
    // writable buffer. Later events are represented by one resync signal.
    student.response.writeResults.push(false, true);
    await publishLiveEvent({ code: 'TEST-SLOW', attemptId: 'attempt-slow', kind: 'answer_saved' });
    await publishLiveEvent({ code: 'TEST-SLOW', attemptId: 'attempt-slow', kind: 'integrity' });
    assert.equal(liveUpdateStats().backpressured, 1);
    assert.equal(student.response.messages.some((message) => message.includes('integrity')), false);

    student.response.emit('drain');
    assert.equal(liveUpdateStats().backpressured, 0);
    assert.match(student.response.messages.at(-1), /"kind":"resync"/);
  } finally {
    student.request.emit('close');
    closeLiveUpdates();
  }
});

test('live streams have a separate bounded cap', () => {
  const previousLimit = process.env.LIVE_STREAM_LIMIT;
  process.env.LIVE_STREAM_LIMIT = '1';
  const first = open(openAdminUpdates, 'TEST-CAP');
  const second = open(openAdminUpdates, 'TEST-CAP');
  try {
    assert.equal(liveUpdateStats().active, 1);
    assert.equal(second.response.statusCode, 503);
    assert.equal(second.response.body.code, 'LIVE_STREAM_BUSY');
  } finally {
    first.request.emit('close');
    closeLiveUpdates();
    if (previousLimit === undefined) delete process.env.LIVE_STREAM_LIMIT;
    else process.env.LIVE_STREAM_LIMIT = previousLimit;
  }
});
