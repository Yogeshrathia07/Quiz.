import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { closeCoordination, initializeCoordination, serializeWrite } from './coordination/index.js';
import { closeDatabase, initializeDatabase } from './db/index.js';
import { PublicTestError } from './lib/errors.js';
import { portalSessionMiddleware } from './auth/portal-auth.js';
import { createApiRouter } from './routes/api-router.js';
import { startScheduler } from './services/scheduler.js';
import { isLiveStreamRequest, trafficMiddleware } from './services/traffic.js';
import { closeExportWorkers } from './export/worker-pool.js';
import { closeLiveUpdates } from './realtime/live-updates.js';

await initializeCoordination();
// Index creation and legacy-data repairs are safe to repeat, but they should
// not all run at once when PM2 starts every worker together.
await serializeWrite('startup:database', initializeDatabase, { ttlMs: 120_000, retryCount: 1_200 });

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Set once this process starts shutting down (see `stop` below).
let stopping = false;

app.disable('x-powered-by');
app.set('trust proxy', 1);
// A process being replaced (PM2's one-at-a-time reload) answers what it has
// and tells each browser to open its next connection afresh - which lands on
// a process that is staying - instead of reusing one that is about to close.
app.use((_req, res, next) => {
  if (stopping) res.set('Connection', 'close');
  next();
});
// JSON, HTML and SVG shrink substantially on slow/mobile links. Hashed assets
// benefit too when a proxy does not already compress them; tiny responses are
// left alone because compression overhead would be larger than the saving.
// EventSource frames must remain uncompressed: compressor buffering can turn a
// sub-second update into a multi-second delay behind a tunnel or proxy.
app.use(compression({
  threshold: 1024,
  filter(req, res) {
    if (isLiveStreamRequest(req.method, req.path)) return false;
    return compression.filter(req, res);
  }
}));
app.use((_req, res, next) => {
  res.set({
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // API responses are never cacheable: an answer, a deadline or a roll call
    // must always be the live one. Static files override this below.
    'Cache-Control': 'no-store'
  });
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser(config.sessionSecret));
app.use(trafficMiddleware);
app.use(portalSessionMiddleware);
app.use(createApiRouter());

// The browser client is the Vite-built React app in client/dist. `public/` holds
// only shared downloads, such as the quiz JSON template.
app.use(express.static(path.join(root, 'client', 'dist'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    // Vite fingerprints everything under assets/, so a given URL's bytes never
    // change: let the browser keep them for a year. The page and the service
    // worker stay uncached so a deployment is picked up on the next visit.
    const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
    res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-store');
  }
}));
app.use(express.static(path.join(root, 'public'), { index: false }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((error, _req, res, _next) => {
  const status = error instanceof PublicTestError ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Unexpected server error.', ...(error.code && status < 500 ? { code: error.code } : {}) });
});

// A class submits in the same instant. Room for that many new connections at
// once, and connections kept open between a paper's check-ins (10-15 s apart)
// - Node's default closes them after 5 s - so the burst reuses them instead of
// opening hundreds of new ones. Longer than the Cloudflare tunnel's own idle
// timeout, so the tunnel never sends a request down a connection just closed.
const server = app.listen({ port: config.port, backlog: 8192 }, () => console.log(`Test portal is running at http://localhost:${config.port}`));
server.keepAliveTimeout = 95_000;
server.headersTimeout = 96_000;
// Starts scheduled tests and submits every paper when a test's time is up.
const stopScheduler = startScheduler();

const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: finishing active requests before shutdown.`);
  stopScheduler();
  // Server-sent event connections are intentionally long-lived. End them
  // first so server.close() does not wait for every browser to navigate away.
  closeLiveUpdates();
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref?.();
  server.close(async () => {
    try {
      await closeCoordination();
      await closeExportWorkers();
      await closeDatabase();
      clearTimeout(forced);
      process.exit(0);
    } catch (error) {
      console.error('Shutdown:', error);
      process.exit(1);
    }
  });
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
// Windows has no such signals for PM2 to send: with `shutdown_with_message`
// (ecosystem.config.cjs) it asks by message instead. Without this, a reload
// killed each process mid-request.
process.on('message', (message) => { if (message === 'shutdown') stop('shutdown'); });
