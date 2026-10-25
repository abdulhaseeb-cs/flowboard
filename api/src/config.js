// All configuration comes from environment variables (12-factor), so the SAME
// image runs locally, in Docker Compose and on every EC2 instance.
const os = require('os');

const isProd = process.env.NODE_ENV === 'production';

function required(name, devFallback) {
  const value = process.env[name] ?? (isProd ? undefined : devFallback);
  if (value === undefined || value === '') throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  isProd,
  port: parseInt(process.env.PORT || '3000', 10),
  appVersion: process.env.APP_VERSION || '1.0.0',

  db: {
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flowboard',
    user: process.env.DB_USER || 'flowboard',
    password: required('DB_PASSWORD', 'flowboard'),
  },

  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',

  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  uploadDir: process.env.UPLOAD_DIR || '/app/uploads',
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '10', 10),

  // Brute-force protection for /auth endpoints (per client IP, stored in Redis)
  authRateLimit: {
    max: parseInt(process.env.AUTH_RATE_LIMIT || '20', 10),
    windowSec: parseInt(process.env.AUTH_RATE_WINDOW_SEC || '900', 10),
  },

  // Serve the built frontend directly (only for running WITHOUT Docker/Nginx)
  staticDir: process.env.STATIC_DIR || '',

  // Shown in the UI so you can SEE which EC2 instance / container answered
  instance: {
    id: process.env.INSTANCE_ID || 'local',
    az: process.env.AVAILABILITY_ZONE || 'n/a',
    container: os.hostname(),
  },

  worker: {
    intervalMs: parseInt(process.env.WORKER_INTERVAL_MS || '30000', 10),
  },
};
