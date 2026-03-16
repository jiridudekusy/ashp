import { Router } from 'express';

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

      ipc.send({ type: 'approval.resolve', ref: result.ipc_msg_id, action });

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
