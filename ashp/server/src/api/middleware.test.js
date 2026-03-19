import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { basicAuth, errorHandler } from './middleware.js';

function makeApp(auth) {
  const app = express();
  app.use(basicAuth(auth));
  app.get('/test', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

async function req(app, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/test`, { headers });
    return { status: res.status, body: await res.json().catch(() => null), headers: Object.fromEntries(res.headers) };
  } finally {
    server.close();
  }
}

describe('basicAuth', () => {
  const auth = { admin: 'secret123' };

  it('returns 401 without auth header', async () => {
    const app = makeApp(auth);
    const res = await req(app);
    assert.equal(res.status, 401);
    assert.ok(res.headers['www-authenticate']?.includes('Basic'));
  });

  it('returns 401 with wrong credentials', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('admin:wrong').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 401);
  });

  it('returns 401 with wrong username', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('nobody:secret123').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 401);
  });

  it('passes with correct credentials', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('admin:secret123').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('rejects Bearer token format', async () => {
    const app = makeApp(auth);
    const res = await req(app, { Authorization: 'Bearer secret123' });
    assert.equal(res.status, 401);
  });
});

describe('errorHandler', () => {
  it('returns JSON with status and error message', async () => {
    const app = express();
    app.get('/err', (req, res, next) => { const e = new Error('bad'); e.status = 400; next(e); });
    app.use(errorHandler);
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://localhost:${port}/err`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'bad');
    } finally {
      server.close();
    }
  });

  it('defaults to 500', async () => {
    const app = express();
    app.get('/err', (req, res, next) => next(new Error('oops')));
    app.use(errorHandler);
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://localhost:${port}/err`);
      assert.equal(res.status, 500);
    } finally {
      server.close();
    }
  });
});
