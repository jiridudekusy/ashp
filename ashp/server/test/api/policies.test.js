import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import policiesRoutes from '../../src/api/policies.js';
import rulesRoutes from '../../src/api/rules.js';
import { errorHandler } from '../../src/api/middleware.js';

let mockPoliciesDAO, mockRulesDAO, mockAgentsDAO, mockIpc, mockEvents, mockSendAgentRulesReload;

function setup() {
  mockPoliciesDAO = {
    list: async () => [
      { id: 1, name: 'Policy A', description: '' },
      { id: 2, name: 'Policy B', description: '' },
    ],
    get: async (id) => (id === 1 ? { id: 1, name: 'Policy A', description: '' } : null),
    create: async (data) => ({ id: 3, name: data.name, description: data.description ?? '' }),
    update: async (id, changes) => (id === 1 ? { id: 1, ...changes } : null),
    delete: async (id) => {},
    addChild: async (parentId, childId) => {
      if (parentId === childId) throw new Error('cycle: self-reference not allowed');
      if (parentId === 99) throw new Error('cycle: adding this relationship would create a cycle');
    },
    removeChild: async (parentId, childId) => {},
    assignToAgent: async (policyId, agentId) => {},
    unassignFromAgent: async (policyId, agentId) => {},
    getPolicyAgents: async (policyId) => [],
    getChildren: async (policyId) => [],
  };

  mockRulesDAO = {
    list: async () => [],
    get: async (id) => (id === 1 ? { id: 1, url_pattern: '.*\\.example\\.com', action: 'allow', methods: ['GET'] } : null),
    create: async (rule) => ({ id: 1, ...rule }),
    update: async (id, data) => (id === 1 ? { id: 1, ...data } : null),
    delete: async (id) => {},
    match: async (url, method, policyId) => {
      if (url === 'https://example.com' && policyId === 1) {
        return { id: 1, action: 'allow', url_pattern: '.*\\.example\\.com' };
      }
      return null;
    },
    moveToPolicy: async (ruleId, policyId) => (ruleId === 1 ? { id: 1, policy_id: policyId } : null),
  };

  mockAgentsDAO = {
    list: async () => [{ id: 1, name: 'agent-1' }],
  };

  mockIpc = { calls: [], send(msg) { this.calls.push(msg); } };
  mockEvents = { calls: [], emit(type, data) { this.calls.push({ type, data }); } };
  mockSendAgentRulesReload = async () => { mockIpc.calls.push({ type: 'rules.reload', data: {} }); };

  const app = express();
  app.use(express.json());
  app.use('/api/policies', policiesRoutes({
    policiesDAO: mockPoliciesDAO,
    rulesDAO: mockRulesDAO,
    agentsDAO: mockAgentsDAO,
    ipc: mockIpc,
    events: mockEvents,
    sendAgentRulesReload: mockSendAgentRulesReload,
  }));
  app.use('/api/rules', rulesRoutes({
    rulesDAO: mockRulesDAO,
    config: { rules: { source: 'db' }, default_behavior: 'deny' },
    ipc: mockIpc,
    events: mockEvents,
    sendAgentRulesReload: mockSendAgentRulesReload,
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
      path: opts.path || '/api/policies',
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

describe('policies API', () => {
  it('GET /api/policies returns list', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server);
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
      assert.equal(res.body[0].name, 'Policy A');
    } finally {
      server.close();
    }
  });

  it('GET /api/policies/:id returns detail', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/policies/1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 1);
      assert.equal(res.body.name, 'Policy A');
    } finally {
      server.close();
    }
  });

  it('GET /api/policies/:id returns 404 for missing', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/policies/999' });
      assert.equal(res.status, 404);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('POST /api/policies creates policy (201)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        body: { name: 'New Policy', description: 'Test' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'New Policy');
    } finally {
      server.close();
    }
  });

  it('POST /api/policies triggers sendAgentRulesReload and event', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      mockIpc.calls = [];
      mockEvents.calls = [];
      await request(server, {
        method: 'POST',
        body: { name: 'Policy X' },
      });
      assert.ok(mockIpc.calls.some((c) => c.type === 'rules.reload'));
      assert.ok(mockEvents.calls.some((c) => c.type === 'policies.changed'));
    } finally {
      server.close();
    }
  });

  it('PUT /api/policies/:id updates policy', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'PUT',
        path: '/api/policies/1',
        body: { name: 'Updated' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Updated');
    } finally {
      server.close();
    }
  });

  it('PUT /api/policies/:id returns 404 for missing', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'PUT',
        path: '/api/policies/999',
        body: { name: 'x' },
      });
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });

  it('DELETE /api/policies/:id deletes (204)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'DELETE',
        path: '/api/policies/1',
      });
      assert.equal(res.status, 204);
    } finally {
      server.close();
    }
  });

  it('POST /api/policies/:id/children adds sub-policy (201)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/policies/1/children',
        body: { child_id: 2 },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.ok);
    } finally {
      server.close();
    }
  });

  it('POST /api/policies/:id/children rejects cycle (409)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      // parentId === childId triggers self-reference cycle error
      const res = await request(server, {
        method: 'POST',
        path: '/api/policies/1/children',
        body: { child_id: 1 },
      });
      assert.equal(res.status, 409);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('POST /api/policies/:id/children rejects transitive cycle (409)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      // parentId === 99 triggers cycle in mock
      const res = await request(server, {
        method: 'POST',
        path: '/api/policies/99/children',
        body: { child_id: 2 },
      });
      assert.equal(res.status, 409);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('DELETE /api/policies/:id/children/:childId removes child (204)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'DELETE',
        path: '/api/policies/1/children/2',
      });
      assert.equal(res.status, 204);
    } finally {
      server.close();
    }
  });

  it('POST /api/policies/:id/agents assigns agent (201)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/policies/1/agents',
        body: { agent_id: 1 },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.ok);
    } finally {
      server.close();
    }
  });

  it('DELETE /api/policies/:id/agents/:agentId unassigns agent (204)', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'DELETE',
        path: '/api/policies/1/agents/1',
      });
      assert.equal(res.status, 204);
    } finally {
      server.close();
    }
  });

  it('GET /api/policies/match returns matching policies', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        path: '/api/policies/match?url=https%3A%2F%2Fexample.com&method=GET',
      });
      assert.equal(res.status, 200);
      // Policy with id 1 should match (mock returns match for policyId===1)
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 1);
      assert.equal(res.body[0].id, 1);
    } finally {
      server.close();
    }
  });
});

describe('rules API — move endpoint', () => {
  it('POST /api/rules/:id/move moves rule to policy', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/rules/1/move',
        body: { policy_id: 2 },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 1);
      assert.equal(res.body.policy_id, 2);
    } finally {
      server.close();
    }
  });

  it('POST /api/rules/:id/move returns 404 for missing rule', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/rules/999/move',
        body: { policy_id: 2 },
      });
      assert.equal(res.status, 404);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('POST /api/rules/:id/move triggers sendAgentRulesReload and event', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      mockIpc.calls = [];
      mockEvents.calls = [];
      await request(server, {
        method: 'POST',
        path: '/api/rules/1/move',
        body: { policy_id: 2 },
      });
      assert.ok(mockIpc.calls.some((c) => c.type === 'rules.reload'));
      assert.ok(mockEvents.calls.some((c) => c.type === 'rules.changed'));
    } finally {
      server.close();
    }
  });
});
