/**
 * @module api/agents
 * @description Agent (API client) management routes. After any mutation, the agent
 * list is pushed to the Go proxy via IPC (`agents.reload`) so it can perform
 * Proxy-Authorization checks with current credentials.
 *
 * Routes:
 * - `GET /api/agents` — list all agents
 * - `GET /api/agents/:id` — get a single agent
 * - `POST /api/agents` — create an agent (returns the one-time plaintext token)
 * - `PUT /api/agents/:id` — update agent fields (name, description, enabled)
 * - `DELETE /api/agents/:id` — delete an agent and its related data
 * - `POST /api/agents/:id/rotate-token` — generate a new token (returns the one-time plaintext token)
 */
import { Router } from 'express';

/**
 * Creates the agents management router.
 *
 * @param {Object} deps
 * @param {import('../dao/interfaces.js').AgentsDAO} deps.agentsDAO
 * @param {import('../ipc/server.js').IPCServer} deps.ipc
 * @returns {import('express').Router}
 */
export default function agentsRoutes({ agentsDAO, ipc }) {
  const r = Router();

  /**
   * Pushes the full agent credential list to the Go proxy via IPC.
   * @returns {Promise<void>}
   */
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
