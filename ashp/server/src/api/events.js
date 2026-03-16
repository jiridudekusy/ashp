import { Router } from 'express';

export class EventBus {
  #clients = new Set();
  #buffer = [];
  #bufferSize;
  #nextId = 1;

  constructor({ bufferSize = 1000 } = {}) {
    this.#bufferSize = bufferSize;
  }

  emit(eventType, data) {
    const event = { id: this.#nextId++, type: eventType, data };
    this.#buffer.push(event);
    if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    for (const client of this.#clients) this.#sendEvent(client, event);
  }

  #sendEvent(res, event) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

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

  get clientCount() { return this.#clients.size; }
}

export default function eventsRoute(eventBus) {
  const r = Router();
  r.get('/', (req, res) => eventBus.addClient(req, res));
  return r;
}
