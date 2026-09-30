/*
 * Several server processes, one per CPU thread (WEB_CONCURRENCY, or all of
 * them). They share locks, the test cache and live events through Redis,
 * which this starts them with; a single process started with `npm start`
 * does not need it and does not use it.
 *
 *   docker start quiz-redis          (or: npm run redis:start the first time)
 *   pm2 start ecosystem.config.cjs   (then: pm2 reload campus-quiz to update with no downtime)
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

module.exports = {
  apps: [{
    name: 'campus-quiz',
    script: 'src/server.js',
    exec_mode: 'cluster',
    instances: process.env.WEB_CONCURRENCY || 'max',
    kill_timeout: 15_000,
    // Windows cannot pass PM2's stop signal to a process: ask it by message
    // (server.js listens), so a reload lets each one finish its requests.
    shutdown_with_message: true,
    listen_timeout: 20_000,
    env: {
      QUIZ_CLUSTERED: 'true',
      REDIS_URL
    },
    env_production: {
      NODE_ENV: 'production',
      QUIZ_CLUSTERED: 'true',
      REDIS_URL
    }
  }]
};
