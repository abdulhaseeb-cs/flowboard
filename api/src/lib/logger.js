// Structured JSON logs on stdout/stderr — Docker collects them
// (`docker compose logs -f api`), nothing is written inside the container.
const service = process.env.SERVICE_NAME || 'api';

function write(level, message, meta = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, service, message, ...meta });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
};
