const express = require('express');
const db = require('../lib/db');
const { redis } = require('../lib/redis');
const config = require('../config');

const router = express.Router();
const info = () => ({
  app: 'FlowBoard',
  version: config.appVersion,
  instanceId: config.instance.id,
  availabilityZone: config.instance.az,
  container: config.instance.container,
  uptimeSeconds: Math.round(process.uptime()),
  time: new Date().toISOString(),
});

// Liveness — is this Node process alive? (Docker HEALTHCHECK)
router.get('/live', (_req, res) => res.json({ status: 'ok' }));

// Readiness — can we serve real traffic? (AWS Target Group health check)
// 200 only when PostgreSQL AND Redis respond. Worker status is informational.
router.get('/', async (_req, res) => {
  const checks = { database: 'down', redis: 'down', worker: 'unknown' };
  const t0 = Date.now();
  try {
    await db.query('SELECT 1');
    checks.database = 'up';
  } catch { /* stays down */ }
  try {
    if (redis.isReady && (await redis.ping()) === 'PONG') {
      checks.redis = 'up';
      const beat = await redis.get('worker:heartbeat');
      checks.worker = beat ? 'up' : 'down';
      checks.workerLastBeat = beat || null;
    }
  } catch { /* stays down */ }
  const ok = checks.database === 'up' && checks.redis === 'up';
  res.status(ok ? 200 : 503).json({ status: ok ? '200' : 'degraded', ...checks, checkMs: Date.now() - t0, ...info() });
});

module.exports = router;
