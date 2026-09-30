import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { coordinationMode, onLiveEvent, publishLiveEvent, runAsLeader, serializeWrite } from '../src/coordination/index.js';

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('local coordination serializes the same resource in arrival order', async () => {
  assert.equal(coordinationMode(), 'local');
  const events = [];
  let active = 0;
  let mostActive = 0;
  await Promise.all([0, 1, 2, 3].map((index) => serializeWrite('same', async () => {
    active += 1;
    mostActive = Math.max(mostActive, active);
    events.push(`start-${index}`);
    await wait(4);
    events.push(`end-${index}`);
    active -= 1;
  })));
  assert.equal(mostActive, 1);
  assert.deepEqual(events, [
    'start-0', 'end-0', 'start-1', 'end-1',
    'start-2', 'end-2', 'start-3', 'end-3'
  ]);
});

test('local coordination lets unrelated resources run together', async () => {
  let active = 0;
  let mostActive = 0;
  const work = (key) => serializeWrite(key, async () => {
    active += 1;
    mostActive = Math.max(mostActive, active);
    await wait(10);
    active -= 1;
  });
  await Promise.all([work('one'), work('two')]);
  assert.equal(mostActive, 2);
});

test('one-process scheduler leadership runs normally without Redis', async () => {
  let calls = 0;
  const result = await runAsLeader('scheduler-test', async () => { calls += 1; return 42; });
  assert.deepEqual(result, { acquired: true, value: 42 });
  assert.equal(calls, 1);
});

test('a local live signal reaches subscribers without Redis', async () => {
  const received = [];
  const unsubscribe = onLiveEvent((event) => received.push(event));
  try {
    await publishLiveEvent({ code: 'TEST-LIVE', attemptId: 'attempt-1', kind: 'answer_saved' });
  } finally {
    unsubscribe();
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].code, 'TEST-LIVE');
  assert.equal(received[0].attemptId, 'attempt-1');
  assert.equal(received[0].kind, 'answer_saved');
  assert.equal(typeof received[0].at, 'number');
});

test('cluster startup is refused when REDIS_URL is missing', () => {
  const source = `
    import { initializeCoordination } from './src/coordination/index.js';
    initializeCoordination().then(() => process.exit(0)).catch((error) => {
      console.error(error.message);
      process.exit(12);
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, QUIZ_CLUSTERED: 'true', REDIS_URL: '' }
  });
  assert.equal(child.status, 12);
  assert.match(child.stderr, /REDIS_URL is required/);
});
