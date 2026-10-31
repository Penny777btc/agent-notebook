// Vault: a folder of Markdown files with YAML frontmatter (Obsidian-compatible).
// Boards are folders that contain a `_board.md` describing their columns;
// cards are the notes inside that folder, grouped by the `status` property.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const DEFAULT_COLUMNS = ['待处理', '进行中', '已完成'];
const NOTE_EXT = '.md';
const BOARD_FILE = '_board.md';
const IGNORED_DIRS = new Set(['.git', '.notebook', '.obsidian', '.trash', 'node_modules']);

export class VaultError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

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
        folders.push({
          type: 'folder',
          name: e.name,
          path: childRel,
          isBoard: fs.existsSync(path.join(abs, e.name, BOARD_FILE)),
          children: this.listTree(childRel)
        });
      } else if (e.isFile() && e.name.endsWith(NOTE_EXT) && e.name !== BOARD_FILE) {
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
    const board = this.isBoard(folder) ? this.getBoardMeta(folder) : null;
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

  // ---- boards -----------------------------------------------------------
  isBoard(folder) {
    return !!folder && fs.existsSync(path.join(this.resolve(folder), BOARD_FILE));
  }

  listBoards() {
    const boards = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.type !== 'folder') continue;
        if (it.isBoard) boards.push(this.getBoardMeta(it.path));
        walk(it.children);
      }
    };
    walk(this.listTree());
    return boards;
  }

  getBoardMeta(folder) {
    const abs = path.join(this.resolve(folder), BOARD_FILE);
    if (!fs.existsSync(abs)) throw new VaultError(`Board not found: ${folder}`, 404);
    const parsed = matter(fs.readFileSync(abs, 'utf8'));
    const columns = Array.isArray(parsed.data.columns) && parsed.data.columns.length ? parsed.data.columns : DEFAULT_COLUMNS;
    return {
      folder,
      title: parsed.data.title || path.basename(folder),
      icon: parsed.data.icon || '📋',
      description: parsed.content.trim(),
      columns
    };
  }

  createBoard({ folder, title, columns = DEFAULT_COLUMNS, icon, description = '' }) {
    if (!folder) throw new VaultError('folder is required', 400);
    const dirAbs = this.resolve(folder);
    fs.mkdirSync(dirAbs, { recursive: true });
    const file = path.join(dirAbs, BOARD_FILE);
    if (fs.existsSync(file)) throw new VaultError(`Board already exists: ${folder}`, 409);
    fs.writeFileSync(file, matter.stringify('\n' + description + '\n', stripUndefined({ title: title || path.basename(folder), icon, columns })));
    return this.getBoardMeta(folder);
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
    excerpt: plainText(note.body).slice(0, 160)
  };
}

/** Rough Markdown → plain text for card previews. */
export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
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
