/**
 * @file API client factory for the ASHP management REST API.
 *
 * Creates an API wrapper with methods for every endpoint. All requests
 * include Basic auth. Two internal helpers: `request` (JSON responses)
 * and `requestRaw` (text responses, used for encrypted body streaming).
 */

/** Thrown on HTTP 401 — triggers logout in the UI. */
class AuthError extends Error { constructor() { super('Unauthorized'); this.name = 'AuthError'; } }

/**
 * Creates an authenticated API client instance.
 *
 * @param {string} baseURL - API base URL (empty string for same-origin)
 * @param {string} credentials - Base64-encoded "user:password" for Basic auth
 * @returns {Object} API client with methods for rules, logs, approvals, agents, and status
 */
function createClient(baseURL = '', credentials = '') {
  /**
   * Makes an authenticated JSON API request.
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g., '/api/rules')
   * @param {Object} [body] - Request body (JSON-serialized)
   * @returns {Promise<Object|null>} Parsed JSON response, or null for 204
   * @throws {AuthError} On 401 responses
   * @throws {Error} On non-OK responses (with .status and .body properties)
   */
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

  /**
   * Makes an authenticated request returning raw text (for decrypted body content).
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @returns {Promise<string>} Raw response text
   */
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
    // Policies
    getPolicies:        ()            => request('GET', '/api/policies'),
    getPolicy:          (id)          => request('GET', `/api/policies/${id}`),
    createPolicy:       (data)        => request('POST', '/api/policies', data),
    updatePolicy:       (id, data)    => request('PUT', `/api/policies/${id}`, data),
    deletePolicy:       (id)          => request('DELETE', `/api/policies/${id}`),
    addPolicyChild:     (id, childId) => request('POST', `/api/policies/${id}/children`, { child_id: childId }),
    removePolicyChild:  (id, childId) => request('DELETE', `/api/policies/${id}/children/${childId}`),
    assignPolicyAgent:  (id, agentId) => request('POST', `/api/policies/${id}/agents`, { agent_id: agentId }),
    unassignPolicyAgent:(id, agentId) => request('DELETE', `/api/policies/${id}/agents/${agentId}`),
    matchPolicies:      (url, method) => request('GET', `/api/policies/match?url=${encodeURIComponent(url)}&method=${method}`),
    moveRule:           (id, policyId)=> request('POST', `/api/rules/${id}/move`, { policy_id: policyId }),
    // Auth credentials for SSE
    credentials,
  };
}

export { createClient, AuthError };
