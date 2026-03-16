import net from 'node:net';
import { frame, parseFrames } from './protocol.js';

export class IPCServer {
  #socketPath; #server; #client = null; #onMessage;
  #buffer = []; #bufferSize;
  #partial = '';

  constructor(socketPath, { onMessage, bufferSize = 10000 } = {}) {
    this.#socketPath = socketPath;
    this.#onMessage = onMessage || (() => {});
    this.#bufferSize = bufferSize;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.#server = net.createServer((socket) => {
        this.#client = socket;
        this.#partial = '';
        // Flush buffered messages
        for (const msg of this.#buffer) socket.write(frame(msg));
        this.#buffer = [];

        socket.on('data', (chunk) => {
          const { messages, remainder } = parseFrames(this.#partial + chunk.toString());
          this.#partial = remainder;
          for (const m of messages) this.#onMessage(m, this);
        });
        socket.on('close', () => { if (this.#client === socket) this.#client = null; });
        socket.on('error', () => { if (this.#client === socket) this.#client = null; });
      });
      this.#server.listen(this.#socketPath, () => resolve());
      this.#server.on('error', reject);
    });
  }

  send(msg) {
    if (this.#client) {
      this.#client.write(frame(msg));
    } else {
      this.#buffer.push(msg);
      if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    }
  }

  get connected() { return this.#client !== null; }

  close() {
    return new Promise((resolve) => {
      if (this.#client) this.#client.destroy();
      this.#server.close(resolve);
    });
  }
}
