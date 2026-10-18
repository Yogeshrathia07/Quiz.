import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { noteRequest, probeReach, reachToken, resetReach, setReachGiveBack, unreachable } from '../src/services/reachability.js';

// The server's own ask at its public address: answered by it (its token), by something else, or not at all.
const answers = (token) => async () => ({ ok: true, json: async () => ({ token }) });
const offline = async () => { throw new TypeError('fetch failed'); };
const tunnelDown = async () => ({ ok: false, status: 530, json: async () => { throw new SyntaxError('an error page'); } });
const ask = (fetchImpl) => probeReach({ testsRunning: true, fetchImpl });
const throughTunnel = { headers: { 'cf-ray': '8a1b2c3d4e5f-BOM' } };
const local = { headers: {} };

// The time given back, as outage.js would - without a database.
const givenBack = [];
test.beforeEach(() => {
  config.publicBaseUrl = 'https://exam.example.org';
  resetReach(Date.now() - 10_000);
  givenBack.length = 0;
  setReachGiveBack(async (from, now, cause) => {
    const outage = { from, ms: now - from, tests: 1, gaveBack: true, cause };
    givenBack.push(outage);
    return outage;
  });
});

test('nothing is asked with no test running, no public address, or an address on this machine', async () => {
  assert.equal((await probeReach({ testsRunning: false, fetchImpl: offline })).asked, false);
  config.publicBaseUrl = '';
  assert.equal((await ask(offline)).asked, false);
  config.publicBaseUrl = 'http://localhost:3000';
  assert.equal((await ask(offline)).asked, false);
  assert.equal(unreachable(), false);
});

test('an address that has never answered is no evidence: however many asks fail, nothing is held', async () => {
  for (let round = 0; round < 5; round += 1) await ask(offline);
  assert.equal(unreachable(), false);
});

test('two failed asks after a good one, with nothing from outside meanwhile: students cannot reach the server', async () => {
  assert.equal((await ask(answers(reachToken()))).ok, true);
  await ask(offline);
  assert.equal(unreachable(), false, 'one failure is a blip');
  await ask(tunnelDown);
  assert.equal(unreachable(), true, 'the tunnel\'s error page is no answer from the server');
});

test('an answer that is not this server\'s (another server, a cached page) is a failure', async () => {
  await ask(answers(reachToken()));
  await ask(answers('someone-else'));
  await ask(answers(undefined));
  assert.equal(unreachable(), true);
});

test('a student\'s request through the tunnel is proof of reach; one from this machine is not', async () => {
  await ask(answers(reachToken()));
  await ask(offline);
  assert.equal(noteRequest(local), null, 'the admin on this machine proves nothing');
  noteRequest(throughTunnel);
  await ask(offline);
  assert.equal(unreachable(), false, 'a student got through between the two failures');
  await ask(offline);
  assert.equal(unreachable(), true);
  // Back: over, and however short, its time given back - from the last thing that got through - before this request goes on.
  const outage = await noteRequest(throughTunnel);
  assert.equal(unreachable(), false);
  assert.equal(outage.cause, 'network');
  assert.equal(givenBack.length, 1, 'given back once');
  assert.equal(await noteRequest(throughTunnel), null, 'nothing more to give back');
});

test('the token is the same for every process of a deployment, and tells nothing of the secret', () => {
  assert.equal(reachToken(), reachToken());
  assert.match(reachToken(), /^[0-9a-f]{32}$/);
  assert.ok(!reachToken().includes(String(config.sessionSecret).slice(0, 8)));
});
