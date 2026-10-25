const { createClient } = require('redis');
const config = require('../config');
const log = require('./logger');

/**
 * One shared Redis connection for commands (rate limiting, presence, locks, heartbeat).
 * Socket.IO's adapter creates its own pub/sub pair via duplicate().
 */
const redis = createClient({
  url: config.redisUrl,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
});
redis.on('error', (err) => log.warn('Redis error', { error: err.message }));
redis.on('ready', () => log.info('Connected to Redis', { url: config.redisUrl.replace(/\/\/.*@/, '//***@') }));

async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
  return redis;
}

module.exports = { redis, connectRedis };
