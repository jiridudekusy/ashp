import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient, AuthError } from './client.js';

describe('API client', () => {
  let client;
  const TOKEN = 'test-token-123';

  beforeEach(() => {
    global.fetch = vi.fn();
    client = createClient('', TOKEN);
  });

  function mockResponse(status, body = null) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  it('getRules calls GET /api/rules with auth header', async () => {
    const rules = [{ id: '1', pattern: '/foo' }];
    global.fetch.mockResolvedValue(mockResponse(200, rules));

    const result = await client.getRules();

    expect(global.fetch).toHaveBeenCalledWith('/api/rules', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    expect(result).toEqual(rules);
  });

  it('createRule calls POST /api/rules with body', async () => {
    const rule = { pattern: '/bar', action: 'allow' };
    const created = { id: '2', ...rule };
    global.fetch.mockResolvedValue(mockResponse(201, created));

    const result = await client.createRule(rule);

    expect(global.fetch).toHaveBeenCalledWith('/api/rules', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rule),
    });
    expect(result).toEqual(created);
  });

  it('resolveApproval calls POST /api/approvals/:id/resolve', async () => {
    const body = { approved: true };
    global.fetch.mockResolvedValue(mockResponse(200, { ok: true }));

    await client.resolveApproval('abc', body);

    expect(global.fetch).toHaveBeenCalledWith('/api/approvals/abc/resolve', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  });

  it('getStatus calls GET /api/status', async () => {
    const status = { uptime: 1234 };
    global.fetch.mockResolvedValue(mockResponse(200, status));

    const result = await client.getStatus();

    expect(global.fetch).toHaveBeenCalledWith('/api/status', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    expect(result).toEqual(status);
  });

  it('handles 401 by throwing AuthError', async () => {
    global.fetch.mockResolvedValue(mockResponse(401));

    await expect(client.getRules()).rejects.toThrow(AuthError);
  });

  it('handles non-OK response by throwing with status', async () => {
    global.fetch.mockResolvedValue(mockResponse(500, { error: 'fail' }));

    const err = await client.getRules().catch(e => e);
    expect(err.message).toBe('HTTP 500');
    expect(err.status).toBe(500);
  });
});
