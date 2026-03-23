/**
 * @module ipc/server
 * @description Unix domain socket IPC server for bidirectional communication with the Go proxy.
 *
 * Protocol: newline-delimited JSON (see protocol.js). Supports a single client connection
 * (the Go proxy). Messages sent while disconnected are buffered (up to `bufferSize`) and
 * flushed when the proxy reconnects. This ensures rules/agents reloads are not lost
 * during proxy restarts.
 */
import net from 'node:net';
import { frame, parseFrames } from './protocol.js';

/**
 * Single-client Unix socket IPC server with message buffering.
 */
export class IPCServer {
  #socketPath; #server; #client = null; #onMessage; #onConnect;
  #buffer = []; #bufferSize;
  /** @type {string} Accumulates partial JSON lines across TCP chunks. */
  #partial = '';

  /**
   * @param {string} socketPath - Path to the Unix domain socket file.
   * @param {Object} [options]
   * @param {function(Object, IPCServer): void} [options.onMessage] - Called for each parsed IPC message from the proxy.
   * @param {function(): void} [options.onConnect] - Called when the proxy connects (used to push initial state).
   * @param {number} [options.bufferSize=10000] - Max messages to buffer while disconnected (oldest dropped first).
   */
  constructor(socketPath, { onMessage, onConnect, bufferSize = 10000 } = {}) {
    this.#socketPath = socketPath;
    this.#onMessage = onMessage || (() => {});
    this.#onConnect = onConnect || (() => {});
    this.#bufferSize = bufferSize;
  }

  /**
   * Binds the Unix socket and begins accepting connections.
   * @returns {Promise<void>} Resolves when the socket is listening.
   * @throws {Error} If the socket path is already in use or inaccessible.
   */
  start() {
    return new Promise((resolve, reject) => {
      this.#server = net.createServer((socket) => {
        this.#client = socket;
        this.#partial = '';
        // Flush buffered messages that accumulated while disconnected
        for (const msg of this.#buffer) socket.write(frame(msg));
        this.#buffer = [];
        this.#onConnect();

        socket.on('data', (chunk) => {
          // Accumulate partial lines across TCP chunk boundaries
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

  /**
   * Sends a message to the connected proxy. If disconnected, buffers the message
   * (dropping the oldest if the buffer is full).
   *
   * @param {Object} msg - Message object to send (will be JSON-serialized and newline-framed).
   */
  send(msg) {
    if (this.#client) {
      this.#client.write(frame(msg));
    } else {
      this.#buffer.push(msg);
      if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    }
  }

  /** @returns {boolean} Whether the Go proxy is currently connected. */
  get connected() { return this.#client !== null; }

  /**
   * Closes the IPC server and destroys any active client connection.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      if (this.#client) this.#client.destroy();
      this.#server.close(resolve);
    });
  }
}
