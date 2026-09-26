module.exports = {
  apps: [{
    name: 'campus-quiz',
    script: 'src/server.js',
    exec_mode: 'cluster',
    instances: process.env.WEB_CONCURRENCY || 'max',
    kill_timeout: 15_000,
    listen_timeout: 20_000,
    env: {
      QUIZ_CLUSTERED: 'true'
    },
    env_production: {
      NODE_ENV: 'production',
      QUIZ_CLUSTERED: 'true'
    }
  }]
};
