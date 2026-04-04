/**
 * @module config
 * @description Configuration loading, validation, and environment variable substitution.
 *
 * Config resolution order (later wins):
 * 1. Built-in DEFAULTS
 * 2. JSON config file (path from `flags.config`)
 * 3. CLI flags (mapped via CLI_MAP)
 *
 * String values prefixed with `env:` are resolved to the corresponding
 * environment variable (e.g. `"env:DB_KEY"` becomes `process.env.DB_KEY`).
 * This allows secrets to be kept out of config files.
 */
import { readFileSync } from 'node:fs';

/** @type {Object} Default configuration values merged under every loaded config. */
const DEFAULTS = {
  proxy: { listen: '0.0.0.0:8080' },
  transparent: {
    enabled: false,
    listen: '0.0.0.0',
    ports: [
      { port: 443, tls: true },
      { port: 80, tls: false },
    ],
  },
  management: { listen: '0.0.0.0:3000', auth: {} },
  rules: { source: 'db' },
  database: { path: 'data/ashp.db' },
  encryption: {},
  default_behavior: 'deny',
  logging: { request_body: 'full', response_body: 'full', retention_days: 30 },
  webhooks: [],
};

/**
 * Recursively resolves `env:VAR_NAME` string references to their environment
 * variable values throughout an object tree.
 *
 * @param {*} obj - Value to resolve (string, array, object, or primitive).
 * @returns {*} The resolved value with all `env:` references substituted.
 * @throws {Error} If a referenced environment variable is not set.
 */
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

/**
 * Deep-merges `source` into `target`. Objects are merged recursively;
 * arrays and primitives in `source` overwrite `target` values.
 *
 * @param {Object} target
 * @param {Object} source
 * @returns {Object} A new merged object (does not mutate inputs).
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else { out[k] = v; }
  }
  return out;
}

/**
 * Maps CLI flag names to config mutation functions.
 * Each entry receives the config object and the flag value.
 * @type {Object.<string, function(Object, string): void>}
 */
const CLI_MAP = {
  'proxy-listen':     (c, v) => { c.proxy.listen = v; },
  'management-listen':(c, v) => { c.management.listen = v; },
  'default-behavior': (c, v) => { c.default_behavior = v; },
  'rules-source':     (c, v) => { c.rules.source = v; },
  'rules-file':       (c, v) => { c.rules.file = v; },
  'database-path':    (c, v) => { c.database.path = v; },
};

/**
 * Loads, merges, and validates the ASHP configuration.
 *
 * @param {Object} flags - CLI flags. Must include `config` (path to JSON config file).
 *   Additional keys matching CLI_MAP override the corresponding config values.
 * @returns {Object} The fully resolved and validated configuration object.
 * @throws {Error} If the config file cannot be read/parsed, an env var is missing,
 *   or `rules.source` / `default_behavior` contains an invalid value.
 */
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
