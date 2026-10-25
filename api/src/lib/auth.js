const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('./db');
const { redis } = require('./redis');
const { HttpError } = require('./errors');

const signToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

/** Verifies a JWT and loads the user. Shared by HTTP middleware and the Socket.IO handshake. */
async function userFromToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Your session has expired, please log in again');
  }
  const { rows } = await db.query('SELECT id, name, email, avatar_color FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0]) throw new HttpError(401, 'Account no longer exists');
  return rows[0];
}

async function requireAuth(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Authentication required'));
  req.user = await userFromToken(token);
  return next();
}

/**
 * Fixed-window rate limiter backed by Redis, so the limit is shared by ALL API
 * replicas (an in-memory counter would let an attacker spread requests across them).
 */
function rateLimit(prefix, { max, windowSec }) {
  return async (req, res, next) => {
    if (!redis.isReady) return next(); // fail open if Redis is briefly down
    const key = `rl:${prefix}:${req.ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    if (count > max) {
      const ttl = await redis.ttl(key);
      res.setHeader('Retry-After', ttl);
      return next(new HttpError(429, `Too many attempts. Try again in ${Math.ceil(ttl / 60)} minute(s).`));
    }
    return next();
  };
}

module.exports = { signToken, userFromToken, requireAuth, rateLimit };
