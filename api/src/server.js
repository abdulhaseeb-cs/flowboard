const http = require('http');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const db = require('./lib/db');
const log = require('./lib/logger');
const { connectRedis, redis } = require('./lib/redis');
const { initRealtime, closeRealtime } = require('./lib/realtime');
const { HttpError } = require('./lib/errors');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Nginx + AWS ALB -> trust X-Forwarded-For for req.ip
app.use(helmet());
app.use(express.json({ limit: '200kb' }));

// Every response says which instance + container answered (proves load balancing)
app.use((_req, res, next) => {
  res.setHeader('X-Served-By', `${config.instance.id}/${config.instance.container}`);
  next();
});

// One structured log line per request (health checks skipped to keep logs readable)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path.startsWith('/api/health')) return;
    log.info('request', {
      method: req.method, path: req.originalUrl, status: res.statusCode,
      ms: Number((process.hrtime.bigint() - start) / 1_000_000n), ip: req.ip, user: req.user?.id,
    });
  });
  next();
});

// ---------------------------------------------------------------- routes
app.use('/api/health', require('./routes/health'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/workspaces', require('./routes/workspaces'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api', require('./routes/projects'));
app.use('/api', require('./routes/tasks'));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API route not found')));

// Optional: serve the built React app when running without Nginx
if (config.staticDir) {
  app.use(express.static(config.staticDir));
  app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: config.staticDir }));
}

// ---------------------------------------------------------------- errors
// Express 5 forwards rejected promises from async handlers to here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Request body is not valid JSON');
  if (err.code === '22P02' || err.code === '23503') err = new HttpError(400, 'Invalid reference in request');
  const status = err.status || 500;
  if (status >= 500) log.error('Unhandled error', { path: req.originalUrl, error: err.message, stack: err.stack });
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details });
});

// ---------------------------------------------------------------- startup
async function start() {
  await db.waitForDatabase();
  await connectRedis();
  const server = http.createServer(app);
  await initRealtime(server);
  server.listen(config.port, () => log.info('FlowBoard API listening', { port: config.port, instance: config.instance }));

  // Graceful shutdown: `docker stop` sends SIGTERM. Stop accepting work, close
  // WebSockets (clients auto-reconnect to another replica), then close pools.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down', { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    await closeRealtime();
    server.close(async () => {
      await Promise.allSettled([db.pool.end(), redis.quit()]);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  log.error('Failed to start', { error: err.message });
  process.exit(1);
});
