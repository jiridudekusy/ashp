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
import { bearerAuth, errorHandler } from './api/middleware.js';
import rulesRoutes from './api/rules.js';
import logsRoutes from './api/logs.js';
import approvalsRoutes from './api/approvals.js';
import statusRoutes from './api/status.js';
import * as crypto from './crypto/index.js';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

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

  // IPC
  const socketPath = resolve(dataDir, 'ashp.sock');
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const events = new EventBus();
  const webhooks = new WebhookDispatcher(config.webhooks || []);
  const logKey = config.encryption?.log_key ? Buffer.from(config.encryption.log_key, 'hex') : null;

  const ipc = new IPCServer(socketPath, {
    onMessage: async (msg) => {
      if (msg.type === 'request.logged') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.allowed', msg.data);
      } else if (msg.type === 'request.blocked') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.blocked', msg.data);
      } else if (msg.type === 'approval.needed') {
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
    },
  });
  await ipc.start();

  // Proxy manager
  const proxyBinPath = resolve(dataDir, '..', 'proxy', 'ashp-proxy');
  const proxyManager = new ProxyManager(proxyBinPath, [
    '--socket', socketPath,
    '--listen', config.proxy.listen,
    '--auth', JSON.stringify(config.proxy.auth || {}),
  ], { onRestart: () => ipc.send({ type: 'rules.reload' }) });

  // Express app
  const app = express();
  app.use(express.json());

  const deps = { rulesDAO, requestLogDAO, approvalQueueDAO, config, ipc, events, proxyManager,
    crypto: { ...crypto, logKey } };

  // Public: CA cert and status
  app.use('/api', statusRoutes(deps));

  // Protected routes
  app.use('/api', bearerAuth(config.management.bearer_token));
  app.use('/api/rules', rulesRoutes(deps));
  app.use('/api/logs', logsRoutes(deps));
  app.use('/api/approvals', approvalsRoutes(deps));
  app.use('/api/events', eventsRoute(events));
  app.use(errorHandler);

  const [host, port] = config.management.listen.split(':');
  const server = await new Promise((res, rej) => {
    const s = app.listen(parseInt(port), host, () => res(s));
    s.on('error', rej);
  });

  // SIGHUP reloads config
  const sighupHandler = () => {
    try {
      const newConfig = loadConfig(flags);
      webhooks.reload(newConfig.webhooks || []);
      if (config.rules.source === 'file' && rulesDAO.reload) rulesDAO.reload();
      ipc.send({ type: 'config.update', data: { default_behavior: newConfig.default_behavior } });
      ipc.send({ type: 'rules.reload' });
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
  startServer(flags).then(({ server }) => {
    console.log(`ASHP management API listening on ${server.address().address}:${server.address().port}`);
  });
}
