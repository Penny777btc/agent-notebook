// HTTP server: Notion-style web UI + REST API for the owner, and an MCP endpoint (/mcp) for remote agents.
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { resolveSource } from './agent-id.js';
import { relatedEdges, conceptsBatch, notesNeedingConcepts } from './relations.js';
import { listAgents, connectAgent, getAgent, serverEntry } from './agents.js';
import { Router, capture, digest, organizeInbox } from './notebooks.js';
import { metrics } from './metrics.js';
import { AI_MODELS, AI_PROVIDERS, GROK_MODELS, aiSettings, testConnection } from './enrich.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Public address Tailscale Funnel (or Serve) publishes for this port, if any. Cached for a minute. */
let funnelCache = { at: 0, url: null };
function funnelUrl(port) {
  if (Date.now() - funnelCache.at < 60000) return funnelCache.url;
  let url = null;
  try {
    const out = execFileSync('tailscale', ['funnel', 'status', '--json'], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    for (const [hostPort, cfg] of Object.entries(j.Web || {})) {
      const proxies = Object.values(cfg.Handlers || {}).map((h) => h.Proxy || '');
      if (!proxies.some((x) => x.endsWith(':' + port))) continue;
      const [host, p] = hostPort.split(':');
      url = `https://${host}${p && p !== '443' ? ':' + p : ''}`;
      if (j.AllowFunnel?.[hostPort]) break; // prefer the public (Funnel) one
    }
  } catch { /* tailscale not installed or not serving */ }
  funnelCache = { at: Date.now(), url };
  return url;
}

export function createApp({ vault, auth, backup }) {
  const app = express();
  const router = new Router(vault);
  const aiLog = (e) => auth.audit({ name: 'ai' }, e.event, e.notebook || '', e);
  const captureOpts = { auth, log: aiLog };
  app.use(express.json({ limit: '5mb' }));

  // ---- identify the caller -------------------------------------------
  app.use((req, res, next) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      req.principal = auth.authenticate(bearer);
      if (!req.principal) return res.status(401).json({ error: 'invalid token' });
    } else if (trustsLoopback(auth) && isLoopback(req)) {
      req.principal = auth.owner(); // the human at the local UI (off on shared servers: config trustLoopback=false)
    } else {
      req.principal = null;
    }
    // Which agent is behind the token? Several agents may share one token; the label comes from
    // an explicit source, the X-Agent-Name header or a recognisable User-Agent, else the token name.
    const hints = { header: req.headers['x-agent-name'] || req.headers['x-agent'], userAgent: req.headers['user-agent'], principal: req.principal, knownNames: auth.listTokens().map((t) => t.name) };
    req.sourceOf = (explicit) => req.principal?.kind === 'token' ? resolveSource({ ...hints, explicit }) : (explicit || req.principal?.name);
    req.agent = req.sourceOf();
    req.audit = (action, target, extra = {}) => auth.audit(req.principal, action, target, { ...(req.agent && req.agent !== req.principal?.name ? { source: req.agent } : {}), ...extra });
    next();
  });

  // ---- phone / remote access: password login ---------------------------
  const loginFailures = new Map(); // ip → { n, until }
  app.get('/api/access', (req, res) => {
    res.json({ authenticated: !!req.principal, principal: req.principal ? { name: req.principal.name, kind: req.principal.kind } : null, passwordSet: auth.hasPassword(), loopback: trustsLoopback(auth) && isLoopback(req) });
  });
  app.post('/api/login', (req, res, next) => {
    // behind Funnel / a tunnel every client arrives from 127.0.0.1: key the lockout on the proxy-reported address
    const ip = String(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const f = loginFailures.get(ip);
    if (f && f.until > Date.now()) return res.status(429).json({ error: `尝试太多次，${Math.ceil((f.until - Date.now()) / 1000)} 秒后再试` });
    try {
      const t = auth.login(req.body?.password, { device: req.body?.device });
      loginFailures.delete(ip);
      auth.audit({ name: t.name }, 'login', 'web', { ip, device: req.body?.device });
      res.json({ token: t.token, name: t.name });
    } catch (err) {
      const n = (f?.n || 0) + 1;
      loginFailures.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      auth.audit({ name: 'anonymous' }, 'login:denied', 'web', { ip });
      next(err);
    }
  });

  // ---- one-URL capture: for agents that can only open a link (browsing tools, bookmarks) ----
  // GET /api/quick/<token>?text=...&title=&tags=a,b&notebook=   (POST with a JSON or form body works too)
  app.all('/api/quick/:token', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const principal = auth.authenticate(req.params.token);
      if (!principal) { auth.audit({ name: 'anonymous' }, 'quick:denied', 'url-token', { ip: req.socket.remoteAddress }); return res.status(401).json({ error: 'invalid token' }); }
      const q = { ...req.query, ...(req.body || {}) };
      const text = String(q.text || q.t || '').trim();
      if (!text) return res.status(400).json({ error: 'text is required: /api/quick/<token>?text=...' });
      auth.require(principal, 'write', q.notebook || '');
      const tags = Array.isArray(q.tags) ? q.tags : String(q.tags || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const source = resolveSource({ explicit: q.source, header: req.headers['x-agent-name'], userAgent: req.headers['user-agent'], principal, knownNames: auth.listTokens().map((t) => t.name) });
      const r = await capture(vault, router, { text, title: q.title || undefined, notebook: q.notebook || undefined, tags, source }, captureOpts);
      auth.audit(principal, 'capture', r.path, { via: 'quick', mode: r.mode, notebook: r.notebook.folder, ...(source !== principal.name ? { source } : {}) });
      if ((req.headers.accept || '').includes('text/html')) {
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已记入</title><body style="font-family:-apple-system,sans-serif;padding:40px 24px;color:#1d1d1f"><h2 style="margin:0 0 8px">${r.notebook.icon} 已记入「${esc(r.notebook.title)}」</h2><p style="color:#6e6e73">${esc(r.title)}</p><p style="color:#86868b;font-size:13px">${esc(r.hint)}</p></body>`);
      } else res.json({ ok: true, notebook: r.notebook, title: r.title, path: r.path, mode: r.mode, hint: r.hint, related: r.related });
    } catch (err) { next(err); }
  });
  /** The address agents should be given: the host the owner is browsing through when it is remote,
   *  else the Tailscale Funnel address if one is published, else the local one. */
  function baseOf(req) {
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${req.socket.localPort}`;
    const local = /^(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    return (local && funnelUrl(req.socket.localPort || auth.config.port || 3777)) || `${proto}://${host}`;
  }
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // OpenAPI description of the REST surface agents need (ChatGPT custom GPT "Actions": import this URL,
  // auth = API key / Bearer with a notebook token)
  app.get('/openapi.json', (req, res) => {
    res.json(openapi(baseOf(req), vault));
  });

  // ---- MCP over Streamable HTTP ---------------------------------------
  // /mcp with a bearer header, or /mcp/<token> for clients that cannot set headers
  // (custom connectors in the Claude / ChatGPT apps). Over HTTPS the URL form is as private as the header.
  app.all(['/mcp', '/mcp/:token'], async (req, res) => {
    let principal = req.principal;
    if (req.params.token) {
      principal = auth.authenticate(req.params.token);
      if (!principal) { auth.audit({ name: 'anonymous' }, 'mcp:denied', 'url-token', { ip: req.socket.remoteAddress }); return res.status(401).json({ error: 'invalid token in URL' }); }
    }
    if (!principal || principal.kind !== 'token') {
      return res.status(401).json({ error: 'Bearer token required for /mcp (or use /mcp/<token>)' });
    }
    const server = buildMcpServer({ vault, auth, principal, hints: { header: req.headers['x-agent-name'] || req.headers['x-agent'], userAgent: req.headers['user-agent'] } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ---- REST API --------------------------------------------------------
  const api = express.Router();
  const guard = (scope, pathOf) => (req, res, next) => {
    try {
      auth.require(req.principal, scope, pathOf ? pathOf(req) : '');
      next();
    } catch (err) { next(err); }
  };
  const notePath = (req) => decodeURIComponent(req.params[0] || '');

  api.get('/status', guard('read'), async (req, res) => {
    res.json({ vault: vault.root, principal: req.principal, backup: await backup.status(), boards: vault.listBoards().length });
  });
  api.get('/tree', guard('read'), (req, res) => res.json(vault.listTree()));
  api.get('/notebooks', guard('read'), (req, res) => res.json(vault.listNotebooks().filter((n) => auth.can(req.principal, 'read', n.folder))));
  api.post('/notebooks', guard('write', (r) => r.body.folder), (req, res) => {
    const nb = vault.createNotebook(req.body);
    req.audit('create_notebook', nb.folder, { via: 'web' });
    res.status(201).json(nb);
  });
  api.get('/notebooks/*', guard('read', notePath), (req, res) => {
    const folder = notePath(req);
    const meta = vault.getNotebookMeta(folder);
    const notes = vault.listNotes({ folder, recursive: false, date: req.query.date, limit: 2000 })
      .map((n) => meta.kind === 'journal' || req.query.bodies === '1' ? { ...n, body: vault.getNote(n.path).body } : n);
    res.json({ ...meta, notes, total: notes.length });
  });
  api.patch('/notebooks/*', guard('write', notePath), (req, res) => {
    const nb = vault.updateNotebook(notePath(req), req.body);
    req.audit('update_notebook', nb.folder, { via: 'web', fields: Object.keys(req.body) });
    res.json(nb);
  });
  // numeric series of a notebook (amount, weight …) for the chart view; registered before /notebooks/* would swallow it
  api.get('/metrics/*', guard('read', notePath), (req, res) => res.json(metrics(vault, notePath(req), { from: req.query.from, to: req.query.to, key: req.query.key })));
  api.get('/today', guard('read'), (req, res) => {
    const d = digest(vault, req.query.date || undefined);
    res.json({ ...d, groups: d.groups.filter((g) => auth.can(req.principal, 'read', g.notebook.folder)) });
  });
  api.get('/links/index', guard('read'), (req, res) => res.json(Object.fromEntries(vault.titleIndex())));
  api.get('/graph', guard('read'), (req, res) => {
    const g = vault.graph();
    const nodes = g.nodes.filter((n) => auth.can(req.principal, 'read', n.path));
    const ok = new Set(nodes.map((n) => n.path));
    const rel = req.query.related === '0' ? { edges: [], coverage: null, concepts: {} } : relatedEdges(vault);
    for (const n of nodes) n.concepts = rel.concepts[n.path] || [];
    res.json({ ...g, nodes, edges: g.edges.filter((e) => ok.has(e.source) && ok.has(e.target)), related: rel.edges.filter((e) => ok.has(e.source) && ok.has(e.target)), coverage: rel.coverage, pendingConcepts: notesNeedingConcepts(vault).length, aiEnabled: aiSettings(auth).enabled });
  });
  // AI reads each note and stores 3–8 core concepts (frontmatter `concepts`); the graph links notes that share them
  api.post('/ai/concepts', guard('write'), async (req, res, next) => {
    try {
      if (!aiSettings(auth).enabled) return res.status(400).json({ error: 'AI 未开启：先在 设置 → 智能归类 里选择方式并开启' });
      const r = await conceptsBatch(vault, auth, { limit: Math.min(10, Number(req.body?.limit) || 5), paths: req.body?.paths, log: aiLog });
      req.audit('ai_concepts', '', { via: 'web', done: r.done.length, failed: r.failed.length, left: r.left });
      res.json(r);
    } catch (err) { next(err); }
  });
  api.post('/capture', guard('write', (r) => r.body.notebook || ''), async (req, res, next) => {
    try {
      const r = await capture(vault, router, { ...req.body, source: req.sourceOf(req.body.source) }, captureOpts);
      req.audit('capture', r.path, { via: 'web', mode: r.mode, notebook: r.notebook.folder });
      res.status(201).json(r);
    } catch (err) { next(err); }
  });
  // ---- AI (optional) ------------------------------------------------------
  api.get('/ai', guard('admin'), (req, res) => res.json({ ...aiSettings(auth), models: AI_MODELS, grokModels: GROK_MODELS, providers: AI_PROVIDERS }));
  api.post('/ai', guard('admin'), (req, res) => {
    const { apiKey, model, grokModel, enabled, mode, clearKey, provider } = req.body || {};
    auth.update((cfg) => {
      cfg.ai = cfg.ai || {};
      if (provider && AI_PROVIDERS.some((p) => p.id === provider)) cfg.ai.provider = provider;
      if (clearKey) { delete cfg.ai.apiKey; cfg.ai.enabled = false; }
      if (apiKey) cfg.ai.apiKey = String(apiKey).trim();
      if (model) cfg.ai.model = model;
      if (grokModel !== undefined) cfg.ai.grokModel = String(grokModel);
      if (mode) cfg.ai.mode = mode;
      if (enabled !== undefined) cfg.ai.enabled = !!enabled;
    });
    req.audit('update_ai', '', { provider, model, enabled, mode, key: apiKey ? 'set' : clearKey ? 'cleared' : undefined });
    res.json({ ...aiSettings(auth), models: AI_MODELS, grokModels: GROK_MODELS, providers: AI_PROVIDERS });
  });
  api.post('/ai/test', guard('admin'), async (req, res) => {
    try { res.json(await testConnection(auth)); }
    catch (err) { res.status(502).json({ ok: false, error: err.message, status: err.status }); }
  });
  api.post('/ai/organize', guard('write', () => vault.inboxFolder() || ''), async (req, res, next) => {
    try {
      if (!aiSettings(auth).enabled) return res.status(400).json({ error: 'AI 未开启：先在 设置 → 智能归类 里选择方式并开启' });
      const r = await organizeInbox(vault, router, auth, { paths: req.body?.paths, log: aiLog });
      req.audit('ai_organize', vault.inboxFolder(), { via: 'web', moved: r.done.length, left: r.left.length });
      res.json(r);
    } catch (err) { next(err); }
  });
  api.post('/move', guard('write', (r) => r.body.folder || ''), (req, res) => {
    const { path: p, folder, learn } = req.body;
    const before = vault.getNote(p);
    const moved = vault.moveNote(p, folder);
    if (learn !== false) router.learn({ title: before.title, tags: before.properties.tags || [], source: before.properties.source }, folder);
    req.audit('move_note', moved.path, { via: 'web', from: before.folder, learn: learn !== false });
    res.json(moved);
  });
  api.get('/classify', guard('read'), (req, res) => res.json(router.classify({ text: req.query.text || '', title: req.query.title || '' })));
  // learned routing rules: review and forget (owner / admin only)
  api.get('/rules', guard('admin'), (req, res) => res.json(router.listRules()));
  api.post('/rules/forget', guard('admin'), (req, res) => {
    const left = router.forget(req.body || {});
    req.audit('forget_rule', `${req.body?.type}:${req.body?.key || ''}`, { via: 'web', folder: req.body?.folder });
    res.json(left);
  });
  api.get('/boards', guard('read'), (req, res) => res.json(vault.listBoards()));
  api.post('/boards', guard('write', (r) => r.body.folder), (req, res) => {
    const b = vault.createBoard(req.body);
    req.audit('create_board', b.folder, { via: 'web' });
    res.status(201).json(b);
  });
  api.get('/boards/*', guard('read', notePath), (req, res) => res.json(vault.getBoard(notePath(req), { date: req.query.date })));
  api.get('/notes', guard('read'), (req, res) => {
    const { folder, status, tag, source, date, since, limit, recursive } = req.query;
    res.json(vault.listNotes({ folder, status, tag, source, date, since, limit: limit ? Number(limit) : 200, recursive: recursive !== 'false' }).filter((n) => auth.can(req.principal, 'read', n.path)));
  });
  api.get('/search', guard('read'), (req, res) => res.json(vault.search(req.query.q, { limit: 50 }).filter((n) => auth.can(req.principal, 'read', n.path))));
  api.post('/notes', guard('write', (r) => r.body.folder || ''), (req, res) => {
    const { folder, title, body, ...properties } = req.body;
    const note = vault.createNote({ folder, title, body, properties: { ...properties, source: req.sourceOf(properties.source) } });
    req.audit('create_note', note.path, { via: 'web' });
    res.status(201).json(note);
  });
  api.get('/notes/*', guard('read', notePath), (req, res) => res.json(vault.getNoteFull(notePath(req))));
  api.patch('/notes/*', guard('write', notePath), (req, res) => {
    const { title, body, append, ...properties } = req.body;
    const note = vault.updateNote(notePath(req), { title, body, append, properties });
    req.audit('update_note', note.path, { via: 'web', fields: Object.keys(req.body) });
    res.json(note);
  });
  // one entry inside a journal day page: PATCH to edit, with remove:true to delete
  api.patch('/entries/*', guard('write', notePath), (req, res) => {
    const r = vault.updateJournalEntry(notePath(req), req.body || {});
    req.audit(req.body?.remove ? 'delete_entry' : 'update_entry', notePath(req), { via: 'web', time: req.body?.time, match: req.body?.match });
    res.json(r);
  });
  api.delete('/notes/*', guard('write', notePath), (req, res) => {
    const r = vault.deleteNote(notePath(req));
    req.audit('delete_note', r.deleted, { via: 'web' });
    res.json(r);
  });

  api.get('/agents', guard('admin'), (req, res) => res.json(listAgents({ vault: vault.root, port: req.socket.localPort })));
  api.post('/agents/:id/connect', guard('admin'), (req, res) => {
    getAgent(req.params.id);
    const { scopes, folders, skill } = req.body || {};
    const r = connectAgent({ id: req.params.id, auth, vault: vault.root, scopes: scopes?.length ? scopes : ['read', 'write'], folders: folders?.length ? folders : ['*'], skill: skill !== false });
    req.audit('connect_agent', req.params.id, { tokenName: r.tokenName, configPath: r.configPath });
    res.status(201).json(r);
  });
  api.post('/agents/snippets', guard('admin'), (req, res) => {
    // token for an agent we can't auto-configure: create it and return copy-paste snippets
    const { name, scopes, folders, replace } = req.body || {};
    const exists = auth.listTokens().some((t) => t.name === name);
    if (exists && !replace) return res.status(409).json({ error: `token "${name}" already exists`, exists: true });
    if (exists) { auth.revokeToken(name); req.audit('revoke_token', name, { via: 'agents', reason: 'regenerated' }); }
    const t = auth.createToken(name, { scopes: scopes?.length ? scopes : ['read', 'write'], folders: (folders || []).filter(Boolean) });
    req.audit('create_token', name, { scopes: t.scopes, folders: t.folders, via: 'agents', replaced: exists });
    const entry = serverEntry({ token: t.token, vault: vault.root });
    // use the address the owner is browsing from (a tunnel host when set up remotely), else loopback
    const base = baseOf(req);
    res.status(201).json({ ...t, base, httpUrl: `${base}/mcp`, tokenUrl: `${base}/mcp/${t.token}`, quickUrl: `${base}/api/quick/${t.token}`, openapiUrl: `${base}/openapi.json`, json: { mcpServers: { 'agent-notebook': entry.json } }, toml: entry.toml, claudeCmd: `claude mcp add agent-notebook -e AGENT_NOTEBOOK_TOKEN=${t.token} -e AGENT_NOTEBOOK_VAULT="${vault.root}" -- node "${entry.json.args[0]}" mcp` });
  });
  // remote-access settings: owner password, bind address, LAN addresses
  api.get('/access/settings', guard('admin'), (req, res) => res.json(accessSettings(req)));
  api.post('/access/settings', guard('admin'), (req, res) => {
    const { password, clearPassword, lan, trustLoopback } = req.body || {};
    if (clearPassword) auth.setPassword('');
    else if (password !== undefined && password !== '') auth.setPassword(password);
    if (lan !== undefined) auth.update((cfg) => { cfg.host = lan ? '0.0.0.0' : '127.0.0.1'; });
    if (trustLoopback !== undefined) {
      if (trustLoopback === false && !auth.hasPassword()) return res.status(400).json({ error: '先设置访问密码，否则关掉本机免密后你自己也登不进来' });
      auth.update((cfg) => { cfg.trustLoopback = !!trustLoopback; });
    }
    req.audit('update_access', 'web', { password: password ? 'set' : clearPassword ? 'cleared' : undefined, lan, trustLoopback });
    res.json(accessSettings(req));
  });
  function accessSettings(req) {
    const cfg = auth.config;
    const port = req.socket.localPort || cfg.port || 3777;
    const lanIps = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const boundLan = !!req.socket.server?.address && req.socket.server.address()?.address !== '127.0.0.1';
    return { passwordSet: auth.hasPassword(), passwordSetAt: cfg.owner?.set || null, lan: cfg.host && cfg.host !== '127.0.0.1', boundLan, port, lanUrls: lanIps.map((ip) => `http://${ip}:${port}`), funnelUrl: funnelUrl(port), trustLoopback: trustsLoopback(auth), hostname: os.hostname(), devices: auth.listTokens().filter((t) => t.device) };
  }
  api.get('/audit', guard('admin'), (req, res) => res.json(auth.readAudit({ limit: Number(req.query.limit) || 200 })));
  api.get('/tokens', guard('admin'), (req, res) => res.json(auth.listTokens()));
  api.post('/tokens', guard('admin'), (req, res) => {
    const { name, scopes, folders } = req.body;
    const t = auth.createToken(name, { scopes, folders: (folders || []).filter(Boolean) });
    req.audit('create_token', name, { scopes: t.scopes, folders: t.folders });
    res.status(201).json(t);
  });
  api.delete('/tokens/:name', guard('admin'), (req, res) => {
    auth.revokeToken(req.params.name);
    req.audit('revoke_token', req.params.name);
    res.json({ ok: true });
  });
  api.post('/backup/run', guard('admin'), async (req, res) => res.json(await backup.run('manual')));
  api.post('/backup/config', guard('admin'), async (req, res) => {
    const { remote, enabled, intervalMinutes } = req.body;
    if (remote !== undefined || enabled) await backup.init(remote || auth.config.backup.remote);
    auth.update((cfg) => { cfg.backup = { ...cfg.backup, ...(enabled !== undefined ? { enabled: !!enabled } : {}), ...(intervalMinutes ? { intervalMinutes: Number(intervalMinutes) } : {}) }; });
    backup.stop();
    backup.start();
    res.json(await backup.status());
  });

  app.use('/api', api);

  // ---- static UI -------------------------------------------------------
  app.use('/vendor/marked.js', express.static(path.join(here, '..', 'node_modules', 'marked', 'lib', 'marked.umd.js')));
  app.use(express.static(path.join(here, '..', 'web'), { etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // ---- errors ----------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });
  return app;
}

/** Owner-without-token only for a direct local connection. A tunnel (cloudflared, tailscale serve, a reverse
 *  proxy) also connects from 127.0.0.1 but announces the real client in a forwarding header → not loopback. */
function openapi(base, vault) {
  const notebooks = vault.listNotebooks().filter((n) => !n.inbox).map((n) => n.folder);
  const captureBody = { type: 'object', required: ['text'], properties: {
    text: { type: 'string', description: 'The content to keep (Markdown ok, [[Title]] links ok)' },
    title: { type: 'string', description: 'One-line headline (≤60 chars); defaults to the first line' },
    notebook: { type: 'string', enum: notebooks, description: 'Only when the owner said where it belongs; otherwise omit and let the router decide' },
    tags: { type: 'array', items: { type: 'string' } },
    properties: { type: 'object', additionalProperties: true, description: 'Structured facts: numbers like {amount: 35, weight: 71.5}, url, ticker…' },
    source: { type: 'string', description: 'Your agent name' } } };
  return {
    openapi: '3.1.0', info: { title: 'Agent Notebook', version: '0.3.0', description: 'The owner\'s local Markdown notebook. Capture anything worth keeping; it is routed to the right notebook automatically.' },
    servers: [{ url: base }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }],
    paths: {
      '/api/capture': { post: { operationId: 'capture', summary: 'Keep something (auto-routed to a notebook)', requestBody: { required: true, content: { 'application/json': { schema: captureBody } } }, responses: { 201: { description: 'Where it went: notebook, path, mode (auto|inbox|explicit), hint, related notes' } } } },
      '/api/today': { get: { operationId: 'today', summary: "Everything recorded on a day, grouped by notebook", parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'groups[]' } } } },
      '/api/search': { get: { operationId: 'search', summary: 'Full-text search', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'hits[]' } } } },
      '/api/notebooks': { get: { operationId: 'listNotebooks', summary: 'Notebooks with kind, keywords, description', responses: { 200: { description: 'notebooks[]' } } } },
      '/api/notes/{path}': {
        get: { operationId: 'readNote', summary: 'Read one note (properties, Markdown body, links, backlinks)', parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Vault-relative path ending in .md, e.g. 财务/2026-11-01.md' }], responses: { 200: { description: 'note' } } },
        patch: { operationId: 'updateNote', summary: 'Edit a note: replace or append body, rename, change properties (null removes one)', parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string', description: 'Replace the whole Markdown body' }, append: { type: 'string', description: 'Append Markdown to the end' }, tags: { type: 'array', items: { type: 'string' } }, status: { type: 'string', description: 'Board column' } }, additionalProperties: true } } } }, responses: { 200: { description: 'updated note' } } },
        delete: { operationId: 'deleteNote', summary: 'Move a note to the trash', parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'deleted' } } } },
      '/api/entries/{path}': { patch: { operationId: 'updateEntry', summary: 'Edit or delete ONE timestamped entry of a journal day page (e.g. correct this morning\'s 财务 entry)', parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'The day page, e.g. 财务/2026-11-01.md' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { time: { type: 'string', description: 'HH:MM of the entry (from the page body or the capture result\'s entry)' }, match: { type: 'string', description: 'Substring of the entry title/text when several share a time' }, title: { type: 'string' }, text: { type: 'string', description: 'New body for that entry' }, properties: { type: 'object', additionalProperties: true, description: 'Inline fields to set, e.g. {amount: 66.7}; null removes one' }, remove: { type: 'boolean', description: 'true deletes the entry' } } } } } }, responses: { 200: { description: 'updated day page' } } } },
      '/api/metrics/{notebook}': { get: { operationId: 'metrics', summary: 'Numeric series of a notebook (amount, weight…)', parameters: [{ name: 'notebook', in: 'path', required: true, schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string' } }, { name: 'to', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'keys[] + series' } } } }
    }
  };
}

/** On a personal machine the local browser is the owner. On a shared server every local process would be,
 *  so `trustLoopback: false` in config.json (or AGENT_NOTEBOOK_TRUST_LOOPBACK=0) makes loopback anonymous too. */
function trustsLoopback(auth) {
  if (process.env.AGENT_NOTEBOOK_TRUST_LOOPBACK === '0') return false;
  return auth.config.trustLoopback !== false;
}
function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['tailscale-user-login'];
  return local && !forwarded;
}
