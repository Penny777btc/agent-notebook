// Vault: a folder of Markdown files with YAML frontmatter (Obsidian-compatible).
// Boards are folders that contain a `_board.md` describing their columns;
// cards are the notes inside that folder, grouped by the `status` property.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fieldsLine } from './metrics.js';

export const DEFAULT_COLUMNS = ['待处理', '进行中', '已完成'];
const SUMMARY_SYSTEM_KEYS = new Set(['title', 'status', 'tags', 'source', 'sources', 'date', 'created', 'updated', 'captured', 'suggested', 'entries']);
const NOTE_EXT = '.md';
const BOARD_FILE = '_board.md';
const NOTEBOOK_FILE = '_notebook.md';
const META_FILES = new Set([BOARD_FILE, NOTEBOOK_FILE]);
export const NOTEBOOK_KINDS = ['board', 'journal', 'pages'];
export const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const IGNORED_DIRS = new Set(['.git', '.notebook', '.obsidian', '.trash', 'node_modules']);

export class VaultError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const today = () => localDate(new Date());
export function localDate(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function slugify(title) {
  return String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ') // chars unsafe for file names / Obsidian links
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim() || 'untitled';
}

export class Vault {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  // ---- path helpers -----------------------------------------------------
  resolve(rel) {
    const abs = path.resolve(this.root, rel || '.');
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new VaultError(`Path escapes vault: ${rel}`, 400);
    }
    return abs;
  }

  relative(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  // ---- tree -------------------------------------------------------------
  listTree(rel = '') {
    const abs = this.resolve(rel);
    const entries = fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [];
    const folders = [];
    const notes = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const nb = this.isNotebook(childRel) ? this.getNotebookMeta(childRel) : null;
        folders.push({
          type: 'folder',
          name: e.name,
          path: childRel,
          isBoard: nb?.kind === 'board',
          isNotebook: !!nb,
          notebook: nb ? { title: nb.title, icon: nb.icon, kind: nb.kind } : null,
          children: this.listTree(childRel)
        });
      } else if (e.isFile() && e.name.endsWith(NOTE_EXT) && !META_FILES.has(e.name)) {
        const meta = this.readMeta(childRel);
        notes.push({ type: 'note', name: e.name, path: childRel, title: meta.title, status: meta.status, updated: meta.updated });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    notes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return [...folders, ...notes];
  }

  // ---- notes ------------------------------------------------------------
  readMeta(rel) {
    const raw = fs.readFileSync(this.resolve(rel), 'utf8');
    const parsed = matter(raw);
    const title = parsed.data.title || path.basename(rel, NOTE_EXT);
    return { ...parsed.data, title, status: parsed.data.status };
  }

  getNote(rel) {
    if (!rel || !rel.endsWith(NOTE_EXT)) throw new VaultError('Note path must end with .md', 400);
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new VaultError(`Note not found: ${rel}`, 404);
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = matter(raw);
    const stat = fs.statSync(abs);
    return {
      path: rel,
      folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      title: parsed.data.title || path.basename(rel, NOTE_EXT),
      properties: parsed.data,
      body: parsed.content.replace(/^\n/, ''),
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  }

  listNotes({ folder = '', recursive = true, status, tag, source, since, date, limit = 200 } = {}) {
    const out = [];
    const walk = (rel) => {
      for (const item of this.listTree(rel)) {
        if (item.type === 'folder') {
          if (recursive) walk(item.path);
          continue;
        }
        const note = this.getNote(item.path);
        const p = note.properties;
        if (status && p.status !== status) continue;
        if (tag && !(Array.isArray(p.tags) && p.tags.includes(tag))) continue;
        if (source && p.source !== source) continue;
        if (date && (p.date || (p.created || '').slice(0, 10)) !== date) continue;
        if (since && (p.updated || p.created || note.mtime) < since) continue;
        out.push(summarize(note));
      }
    };
    walk(folder);
    out.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    return out.slice(0, limit);
  }

  createNote({ folder = '', title, body = '', properties = {} }) {
    if (!title) throw new VaultError('title is required', 400);
    const dirAbs = this.resolve(folder);
    fs.mkdirSync(dirAbs, { recursive: true });
    let base = slugify(title);
    let rel = folder ? `${folder}/${base}${NOTE_EXT}` : `${base}${NOTE_EXT}`;
    let n = 2;
    while (fs.existsSync(this.resolve(rel))) {
      rel = folder ? `${folder}/${base} ${n}${NOTE_EXT}` : `${base} ${n}${NOTE_EXT}`;
      n++;
    }
    const board = this.isBoard(folder) ? this.getNotebookMeta(folder) : null;
    const data = {
      title,
      created: nowIso(),
      updated: nowIso(),
      date: today(),
      ...stripUndefined(properties)
    };
    if (board && !data.status) data.status = board.columns[0];
    if (data.tags && !Array.isArray(data.tags)) data.tags = String(data.tags).split(',').map((s) => s.trim()).filter(Boolean);
    fs.writeFileSync(this.resolve(rel), matter.stringify('\n' + body.trim() + '\n', data));
    return this.getNote(rel);
  }

  updateNote(rel, { title, body, append, properties = {} } = {}) {
    const note = this.getNote(rel);
    const data = { ...note.properties, ...stripUndefined(properties), updated: nowIso() };
    if (title) data.title = title;
    if (data.tags && !Array.isArray(data.tags)) data.tags = String(data.tags).split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
    let content = body !== undefined ? body : note.body;
    if (append) content = (content.trimEnd() + '\n\n' + append.trim()).trim();
    fs.writeFileSync(this.resolve(rel), matter.stringify('\n' + content.trim() + '\n', data));
    return this.getNote(rel);
  }

  deleteNote(rel) {
    const note = this.getNote(rel);
    const trashDir = path.join(this.root, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const dest = path.join(trashDir, `${Date.now()}-${path.basename(rel)}`);
    fs.renameSync(this.resolve(rel), dest);
    return { deleted: note.path, trash: this.relative(dest) };
  }

  search(q, { limit = 50 } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const n of this.listNotes({ limit: 5000 })) {
      const note = this.getNote(n.path);
      const hay = `${note.title}\n${JSON.stringify(note.properties)}\n${note.body}`.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      const bodyIdx = note.body.toLowerCase().indexOf(needle);
      const snippet = bodyIdx >= 0
        ? note.body.slice(Math.max(0, bodyIdx - 60), bodyIdx + 100).replace(/\s+/g, ' ')
        : note.body.slice(0, 120).replace(/\s+/g, ' ');
      hits.push({ ...summarize(note), snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ---- notebooks ----------------------------------------------------------
  // A notebook is a folder with _notebook.md (or a legacy _board.md). kind: board | journal | pages.
  isNotebook(folder) {
    if (!folder) return false;
    const abs = this.resolve(folder);
    return fs.existsSync(path.join(abs, NOTEBOOK_FILE)) || fs.existsSync(path.join(abs, BOARD_FILE));
  }

  isBoard(folder) {
    return this.isNotebook(folder) && this.getNotebookMeta(folder).kind === 'board';
  }

  getNotebookMeta(folder) {
    const abs = this.resolve(folder);
    const file = fs.existsSync(path.join(abs, NOTEBOOK_FILE)) ? path.join(abs, NOTEBOOK_FILE) : path.join(abs, BOARD_FILE);
    if (!fs.existsSync(file)) throw new VaultError(`Notebook not found: ${folder}`, 404);
    const parsed = matter(fs.readFileSync(file, 'utf8'));
    const d = parsed.data;
    const legacyBoard = file.endsWith(BOARD_FILE);
    const kind = NOTEBOOK_KINDS.includes(d.kind) ? d.kind : (legacyBoard || d.columns ? 'board' : 'pages');
    return {
      folder,
      title: d.title || path.basename(folder),
      icon: d.icon || (kind === 'board' ? '📋' : kind === 'journal' ? '📆' : '📁'),
      kind,
      description: parsed.content.trim(),
      keywords: Array.isArray(d.keywords) ? d.keywords.map(String) : [],
      columns: kind === 'board' ? (Array.isArray(d.columns) && d.columns.length ? d.columns : DEFAULT_COLUMNS) : null,
      inbox: !!d.inbox,
      order: typeof d.order === 'number' ? d.order : 100
    };
  }

  listNotebooks() {
    const out = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.type !== 'folder') continue;
        if (it.isNotebook) out.push({ ...this.getNotebookMeta(it.path), count: countNotes(it) });
        walk(it.children);
      }
    };
    walk(this.listTree());
    out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'));
    return out;
  }

  inboxFolder() {
    return this.listNotebooks().find((n) => n.inbox)?.folder || null;
  }

  createNotebook({ folder, title, icon, kind = 'pages', description = '', keywords = [], columns, inbox = false, order }) {
    if (!folder) throw new VaultError('folder is required', 400);
    if (!NOTEBOOK_KINDS.includes(kind)) throw new VaultError(`kind must be one of ${NOTEBOOK_KINDS.join(', ')}`, 400);
    const dirAbs = this.resolve(folder);
    fs.mkdirSync(dirAbs, { recursive: true });
    if (this.isNotebook(folder)) throw new VaultError(`Notebook already exists: ${folder}`, 409);
    const data = stripUndefined({ title: title || path.basename(folder), icon, kind, keywords, columns: kind === 'board' ? (columns?.length ? columns : DEFAULT_COLUMNS) : undefined, inbox: inbox || undefined, order });
    fs.writeFileSync(path.join(dirAbs, NOTEBOOK_FILE), matter.stringify('\n' + description + '\n', data));
    return this.getNotebookMeta(folder);
  }

  updateNotebook(folder, patch = {}) {
    const meta = this.getNotebookMeta(folder);
    const abs = this.resolve(folder);
    // always write the new-style file; drop a legacy _board.md if present
    const data = stripUndefined({
      title: patch.title ?? meta.title,
      icon: patch.icon ?? meta.icon,
      kind: patch.kind ?? meta.kind,
      keywords: patch.keywords ?? meta.keywords,
      columns: (patch.kind ?? meta.kind) === 'board' ? (patch.columns ?? meta.columns ?? DEFAULT_COLUMNS) : undefined,
      inbox: (patch.inbox ?? meta.inbox) || undefined,
      order: patch.order ?? meta.order
    });
    fs.writeFileSync(path.join(abs, NOTEBOOK_FILE), matter.stringify('\n' + (patch.description ?? meta.description) + '\n', data));
    if (fs.existsSync(path.join(abs, BOARD_FILE))) fs.unlinkSync(path.join(abs, BOARD_FILE));
    return this.getNotebookMeta(folder);
  }

  // boards = notebooks of kind "board" (kept for API compatibility)
  listBoards() {
    return this.listNotebooks().filter((n) => n.kind === 'board');
  }

  getBoardMeta(folder) {
    const meta = this.getNotebookMeta(folder);
    if (meta.kind !== 'board') throw new VaultError(`"${folder}" is not a board`, 400);
    return meta;
  }

  createBoard({ folder, title, columns = DEFAULT_COLUMNS, icon, description = '', keywords = [] }) {
    return this.createNotebook({ folder, title, icon, kind: 'board', description, keywords, columns });
  }

  getBoard(folder, { date } = {}) {
    const meta = this.getBoardMeta(folder);
    const cards = this.listNotes({ folder, recursive: false, date, limit: 2000 });
    const columns = meta.columns.map((name) => ({ name, cards: [] }));
    for (const card of cards) {
      const col = columns.find((c) => c.name === card.status) || columns[0];
      col.cards.push(card);
    }
    return { ...meta, columns, total: cards.length };
  }

  moveCard(rel, status) {
    const note = this.getNote(rel);
    if (!this.isBoard(note.folder)) throw new VaultError('Note is not on a board', 400);
    const meta = this.getBoardMeta(note.folder);
    if (!meta.columns.includes(status)) throw new VaultError(`Unknown column "${status}". Columns: ${meta.columns.join(', ')}`, 400);
    return this.updateNote(rel, { properties: { status } });
  }

  /** Move a note into another folder / notebook. Keeps the file name, avoids collisions. */
  moveNote(rel, folder) {
    const note = this.getNote(rel);
    const destDir = this.resolve(folder || '');
    fs.mkdirSync(destDir, { recursive: true });
    const base = path.basename(rel, NOTE_EXT);
    let destRel = folder ? `${folder}/${base}${NOTE_EXT}` : `${base}${NOTE_EXT}`;
    let n = 2;
    while (fs.existsSync(this.resolve(destRel)) && destRel !== rel) {
      destRel = folder ? `${folder}/${base} ${n}${NOTE_EXT}` : `${base} ${n}${NOTE_EXT}`;
      n++;
    }
    if (destRel === rel) return note;
    fs.renameSync(this.resolve(rel), this.resolve(destRel));
    const props = { updated: nowIso() };
    if (this.isBoard(folder)) {
      const meta = this.getNotebookMeta(folder);
      if (!meta.columns.includes(note.properties.status)) props.status = meta.columns[0];
    }
    return this.updateNote(destRel, { properties: props });
  }

  /** Journal notebooks: one note per day, entries appended as timestamped sections. */
  appendJournal(folder, { title, text, source, tags = [], properties = {}, date } = {}) {
    const day = date || today();
    const rel = `${folder}/${day}${NOTE_EXT}`;
    const time = new Date().toTimeString().slice(0, 5);
    const heading = `## ${time}${title ? ' · ' + title : ''}${source ? `  <small>${source}</small>` : ''}`;
    // scalar facts (amount, weight …) live inside the entry as Dataview-style inline fields, so a day
    // with several entries keeps every value and the chart view can read them back per entry
    const fields = fieldsLine(properties);
    const pageProps = Object.fromEntries(Object.entries(properties).filter(([, v]) => v && typeof v === 'object'));
    const block = `${heading}\n\n${String(text || '').trim()}${fields ? '\n\n' + fields : ''}\n`;
    if (!fs.existsSync(this.resolve(rel))) {
      this.createNote({ folder, title: day, body: block, properties: { date: day, tags, source, entries: 1, ...pageProps } });
      return { ...this.getNote(rel), entry: heading };
    }
    const note = this.getNote(rel);
    const p = note.properties;
    const mergedTags = Array.from(new Set([...(Array.isArray(p.tags) ? p.tags : []), ...tags]));
    const sources = Array.from(new Set([...(Array.isArray(p.sources) ? p.sources : p.source ? [p.source] : []), ...(source ? [source] : [])]));
    this.updateNote(rel, { append: block, properties: { tags: mergedTags, sources, source: sources.length === 1 ? sources[0] : 'multiple', entries: (p.entries || 0) + 1, ...pageProps } });
    return { ...this.getNote(rel), entry: heading };
  }

  // ---- links -------------------------------------------------------------
  /** title / file name (lower-cased) → path, for resolving [[wikilinks]]. */
  titleIndex() {
    const idx = new Map();
    for (const n of this.listNotes({ limit: 10000 })) {
      idx.set(n.title.toLowerCase(), n.path);
      idx.set(path.basename(n.path, NOTE_EXT).toLowerCase(), n.path);
    }
    return idx;
  }

  resolveLink(name, idx = this.titleIndex()) {
    return idx.get(String(name).trim().toLowerCase()) || null;
  }

  extractLinks(body, idx = this.titleIndex()) {
    const out = [];
    const seen = new Set();
    for (const m of String(body || '').matchAll(WIKILINK_RE)) {
      const name = m[1].trim();
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, label: m[2]?.trim() || name, path: this.resolveLink(name, idx) });
    }
    return out;
  }

  backlinks(rel) {
    const note = this.getNote(rel);
    const names = new Set([note.title.toLowerCase(), path.basename(rel, NOTE_EXT).toLowerCase()]);
    const out = [];
    for (const n of this.listNotes({ limit: 10000 })) {
      if (n.path === rel) continue;
      const body = this.getNote(n.path).body;
      for (const m of body.matchAll(WIKILINK_RE)) {
        if (names.has(m[1].trim().toLowerCase())) { out.push({ path: n.path, title: n.title, folder: n.folder }); break; }
      }
    }
    return out;
  }

  /** getNote + resolved links + backlinks (used by read endpoints, not by listings). */
  getNoteFull(rel) {
    const note = this.getNote(rel);
    const idx = this.titleIndex();
    return { ...note, links: this.extractLinks(note.body, idx), backlinks: this.backlinks(rel), notebook: this.notebookOf(note.folder) };
  }

  notebookOf(folder) {
    let f = folder;
    while (f) {
      if (this.isNotebook(f)) { const m = this.getNotebookMeta(f); return { folder: f, title: m.title, icon: m.icon, kind: m.kind }; }
      f = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    }
    return null;
  }
}

function countNotes(f) {
  return f.children.reduce((n, c) => n + (c.type === 'note' ? 1 : countNotes(c)), 0);
}

function summarize(note) {
  const p = note.properties;
  return {
    path: note.path,
    folder: note.folder,
    title: note.title,
    status: p.status,
    tags: Array.isArray(p.tags) ? p.tags : [],
    source: p.source,
    date: p.date || (p.created || '').slice(0, 10),
    created: p.created,
    updated: p.updated || note.mtime,
    captured: p.captured,
    suggested: Array.isArray(p.suggested) ? p.suggested : [],
    entries: p.entries,
    props: Object.fromEntries(Object.entries(p).filter(([k]) => !SUMMARY_SYSTEM_KEYS.has(k))),
    excerpt: plainText(note.body).slice(0, 160)
  };
}

/** Rough Markdown → plain text for card previews. */
export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(WIKILINK_RE, (m, n, l) => (l || n).trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}
