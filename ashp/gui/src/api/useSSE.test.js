import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useSSE } from './useSSE.js';

/**
 * Creates a mock ReadableStream that yields SSE-formatted chunks.
 * @param {string[]} chunks - Raw string chunks to emit
 */
function mockStream(chunks) {
  let idx = 0;
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('useSSE', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects with Basic auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: mockStream([]),
    });

    renderHook(() => useSSE('/api/events', { credentials: 'cred123' }));

    // Let the async connect() run
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledWith('/api/events', expect.objectContaining({
      headers: { Authorization: 'Basic cred123' },
    }));
  });

  it('calls onEvent for parsed SSE frames', async () => {
    const handler = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: mockStream([
        'event: request.allowed\ndata: {"id":"1","action":"allow"}\n\n',
      ]),
    });

    renderHook(() => useSSE('/api/events', { onEvent: handler, credentials: 'cred' }));

    await vi.advanceTimersByTimeAsync(10);

    expect(handler).toHaveBeenCalledWith('request.allowed', { id: '1', action: 'allow' });
  });

  it('reconnects on non-ok response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, body: mockStream([]) });

    const onDisconnect = vi.fn();
    renderHook(() => useSSE('/api/events', { credentials: 'cred', onDisconnect }));

    await vi.advanceTimersByTimeAsync(0);
    expect(onDisconnect).toHaveBeenCalled();

    // Reconnect after 3s
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('aborts fetch on unmount', async () => {
    const abortSpy = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
      opts.signal.addEventListener('abort', abortSpy);
      // Never resolve — simulate long-lived connection
      return new Promise(() => {});
    });

    const { unmount } = renderHook(() => useSSE('/api/events', { credentials: 'cred' }));

    await vi.advanceTimersByTimeAsync(0);
    unmount();

    expect(abortSpy).toHaveBeenCalled();
  });
});
