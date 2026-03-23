/**
 * @module index
 * @description ASHP server entry point. Orchestrates startup of all subsystems:
 *
 * 1. Loads and validates configuration (config file + CLI flags + env vars)
 * 2. Initializes the SQLite database and DAO layer
 * 3. Starts the Unix-socket IPC server for communication with the Go proxy
 * 4. Spawns the Go MITM proxy as a managed child process
 * 5. Mounts the Express management API (rules, logs, approvals, agents, SSE events)
 * 6. Registers SIGHUP handler for live config reload
 *
 * Architecture overview:
 * - The Go proxy intercepts HTTP(S) traffic and evaluates rules locally.
 * - When a request needs human approval ("queue" mode), the proxy sends an
 *   `approval.needed` IPC message and holds the TCP connection open.
 * - The Node server stores the pending approval (with `ipc_msg_id` for correlation)
 *   and notifies the GUI via SSE / webhooks.
 * - When a human resolves the approval, Node sends an `approval.resolve` IPC message
 *   back to the proxy, referencing the original `ipc_msg_id`, so the proxy can
 *   release or reject the held connection.
 * - Request/response bodies are stored as encrypted blobs on disk by the Go proxy;
 *   the DB stores a `body_ref` in the format `path:offset:length` for retrieval.
 */
import express from 'express';
import { loadConfig } from './config.js';
import { createConnection } from './dao/sqlite/connection.js';
import { SqliteRulesDAO } from './dao/sqlite/rules.js';
import { SqliteRequestLogDAO } from './dao/sqlite/request-log.js';
import { SqliteApprovalQueueDAO } from './dao/sqlite/approval-queue.js';
import { JsonFileRulesDAO } from './dao/jsonfile/rules.js';
import { IPCServer } from './ipc/server.js';
import eventsRoute, { EventBus } from './api/events.js';
import { ProxyManager } from './proxy-manager.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { basicAuth, errorHandler } from './api/middleware.js';
import rulesRoutes from './api/rules.js';
import logsRoutes from './api/logs.js';
import approvalsRoutes from './api/approvals.js';
import agentsRoutes from './api/agents.js';
import statusRoutes from './api/status.js';
import { SqliteAgentsDAO } from './dao/sqlite/agents.js';
import * as crypto from './crypto/index.js';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

/**
 * Bootstraps and starts the ASHP server with all subsystems.
 *
 * @param {Object} [flags={}] - CLI flags (e.g. `{ config: 'path/to/config.json', 'proxy-listen': '0.0.0.0:8080' }`)
 * @returns {Promise<{app: import('express').Application, server: import('http').Server, ipc: IPCServer, proxyManager: ProxyManager, db: import('better-sqlite3').Database, close: () => void}>}
 *   Resolves with handles to all subsystems and a `close()` function for graceful shutdown.
 * @throws {Error} If config loading, DB initialization, or IPC socket binding fails.
 */
