/**
 * @module api/rules
 * @description CRUD routes for proxy rules. After any mutation, the full rule list
 * is pushed to the Go proxy via IPC (`rules.reload`) so it always has current state.
 *
 * When `config.rules.source === 'file'`, mutations are rejected with 403 since
 * rules are managed externally via a JSON file.
 *
 * Routes:
 * - `GET /api/rules` — list all rules
 * - `GET /api/rules/:id` — get a single rule
 * - `POST /api/rules/test` — test a URL+method against current rules (returns matching rule and decision)
 * - `POST /api/rules` — create a rule (DB mode only)
 * - `PUT /api/rules/:id` — update a rule (DB mode only)
 * - `DELETE /api/rules/:id` — delete a rule (DB mode only)
 */
import { Router } from 'express';

/**
 * Creates the rules CRUD router.
 *
 * @param {Object} deps
 * @param {import('../dao/interfaces.js').RulesDAO} deps.rulesDAO
 * @param {Object} deps.config
 * @param {import('../ipc/server.js').IPCServer} deps.ipc
 * @param {import('./events.js').EventBus} deps.events
 * @returns {import('express').Router}
 */
export default function rulesRoutes({ rulesDAO, config, ipc, events }) {
  const r = Router();

  /**
   * Pushes the full rule list to the Go proxy via IPC. Called after every mutation
   * to keep the proxy's in-memory rule set synchronized.
   * @returns {Promise<void>}
   */
  async function sendRulesReload() {
    const rules = await rulesDAO.list();
    ipc.send({ type: 'rules.reload', data: rules });
  }

  /**
   * Guard middleware that rejects write operations when rules source is 'file'.
   * @type {import('express').RequestHandler}
   */
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
