/**
 * @module webhooks/dispatcher
 * @description Dispatches webhook notifications to configured HTTP endpoints when events
 * occur (e.g. `approval.needed`).
 *
 * Each webhook config specifies:
 * - `url` — target HTTP endpoint
 * - `secret` — shared secret for HMAC-SHA256 signature (sent in `X-ASHP-Signature` header)
 * - `events` — array of event types to subscribe to
 * - `timeout_ms` — request timeout (default 5000ms)
 * - `retries` — max retry attempts (default 3)
 *
 * Retries use exponential backoff: 100ms, 200ms, 400ms, etc.
 * Failed deliveries are silently dropped after exhausting retries (fire-and-forget).
 */
import { createHmac } from 'node:crypto';

/**
 * Dispatches webhook events to configured HTTP endpoints with HMAC signing and retry.
 */
export class WebhookDispatcher {
  #webhooks;

  /**
   * @param {Array<{url: string, secret: string, events: string[], timeout_ms?: number, retries?: number}>} webhooks
   */
  constructor(webhooks = []) {
    this.#webhooks = webhooks;
  }

  /**
   * Dispatches an event to all webhooks subscribed to the given event type.
   * Uses `Promise.allSettled` so one failing webhook does not block others.
   *
   * @param {string} eventType - Event name (e.g. 'approval.needed').
   * @param {Object} data - Event payload.
   * @returns {Promise<void>}
   */
  async dispatch(eventType, data) {
    const matching = this.#webhooks.filter(w => w.events.includes(eventType));
    await Promise.allSettled(matching.map(w => this.#deliver(w, eventType, data)));
  }

  /**
   * Delivers a single webhook with HMAC-SHA256 signature and exponential-backoff retry.
   *
   * @param {Object} webhook - Webhook configuration object.
   * @param {string} eventType
   * @param {Object} data
   * @param {number} [attempt=0] - Current retry attempt (0-indexed).
   * @returns {Promise<void>}
   * @private
   */
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

  /**
   * Replaces the webhook configuration list (used during SIGHUP live reload).
   * @param {Array<{url: string, secret: string, events: string[], timeout_ms?: number, retries?: number}>} webhooks
   */
  reload(webhooks) { this.#webhooks = webhooks; }
}