export async function startServer(flags = {}) {
  const config = loadConfig(flags);
  const dataDir = dirname(resolve(config.database.path));
  mkdirSync(dataDir, { recursive: true });

  // DAO layer
  const db = createConnection(resolve(config.database.path), config.database.encryption_key);
  const rulesDAO = config.rules.source === 'file'
    ? new JsonFileRulesDAO(resolve(config.rules.file))
    : new SqliteRulesDAO(db);
  const requestLogDAO = new SqliteRequestLogDAO(db);
  const approvalQueueDAO = new SqliteApprovalQueueDAO(db);
  const agentsDAO = new SqliteAgentsDAO(db);

  // IPC — clean up stale socket from previous run
  const socketPath = config.ipc_socket || resolve(dataDir, 'ashp.sock');
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const events = new EventBus();
  const webhooks = new WebhookDispatcher(config.webhooks || []);
  const logKey = config.encryption?.log_key ? Buffer.from(config.encryption.log_key, 'hex') : null;

  /*
   * IPC message flow between Node and the Go proxy:
   * - On proxy connect: push full rules + agents list so the proxy has current state.
   * - On 'request.logged' / 'request.blocked': persist to request_log, emit SSE event.
   * - On 'approval.needed': persist log + enqueue approval with `ipc_msg_id` for later
   *   correlation when the human resolves it (see api/approvals.js).
   * - After any message: update per-rule hit counts and per-agent request counts.
   */
  const ipc = new IPCServer(socketPath, {
    onConnect: async () => {
      try {
        const rules = await rulesDAO.list();
        ipc.send({ type: 'rules.reload', data: rules });
        const agents = agentsDAO.listForProxy();
        ipc.send({ type: 'agents.reload', data: agents });
      } catch (err) {
        console.error('[IPC] onConnect error:', err.message);
      }
    },
    onMessage: async (msg) => {
      try {
      if (msg.type === 'request.logged') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.allowed', msg.data);
      } else if (msg.type === 'request.blocked') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.blocked', msg.data);
      } else if (msg.type === 'approval.needed') {
        // Store ipc_msg_id so the approval resolve can reference it back to the proxy,
        // allowing the held connection to be released or rejected.
        const logEntry = await requestLogDAO.insert(msg.data);
        await approvalQueueDAO.enqueue({
          request_log_id: logEntry.id,
          ipc_msg_id: msg.msg_id,
          suggested_pattern: msg.data.suggested_pattern,
          suggested_methods: msg.data.suggested_methods,
        });
        events.emit('approval.needed', { ...msg.data, log_id: logEntry.id });
        webhooks.dispatch('approval.needed', msg.data);
      }
      if (msg.data?.rule_id) await rulesDAO.incrementHitCount(msg.data.rule_id);
      if (msg.data?.agent_id) await agentsDAO.incrementRequestCount(msg.data.agent_id);
      } catch (err) {
        console.error(`IPC onMessage error (${msg.type}):`, err.message);
      }
    },
  });
  await ipc.start();

  // Proxy manager — spawns the Go binary with IPC socket, listen addr, and crypto args
  const proxyBinPath = config.proxy?.bin_path || resolve(dataDir, '..', 'proxy', 'ashp-proxy');
  const proxyArgs = [
    '--socket', socketPath,
    '--listen', config.proxy.listen,
    '--default-behavior', config.default_behavior || 'deny',
  ];
  if (config.proxy.hold_timeout) proxyArgs.push('--hold-timeout', String(config.proxy.hold_timeout));
  if (config.encryption?.ca_key) proxyArgs.push('--ca-pass', config.encryption.ca_key);
  if (config.encryption?.log_key) proxyArgs.push('--log-key', config.encryption.log_key);
  proxyArgs.push('--ca-dir', resolve(dataDir, 'ca'));
  proxyArgs.push('--log-dir', resolve(dataDir, 'logs'));

  const proxyManager = new ProxyManager(proxyBinPath, proxyArgs, { onRestart: async () => {
    const rules = await rulesDAO.list();
    ipc.send({ type: 'rules.reload', data: rules });
    const agents = agentsDAO.listForProxy();
    ipc.send({ type: 'agents.reload', data: agents });
  }});

  // Express app — public routes first, then Basic Auth gate, then protected routes
  const app = express();
  app.use(express.json());

  const deps = { rulesDAO, requestLogDAO, approvalQueueDAO, agentsDAO, config, ipc, events, proxyManager,
    crypto: { ...crypto, logKey } };

  // Public: CA cert and status
  app.use('/api', statusRoutes(deps));

  // Protected routes (require Basic Auth)
  app.use('/api', basicAuth(config.management.auth));
  app.use('/api/rules', rulesRoutes(deps));
  app.use('/api/logs', logsRoutes(deps));
  app.use('/api/approvals', approvalsRoutes(deps));
  app.use('/api/agents', agentsRoutes({ agentsDAO, ipc }));
  app.use('/api/events', eventsRoute(events));

  // Serve GUI static files if dist/ exists (production mode)
  const guiDistPath = config.gui?.dist_path
    ? resolve(config.gui.dist_path)
    : resolve(dataDir, '..', 'gui', 'dist');
  if (existsSync(guiDistPath)) {
    app.use(express.static(guiDistPath));
    // SPA fallback: serve index.html for non-API GET requests
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(resolve(guiDistPath, 'index.html'));
    });
  }

  app.use(errorHandler);

  const [host, port] = config.management.listen.split(':');
  const server = await new Promise((res, rej) => {
    const s = app.listen(parseInt(port), host, () => res(s));
    s.on('error', rej);
  });

  // SIGHUP triggers a live reload: re-reads config, refreshes webhooks,
  // pushes updated rules/agents/default_behavior to the Go proxy via IPC.
  const sighupHandler = async () => {
    try {
      const newConfig = loadConfig(flags);
      webhooks.reload(newConfig.webhooks || []);
      if (config.rules.source === 'file' && rulesDAO.reload) rulesDAO.reload();
      ipc.send({ type: 'config.update', data: { default_behavior: newConfig.default_behavior } });
      const currentRules = await rulesDAO.list();
      ipc.send({ type: 'rules.reload', data: currentRules });
      const currentAgents = agentsDAO.listForProxy();
      ipc.send({ type: 'agents.reload', data: currentAgents });
      Object.assign(config, newConfig);
    } catch (err) {
      console.error('SIGHUP reload failed:', err.message);
    }
  };
  process.on('SIGHUP', sighupHandler);

  return { app, server, ipc, proxyManager, db, close: () => {
    process.removeListener('SIGHUP', sighupHandler);
    proxyManager.stop();
    server.close();
    ipc.close();
    db.close();
  }};
}

// CLI entry point
if (process.argv[1] === import.meta.filename) {
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  }
  startServer(flags).then(({ server, proxyManager }) => {
    const addr = server.address();
    if (addr) console.log(`ASHP management API listening on ${addr.address}:${addr.port}`);
    if (flags['start-proxy'] !== 'false') {
      proxyManager.start();
      console.log('ASHP proxy started');
    }
  }).catch(err => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}
