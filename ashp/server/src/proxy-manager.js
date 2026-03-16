import { spawn } from 'node:child_process';

export class ProxyManager {
  #proc = null; #binPath; #args; #onRestart; #stopped = false;
  #startedAt = null; #restartDelay;

  constructor(binPath, args = [], { onRestart, restartDelay = 1000 } = {}) {
    this.#binPath = binPath;
    this.#args = args;
    this.#onRestart = onRestart || (() => {});
    this.#restartDelay = restartDelay;
  }

  start() {
    this.#stopped = false;
    this.#spawn();
  }

  #spawn() {
    this.#proc = spawn(this.#binPath, this.#args, { stdio: 'ignore' });
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

  stop() {
    this.#stopped = true;
    if (this.#proc) { this.#proc.kill('SIGTERM'); this.#proc = null; }
  }

  get running() { return this.#proc !== null; }
  get pid() { return this.#proc?.pid ?? null; }
  getStatus() {
    return {
      running: this.running, pid: this.pid,
      uptime_ms: this.#startedAt ? Date.now() - this.#startedAt : 0,
    };
  }
}
