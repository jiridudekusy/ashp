/**
 * @module api/policies
 * @description CRUD routes for policies. Policies group rules into named sets that
 * can be assigned to agents. They form a directed acyclic graph (DAG) via parent/child
 * relationships. After any mutation, the per-agent rules map is pushed to the Go proxy
 * via IPC (`rules.reload`) and an SSE event is emitted.
 *
 * Routes:
 * - `GET /api/policies`                              — list all policies (tree for sidebar)
 * - `GET /api/policies/match`                        — find policies whose rules match ?url=&method=
 * - `GET /api/policies/:id`                          — get a single policy with children + assigned agents
 * - `POST /api/policies`                             — create a policy
 * - `PUT /api/policies/:id`                          — update a policy
 * - `DELETE /api/policies/:id`                       — delete a policy
 * - `POST /api/policies/:id/children`                — add a child sub-policy (409 on cycle)
 * - `DELETE /api/policies/:id/children/:childId`     — remove a child relationship
 * - `POST /api/policies/:id/agents`                  — assign a policy to an agent
 * - `DELETE /api/policies/:id/agents/:agentId`       — unassign a policy from an agent
 */
import { Router } from 'express';

/**
 * Creates the policies management router.
 *
 * @param {Object} deps
 * @param {import('../dao/interfaces.js').PoliciesDAO} deps.policiesDAO
 * @param {import('../dao/interfaces.js').RulesDAO} deps.rulesDAO
 * @param {import('../dao/interfaces.js').AgentsDAO} deps.agentsDAO
 * @param {import('../ipc/server.js').IPCServer} deps.ipc
 * @param {import('./events.js').EventBus} deps.events
 * @param {Function} deps.sendAgentRulesReload
 * @returns {import('express').Router}
 */
export default function policiesRoutes({ policiesDAO, rulesDAO, agentsDAO, ipc, events, sendAgentRulesReload }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      res.json(await policiesDAO.list());
    } catch (e) { next(e); }
  });

  // /match must come before /:id to avoid being consumed as an id route
  r.get('/match', async (req, res, next) => {
    try {
      const { url, method } = req.query;
      const policies = await policiesDAO.list();
      const matching = [];
      for (const policy of policies) {
        const rule = await rulesDAO.match(url, method, policy.id);
        if (rule) matching.push(policy);
      }
      res.json(matching);
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const policy = await policiesDAO.get(id);
      if (!policy) return res.status(404).json({ error: 'Policy not found' });
      policy.agents = await policiesDAO.getPolicyAgents(id);
      policy.children = await policiesDAO.getChildren(id);
      res.json(policy);
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    try {
      const policy = await policiesDAO.create(req.body);
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: policy.id });
      res.status(201).json(policy);
    } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const policy = await policiesDAO.update(Number(req.params.id), req.body);
      if (!policy) return res.status(404).json({ error: 'Policy not found' });
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: policy.id });
      res.json(policy);
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      await policiesDAO.delete(Number(req.params.id));
      await sendAgentRulesReload();
      events.emit('policies.changed', {});
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/children', async (req, res, next) => {
    try {
      await policiesDAO.addChild(Number(req.params.id), req.body.child_id);
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: Number(req.params.id) });
      res.status(201).json({ ok: true });
    } catch (e) {
      if (/cycle/i.test(e.message)) return res.status(409).json({ error: e.message });
      next(e);
    }
  });

  r.delete('/:id/children/:childId', async (req, res, next) => {
    try {
      await policiesDAO.removeChild(Number(req.params.id), Number(req.params.childId));
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: Number(req.params.id) });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/agents', async (req, res, next) => {
    try {
      await policiesDAO.assignToAgent(Number(req.params.id), req.body.agent_id);
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: Number(req.params.id) });
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/:id/agents/:agentId', async (req, res, next) => {
    try {
      await policiesDAO.unassignFromAgent(Number(req.params.id), Number(req.params.agentId));
      await sendAgentRulesReload();
      events.emit('policies.changed', { policy_id: Number(req.params.id) });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
