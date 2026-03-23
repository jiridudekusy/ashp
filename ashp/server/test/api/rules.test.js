import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import rulesRoutes from '../../src/api/rules.js';
import { errorHandler } from '../../src/api/middleware.js';

let mockRulesDAO, mockConfig, mockIpc, mockEvents;

function setup(configOverrides = {}) {
  mockRulesDAO = {
    list: async () => [
      { id: 1, name: 'Rule 1', url_pattern: '*.example.com', action: 'allow' },
      { id: 2, name: 'Rule 2', url_pattern: '*.blocked.com', action: 'deny' },
    ],
    get: async (id) => (id === 1 ? { id: 1, name: 'Rule 1' } : null),
    create: async (rule) => ({ id: 1, ...rule }),
    update: async (id, data) => (id === 1 ? { id: 1, ...data } : null),
    delete: async (id) => {},
    match: async (url, method) => {
      if (url === 'https://example.com') return { id: 1, action: 'allow', url_pattern: '*.example.com' };
      return null;
    },
  };
  mockConfig = {
    rules: { source: 'db' },
    default_behavior: 'deny',
    ...configOverrides,
  };
  mockIpc = { calls: [], send(msg) { this.calls.push(msg); } };
  mockEvents = { calls: [], emit(type, data) { this.calls.push({ type, data }); } };

  const app = express();
  app.use(express.json());
  app.use('/api/rules', rulesRoutes({ rulesDAO: mockRulesDAO, config: mockConfig, ipc: mockIpc, events: mockEvents }));
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
      path: opts.path || '/api/rules',
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

describe('rules API', () => {
  it('GET /api/rules returns rule list', async () => {
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

  it('GET /api/rules/:id returns single rule', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/rules/1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 1);
    } finally {
      server.close();
    }
  });

  it('GET /api/rules/:id returns 404 for missing', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/rules/999' });
      assert.equal(res.status, 404);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('POST /api/rules creates rule in db mode', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        body: { name: 'New Rule', url_pattern: '*.new.com', action: 'allow' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'New Rule');
    } finally {
      server.close();
    }
  });

  it('POST /api/rules returns 403 in file mode', async () => {
    const app = setup({ rules: { source: 'file' } });
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        body: { name: 'New Rule' },
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });

  it('PUT /api/rules/:id updates rule', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'PUT',
        path: '/api/rules/1',
        body: { name: 'Updated Rule' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Updated Rule');
    } finally {
      server.close();
    }
  });

  it('DELETE /api/rules/:id deletes rule', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'DELETE',
        path: '/api/rules/1',
      });
      assert.equal(res.status, 204);
    } finally {
      server.close();
    }
  });

  it('POST /api/rules/test tests URL against rules', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/rules/test',
        body: { url: 'https://example.com', method: 'GET' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.match);
      assert.equal(res.body.decision, 'allow');

      // Test no match — should fall back to default_behavior
      mockRulesDAO.match = async () => null;
      const res2 = await request(server, {
        method: 'POST',
        path: '/api/rules/test',
        body: { url: 'https://unknown.com', method: 'GET' },
      });
      assert.equal(res2.body.match, null);
      assert.equal(res2.body.decision, 'deny');
    } finally {
      server.close();
    }
  });

  it('POST /api/rules triggers ipc rules.reload', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      await request(server, {
        method: 'POST',
        body: { name: 'Rule' },
      });
      assert.ok(mockIpc.calls.some((c) => c.type === 'rules.reload'));
    } finally {
      server.close();
    }
  });
});
