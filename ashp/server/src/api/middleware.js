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

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
