/**
 * @module api/status
 * @description Public (unauthenticated) API routes for system status and CA certificate retrieval.
 *
 * - `GET /api/status` — proxy health, management uptime, rule count, config info.
 * - `GET /api/ca/certificate` — serves the MITM root CA certificate (PEM format)
 *   that clients must trust to allow the proxy to intercept HTTPS traffic.
 */
import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Creates the status and CA certificate router.
 *
 * @param {Object} deps
 * @param {import('../proxy-manager.js').ProxyManager} deps.proxyManager
 * @param {import('../dao/interfaces.js').RulesDAO} deps.rulesDAO
 * @param {Object} deps.config
 * @param {import('../ipc/server.js').IPCServer} deps.ipc
 * @returns {import('express').Router}
 */
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

  /** Serves the root CA certificate from the data/ca/ directory. */
  r.get('/ca/certificate', (req, res) => {
    const certPath = config.database.path.replace(/\/[^/]+$/, '') + '/ca/root.crt';
    if (!existsSync(certPath)) return res.status(404).json({ error: 'CA certificate not found' });
    res.type('application/x-pem-file').send(readFileSync(certPath));
  });

  return r;
}
