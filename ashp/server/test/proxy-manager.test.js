import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyManager } from '../src/proxy-manager.js';

let manager;

describe('ProxyManager', () => {
  afterEach(() => {
    if (manager) manager.stop();
    manager = null;
  });

  it('spawn starts child process', () => {
    manager = new ProxyManager('node', ['-e', 'setTimeout(()=>{},60000)']);
    manager.start();
    assert.equal(manager.running, true);
    assert.equal(typeof manager.pid, 'number');
  });

  it('stop kills child process', async () => {
    manager = new ProxyManager('node', ['-e', 'setTimeout(()=>{},60000)']);
    manager.start();
    assert.equal(manager.running, true);
    manager.stop();
    assert.equal(manager.running, false);
  });

  it('restart on crash', async () => {
    const restartPromise = new Promise((resolve) => {
      manager = new ProxyManager('node', ['-e', 'process.exit(1)'], {
        onRestart: (code) => { resolve(code); },
        restartDelay: 100,
      });
    });
    manager.start();
    const exitCode = await restartPromise;
    assert.equal(exitCode, 1, 'should report exit code');
    // After onRestart fires, the process has been respawned
    // Stop to prevent infinite restart loop
    manager.stop();
  });

  it('does not restart after explicit stop', async () => {
    let restartCalled = false;
    manager = new ProxyManager('node', ['-e', 'process.exit(1)'], {
      onRestart: () => { restartCalled = true; },
      restartDelay: 100,
    });
    manager.start();
    // Stop immediately before the crash restart can happen
    manager.stop();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(restartCalled, false, 'onRestart should not be called after stop');
  });

  it('getStatus returns uptime and pid', async () => {
    manager = new ProxyManager('node', ['-e', 'setTimeout(()=>{},60000)']);
    manager.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = manager.getStatus();
    assert.equal(status.running, true);
    assert.equal(typeof status.pid, 'number');
    assert.ok(status.uptime_ms >= 0, 'uptime should be non-negative');
  });
});
