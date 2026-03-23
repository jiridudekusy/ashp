import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IPCServer } from '../../src/ipc/server.js';
import { frame, parseFrames } from '../../src/ipc/protocol.js';

let tempDir;
let socketPath;
let server;

function connectClient(path) {
  return new Promise((resolve) => {
    const client = net.createConnection(path, () => resolve(client));
  });
}

function readAll(client) {
  return new Promise((resolve) => {
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
  });
}

function waitForData(client) {
  return new Promise((resolve) => {
    client.once('data', (chunk) => resolve(chunk.toString()));
  });
}

describe('IPCServer', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
    socketPath = join(tempDir, 'test.sock');
  });

  afterEach(async () => {
    if (server) await server.close().catch(() => {});
    server = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts connection and receives framed message', async () => {
    server = new IPCServer(socketPath);
    await server.start();
    const client = await connectClient(socketPath);
    server.send({ type: 'rules.reload' });
    const data = await waitForData(client);
    const { messages } = parseFrames(data);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'rules.reload');
    client.destroy();
  });

  it('receives messages from client', async () => {
    const received = [];
    server = new IPCServer(socketPath, {
      onMessage: (msg) => received.push(msg),
    });
    await server.start();
    const client = await connectClient(socketPath);
    client.write(frame({ type: 'request.logged', url: '/foo' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'request.logged');
    assert.equal(received[0].url, '/foo');
    client.destroy();
  });

  it('handles partial frames across chunks', async () => {
    const received = [];
    server = new IPCServer(socketPath, {
      onMessage: (msg) => received.push(msg),
    });
    await server.start();
    const client = await connectClient(socketPath);
    const fullMsg = JSON.stringify({ type: 'partial.test', value: 42 }) + '\n';
    const mid = Math.floor(fullMsg.length / 2);
    client.write(fullMsg.slice(0, mid));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 0, 'should not parse partial');
    client.write(fullMsg.slice(mid));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'partial.test');
    assert.equal(received[0].value, 42);
    client.destroy();
  });

  it('reconnection after client disconnect', async () => {
    server = new IPCServer(socketPath);
    await server.start();
    const client1 = await connectClient(socketPath);
    client1.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const client2 = await connectClient(socketPath);
    server.send({ type: 'hello.again' });
    const data = await waitForData(client2);
    const { messages } = parseFrames(data);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'hello.again');
    client2.destroy();
  });

  it('buffers messages when no client connected', async () => {
    server = new IPCServer(socketPath);
    await server.start();
    server.send({ type: 'msg', n: 1 });
    server.send({ type: 'msg', n: 2 });
    server.send({ type: 'msg', n: 3 });
    const client = await connectClient(socketPath);
    const data = await waitForData(client);
    const { messages } = parseFrames(data);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].n, 1);
    assert.equal(messages[2].n, 3);
    client.destroy();
  });

  it('ring buffer drops oldest when full', async () => {
    server = new IPCServer(socketPath, { bufferSize: 2 });
    await server.start();
    for (let i = 1; i <= 5; i++) server.send({ type: 'msg', n: i });
    const client = await connectClient(socketPath);
    const data = await waitForData(client);
    const { messages } = parseFrames(data);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].n, 4);
    assert.equal(messages[1].n, 5);
    client.destroy();
  });
});
