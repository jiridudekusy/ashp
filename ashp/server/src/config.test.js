import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';

describe('config', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(obj) {
    const file = join(dir, 'ashp.json');
    writeFileSync(file, JSON.stringify(obj));
    return file;
  }

  it('loads valid config and applies defaults', () => {
    const file = writeConfig({});
    const cfg = loadConfig({ config: file });
    assert.equal(cfg.default_behavior, 'deny');
    assert.equal(cfg.logging.request_body, 'full');
    assert.equal(cfg.logging.retention_days, 30);
  });

  it('resolves env: prefixed values', () => {
    process.env.ASHP_TEST_KEY = 'resolved-secret';
    try {
      const file = writeConfig({ encryption: { key: 'env:ASHP_TEST_KEY' } });
      const cfg = loadConfig({ config: file });
      assert.equal(cfg.encryption.key, 'resolved-secret');
    } finally {
      delete process.env.ASHP_TEST_KEY;
    }
  });

  it('throws if env var is missing', () => {
    const file = writeConfig({ encryption: { key: 'env:ASHP_MISSING_VAR' } });
    assert.throws(() => loadConfig({ config: file }), /ASHP_MISSING_VAR/);
  });

  it('CLI flags override config', () => {
    const file = writeConfig({});
    const cfg = loadConfig({
      config: file,
      'proxy-listen': '0.0.0.0:9999',
      'default-behavior': 'hold',
    });
    assert.equal(cfg.proxy.listen, '0.0.0.0:9999');
    assert.equal(cfg.default_behavior, 'hold');
  });

  it('throws on invalid rules source', () => {
    const file = writeConfig({ rules: { source: 'invalid' } });
    assert.throws(() => loadConfig({ config: file }), /source/);
  });
});
