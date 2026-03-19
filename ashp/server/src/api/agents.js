import { Router } from 'express';

export default function agentsRoutes({ agentsDAO, ipc }) {
  const r = Router();

  async function sendAgentsReload() {
    const agents = agentsDAO.listForProxy();
    ipc.send({ type: 'agents.reload', data: agents });
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await agentsDAO.list()); } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const agent = await agentsDAO.get(Number(req.params.id));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(agent);
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    try {
      const agent = await agentsDAO.create(req.body);
      await sendAgentsReload();
      res.status(201).json(agent);
    } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const agent = await agentsDAO.update(Number(req.params.id), req.body);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      await sendAgentsReload();
      res.json(agent);
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      await agentsDAO.delete(Number(req.params.id));
      await sendAgentsReload();
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/rotate-token', async (req, res, next) => {
    try {
      const result = await agentsDAO.rotateToken(Number(req.params.id));
      if (!result) return res.status(404).json({ error: 'Agent not found' });
      await sendAgentsReload();
      res.json(result);
    } catch (e) { next(e); }
  });

  return r;
}
