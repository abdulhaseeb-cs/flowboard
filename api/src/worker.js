// =====================================================================
// FlowBoard background worker  (same Docker image as the API, different command)
//
//   * every WORKER_INTERVAL_MS: send "due soon" / "overdue" reminders
//   * every hour: delete old read notifications
//   * writes a heartbeat to Redis so /api/health can report worker status
//
// Several workers may run (one per EC2 instance, or scaled replicas). A Redis
// lock (SET key value NX PX ttl) guarantees each job runs on only ONE of them
// at a time, so users never get duplicate reminders.
// Notifications are pushed to browsers through the Socket.IO Redis *emitter*:
// the worker has no WebSocket server, it publishes to Redis and the API
// replicas deliver the message.
// =====================================================================
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'worker';
const crypto = require('crypto');
const fs = require('fs');
const { Emitter } = require('@socket.io/redis-emitter');
const config = require('./config');
const db = require('./lib/db');
const log = require('./lib/logger');
const { connectRedis, redis } = require('./lib/redis');
const { notify } = require('./lib/events');

const WORKER_ID = `${config.instance.id}/${config.instance.container}/${crypto.randomBytes(3).toString('hex')}`;
let emitter;
const emit = (userId, event, payload) => emitter.to(`user:${userId}`).emit(event, payload);

/** Distributed lock. Returns true if THIS worker got it. */
async function acquireLock(name, ttlMs) {
  return (await redis.set(`lock:${name}`, WORKER_ID, { NX: true, PX: ttlMs })) === 'OK';
}

async function dueDateReminders() {
  // FOR UPDATE SKIP LOCKED: belt-and-braces — even without the Redis lock two
  // workers could never pick the same rows.
  const tasks = await db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT t.id, t.number, t.title, t.due_date, t.assignee_id, t.project_id, p.key,
              (t.due_date < CURRENT_DATE) AS overdue
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.completed_at IS NULL AND t.assignee_id IS NOT NULL AND t.due_notified = FALSE
          AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE + 1
        ORDER BY t.due_date LIMIT 200
        FOR UPDATE OF t SKIP LOCKED`,
    );
    if (rows.length) await c.query('UPDATE tasks SET due_notified = TRUE WHERE id = ANY($1::int[])', [rows.map((r) => r.id)]);
    return rows;
  });

  for (const t of tasks) {
    const key = `${t.key}-${t.number}`;
    await notify(
      {
        userId: t.assignee_id,
        type: t.overdue ? 'overdue' : 'due_soon',
        title: t.overdue ? `${key} is overdue (was due ${t.due_date})` : `${key} is due ${t.due_date === new Date().toISOString().slice(0, 10) ? 'today' : 'tomorrow'}`,
        body: t.title,
        link: `/p/${t.project_id}?task=${t.id}`,
      },
      emit,
    );
  }
  if (tasks.length) log.info('Due-date reminders sent', { count: tasks.length });
}

async function cleanupNotifications() {
  const { rowCount } = await db.query(`DELETE FROM notifications WHERE read_at < NOW() - INTERVAL '30 days'`);
  if (rowCount) log.info('Old notifications deleted', { count: rowCount });
}

// The container HEALTHCHECK looks at this file's age (the worker has no HTTP port)
const HEARTBEAT_FILE = '/tmp/worker-heartbeat';

async function tick() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
    await redis.set('worker:heartbeat', new Date().toISOString(), { EX: Math.ceil((config.worker.intervalMs * 3) / 1000) });
    if (await acquireLock('due-reminders', config.worker.intervalMs - 1000)) await dueDateReminders();
    if (await acquireLock('cleanup', 60 * 60 * 1000)) await cleanupNotifications();
  } catch (err) {
    log.error('Worker tick failed', { error: err.message });
  }
}

async function start() {
  await db.waitForDatabase();
  await connectRedis();
  emitter = new Emitter(redis);
  log.info('Worker started', { workerId: WORKER_ID, intervalMs: config.worker.intervalMs });
  await tick();
  const timer = setInterval(tick, config.worker.intervalMs);

  const shutdown = async (signal) => {
    log.info('Worker shutting down', { signal });
    clearInterval(timer);
    await Promise.allSettled([db.pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  log.error('Worker failed to start', { error: err.message });
  process.exit(1);
});
