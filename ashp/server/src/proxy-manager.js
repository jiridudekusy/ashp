/**
 * @module proxy-manager
 * @description Manages the Go MITM proxy as a supervised child process.
 *
 * The proxy binary is spawned with `stdio: 'inherit'` so its stdout/stderr
 * appear in the Node process output. If the proxy exits unexpectedly,
 * ProxyManager automatically restarts it after a configurable delay and
 * invokes the `onRestart` callback (used to re-push rules/agents via IPC).
 */
import { spawn } from 'node:child_process';

/**
 * Supervises the Go proxy child process with automatic restart.
 */
export class ProxyManager {
  #proc = null; #binPath; #args; #onRestart; #stopped = false;
  #startedAt = null; #restartDelay;

  /**
   * @param {string} binPath - Absolute path to the Go proxy binary.
   * @param {string[]} [args=[]] - Command-line arguments for the proxy.
   * @param {Object} [options]
   * @param {function(number): void} [options.onRestart] - Called after automatic restart with the previous exit code.
   * @param {number} [options.restartDelay=1000] - Milliseconds to wait before restarting after an unexpected exit.
   */
  constructor(binPath, args = [], { onRestart, restartDelay = 1000 } = {}) {
    this.#binPath = binPath;
    this.#args = args;
    this.#onRestart = onRestart || (() => {});
    this.#restartDelay = restartDelay;
  }

  /**
   * Starts the proxy process. Clears the stopped flag so automatic restarts are enabled.
   */
  start() {
    this.#stopped = false;
    this.#spawn();
  }

  /**
   * Spawns the proxy binary and sets up the exit handler for auto-restart.
   * @private
   */
  #spawn() {
    this.#proc = spawn(this.#binPath, this.#args, { stdio: 'inherit' });
    this.#startedAt = Date.now();
    this.#proc.on('exit', (code) => {
      this.#proc = null;
      if (!this.#stopped) {
        setTimeout(() => {
          if (!this.#stopped) { this.#spawn(); this.#onRestart(code); }
        }, this.#restartDelay);
      }
    });
  }

  /**
   * Gracefully stops the proxy. Sends SIGTERM and disables automatic restart.
   */
  stop() {
    this.#stopped = true;
    if (this.#proc) { this.#proc.kill('SIGTERM'); this.#proc = null; }
  }

  /** @returns {boolean} Whether the proxy process is currently running. */
  get running() { return this.#proc !== null; }

  /** @returns {number|null} PID of the running proxy, or null. */
  get pid() { return this.#proc?.pid ?? null; }

  /**
   * Returns a status snapshot of the proxy process.
   * @returns {{running: boolean, pid: number|null, uptime_ms: number}}
   */
  getStatus() {
    return {
      running: this.running, pid: this.pid,
      uptime_ms: this.#startedAt ? Date.now() - this.#startedAt : 0,
    };
  }
}
