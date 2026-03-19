import { useEffect, useRef, useCallback } from 'react';

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
