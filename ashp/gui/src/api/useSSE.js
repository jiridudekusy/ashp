import { useEffect, useRef, useCallback } from 'react';

export function useSSE(url, { onEvent, token } = {}) {
  const esRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    const es = new EventSource(`${url}?token=${encodeURIComponent(token || '')}`);
    esRef.current = es;

    const eventTypes = ['request.allowed', 'request.blocked', 'approval.needed', 'approval.resolved', 'rules.changed'];
    for (const type of eventTypes) {
      es.addEventListener(type, (e) => {
        if (onEvent) onEvent(type, JSON.parse(e.data));
      });
    }

    es.onerror = () => {
      es.close();
      reconnectTimer.current = setTimeout(connect, 3000);
    };
  }, [url, token, onEvent]);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) esRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);
}
