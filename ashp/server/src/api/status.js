import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';

export default function statusRoutes({ proxyManager, rulesDAO, config, ipc }) {
  const r = Router();
  const startedAt = Date.now();

  r.get('/status', async (req, res, next) => {
    try {
      const rules = await rulesDAO.list();
      res.json({
        proxy: { ...proxyManager.getStatus(), connected: ipc?.connected ?? false },
        management: { uptime_ms: Date.now() - startedAt },
        rules_count: rules.length,
        rules_source: config.rules.source,
        db_path: config.database.path,
      });
    } catch (e) { next(e); }
  });

  r.get('/ca/certificate', (req, res) => {
    const certPath = config.database.path.replace(/\/[^/]+$/, '') + '/ca/root.crt';
    if (!existsSync(certPath)) return res.status(404).json({ error: 'CA certificate not found' });
    res.type('application/x-pem-file').send(readFileSync(certPath));
  });

  return r;
}
