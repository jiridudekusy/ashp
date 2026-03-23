/**
 * @module crypto
 * @description AES-256-GCM encryption/decryption for request/response body log records.
 *
 * The Go proxy writes encrypted body blobs to append-only log files on disk.
 * Each record is keyed independently using HKDF: the master key and the file
 * offset are fed into HKDF-SHA256 to derive a unique 256-bit AES key per record.
 * This means compromising one record's key does not expose others.
 *
 * Record wire format (all integers are little-endian):
 * ```
 * [total_len:4][nonce:12][ciphertext:N][auth_tag:16][total_len:4]
 * ```
 * The duplicated `total_len` trailer allows reverse scanning of the log file.
 *
 * The database stores body references as `path:offset:length` strings. The Node
 * server reads the raw bytes at that offset, then calls `decryptRecord` to recover
 * the plaintext (see api/logs.js streamBody).
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

/**
 * Derives a per-record AES-256 key from the master key using HKDF-SHA256.
 *
 * @param {Buffer} masterKey - 32-byte master encryption key.
 * @param {number} offset - File offset of this record, used as part of the HKDF info string
 *   to ensure each record gets a unique derived key.
 * @returns {Buffer} 32-byte derived key.
 */
export function deriveRecordKey(masterKey, offset) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `ashp-log-record:${offset}`, 32));
}

/**
 * Encrypts a plaintext payload into a self-contained log record.
 *
 * @param {Buffer} masterKey - 32-byte master encryption key.
 * @param {number} offset - File offset where this record will be written (used for key derivation).
 * @param {Buffer} payload - Plaintext data to encrypt.
 * @returns {Buffer} The complete encrypted record including length headers, nonce, ciphertext, and auth tag.
 */
export function encryptRecord(masterKey, offset, payload) {
  const key = deriveRecordKey(masterKey, offset);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Pack: [total_len:4][nonce:12][ciphertext:N][tag:16][total_len:4]
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

/**
 * Decrypts an encrypted log record back to plaintext.
 *
 * @param {Buffer} masterKey - 32-byte master encryption key (same key used to encrypt).
 * @param {number} offset - File offset of this record (must match the offset used during encryption).
 * @param {Buffer} record - The raw encrypted record bytes (including length headers).
 * @returns {Buffer} The decrypted plaintext payload.
 * @throws {Error} If authentication fails (tampered data or wrong key/offset).
 */
export function decryptRecord(masterKey, offset, record) {
  const key = deriveRecordKey(masterKey, offset);
  // Skip leading total_len (4 bytes), read nonce, ciphertext, tag; skip trailing total_len
  let pos = 4;
  const nonce = record.subarray(pos, pos + 12); pos += 12;
  const ciphertext = record.subarray(pos, record.length - 16 - 4);
  const tag = record.subarray(record.length - 16 - 4, record.length - 4);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
