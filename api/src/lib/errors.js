const { ZodError } = require('zod');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);

/** Validate req.body (or any object) with a zod schema; turns issues into a 400 with field errors. */
function validate(schema, data) {
  try {
    return schema.parse(data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const details = {};
      for (const issue of err.issues) details[issue.path.join('.') || 'body'] ??= issue.message;
      throw new HttpError(400, 'Please fix the highlighted fields', details);
    }
    throw err;
  }
}

module.exports = { HttpError, notFound, forbidden, validate };
