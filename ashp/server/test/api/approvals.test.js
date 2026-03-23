import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import approvalsRoutes from '../../src/api/approvals.js';
import { errorHandler } from '../../src/api/middleware.js';

let mockApprovalQueueDAO, mockRulesDAO, mockConfig, mockIpc, mockEvents;

function setup() {
  mockApprovalQueueDAO = {
    listPending: async () => [
      { id: 1, url: 'https://example.com', status: 'pending' },
      { id: 2, url: 'https://api.example.com', status: 'pending' },
    ],
    resolve: async (id, opts) => {
      if (id === 999) return null;
      return {
        id,
        status: opts.action === 'approve' ? 'approved' : 'rejected',
        ipc_msg_id: 'msg-123',
        suggested_pattern: '*.example.com',
        suggested_methods: '["GET","POST"]',
      };
    },
  };
  mockRulesDAO = {
    createCalls: [],
    create: async function (rule) {
      this.createCalls.push(rule);
      return { id: 10, ...rule };
    },
  };
  mockConfig = {};
  mockIpc = { calls: [], send(msg) { this.calls.push(msg); } };
  mockEvents = { calls: [], emit(type, data) { this.calls.push({ type, data }); } };

  const app = express();
  app.use(express.json());
  app.use('/api/approvals', approvalsRoutes({
    approvalQueueDAO: mockApprovalQueueDAO,
    rulesDAO: mockRulesDAO,
    config: mockConfig,
    ipc: mockIpc,
    events: mockEvents,
  }));
  app.use(errorHandler);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOpts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: opts.path || '/api/approvals',
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

describe('approvals API', () => {
  it('GET /api/approvals returns pending list', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server);
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
    } finally {
      server.close();
    }
  });

  it('GET /api/approvals?status=pending passes filter', async () => {
    const app = setup();
    let calledListPending = false;
    mockApprovalQueueDAO.listPending = async () => {
      calledListPending = true;
      return [];
    };
    const server = await listen(app);
    try {
      await request(server, { path: '/api/approvals?status=pending' });
      assert.ok(calledListPending);
    } finally {
      server.close();
    }
  });

  it('POST /api/approvals/:id/resolve approves and notifies', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/approvals/1/resolve',
        body: { action: 'approve', create_rule: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'approved');
      assert.ok(mockIpc.calls.some((c) => c.type === 'approval.resolve'));
      assert.ok(mockEvents.calls.some((c) => c.type === 'approval.resolved'));
    } finally {
      server.close();
    }
  });

  it('POST /api/approvals/:id/resolve with create_rule creates a rule', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/approvals/1/resolve',
        body: { action: 'approve', create_rule: true },
      });
      assert.equal(res.status, 200);
      assert.equal(mockRulesDAO.createCalls.length, 1);
      const created = mockRulesDAO.createCalls[0];
      assert.equal(created.url_pattern, '*.example.com');
      assert.deepEqual(created.methods, ['GET', 'POST']);
      assert.equal(created.action, 'allow');
      assert.ok(mockIpc.calls.some((c) => c.type === 'rules.reload'));
    } finally {
      server.close();
    }
  });

  it('POST /api/approvals/:id/resolve returns 404 for unknown', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/approvals/999/resolve',
        body: { action: 'approve', create_rule: false },
      });
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });

  it('POST /api/approvals/:id/resolve rejects invalid action', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/approvals/1/resolve',
        body: { action: 'maybe' },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });
});
