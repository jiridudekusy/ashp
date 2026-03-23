/**
 * @module ipc/protocol
 * @description Newline-delimited JSON (NDJSON) framing for IPC messages between Node and Go.
 *
 * Each message is a single JSON object terminated by `\n`. Every message carries a
 * unique `msg_id` (UUID v4) for correlation. Response messages include a `ref` field
 * pointing to the original message's `msg_id` — this is how the Go proxy matches
 * approval responses back to held connections.
 */
import { randomUUID } from 'node:crypto';

/**
 * Serializes a message object to a newline-terminated JSON Buffer.
 * Assigns a `msg_id` (UUID v4) if one is not already present.
 *
 * @param {Object} msg - Message object to frame.
 * @returns {Buffer} The JSON-serialized message followed by a newline.
 */
export function frame(msg) {
  if (!msg.msg_id) msg.msg_id = randomUUID();
  return Buffer.from(JSON.stringify(msg) + '\n');
}

/**
 * Parses a string buffer that may contain multiple newline-delimited JSON messages.
 * Handles partial messages at the end of a TCP chunk by returning them as `remainder`.
 *
 * @param {string|Buffer} buf - Raw data (possibly spanning multiple messages).
 * @returns {{messages: Object[], remainder: string}} Parsed complete messages and any
 *   trailing partial data to be prepended to the next chunk.
 */
export function parseFrames(buf) {
  const str = typeof buf === 'string' ? buf : buf.toString();
  const lines = str.split('\n');
  const remainder = lines.pop(); // last element is either '' or partial
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    messages.push(JSON.parse(trimmed));
  }
  return { messages, remainder };
}

/**
 * Creates a response message that references the original message's `msg_id`.
 * Used to correlate approval responses back to the proxy's held connections.
 *
 * @param {Object} original - The original message being responded to (must have `msg_id`).
 * @param {Object} data - Response payload fields.
 * @returns {Object} A new message with `ref` set to the original's `msg_id` and a fresh `msg_id`.
 */
export function createResponse(original, data) {
  return { ...data, ref: original.msg_id, msg_id: randomUUID() };
}
