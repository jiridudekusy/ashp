/**
 * @module api/approvals
 * @description Approval queue routes for resolving held proxy requests.
 *
 * Routes:
 * - `GET /api/approvals` — list all pending approvals
 * - `POST /api/approvals/:id/resolve` — approve or reject a pending request
 *
 * Resolution flow:
 * 1. Human POSTs `{ action: 'approve'|'reject', create_rule?: boolean }`.
 * 2. The approval entry is marked resolved in the DB.
 * 3. An `approval.resolve` IPC message is sent to the Go proxy with `ref` set to the
 *    original `ipc_msg_id`, allowing the proxy to match it to the held TCP connection
 *    and either forward or reject the request.
 * 4. If `create_rule` is true, a new allow/deny rule is auto-created from the
 *    `suggested_pattern` and `suggested_methods` stored at enqueue time, and the
 *    proxy's rule set is reloaded.
 */
import { Router } from 'express';

/**
 * Creates the approvals router.
 *
 * @param {Object} deps
 * @param {import('../dao/interfaces.js').ApprovalQueueDAO} deps.approvalQueueDAO
 * @param {import('../dao/interfaces.js').RulesDAO} deps.rulesDAO
 * @param {Object} deps.config
 * @param {import('../ipc/server.js').IPCServer} deps.ipc
 * @param {import('./events.js').EventBus} deps.events
 * @returns {import('express').Router}
 */
export default function approvalsRoutes({ approvalQueueDAO, rulesDAO, config, ipc, events }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const items = await approvalQueueDAO.listPending();
      res.json(items);
    } catch (e) { next(e); }
  });

  r.post('/:id/resolve', async (req, res, next) => {
    try {
      const { action, create_rule } = req.body;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action must be "approve" or "reject"' });
      }

      const result = await approvalQueueDAO.resolve(Number(req.params.id), {
        action, create_rule: !!create_rule, resolved_by: 'api',
      });
      if (!result) return res.status(404).json({ error: 'Approval not found or already resolved' });

      // Send the resolution back to the Go proxy, using `ref` for IPC correlation
      ipc.send({ type: 'approval.resolve', ref: result.ipc_msg_id, data: { action } });

      // Optionally auto-create a rule from the suggested pattern
      if (create_rule && result.suggested_pattern) {
        const methods = result.suggested_methods ? JSON.parse(result.suggested_methods) : [];
        await rulesDAO.create({
          name: `Auto: ${result.suggested_pattern}`,
          url_pattern: result.suggested_pattern,
          methods,
          action: action === 'approve' ? 'allow' : 'deny',
          priority: 50, enabled: true,
        });
        ipc.send({ type: 'rules.reload' });
        events.emit('rules.changed', {});
      }

      events.emit('approval.resolved', { id: result.id, action });
      res.json(result);
    } catch (e) { next(e); }
  });

  return r;
}
