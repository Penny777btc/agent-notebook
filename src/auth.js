// Tokens, permissions and audit log. Everything lives in <vault>/.notebook/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCOPES = ['read', 'write', 'admin'];

export class AuthError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

export class Auth {
  constructor(vaultRoot) {
    this.dir = path.join(vaultRoot, '.notebook');
    this.configPath = path.join(this.dir, 'config.json');
    this.auditPath = path.join(this.dir, 'audit.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
    this.load(); // creates config.json with defaults on first run
  }

  load() {
    const defaults = {
      port: 3777,
      host: '127.0.0.1',
      tokens: [],
      backup: { enabled: false, intervalMinutes: 30, remote: '' }
    };
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return { ...defaults, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) };
  }

  /** Always fresh from disk: the CLI and the web server both use this file. */
  get config() {
    return this.load();
  }

  /** load → mutate → write. Every write goes through here so no process can clobber another's changes. */
  update(mutate) {
    const cfg = this.load();
    mutate(cfg);
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
    return cfg;
  }

  // ---- tokens -----------------------------------------------------------
  static hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  createToken(name, { scopes = ['read'], folders = ['*'] } = {}) {
    if (!name || !/^[\w.-]{1,40}$/.test(name)) throw new AuthError('name must be 1-40 chars of letters, digits, . _ -', 400);
    if (this.config.tokens.some((t) => t.name === name)) throw new AuthError(`token "${name}" already exists`, 409);
    scopes = scopes.filter((s) => SCOPES.includes(s));
    if (!scopes.length) scopes = ['read'];
    const token = 'nb_' + crypto.randomBytes(24).toString('base64url');
    this.update((cfg) => {
      if (cfg.tokens.some((t) => t.name === name)) throw new AuthError(`token "${name}" already exists`, 409);
      cfg.tokens.push({
        name,
        prefix: token.slice(0, 10),
        hash: Auth.hash(token),
        scopes,
        folders: folders.length ? folders : ['*'],
        created: new Date().toISOString(),
        lastUsed: null
      });
    });
    return { token, name, scopes, folders };
  }

  listTokens() {
    return this.config.tokens.map(({ hash, ...t }) => t);
  }

  revokeToken(name) {
    this.update((cfg) => {
      const before = cfg.tokens.length;
      cfg.tokens = cfg.tokens.filter((t) => t.name !== name);
      if (cfg.tokens.length === before) throw new AuthError(`token "${name}" not found`, 404);
    });
  }

  /** Returns a principal for a bearer token, or null. */
  authenticate(token) {
    if (!token) return null;
    const h = Auth.hash(token);
    const t = this.config.tokens.find((x) => x.hash === h);
    if (!t) return null;
    this.update((cfg) => { const x = cfg.tokens.find((y) => y.hash === h); if (x) x.lastUsed = new Date().toISOString(); });
    return { name: t.name, scopes: t.scopes, folders: t.folders, kind: 'token' };
  }

  /** The human owner using the local web UI. */
  owner() {
    return { name: 'owner', scopes: ['read', 'write', 'admin'], folders: ['*'], kind: 'owner' };
  }

  // ---- authorization ----------------------------------------------------
  can(principal, scope, relPath = '') {
    if (!principal) return false;
    if (!principal.scopes.includes(scope) && !(scope !== 'admin' && principal.scopes.includes('admin'))) return false;
    if (scope === 'admin') return true;
    return pathAllowed(principal.folders, relPath);
  }

  require(principal, scope, relPath = '') {
    if (!principal) throw new AuthError('Authentication required: pass a bearer token', 401);
    if (!this.can(principal, scope, relPath)) {
      throw new AuthError(`"${principal.name}" lacks ${scope} permission on "${relPath || '/'}" (scopes: ${principal.scopes.join(',')}; folders: ${principal.folders.join(',')})`, 403);
    }
  }

  // ---- audit ------------------------------------------------------------
  audit(principal, action, target, extra = {}) {
    const entry = { ts: new Date().toISOString(), agent: principal?.name || 'anonymous', action, target, ...extra };
    fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
    return entry;
  }

  readAudit({ limit = 100 } = {}) {
    if (!fs.existsSync(this.auditPath)) return [];
    const lines = fs.readFileSync(this.auditPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }
}

/** folders: ['*'] = everything; ['Alpha看板', 'Inbox'] = only those folders (and below). */
export function pathAllowed(folders, relPath) {
  if (!folders || folders.includes('*')) return true;
  const p = String(relPath || '').replace(/^\/+/, '');
  return folders.some((f) => {
    const base = String(f).replace(/^\/+|\/+$/g, '');
    return p === base || p.startsWith(base + '/');
  });
}
