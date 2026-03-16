import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useSSE } from './useSSE.js';

describe('useSSE', () => {
  let mockES;
  let listeners;

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = {};
    mockES = {
      addEventListener: vi.fn((type, cb) => { listeners[type] = cb; }),
      close: vi.fn(),
      onerror: null,
    };
    global.EventSource = vi.fn(() => mockES);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete global.EventSource;
  });

  it('connects to /api/events with auth', () => {
    renderHook(() => useSSE('/api/events', { token: 'tok123' }));

    expect(global.EventSource).toHaveBeenCalledWith('/api/events?token=tok123');
  });

  it('calls handler on event', () => {
    const handler = vi.fn();
    renderHook(() => useSSE('/api/events', { onEvent: handler, token: 'tok' }));

    const data = { id: '1', action: 'allow' };
    listeners['request.allowed']({ data: JSON.stringify(data) });

    expect(handler).toHaveBeenCalledWith('request.allowed', data);
  });

  it('reconnects on error', () => {
    renderHook(() => useSSE('/api/events', { token: 'tok' }));

    expect(global.EventSource).toHaveBeenCalledTimes(1);

    // Simulate error
    mockES.onerror();

    expect(mockES.close).toHaveBeenCalled();

    // Create new mock for reconnection
    const mockES2 = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null,
    };
    global.EventSource.mockReturnValue(mockES2);

    vi.advanceTimersByTime(3000);

    expect(global.EventSource).toHaveBeenCalledTimes(2);
  });

  it('cleans up on unmount', () => {
    const { unmount } = renderHook(() => useSSE('/api/events', { token: 'tok' }));

    unmount();

    expect(mockES.close).toHaveBeenCalled();
  });
});
