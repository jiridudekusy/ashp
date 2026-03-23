/**
 * @module api/events
 * @description Server-Sent Events (SSE) bus and streaming endpoint.
 *
 * The EventBus is a pub/sub hub: server-side code calls `emit()` to broadcast events
 * (e.g. `request.allowed`, `approval.needed`, `rules.changed`), and connected SSE
 * clients receive them in real time via `GET /api/events`.
 *
 * Features:
 * - Event buffering: recent events are kept in memory so reconnecting clients can
 *   catch up using the `Last-Event-ID` header (standard SSE reconnection protocol).
 * - Each event has an auto-incrementing `id` for ordering and replay.
 */
import { Router } from 'express';

/**
 * In-memory pub/sub event bus with SSE client management and replay buffer.
 */
export class EventBus {
  /** @type {Set<import('express').Response>} Active SSE client connections. */
  #clients = new Set();
  /** @type {Array<{id: number, type: string, data: Object}>} Circular event buffer for replay. */
  #buffer = [];
  #bufferSize;
  #nextId = 1;

  /**
   * @param {Object} [options]
   * @param {number} [options.bufferSize=1000] - Max events to retain for replay on reconnect.
   */
  constructor({ bufferSize = 1000 } = {}) {
    this.#bufferSize = bufferSize;
  }

  /**
   * Broadcasts an event to all connected SSE clients and adds it to the replay buffer.
   *
   * @param {string} eventType - SSE event name (e.g. 'request.allowed', 'approval.needed').
   * @param {Object} data - Event payload (JSON-serialized in the SSE `data:` field).
   */
  emit(eventType, data) {
    const event = { id: this.#nextId++, type: eventType, data };
    this.#buffer.push(event);
    if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    for (const client of this.#clients) this.#sendEvent(client, event);
  }

  /**
   * Writes a single SSE-formatted event to a response stream.
   * @param {import('express').Response} res
   * @param {{id: number, type: string, data: Object}} event
   * @private
   */
  #sendEvent(res, event) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  /**
   * Registers an SSE client. Sets appropriate headers, sends an initial `:ok` comment,
   * replays any missed events (based on `Last-Event-ID`), and tracks the connection.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

    // Replay missed events if the client provides Last-Event-ID
    const lastIdHeader = req.headers['last-event-id'];
    if (lastIdHeader !== undefined) {
      const lastId = parseInt(lastIdHeader) || 0;
      for (const event of this.#buffer) {
        if (event.id > lastId) this.#sendEvent(res, event);
      }
    }

    this.#clients.add(res);
    req.on('close', () => this.#clients.delete(res));
  }

  /** @returns {number} Number of currently connected SSE clients. */
  get clientCount() { return this.#clients.size; }
}

/**
 * Creates the SSE streaming router.
 *
 * @param {EventBus} eventBus - The shared event bus instance.
 * @returns {import('express').Router}
 */
export default function eventsRoute(eventBus) {
  const r = Router();
  r.get('/', (req, res) => eventBus.addClient(req, res));
  return r;
}
