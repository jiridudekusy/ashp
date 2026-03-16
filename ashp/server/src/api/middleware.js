export function bearerAuth(token) {
  return (req, res, next) => {
    if (req.query.token && req.query.token === token) {
      return next();
    }
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
