/**
 * @module api/logs
 * @description Request log query and encrypted body streaming routes.
 *
 * Routes:
 * - `GET /api/logs` — query log entries with filters (method, decision, url, date range, agent, pagination)
 * - `GET /api/logs/:id` — get a single log entry by ID
 * - `GET /api/logs/:id/request-body` — decrypt and stream the request body
 * - `GET /api/logs/:id/response-body` — decrypt and stream the response body
 *
 * Body retrieval flow:
 * 1. The log entry's `request_body_ref` / `response_body_ref` is a string in `path:offset:length` format,
 *    written by the Go proxy when it captured the body.
 * 2. The Node server reads `length` bytes at `offset` from the log file at `path`.
 * 3. Those bytes are an AES-256-GCM encrypted record (see crypto/index.js) that is
 *    decrypted using the master `logKey` and the file offset as HKDF context.
 */
import { Router } from 'express';
import { open } from 'node:fs/promises';

/**
 * Creates the log query and body streaming router.
 *
 * @param {Object} deps
 * @param {import('../dao/interfaces.js').RequestLogDAO} deps.requestLogDAO
 * @param {Object} deps.crypto - Crypto module augmented with `logKey` (Buffer|null).
 * @param {Object} deps.config
 * @returns {import('express').Router}
 */
export default function logsRoutes({ requestLogDAO, crypto, config }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const filters = {};
      for (const k of ['method', 'decision', 'url', 'from', 'to', 'agent_id']) {
        if (req.query[k]) filters[k] = req.query[k];
      }
      filters.limit = parseInt(req.query.limit) || 50;
      filters.offset = parseInt(req.query.offset) || 0;
      res.json(await requestLogDAO.query(filters));
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const entry = await requestLogDAO.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      res.json(entry);
    } catch (e) { next(e); }
  });

  /**
   * Reads an encrypted body blob from disk and streams the decrypted content.
   * Parses the body_ref string (`path:offset:length`), reads raw bytes from
   * the log file, and decrypts using the per-record HKDF-derived key.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   * @param {string} refField - Column name: 'request_body_ref' or 'response_body_ref'.
   */
  async function streamBody(req, res, next, refField) {
    try {
      const entry = await requestLogDAO.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      const ref = entry[refField];
      if (!ref) return res.status(404).json({ error: 'No body recorded' });

      // Parse the body reference: "relative/path:byteOffset:byteLength"
      const [filePath, offsetStr, lengthStr] = ref.split(':');
      const offset = parseInt(offsetStr);
      const length = parseInt(lengthStr);
      const dataDir = config.database.path.replace(/\/[^/]+$/, '');
      const fullPath = filePath.startsWith('logs/') ? `${dataDir}/${filePath}` : `${dataDir}/logs/${filePath}`;

      const fh = await open(fullPath, 'r');
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      await fh.close();

      const decrypted = crypto.decryptRecord(crypto.logKey, offset, buf);
      res.type('application/octet-stream').send(decrypted);
    } catch (e) { next(e); }
  }

  r.get('/:id/request-body', (req, res, next) => streamBody(req, res, next, 'request_body_ref'));
  r.get('/:id/response-body', (req, res, next) => streamBody(req, res, next, 'response_body_ref'));

  return r;
}
