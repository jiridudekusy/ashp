import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecordKey, encryptRecord, decryptRecord } from './index.js';

describe('crypto', () => {
  const masterKey = Buffer.alloc(32, 0xab);

  it('deriveRecordKey produces 32-byte key', () => {
    const key = deriveRecordKey(masterKey, 0);
    assert.equal(key.length, 32);
  });

  it('different offsets produce different keys', () => {
    const k1 = deriveRecordKey(masterKey, 0);
    const k2 = deriveRecordKey(masterKey, 1);
    assert.notDeepEqual(k1, k2);
  });

  it('same offset produces same key', () => {
    const k1 = deriveRecordKey(masterKey, 42);
    const k2 = deriveRecordKey(masterKey, 42);
    assert.deepEqual(k1, k2);
  });

  it('encryptRecord/decryptRecord round-trips payload', () => {
    const payload = Buffer.from('hello world');
    const record = encryptRecord(masterKey, 0, payload);
    const decrypted = decryptRecord(masterKey, 0, record);
    assert.deepEqual(decrypted, payload);
  });

  it('record has matching length prefix and suffix', () => {
    const payload = Buffer.from('test');
    const record = encryptRecord(masterKey, 0, payload);
    const prefix = record.readUInt32LE(0);
    const suffix = record.readUInt32LE(record.length - 4);
    assert.equal(prefix, suffix);
    assert.equal(prefix, record.length);
  });

  it('tampered ciphertext fails auth', () => {
    const payload = Buffer.from('secret');
    const record = encryptRecord(masterKey, 0, payload);
    record[20] ^= 0xff;
    assert.throws(() => decryptRecord(masterKey, 0, record));
  });

  it('wrong offset fails decryption', () => {
    const payload = Buffer.from('secret');
    const record = encryptRecord(masterKey, 0, payload);
    assert.throws(() => decryptRecord(masterKey, 999, record));
  });
});
