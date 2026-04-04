import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../../src/api/middleware.js';
import agentsRoutes, { createRegisterIpRoute } from '../../src/api/agents.js';

// Mock DAO
function mockAgentsDAO() {
  const agents = [];
  let nextId = 1;
  return {
    list: async () => agents.map(({ token, token_hash, ...a }) => a),
    get: async (id) => { const a = agents.find(a => a.id === id); if (!a) return null; const { token, token_hash, ...rest } = a; return rest; },
    create: async ({ name }) => {
      const agent = { id: nextId++, name, token: 'generated-token-123', enabled: true, request_count: 0, created_at: new Date().toISOString() };
      agents.push(agent);
      return agent;
    },
    update: async (id, fields) => {
      const a = agents.find(a => a.id === id);
      if (!a) return null;
      Object.assign(a, fields);
      return { ...a, token_hash: undefined };
    },
    delete: async (id) => { const idx = agents.findIndex(a => a.id === id); if (idx >= 0) agents.splice(idx, 1); },
    rotateToken: async (id) => {
      const a = agents.find(a => a.id === id);
      if (!a) return null;
      return { token: 'new-rotated-token-456' };
    },
    listForProxy: () => [],
    authenticate: async (name, token) => {
      const a = agents.find(a => a.name === name && a.enabled);
      if (!a) return null;
      // In the mock, the token stored is the plaintext token itself
      return (a.token === token) ? { id: a.id, name: a.name, enabled: a.enabled } : null;
    },
    registerIp: async (id, ip) => {
      const a = agents.find(a => a.id === id);
      if (a) a.ip_address = ip;
    },
    getIPMapping: () => {
      const map = {};
      for (const a of agents) {
        if (a.ip_address) map[a.ip_address] = a.name;
      }
      return map;
    },
    _agents: agents,
  };
}

function makeApp(agentsDAO) {
  const app = express();
  app.use(express.json());
  const ipc = { send: () => {} };
  // Register-IP route must be mounted before any auth middleware
  app.post('/api/agents/register-ip', createRegisterIpRoute(agentsDAO, ipc));
  app.use('/api/agents', agentsRoutes({ agentsDAO, ipc }));
  app.use(errorHandler);
  return app;
}

async function req(app, method, path, body) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('agents API', () => {
  let dao, app;
  beforeEach(() => { dao = mockAgentsDAO(); app = makeApp(dao); });

  it('POST /api/agents creates agent and returns token', async () => {
    const res = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'agent1');
    assert.ok(res.body.token); // token visible only on create
  });

  it('GET /api/agents lists without tokens', async () => {
    await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'GET', '/api/agents');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.ok(!res.body[0].token);
  });

  it('GET /api/agents/:id returns agent without token', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'GET', `/api/agents/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.token);
  });

  it('GET /api/agents/:id returns 404 for nonexistent', async () => {
    const res = await req(app, 'GET', '/api/agents/999');
    assert.equal(res.status, 404);
  });

  it('DELETE /api/agents/:id removes agent', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'DELETE', `/api/agents/${created.body.id}`);
    assert.equal(res.status, 204);
  });

  it('POST /api/agents/:id/rotate-token returns new token', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'POST', `/api/agents/${created.body.id}/rotate-token`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  it('POST /api/agents/:id/rotate-token returns 404 for nonexistent', async () => {
    const res = await req(app, 'POST', '/api/agents/999/rotate-token');
    assert.equal(res.status, 404);
  });

  it('PUT /api/agents/:id returns 404 for nonexistent', async () => {
    const res = await req(app, 'PUT', '/api/agents/999', { name: 'x' });
    assert.equal(res.status, 404);
  });

  it('POST /api/agents/register-ip registers IP with valid credentials', async () => {
    // Create an agent first
    const created = await req(app, 'POST', '/api/agents', { name: 'ip-reg-test-agent' });
    assert.equal(created.status, 201);
    const { token, id } = created.body;

    // Register IP using agent credentials (no Basic Auth)
    const res = await req(app, 'POST', '/api/agents/register-ip', {
      name: 'ip-reg-test-agent',
      token,
      ip_address: '172.18.0.10',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Verify the IP was stored
    assert.equal(dao._agents.find(a => a.id === id)?.ip_address, '172.18.0.10');
  });

  it('POST /api/agents/register-ip rejects invalid token', async () => {
    await req(app, 'POST', '/api/agents', { name: 'ip-reg-test-agent' });
    const res = await req(app, 'POST', '/api/agents/register-ip', {
      name: 'ip-reg-test-agent',
      token: 'wrong-token',
      ip_address: '172.18.0.10',
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/agents/register-ip rejects missing fields', async () => {
    const res = await req(app, 'POST', '/api/agents/register-ip', { name: 'test' });
    assert.equal(res.status, 400);
  });
});
