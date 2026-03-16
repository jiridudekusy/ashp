class AuthError extends Error { constructor() { super('Unauthorized'); this.name = 'AuthError'; } }

function createClient(baseURL = '', token = '') {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      headers: { 'Authorization': `Bearer ${token}` },
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
  };
}

export { createClient, AuthError };
