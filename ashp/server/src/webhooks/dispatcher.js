import { createHmac } from 'node:crypto';

export class WebhookDispatcher {
  #webhooks;

  constructor(webhooks = []) {
    this.#webhooks = webhooks;
  }

  async dispatch(eventType, data) {
    const matching = this.#webhooks.filter(w => w.events.includes(eventType));
    await Promise.allSettled(matching.map(w => this.#deliver(w, eventType, data)));
  }

  async #deliver(webhook, eventType, data, attempt = 0) {
    const body = JSON.stringify({ event: eventType, data, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhook.timeout_ms || 5000);

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ASHP-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok && attempt < (webhook.retries ?? 3)) {
        await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
        return this.#deliver(webhook, eventType, data, attempt + 1);
      }
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < (webhook.retries ?? 3)) {
        await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
        return this.#deliver(webhook, eventType, data, attempt + 1);
      }
    }
  }

  reload(webhooks) { this.#webhooks = webhooks; }
}
