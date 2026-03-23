import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import eventsRoute, { EventBus } from '../../src/api/events.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function connectSSE(server, headers = {}) {
  return new Promise((resolve) => {
    const addr = server.address();
    const req = http.get({
      hostname: '127.0.0.1',
      port: addr.port,
      path: '/events',
      headers: { Accept: 'text/event-stream', ...headers },
    }, (res) => {
      const stream = { req, res, chunks: '', blocks: [], waiters: [] };
      res.on('data', (chunk) => {
        stream.chunks += chunk.toString();
        // Re-parse all complete blocks
        const parts = stream.chunks.split('\n\n');
        // Last part may be incomplete
        stream.blocks = parts.slice(0, -1).filter(b => b.length > 0);
        // Resolve any waiters
        for (const w of stream.waiters) {
          if (stream.blocks.length >= w.count) {
            w.resolve(stream.blocks.slice(0, w.count));
          }
        }
        stream.waiters = stream.waiters.filter(w => stream.blocks.length < w.count);
      });
      resolve(stream);
    });
  });
}

function waitForBlocks(stream, count) {
  if (stream.blocks.length >= count) {
    return Promise.resolve(stream.blocks.slice(0, count));
  }
  return new Promise((resolve) => {
    stream.waiters.push({ count, resolve });
  });
}

describe('SSE events endpoint', () => {
  let server;
  let streams = [];

  afterEach(async () => {
    for (const s of streams) {
      try { s.req.destroy(); } catch {}
    }
    streams = [];
    if (server) await new Promise(r => server.close(r));
    server = null;
  });

  it('connects and receives initial comment', async () => {
    const eventBus = new EventBus();
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    const stream = await connectSSE(server);
    streams.push(stream);

    const blocks = await waitForBlocks(stream, 1);
    assert.ok(blocks[0].startsWith(':ok'), 'first data should start with :ok');
  });

  it('receives emitted event', async () => {
    const eventBus = new EventBus();
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    const stream = await connectSSE(server);
    streams.push(stream);

    // Wait for initial comment
    await waitForBlocks(stream, 1);

    // Emit an event
    eventBus.emit('request.allowed', { url: 'https://example.com' });

    const blocks = await waitForBlocks(stream, 2);
    const eventBlock = blocks[1];
    assert.ok(eventBlock.includes('event: request.allowed'), 'should contain event type');
    assert.ok(eventBlock.includes('data: '), 'should contain data');
    const dataLine = eventBlock.split('\n').find(l => l.startsWith('data: '));
    const parsed = JSON.parse(dataLine.replace('data: ', ''));
    assert.deepStrictEqual(parsed, { url: 'https://example.com' });
  });

  it('each event has incrementing id', async () => {
    const eventBus = new EventBus();
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    const stream = await connectSSE(server);
    streams.push(stream);

    await waitForBlocks(stream, 1);

    eventBus.emit('e1', { n: 1 });
    eventBus.emit('e2', { n: 2 });
    eventBus.emit('e3', { n: 3 });

    const blocks = await waitForBlocks(stream, 4);
    const ids = blocks.slice(1).map(b => {
      const idLine = b.split('\n').find(l => l.startsWith('id: '));
      return parseInt(idLine.replace('id: ', ''));
    });
    assert.deepStrictEqual(ids, [1, 2, 3]);
  });

  it('Last-Event-ID replays missed events', async () => {
    const eventBus = new EventBus();
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    // Emit 5 events before connecting
    for (let i = 0; i < 5; i++) {
      eventBus.emit('test', { n: i + 1 });
    }

    // Connect with Last-Event-ID: 2
    const stream = await connectSSE(server, { 'Last-Event-ID': '2' });
    streams.push(stream);

    // Should receive :ok + events 3, 4, 5
    const blocks = await waitForBlocks(stream, 4);
    assert.ok(blocks[0].startsWith(':ok'));
    const ids = blocks.slice(1).map(b => {
      const idLine = b.split('\n').find(l => l.startsWith('id: '));
      return parseInt(idLine.replace('id: ', ''));
    });
    assert.deepStrictEqual(ids, [3, 4, 5]);
  });

  it('buffer drops oldest events beyond limit', async () => {
    const eventBus = new EventBus({ bufferSize: 3 });
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    // Emit 5 events
    for (let i = 0; i < 5; i++) {
      eventBus.emit('test', { n: i + 1 });
    }

    // Reconnect with Last-Event-ID: 0 — only last 3 events should be in buffer
    const stream = await connectSSE(server, { 'Last-Event-ID': '0' });
    streams.push(stream);

    // Should receive :ok + events 3, 4, 5
    const blocks = await waitForBlocks(stream, 4);
    assert.ok(blocks[0].startsWith(':ok'));
    const ids = blocks.slice(1).map(b => {
      const idLine = b.split('\n').find(l => l.startsWith('id: '));
      return parseInt(idLine.replace('id: ', ''));
    });
    assert.deepStrictEqual(ids, [3, 4, 5]);
  });

  it('multiple clients receive same event', async () => {
    const eventBus = new EventBus();
    const app = express();
    app.use('/events', eventsRoute(eventBus));
    server = await listen(app);

    const stream1 = await connectSSE(server);
    const stream2 = await connectSSE(server);
    streams.push(stream1, stream2);

    await waitForBlocks(stream1, 1);
    await waitForBlocks(stream2, 1);

    eventBus.emit('broadcast', { msg: 'hello' });

    const [blocks1, blocks2] = await Promise.all([
      waitForBlocks(stream1, 2),
      waitForBlocks(stream2, 2),
    ]);

    assert.ok(blocks1[1].includes('event: broadcast'));
    assert.ok(blocks2[1].includes('event: broadcast'));
  });
});
