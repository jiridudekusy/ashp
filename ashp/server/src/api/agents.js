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
 * - `POST /api/agents/register-ip` — register a sandbox container IP (agent credentials, no Basic Auth)
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
    const mapping = agentsDAO.getIPMapping();
    ipc.send({ type: 'agents.ipmapping', data: mapping });
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

/**
 * Creates a route handler for `POST /api/agents/register-ip`.
 *
 * This endpoint is intentionally mounted BEFORE the Basic Auth middleware so that
 * sandbox container entrypoints — which only possess agent credentials — can register
 * their IP address without needing management credentials.
 *
 * Authentication is performed by verifying the agent name and token via bcrypt
 * (delegating to `agentsDAO.authenticate`). On success, the IP is stored and the
 * updated IP mapping is pushed to the Go proxy via IPC so transparent proxy mode
 * can immediately identify the container.
 *
 * @param {import('../dao/interfaces.js').AgentsDAO} agentsDAO
 * @param {import('../ipc/server.js').IPCServer} ipc
 * @returns {import('express').RequestHandler}
 */
export function createRegisterIpRoute(agentsDAO, ipc) {
  return async (req, res, next) => {
    try {
      const { name, token, ip_address } = req.body;
      if (!name || !token || !ip_address) {
        return res.status(400).json({ error: 'name, token, and ip_address required' });
      }
      const agent = await agentsDAO.authenticate(name, token);
      if (!agent) {
        return res.status(401).json({ error: 'Invalid agent credentials' });
      }
      await agentsDAO.registerIp(agent.id, ip_address);
      const mapping = agentsDAO.getIPMapping();
      ipc.send({ type: 'agents.ipmapping', data: mapping });
      res.json({ ok: true });
    } catch (e) { next(e); }
  };
}
