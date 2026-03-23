import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import logsRoutes from '../../src/api/logs.js';
import { errorHandler } from '../../src/api/middleware.js';

let mockRequestLogDAO, mockCrypto, mockConfig;
let queriedFilters;

function setup() {
  queriedFilters = null;
  mockRequestLogDAO = {
    query: async (filters) => {
      queriedFilters = filters;
      return [
        { id: 1, method: 'GET', url: 'https://example.com', decision: 'allowed' },
        { id: 2, method: 'POST', url: 'https://api.example.com', decision: 'denied' },
      ];
    },
    getById: async (id) => {
      if (id === 1) return { id: 1, method: 'GET', url: 'https://example.com', request_body_ref: null };
      if (id === 2) return { id: 2, method: 'POST', url: 'https://api.example.com', request_body_ref: 'logs/test.enc:0:100' };
      return null;
    },
  };
  mockCrypto = {
    logKey: Buffer.alloc(32),
    decryptRecord: (key, offset, buf) => Buffer.from('decrypted body content'),
  };
  mockConfig = {
    database: { path: '/data/ashp/db.sqlite' },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/logs', logsRoutes({ requestLogDAO: mockRequestLogDAO, crypto: mockCrypto, config: mockConfig }));
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
      path: opts.path || '/api/logs',
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), raw });
        } catch {
          resolve({ status: res.statusCode, body: raw.toString(), raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('logs API', () => {
  it('GET /api/logs returns filtered list', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/logs?method=GET' });
      assert.equal(res.status, 200);
      assert.equal(res.body.length, 2);
      assert.equal(queriedFilters.method, 'GET');
      assert.equal(queriedFilters.limit, 50);
      assert.equal(queriedFilters.offset, 0);
    } finally {
      server.close();
    }
  });

  it('GET /api/logs passes all query params', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, {
        path: '/api/logs?from=2026-01-01&to=2026-12-31&method=POST&decision=allowed&limit=10&offset=5',
      });
      assert.equal(res.status, 200);
      assert.equal(queriedFilters.from, '2026-01-01');
      assert.equal(queriedFilters.to, '2026-12-31');
      assert.equal(queriedFilters.method, 'POST');
      assert.equal(queriedFilters.decision, 'allowed');
      assert.equal(queriedFilters.limit, 10);
      assert.equal(queriedFilters.offset, 5);
    } finally {
      server.close();
    }
  });

  it('GET /api/logs/:id returns log detail', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/logs/1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 1);
    } finally {
      server.close();
    }
  });

  it('GET /api/logs/:id returns 404 for missing', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const res = await request(server, { path: '/api/logs/999' });
      assert.equal(res.status, 404);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('GET /api/logs/:id/request-body streams decrypted body', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = join(tmpdir(), `ashp-test-${Date.now()}`);
    await mkdir(join(tempDir, 'logs'), { recursive: true });

    const encData = Buffer.alloc(100, 0x42);
    await writeFile(join(tempDir, 'logs', 'test.enc'), encData);

    const localConfig = { database: { path: join(tempDir, 'db.sqlite') } };
    const localDAO = {
      getById: async (id) => {
        if (id === 2) return { id: 2, method: 'POST', request_body_ref: 'logs/test.enc:0:100' };
        return null;
      },
    };
    const localCrypto = {
      logKey: Buffer.alloc(32),
      decryptRecord: (key, offset, buf) => Buffer.from('decrypted body content'),
    };

    const app2 = express();
    app2.use(express.json());
    app2.use('/api/logs', logsRoutes({ requestLogDAO: localDAO, crypto: localCrypto, config: localConfig }));
    app2.use(errorHandler);

    const server = await listen(app2);
    try {
      const res = await request(server, { path: '/api/logs/2/request-body' });
      assert.equal(res.status, 200);
      assert.equal(res.body, 'decrypted body content');
    } finally {
      server.close();
      await rm(tempDir, { recursive: true });
    }
  });

  it('GET /api/logs?agent_id= filters by agent', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      const passedFilters = {};
      mockRequestLogDAO.query = async (filters) => { Object.assign(passedFilters, filters); return []; };
      const res = await request(server, { path: '/api/logs?agent_id=agent1' });
      assert.equal(res.status, 200);
      assert.equal(passedFilters.agent_id, 'agent1');
    } finally {
      server.close();
    }
  });

  it('GET /api/logs/:id/request-body returns 404 when no body ref', async () => {
    const app = setup();
    const server = await listen(app);
    try {
      // id=1 has request_body_ref: null
      const res = await request(server, { path: '/api/logs/1/request-body' });
      assert.equal(res.status, 404);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });
});
