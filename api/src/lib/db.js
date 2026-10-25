const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (avoids timezone shifts)
types.setTypeParser(1082, (v) => v);
const config = require('../config');
const log = require('./logger');

const pool = new Pool({ ...config.db, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
pool.on('error', (err) => log.error('PostgreSQL pool error', { error: err.message }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry with back-off: the DB container may still be starting when we boot. */
async function waitForDatabase(retries = 20) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      log.info('Connected to PostgreSQL', { host: config.db.host, attempt });
      return;
    } catch (err) {
      const delay = Math.min(1000 * attempt, 5000);
      log.warn('PostgreSQL not ready, retrying', { attempt, delayMs: delay, error: err.message });
      await sleep(delay);
    }
  }
  throw new Error('Could not connect to PostgreSQL');
}

/** Run fn(client) inside BEGIN/COMMIT; ROLLBACK on any error. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), tx, waitForDatabase };
