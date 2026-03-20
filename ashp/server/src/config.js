import { readFileSync } from 'node:fs';

const DEFAULTS = {
  proxy: { listen: '0.0.0.0:8080' },
  management: { listen: '0.0.0.0:3000', auth: {} },
  rules: { source: 'db' },
  database: { path: 'data/ashp.db' },
  encryption: {},
  default_behavior: 'deny',
  logging: { request_body: 'full', response_body: 'full', retention_days: 30 },
  webhooks: [],
};

function resolveEnvRefs(obj) {
  if (typeof obj === 'string' && obj.startsWith('env:')) {
    const name = obj.slice(4);
    const val = process.env[name];
    if (val === undefined) throw new Error(`Environment variable ${name} is not set (referenced as "env:${name}")`);
    return val;
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveEnvRefs(v)]));
  }
  return obj;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else { out[k] = v; }
  }
  return out;
}

const CLI_MAP = {
  'proxy-listen':     (c, v) => { c.proxy.listen = v; },
  'management-listen':(c, v) => { c.management.listen = v; },
  'default-behavior': (c, v) => { c.default_behavior = v; },
  'rules-source':     (c, v) => { c.rules.source = v; },
  'rules-file':       (c, v) => { c.rules.file = v; },
  'database-path':    (c, v) => { c.database.path = v; },
};

export function loadConfig(flags) {
  const raw = JSON.parse(readFileSync(flags.config, 'utf-8'));
  let cfg = deepMerge(DEFAULTS, raw);
  for (const [flag, apply] of Object.entries(CLI_MAP)) {
    if (flags[flag] !== undefined) apply(cfg, flags[flag]);
  }
  cfg = resolveEnvRefs(cfg);
  if (!['db', 'file'].includes(cfg.rules?.source))
    throw new Error(`Invalid rules source "${cfg.rules?.source}". Must be "db" or "file".`);
  if (!['deny', 'hold', 'queue'].includes(cfg.default_behavior))
    throw new Error(`Invalid default_behavior "${cfg.default_behavior}".`);
  return cfg;
}
