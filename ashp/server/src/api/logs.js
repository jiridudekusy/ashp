import { Router } from 'express';
import { open } from 'node:fs/promises';

export default function logsRoutes({ requestLogDAO, crypto, config }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const filters = {};
      for (const k of ['method', 'decision', 'url', 'from', 'to']) {
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

  async function streamBody(req, res, next, refField) {
    try {
      const entry = await requestLogDAO.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      const ref = entry[refField];
      if (!ref) return res.status(404).json({ error: 'No body recorded' });

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
