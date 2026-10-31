// Git-based backup of the vault. If a remote is configured, pushes to it (GitHub or any git host).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class Backup {
  constructor(vaultRoot, auth, log = () => {}) {
    this.root = vaultRoot;
    this.auth = auth;
    this.log = log;
    this.timer = null;
    this.state = { lastRun: null, lastResult: null, lastError: null, running: false };
  }

  async git(...args) {
    const { stdout } = await execFileP('git', args, { cwd: this.root, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  isRepo() {
    return fs.existsSync(path.join(this.root, '.git'));
  }

  ensureGitignore() {
    const p = path.join(this.root, '.gitignore');
    const wanted = ['.notebook/config.json', '.trash/', '.DS_Store'];
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [];
    const missing = wanted.filter((w) => !existing.includes(w));
    if (missing.length) fs.writeFileSync(p, [...existing.filter(Boolean), ...missing].join('\n') + '\n');
  }

  async init(remote) {
    if (!this.isRepo()) {
      await this.git('init', '-b', 'main').catch(() => this.git('init'));
    }
    this.ensureGitignore();
    if (remote) {
      const remotes = (await this.git('remote')).split('\n').filter(Boolean);
      if (remotes.includes('origin')) await this.git('remote', 'set-url', 'origin', remote);
      else await this.git('remote', 'add', 'origin', remote);
      this.auth.update((cfg) => { cfg.backup = { ...cfg.backup, enabled: true, remote }; });
    }
    return this.status();
  }

  async status() {
    const cfg = this.auth.config.backup || {};
    let remote = null;
    let branch = null;
    let dirty = null;
    let lastCommit = null;
    if (this.isRepo()) {
      remote = await this.git('remote', 'get-url', 'origin').catch(() => null);
      branch = await this.git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => null);
      dirty = (await this.git('status', '--porcelain').catch(() => '')).split('\n').filter(Boolean).length;
      lastCommit = await this.git('log', '-1', '--format=%cI %s').catch(() => null);
    }
    return { isRepo: this.isRepo(), remote, branch, dirty, lastCommit, enabled: !!cfg.enabled, intervalMinutes: cfg.intervalMinutes || 30, ...this.state };
  }

  async run(reason = 'scheduled') {
    if (this.state.running) return this.state;
    if (!this.isRepo()) {
      this.state.lastError = 'vault is not a git repository (run: agent-notebook backup init <remote>)';
      return this.state;
    }
    this.state.running = true;
    try {
      this.ensureGitignore();
      await this.git('add', '-A');
      const staged = await this.git('diff', '--cached', '--name-only');
      let committed = false;
      if (staged) {
        await this.git('-c', 'user.name=agent-notebook', '-c', 'user.email=agent-notebook@localhost', 'commit', '-q', '-m', `backup (${reason}): ${new Date().toISOString()}`);
        committed = true;
      }
      let pushed = false;
      const remote = await this.git('remote', 'get-url', 'origin').catch(() => null);
      if (remote) {
        const branch = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
        await this.git('push', '-u', 'origin', branch);
        pushed = true;
      }
      this.state.lastResult = { committed, pushed, files: staged ? staged.split('\n').length : 0 };
      this.state.lastError = null;
      this.log(`backup: committed=${committed} pushed=${pushed}`);
    } catch (err) {
      this.state.lastError = err.stderr?.toString().trim() || err.message;
      this.log(`backup failed: ${this.state.lastError}`);
    } finally {
      this.state.running = false;
      this.state.lastRun = new Date().toISOString();
    }
    return this.state;
  }

  start() {
    const cfg = this.auth.config.backup || {};
    if (!cfg.enabled) return false;
    const ms = Math.max(1, cfg.intervalMinutes || 30) * 60 * 1000;
    this.timer = setInterval(() => this.run('scheduled'), ms);
    this.timer.unref?.();
    this.log(`backup: every ${cfg.intervalMinutes || 30} min → ${cfg.remote || '(local git only)'}`);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
