/**
 * @module api/middleware
 * @description Express middleware for the management API: HTTP Basic Authentication
 * and centralized error handling.
 */

/**
 * Returns an Express middleware that enforces HTTP Basic Authentication.
 * Credentials are validated against a static username:password map from config.
 *
 * @param {Object.<string, string>} authMap - Map of username to plaintext password
 *   (from `config.management.auth`).
 * @returns {import('express').RequestHandler} Middleware that responds with 401 if
 *   credentials are missing, malformed, or invalid.
 */
export function basicAuth(authMap) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    if (sep === -1) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (!authMap[user] || authMap[user] !== pass) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

/**
 * Express error-handling middleware. Catches errors thrown or passed via `next(err)`
 * in route handlers and returns a JSON error response.
 *
 * @param {Error & {status?: number}} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
