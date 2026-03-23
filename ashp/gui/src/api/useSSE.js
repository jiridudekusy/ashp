/**
 * @file React hook for consuming Server-Sent Events from the ASHP management API.
 *
 * Uses fetch() with a streaming reader instead of the native EventSource API
 * because EventSource doesn't support custom headers (needed for Basic auth).
 * Implements automatic reconnection with a 3-second backoff on disconnect or error.
 *
 * SSE frame parsing: expects "event: <type>\ndata: <json>\n\n" format.
 * Incomplete lines are buffered across chunks for correct frame reassembly.
 */
import { useEffect, useRef, useCallback } from 'react';

/**
 * Connects to an SSE endpoint with Basic auth and auto-reconnection.
 *
 * @param {string} url - SSE endpoint path (e.g., '/api/events')
 * @param {Object} options
 * @param {Function} options.onEvent - Called with (eventType, parsedData) for each SSE message
 * @param {string} options.credentials - Base64-encoded Basic auth credentials
 * @param {Function} [options.onConnect] - Called when the stream is successfully opened
 * @param {Function} [options.onDisconnect] - Called when the stream is lost (triggers 3s reconnect)
 */
export function useSSE(url, { onEvent, credentials, onConnect, onDisconnect } = {}) {
  const abortRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    if (!credentials) return;

    const controller = new AbortController();
    abortRef.current = controller;

    async function run() {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${credentials}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          onDisconnect?.();
          reconnectTimer.current = setTimeout(connect, 3000);
          return;
        }

        onConnect?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                if (onEvent) onEvent(currentEvent, data);
              } catch { /* ignore parse errors */ }
              currentEvent = null;
            } else if (line === '') {
              currentEvent = null;
            }
          }
        }
        // Stream ended — reconnect
        onDisconnect?.();
        reconnectTimer.current = setTimeout(connect, 3000);
      } catch (err) {
        if (err.name !== 'AbortError') {
          onDisconnect?.();
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      }
    }

    run();
  }, [url, credentials, onEvent, onConnect, onDisconnect]);

  useEffect(() => {
    connect();
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);
}
