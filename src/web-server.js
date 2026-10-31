// HTTP server: Notion-style web UI + REST API for the owner, and an MCP endpoint (/mcp) for remote agents.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { listAgents, connectAgent, getAgent, serverEntry } from './agents.js';
import { Router, capture, digest } from './notebooks.js';
import { metrics } from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ vault, auth, backup }) {
  const app = express();
  const router = new Router(vault);
  app.use(express.json({ limit: '5mb' }));

  // ---- identify the caller -------------------------------------------
  app.use((req, res, next) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      req.principal = auth.authenticate(bearer);
      if (!req.principal) return res.status(401).json({ error: 'invalid token' });
    } else if (isLoopback(req)) {
      req.principal = auth.owner(); // the human at the local UI
    } else {
      req.principal = null;
    }
    next();
  });

  // ---- MCP over Streamable HTTP ---------------------------------------
  app.all('/mcp', async (req, res) => {
    if (!req.principal || req.principal.kind !== 'token') {
      return res.status(401).json({ error: 'Bearer token required for /mcp' });
    }
    const server = buildMcpServer({ vault, auth, principal: req.principal });
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
    auth.audit(req.principal, 'create_notebook', nb.folder, { via: 'web' });
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
    auth.audit(req.principal, 'update_notebook', nb.folder, { via: 'web', fields: Object.keys(req.body) });
    res.json(nb);
  });
  // numeric series of a notebook (amount, weight …) for the chart view; registered before /notebooks/* would swallow it
  api.get('/metrics/*', guard('read', notePath), (req, res) => res.json(metrics(vault, notePath(req), { from: req.query.from, to: req.query.to, key: req.query.key })));
  api.get('/today', guard('read'), (req, res) => {
    const d = digest(vault, req.query.date || undefined);
    res.json({ ...d, groups: d.groups.filter((g) => auth.can(req.principal, 'read', g.notebook.folder)) });
  });
  api.get('/links/index', guard('read'), (req, res) => res.json(Object.fromEntries(vault.titleIndex())));
  api.post('/capture', guard('write', (r) => r.body.notebook || ''), (req, res) => {
    const r = capture(vault, router, { ...req.body, source: req.body.source || req.principal.name });
    auth.audit(req.principal, 'capture', r.path, { via: 'web', mode: r.mode, notebook: r.notebook.folder });
    res.status(201).json(r);
  });
  api.post('/move', guard('write', (r) => r.body.folder || ''), (req, res) => {
    const { path: p, folder, learn } = req.body;
    const before = vault.getNote(p);
    const moved = vault.moveNote(p, folder);
    if (learn !== false) router.learn({ title: before.title, tags: before.properties.tags || [], source: before.properties.source }, folder);
    auth.audit(req.principal, 'move_note', moved.path, { via: 'web', from: before.folder, learn: learn !== false });
    res.json(moved);
  });
  api.get('/classify', guard('read'), (req, res) => res.json(router.classify({ text: req.query.text || '', title: req.query.title || '' })));
  api.get('/boards', guard('read'), (req, res) => res.json(vault.listBoards()));
  api.post('/boards', guard('write', (r) => r.body.folder), (req, res) => {
    const b = vault.createBoard(req.body);
    auth.audit(req.principal, 'create_board', b.folder, { via: 'web' });
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
    const note = vault.createNote({ folder, title, body, properties: { source: req.principal.name, ...properties } });
    auth.audit(req.principal, 'create_note', note.path, { via: 'web' });
    res.status(201).json(note);
  });
  api.get('/notes/*', guard('read', notePath), (req, res) => res.json(vault.getNoteFull(notePath(req))));
  api.patch('/notes/*', guard('write', notePath), (req, res) => {
    const { title, body, append, ...properties } = req.body;
    const note = vault.updateNote(notePath(req), { title, body, append, properties });
    auth.audit(req.principal, 'update_note', note.path, { via: 'web', fields: Object.keys(req.body) });
    res.json(note);
  });
  api.delete('/notes/*', guard('write', notePath), (req, res) => {
    const r = vault.deleteNote(notePath(req));
    auth.audit(req.principal, 'delete_note', r.deleted, { via: 'web' });
    res.json(r);
  });

  api.get('/agents', guard('admin'), (req, res) => res.json(listAgents({ vault: vault.root, port: req.socket.localPort })));
  api.post('/agents/:id/connect', guard('admin'), (req, res) => {
    getAgent(req.params.id);
    const { scopes, folders, skill } = req.body || {};
    const r = connectAgent({ id: req.params.id, auth, vault: vault.root, scopes: scopes?.length ? scopes : ['read', 'write'], folders: folders?.length ? folders : ['*'], skill: skill !== false });
    auth.audit(req.principal, 'connect_agent', req.params.id, { tokenName: r.tokenName, configPath: r.configPath });
    res.status(201).json(r);
  });
  api.post('/agents/snippets', guard('admin'), (req, res) => {
    // token for an agent we can't auto-configure: create it and return copy-paste snippets
    const { name, scopes, folders } = req.body || {};
    const t = auth.createToken(name, { scopes: scopes?.length ? scopes : ['read', 'write'], folders: (folders || []).filter(Boolean) });
    auth.audit(req.principal, 'create_token', name, { scopes: t.scopes, folders: t.folders, via: 'agents' });
    const entry = serverEntry({ token: t.token, vault: vault.root });
    res.status(201).json({ ...t, httpUrl: `http://127.0.0.1:${req.socket.localPort}/mcp`, json: { mcpServers: { 'agent-notebook': entry.json } }, toml: entry.toml, claudeCmd: `claude mcp add agent-notebook -e AGENT_NOTEBOOK_TOKEN=${t.token} -e AGENT_NOTEBOOK_VAULT="${vault.root}" -- node "${entry.json.args[0]}" mcp` });
  });
  api.get('/audit', guard('admin'), (req, res) => res.json(auth.readAudit({ limit: Number(req.query.limit) || 200 })));
  api.get('/tokens', guard('admin'), (req, res) => res.json(auth.listTokens()));
  api.post('/tokens', guard('admin'), (req, res) => {
    const { name, scopes, folders } = req.body;
    const t = auth.createToken(name, { scopes, folders: (folders || []).filter(Boolean) });
    auth.audit(req.principal, 'create_token', name, { scopes: t.scopes, folders: t.folders });
    res.status(201).json(t);
  });
  api.delete('/tokens/:name', guard('admin'), (req, res) => {
    auth.revokeToken(req.params.name);
    auth.audit(req.principal, 'revoke_token', req.params.name);
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

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
