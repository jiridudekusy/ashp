import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frame, parseFrames, createResponse } from '../../src/ipc/protocol.js';

describe('IPC protocol', () => {
  it('frame serializes JSON with newline delimiter', () => {
    const buf = frame({ type: 'rules.reload' });
    assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
    assert.ok(buf[buf.length - 1] === 0x0a, 'should end with newline');
    const parsed = JSON.parse(buf.toString());
    assert.equal(parsed.type, 'rules.reload');
  });

  it('frame auto-generates msg_id if missing', () => {
    const buf = frame({ type: 'rules.reload' });
    const parsed = JSON.parse(buf.toString());
    assert.ok(parsed.msg_id, 'should have msg_id');
    assert.match(parsed.msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('frame preserves existing msg_id', () => {
    const buf = frame({ type: 'rules.reload', msg_id: 'abc' });
    const parsed = JSON.parse(buf.toString());
    assert.equal(parsed.msg_id, 'abc');
  });

  it('parseFrames splits multiple messages on newline', () => {
    const input = '{"a":1}\n{"b":2}\n';
    const { messages, remainder } = parseFrames(input);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { a: 1 });
    assert.deepEqual(messages[1], { b: 2 });
    assert.equal(remainder, '');
  });

  it('parseFrames handles partial messages', () => {
    const input = '{"a":1}\n{"b":2';
    const { messages, remainder } = parseFrames(input);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { a: 1 });
    assert.equal(remainder, '{"b":2');
  });

  it('parseFrames ignores empty lines', () => {
    const input = '{"a":1}\n\n\n{"b":2}\n';
    const { messages } = parseFrames(input);
    assert.equal(messages.length, 2);
  });

  it('createResponse creates message with ref to original msg_id', () => {
    const original = { msg_id: 'orig-123', type: 'request' };
    const response = createResponse(original, { type: 'response', status: 'ok' });
    assert.equal(response.ref, 'orig-123');
    assert.equal(response.type, 'response');
    assert.equal(response.status, 'ok');
    assert.ok(response.msg_id, 'response should have its own msg_id');
    assert.notEqual(response.msg_id, 'orig-123');
  });
});
