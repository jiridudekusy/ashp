import { randomUUID } from 'node:crypto';

export function frame(msg) {
  if (!msg.msg_id) msg.msg_id = randomUUID();
  return Buffer.from(JSON.stringify(msg) + '\n');
}

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

export function createResponse(original, data) {
  return { ...data, ref: original.msg_id, msg_id: randomUUID() };
}
