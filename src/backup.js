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
    this.state = { lastRun: null, lastResult: null, lastError: null, lastSuccess: null, failures: 0, running: false };
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
    const wanted = ['.notebook/config.json', '.notebook/seen.json', '.trash/', '.DS_Store'];
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [];
    const missing = wanted.filter((w) => !existing.includes(w));
    if (missing.length) fs.writeFileSync(p, [...existing.filter(Boolean), ...missing].join('\n') + '\n');
    // The audit log is append-only JSON lines: when two copies of the vault both appended, keep both sides instead of conflicting.
    const ap = path.join(this.root, '.gitattributes');
    const rule = '.notebook/audit.jsonl merge=union';
    const attrs = fs.existsSync(ap) ? fs.readFileSync(ap, 'utf8').split('\n') : [];
    if (!attrs.includes(rule)) fs.writeFileSync(ap, [...attrs.filter(Boolean), rule].join('\n') + '\n');
  }

  // The remote has commits this copy lacks (another copy of the vault pushed). Fetch and merge them so the push can go through.
  // A real content conflict is left for a human: the merge is aborted and the working tree stays exactly as it was.
  async reconcile(branch) {
    await this.git('fetch', 'origin', branch);
    try {
      await this.git('-c', 'user.name=agent-notebook', '-c', 'user.email=agent-notebook@localhost', 'merge', '--no-edit', '-m', `backup: merge origin/${branch}`, `origin/${branch}`);
    } catch (err) {
      const files = await this.git('diff', '--name-only', '--diff-filter=U').catch(() => '');
      await this.git('merge', '--abort').catch(() => {});
      const e = new Error(`remote has changes that conflict with this vault; merge them by hand (git fetch && git merge origin/${branch})${files ? ': ' + files.split('\n').join(', ') : ''}`);
      e.cause = err;
      throw e;
    }
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
    let ahead = null;
    if (this.isRepo()) {
      remote = await this.git('remote', 'get-url', 'origin').catch(() => null);
      branch = await this.git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => null);
      dirty = (await this.git('status', '--porcelain').catch(() => '')).split('\n').filter(Boolean).length;
      lastCommit = await this.git('log', '-1', '--format=%cI %s').catch(() => null);
      if (remote && branch) ahead = await this.git('rev-list', '--count', `origin/${branch}..HEAD`).then(Number).catch(() => null); // commits not on the remote yet
    }
    return { isRepo: this.isRepo(), remote, branch, dirty, lastCommit, ahead, enabled: !!cfg.enabled, intervalMinutes: cfg.intervalMinutes || 30, ...this.state };
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
      let merged = false;
      const remote = await this.git('remote', 'get-url', 'origin').catch(() => null);
      if (remote) {
        const branch = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
        try {
          await this.git('push', '-u', 'origin', branch);
        } catch (err) {
          if (!/rejected|non-fast-forward|fetch first/i.test(err.stderr?.toString() || '')) throw err;
          await this.reconcile(branch);
          merged = true;
          await this.git('push', '-u', 'origin', branch);
        }
        pushed = true;
      }
      this.state.lastResult = { committed, pushed, merged, files: staged ? staged.split('\n').length : 0 };
      this.state.lastError = null;
      this.state.failures = 0;
      this.state.lastSuccess = new Date().toISOString();
      this.log(`backup: committed=${committed} pushed=${pushed}${merged ? ' (merged remote changes first)' : ''}`);
    } catch (err) {
      this.state.lastError = err.stderr?.toString().trim() || err.message;
      this.state.failures += 1;
      this.log(`backup failed (${this.state.failures} in a row): ${this.state.lastError}`);
    } finally {
      this.state.running = false;
      this.state.lastRun = new Date().toISOString();
    }
    return this.state;
  }

  // In-memory only (no git calls): something the home page can poll cheaply. One failed run can be a network blip; two in a row is worth showing.
  health() {
    const { failures, lastError, lastSuccess, lastRun } = this.state;
    return { enabled: !!(this.auth.config.backup || {}).enabled, failing: failures >= 2, failures, lastError: failures ? lastError : null, lastSuccess, lastRun };
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
