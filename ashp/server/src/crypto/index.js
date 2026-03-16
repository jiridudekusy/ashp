import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

export function deriveRecordKey(masterKey, offset) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `ashp-log-record:${offset}`, 32));
}

export function encryptRecord(masterKey, offset, payload) {
  const key = deriveRecordKey(masterKey, offset);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  const totalLen = 4 + 12 + encrypted.length + 16 + 4;
  const record = Buffer.alloc(totalLen);
  let pos = 0;
  record.writeUInt32LE(totalLen, pos); pos += 4;
  nonce.copy(record, pos);             pos += 12;
  encrypted.copy(record, pos);         pos += encrypted.length;
  tag.copy(record, pos);               pos += 16;
  record.writeUInt32LE(totalLen, pos);
  return record;
}

export function decryptRecord(masterKey, offset, record) {
  const key = deriveRecordKey(masterKey, offset);
  let pos = 4;
  const nonce = record.subarray(pos, pos + 12); pos += 12;
  const ciphertext = record.subarray(pos, record.length - 16 - 4);
  const tag = record.subarray(record.length - 16 - 4, record.length - 4);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
