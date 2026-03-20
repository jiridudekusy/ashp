class AuthError extends Error { constructor() { super('Unauthorized'); this.name = 'AuthError'; } }

function createClient(baseURL = '', credentials = '') {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseURL}${path}`, opts);
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch {}
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function requestRaw(method, path) {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { 'Authorization': `Basic ${credentials}` },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch {}
      throw err;
    }
    return res.text();
  }

  return {
    getRules:         ()          => request('GET', '/api/rules'),
    getRule:          (id)        => request('GET', `/api/rules/${id}`),
    createRule:       (rule)      => request('POST', '/api/rules', rule),
    updateRule:       (id, rule)  => request('PUT', `/api/rules/${id}`, rule),
    deleteRule:       (id)        => request('DELETE', `/api/rules/${id}`),
    testRule:         (url, method) => request('POST', '/api/rules/test', { url, method }),
    getLogs:          (params)    => request('GET', `/api/logs?${new URLSearchParams(params)}`),
    getLog:           (id)        => request('GET', `/api/logs/${id}`),
    getRequestBody:   (id)        => requestRaw('GET', `/api/logs/${id}/request-body`),
    getResponseBody:  (id)        => requestRaw('GET', `/api/logs/${id}/response-body`),
    getApprovals:     ()          => request('GET', '/api/approvals'),
    resolveApproval:  (id, body)  => request('POST', `/api/approvals/${id}/resolve`, body),
    getStatus:        ()          => request('GET', '/api/status'),
    // New agent methods
    getAgents:        ()          => request('GET', '/api/agents'),
    getAgent:         (id)        => request('GET', `/api/agents/${id}`),
    createAgent:      (data)      => request('POST', '/api/agents', data),
    updateAgent:      (id, data)  => request('PUT', `/api/agents/${id}`, data),
    deleteAgent:      (id)        => request('DELETE', `/api/agents/${id}`),
    rotateToken:      (id)        => request('POST', `/api/agents/${id}/rotate-token`),
    // Auth credentials for SSE
    credentials,
  };
}

export { createClient, AuthError };
