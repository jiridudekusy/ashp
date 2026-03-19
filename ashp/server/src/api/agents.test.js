import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from './middleware.js';
import agentsRoutes from './agents.js';

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
    _agents: agents,
  };
}

function makeApp(agentsDAO) {
  const app = express();
  app.use(express.json());
  const ipc = { send: () => {} };
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
});
