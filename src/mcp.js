// Builds an MCP server bound to one authenticated principal.
// Used by both the stdio transport (local agents) and the HTTP transport (remote agents).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Router, capture, digest } from './notebooks.js';
import { metrics } from './metrics.js';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });

export function buildMcpServer({ vault, auth, principal }) {
  const server = new McpServer({ name: 'agent-notebook', version: '0.2.0' });
  const router = new Router(vault);

  const guarded = (scope, pathOf, fn) => async (args) => {
    const target = pathOf ? pathOf(args) : '';
    try {
      auth.require(principal, scope, target);
      const result = await fn(args);
      if (scope === 'write') auth.audit(principal, fn.name || 'write', target, { via: 'mcp', args: compact(args) });
      return text(result);
    } catch (err) {
      auth.audit(principal, `${scope}:denied`, target, { via: 'mcp', error: err.message });
      return fail(err);
    }
  };

  server.registerTool('notebook_whoami', {
    title: 'Who am I',
    description: 'Show the identity, scopes (read/write/admin) and folder restrictions of the current token.',
    inputSchema: {}
  }, async () => text({ ...principal, vault: vault.root }));

  server.registerTool('notebook_capture', {
    title: 'Capture (the one call you need)',
    description: 'Keep something: a finding, idea, health/reading/finance/thinking note, alpha lead, topic. The notebook routes it to the right notebook by keywords and learned rules, or to 收件箱 if unsure. Journals get a timestamped entry on today\'s page, boards get a card, page notebooks get a page. Only pass `notebook` when the owner said where it belongs. Returns where it went plus related notes to [[link]].',
    inputSchema: {
      text: z.string().describe('The content to keep (Markdown ok). Use [[Title]] to link other notes.'),
      title: z.string().optional().describe('Short headline (≤60 chars). Defaults to the first line.'),
      notebook: z.string().optional().describe('Notebook folder, only when known (see notebook_list_notebooks)'),
      tags: z.array(z.string()).optional(),
      source: z.string().optional().describe('Your agent name (defaults to the token name)'),
      properties: z.record(z.any()).optional().describe('Structured facts: {url, amount, ticker, weight…}'),
      date: z.string().optional().describe('YYYY-MM-DD for journal entries that belong to another day')
    }
  }, guarded('write', (a) => a.notebook || '', function capture_note(args) {
    return capture(vault, router, { ...args, source: args.source || principal.name }, { auth, log: (e) => auth.audit({ name: 'ai' }, e.event, e.notebook || '', e) });
  }));

  server.registerTool('notebook_list_notebooks', {
    title: 'List notebooks',
    description: 'All notebooks (areas) with kind (board/journal/pages), keywords, description and columns. Call once to learn the owner\'s areas.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, guarded('read', null, function list_notebooks() {
    return vault.listNotebooks().filter((n) => auth.can(principal, 'read', n.folder));
  }));

  server.registerTool('notebook_today', {
    title: "Today's digest",
    description: 'Everything recorded on a day (default today), grouped by notebook, journal bodies inline. Use when the owner asks what was recorded / collected.',
    inputSchema: { date: z.string().optional().describe('YYYY-MM-DD') },
    annotations: { readOnlyHint: true }
  }, guarded('read', null, function today({ date }) {
    const d = digest(vault, date);
    return { ...d, groups: d.groups.filter((g) => auth.can(principal, 'read', g.notebook.folder)) };
  }));

  server.registerTool('notebook_metrics', {
    title: 'Numeric metrics of a notebook',
    description: 'Time series of the numbers recorded in a notebook (amount, weight, steps … — whatever was passed as properties or written as [key:: value]). Per key: count, sum, avg, min, max, latest, plus the points. Use when the owner asks "how much did I spend this month" or "how is my weight trending".',
    inputSchema: {
      notebook: z.string().describe('Notebook folder, e.g. 财务'),
      key: z.string().optional().describe('Only this property, e.g. amount'),
      from: z.string().optional().describe('YYYY-MM-DD inclusive'),
      to: z.string().optional().describe('YYYY-MM-DD inclusive')
    },
    annotations: { readOnlyHint: true }
  }, guarded('read', (a) => a.notebook, function notebook_metrics({ notebook, key, from, to }) {
    const m = metrics(vault, notebook, { key, from, to });
    for (const k of Object.keys(m.series)) if (m.series[k].length > 500) m.series[k] = m.series[k].slice(-500);
    return m;
  }));

  server.registerTool('notebook_move_note', {
    title: 'Move note to a notebook',
    description: 'Move a note into another notebook (e.g. out of 收件箱). The router learns from the move.',
    inputSchema: { path: z.string(), notebook: z.string().describe('Target notebook folder') }
  }, guarded('write', (a) => a.notebook, function move_note({ path, notebook }) {
    const before = vault.getNote(path);
    const moved = vault.moveNote(path, notebook);
    router.learn({ title: before.title, tags: before.properties.tags || [], source: before.properties.source }, notebook);
    return moved;
  }));

  server.registerTool('notebook_create_notebook', {
    title: 'Create notebook',
    description: 'Create a new area. kind: board (kanban columns), journal (one page per day), pages (one page per note). Only when the owner asks.',
    inputSchema: {
      folder: z.string(), title: z.string().optional(), icon: z.string().optional(),
      kind: z.enum(['board', 'journal', 'pages']).optional().default('pages'),
      description: z.string().optional().describe('What belongs here — used for routing'),
      keywords: z.array(z.string()).optional().describe('Routing keywords'),
      columns: z.array(z.string()).optional()
    }
  }, guarded('write', (a) => a.folder, function create_notebook(args) {
    return vault.createNotebook(args);
  }));

  server.registerTool('notebook_list_boards', {
    title: 'List boards',
    description: 'List all kanban boards (folders that contain _board.md) with their columns.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, guarded('read', null, function list_boards() {
    return vault.listBoards().filter((b) => auth.can(principal, 'read', b.folder));
  }));

  server.registerTool('notebook_get_board', {
    title: 'Get board',
    description: 'Get a board with its cards grouped by column. Optionally filter cards to one date (YYYY-MM-DD), e.g. today\'s Alpha board.',
    inputSchema: { folder: z.string().describe('Board folder, e.g. "Alpha看板"'), date: z.string().optional().describe('YYYY-MM-DD; only cards dated that day') },
    annotations: { readOnlyHint: true }
  }, guarded('read', (a) => a.folder, function get_board({ folder, date }) {
    return vault.getBoard(folder, { date });
  }));

  server.registerTool('notebook_list_notes', {
    title: 'List notes',
    description: 'List notes (pages/cards) with metadata, newest first. Filter by folder, status, tag, source agent, date or updated-since.',
    inputSchema: {
      folder: z.string().optional().describe('Folder to list; empty = whole vault'),
      recursive: z.boolean().optional().default(true),
      status: z.string().optional(),
      tag: z.string().optional(),
      source: z.string().optional().describe('Agent name that created the note'),
      date: z.string().optional().describe('YYYY-MM-DD'),
      since: z.string().optional().describe('ISO timestamp; only notes updated after this'),
      limit: z.number().int().min(1).max(500).optional().default(50)
    },
    annotations: { readOnlyHint: true }
  }, guarded('read', null, function list_notes(args) {
    return vault.listNotes(args).filter((n) => auth.can(principal, 'read', n.path));
  }));

  server.registerTool('notebook_read_note', {
    title: 'Read note',
    description: 'Read one note: properties, Markdown body, resolved [[links]] and backlinks.',
    inputSchema: { path: z.string().describe('Vault-relative path ending in .md') },
    annotations: { readOnlyHint: true }
  }, guarded('read', (a) => a.path, function read_note({ path }) {
    return vault.getNoteFull(path);
  }));

  server.registerTool('notebook_search', {
    title: 'Search',
    description: 'Full-text search across titles, properties and bodies.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(200).optional().default(30) },
    annotations: { readOnlyHint: true }
  }, guarded('read', null, function search({ query, limit }) {
    return vault.search(query, { limit }).filter((n) => auth.can(principal, 'read', n.path));
  }));

  server.registerTool('notebook_create_note', {
    title: 'Create note / card',
    description: 'Low-level: create a note in an exact folder. Prefer notebook_capture, which routes automatically. If the folder is a board the note becomes a card.',
    inputSchema: {
      folder: z.string().describe('Target folder, e.g. "Alpha看板" or "灵感"'),
      title: z.string(),
      body: z.string().optional().default('').describe('Markdown body'),
      status: z.string().optional().describe('Board column name'),
      tags: z.array(z.string()).optional(),
      source: z.string().optional().describe('Your agent name (defaults to the token name)'),
      properties: z.record(z.any()).optional().describe('Extra frontmatter properties, e.g. {url, score, ticker}')
    }
  }, guarded('write', (a) => a.folder, function create_note({ folder, title, body, status, tags, source, properties }) {
    return vault.createNote({ folder, title, body, properties: { ...(properties || {}), status, tags, source: source || principal.name } });
  }));

  server.registerTool('notebook_update_note', {
    title: 'Update note',
    description: 'Update a note: replace body, append to body, rename, change status/tags or any property. Set a property to null to remove it.',
    inputSchema: {
      path: z.string(),
      title: z.string().optional(),
      body: z.string().optional().describe('Replace the whole Markdown body'),
      append: z.string().optional().describe('Append Markdown to the end of the body'),
      status: z.string().optional(),
      tags: z.array(z.string()).optional(),
      properties: z.record(z.any()).optional()
    }
  }, guarded('write', (a) => a.path, function update_note({ path, title, body, append, status, tags, properties }) {
    return vault.updateNote(path, { title, body, append, properties: { ...(properties || {}), status, tags } });
  }));

  server.registerTool('notebook_update_entry', {
    title: 'Edit / delete one journal entry',
    description: 'Journals (健康, 财务 …) keep one page per day with timestamped entries. Correct or delete ONE entry instead of rewriting the page: locate it by time (HH:MM, from the capture result\'s `entry` or the page body) and, if needed, a `match` substring. Set remove:true to delete it.',
    inputSchema: {
      path: z.string().describe('Day page path, e.g. 财务/2026-11-01.md'),
      time: z.string().optional().describe('HH:MM of the entry'),
      match: z.string().optional().describe('Substring of the entry title/text to disambiguate'),
      title: z.string().optional(),
      text: z.string().optional().describe('New body for the entry (Markdown)'),
      properties: z.record(z.any()).optional().describe('Inline fields to set, e.g. {amount: 66.7}; null removes'),
      remove: z.boolean().optional()
    }
  }, guarded('write', (a) => a.path, function update_entry({ path, ...rest }) {
    return vault.updateJournalEntry(path, rest);
  }));

  server.registerTool('notebook_move_card', {
    title: 'Move card',
    description: 'Move a board card to another column (sets its status).',
    inputSchema: { path: z.string(), status: z.string().describe('Target column name') }
  }, guarded('write', (a) => a.path, function move_card({ path, status }) {
    return vault.moveCard(path, status);
  }));

  server.registerTool('notebook_create_board', {
    title: 'Create board',
    description: 'Create a new kanban board (folder with _board.md).',
    inputSchema: {
      folder: z.string(),
      title: z.string().optional(),
      icon: z.string().optional(),
      columns: z.array(z.string()).min(1).optional(),
      description: z.string().optional()
    }
  }, guarded('write', (a) => a.folder, function create_board(args) {
    return vault.createBoard(args);
  }));

  server.registerTool('notebook_delete_note', {
    title: 'Delete note',
    description: 'Move a note to the vault trash (.trash/). Recoverable by the owner.',
    inputSchema: { path: z.string() },
    annotations: { destructiveHint: true }
  }, guarded('write', (a) => a.path, function delete_note({ path }) {
    return vault.deleteNote(path);
  }));

  return server;
}

function compact(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  }
  return out;
}
