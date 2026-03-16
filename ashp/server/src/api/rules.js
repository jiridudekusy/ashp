import { Router } from 'express';

export default function rulesRoutes({ rulesDAO, config, ipc, events }) {
  const r = Router();

  async function sendRulesReload() {
    const rules = await rulesDAO.list();
    ipc.send({ type: 'rules.reload', data: rules });
  }

  function rejectIfReadOnly(req, res, next) {
    if (config.rules.source === 'file') return res.status(403).json({ error: 'Rules are read-only in file mode' });
    next();
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await rulesDAO.list()); } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const rule = await rulesDAO.get(Number(req.params.id));
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      res.json(rule);
    } catch (e) { next(e); }
  });

  r.post('/test', async (req, res, next) => {
    try {
      const { url, method } = req.body;
      const match = await rulesDAO.match(url, method);
      res.json({ match, decision: match ? match.action : config.default_behavior });
    } catch (e) { next(e); }
  });

  r.post('/', rejectIfReadOnly, async (req, res, next) => {
    try {
      const rule = await rulesDAO.create(req.body);
      await sendRulesReload();
      events.emit('rules.changed', { rule_id: rule.id });
      res.status(201).json(rule);
    } catch (e) { next(e); }
  });

  r.put('/:id', rejectIfReadOnly, async (req, res, next) => {
    try {
      const rule = await rulesDAO.update(Number(req.params.id), req.body);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      await sendRulesReload();
      events.emit('rules.changed', { rule_id: rule.id });
      res.json(rule);
    } catch (e) { next(e); }
  });

  r.delete('/:id', rejectIfReadOnly, async (req, res, next) => {
    try {
      await rulesDAO.delete(Number(req.params.id));
      await sendRulesReload();
      events.emit('rules.changed', {});
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
