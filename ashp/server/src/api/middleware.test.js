import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { bearerAuth, errorHandler } from './middleware.js';

function makeApp(token, routeHandler) {
  const app = express();
  app.use(bearerAuth(token));
  app.get('/test', routeHandler || ((req, res) => res.json({ ok: true })));
  app.use(errorHandler);
  return app;
}

function request(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOpts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: opts.path || '/test',
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('middleware', () => {
  it('rejects request with no Authorization header', async () => {
    const app = makeApp('secret-token');
    const server = await listen(app);
    try {
      const res = await request(server);
      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    } finally {
      server.close();
    }
  });

  it('rejects request with wrong token', async () => {
    const app = makeApp('secret-token');
    const server = await listen(app);
    try {
      const res = await request(server, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });

  it('passes request with valid bearer token', async () => {
    const app = makeApp('secret-token');
    const server = await listen(app);
    try {
      const res = await request(server, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    } finally {
      server.close();
    }
  });

  it('error handler returns JSON with status and error message', async () => {
    const app = makeApp('secret-token', (req, res, next) => {
      next(new Error('boom'));
    });
    const server = await listen(app);
    try {
      const res = await request(server, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'boom');
    } finally {
      server.close();
    }
  });

  it('error handler respects err.status', async () => {
    const app = makeApp('secret-token', (req, res, next) => {
      const err = new Error('bad input');
      err.status = 422;
      next(err);
    });
    const server = await listen(app);
    try {
      const res = await request(server, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      assert.equal(res.status, 422);
      assert.equal(res.body.error, 'bad input');
    } finally {
      server.close();
    }
  });
});
