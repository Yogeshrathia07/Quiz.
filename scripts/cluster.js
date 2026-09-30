/**
 * Runs the portal as several server processes under PM2, sharing locks, the
 * test cache and live events through Redis (see ecosystem.config.cjs).
 *
 *   npm run cluster:start    build the client, make sure Redis is up, start (or restart) the processes
 *   npm run cluster:reload   build the client, then restart the processes one at a time - no downtime
 *   npm run cluster:stop     stop them (then `npm start` runs the single process again)
 *
 * WEB_CONCURRENCY sets how many processes (default 6: this laptop has 12
 * threads, and MongoDB and everything else need their share of its memory).
 *
 * On Windows, Node leaves sharing connections between the processes to the
 * operating system, which gives most of them to two or three: measured, the
 * rest sat idle and eight processes were no faster than one. Turn-taking
 * (round robin) must be set on PM2's own background process, which is why
 * `start` restarts it with NODE_CLUSTER_SCHED_POLICY=rr.
 */
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';

const APP = 'campus-quiz';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_CONTAINER = 'quiz-redis';
const command = process.argv[2];

const env = {
  ...process.env,
  NODE_CLUSTER_SCHED_POLICY: 'rr',
  WEB_CONCURRENCY: process.env.WEB_CONCURRENCY || '6',
  REDIS_URL
};
const run = (program, args, { quiet = false } = {}) => spawnSync(program, args, { env, shell: true, stdio: quiet ? 'pipe' : 'inherit' });
const fail = (message) => { console.error(`\n  ${message}\n`); process.exit(1); };

async function redisIsUp() {
  const client = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2_000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on('error', () => {});
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

async function ensureRedis() {
  if (await redisIsUp()) return;
  console.log('  Redis is not answering - starting its Docker container...');
  const started = run('docker', ['start', REDIS_CONTAINER], { quiet: true });
  if (started.status !== 0) {
    // First time on this computer: create it. Reachable from this computer only; keeps nothing on disk
    // (the portal stores only locks and a few seconds of cache there, never answers).
    const created = run('docker', ['run', '-d', '--name', REDIS_CONTAINER, '--restart', 'unless-stopped',
      '-p', '127.0.0.1:6379:6379', 'redis:7-alpine', 'redis-server', '--save', '""', '--appendonly', 'no']);
    if (created.status !== 0) fail('Could not start Redis. Is Docker Desktop running?');
  }
  for (let tries = 0; tries < 20; tries += 1) {
    if (await redisIsUp()) return;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  fail(`Redis did not answer at ${REDIS_URL}.`);
}

const build = () => { if (run('npm', ['run', 'build:client']).status !== 0) fail('The client build failed; nothing was changed.'); };

if (command === 'start') {
  build();
  await ensureRedis();
  // Restart PM2's background process with turn-taking on. Anything else it
  // was running is listed first, so nothing is stopped by surprise.
  const listed = String(run('pm2', ['jlist'], { quiet: true }).stdout || '');
  let running = [];
  try { running = JSON.parse(listed.slice(listed.indexOf('['))).map((entry) => entry.name).filter((name) => name !== APP); } catch { /* PM2 not running yet */ }
  if (running.length) fail(`PM2 is also running: ${[...new Set(running)].join(', ')}. Stop those first (pm2 delete <name>) - starting the portal restarts PM2.`);
  run('pm2', ['kill'], { quiet: true });
  if (run('pm2', ['start', 'ecosystem.config.cjs', '--update-env']).status !== 0) fail('PM2 could not start the portal.');
  run('pm2', ['save'], { quiet: true });
  console.log(`\n  The portal is running as ${env.WEB_CONCURRENCY} processes. Watch them with: pm2 monit\n`);
} else if (command === 'reload') {
  build();
  await ensureRedis();
  if (run('pm2', ['reload', APP, '--update-env']).status !== 0) fail('PM2 could not reload the portal. Is it running? (npm run cluster:start)');
  console.log('\n  Reloaded one process at a time - no downtime.\n');
} else if (command === 'stop') {
  run('pm2', ['delete', APP]);
  run('pm2', ['save', '--force'], { quiet: true });
  console.log('\n  Stopped. `npm start` runs the single process again.\n');
} else {
  fail('Use: node scripts/cluster.js start | reload | stop');
}
