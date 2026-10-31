// Routing captured text into the right notebook, learning from the owner's corrections,
// and the single `capture` entry point agents use.
import fs from 'node:fs';
import path from 'node:path';
import { localDate } from './vault.js';
import { extractFields } from './metrics.js';

const INBOX_FOLDER = '收件箱';
// whole CJK phrases of 2-6 chars (bounded by non-CJK); longer runs are sentences, not keywords
const CJK_RUN = /(?<![一-鿿])[一-鿿]{2,6}(?![一-鿿])/g;
const LATIN_WORD = /[a-z][a-z0-9+#.-]{2,}/gi;

/** Learns keyword / tag / source → notebook rules from how the owner files things. */
export class Router {
  constructor(vault) {
    this.vault = vault;
    this.rulesPath = path.join(vault.root, '.notebook', 'rules.json');
  }

  rules() {
    try { return { keywords: {}, tags: {}, sources: {}, ...JSON.parse(fs.readFileSync(this.rulesPath, 'utf8')) }; }
    catch { return { keywords: {}, tags: {}, sources: {} }; }
  }

  saveRules(r) {
    fs.mkdirSync(path.dirname(this.rulesPath), { recursive: true });
    fs.writeFileSync(this.rulesPath, JSON.stringify(r, null, 2));
  }

  /** Remember that content like this belongs in `folder`. */
  learn({ title = '', tags = [], source }, folder, { strong = true } = {}) {
    const r = this.rules();
    if (strong) for (const kw of keywordsOf(title)) r.keywords[kw] = folder;
    for (const t of tags) r.tags[String(t).toLowerCase()] = folder;
    if (source) {
      r.sources[source] = r.sources[source] || {};
      r.sources[source][folder] = (r.sources[source][folder] || 0) + 1;
    }
    this.saveRules(r);
    return r;
  }

  /** Score every notebook for a piece of text. Returns {decision, candidates}. */
  classify({ text = '', title = '', tags = [], source } = {}) {
    const hay = `${title}\n${text}`.toLowerCase();
    const lowTags = tags.map((t) => String(t).toLowerCase());
    const r = this.rules();
    const candidates = [];
    for (const nb of this.vault.listNotebooks()) {
      if (nb.inbox) continue;
      let score = 0;
      const reasons = [];
      for (const kw of nb.keywords) {
        if (kw && hay.includes(String(kw).toLowerCase())) { score += 2; reasons.push(`关键词「${kw}」`); }
      }
      for (const [kw, folder] of Object.entries(r.keywords)) {
        if (folder === nb.folder && hay.includes(kw.toLowerCase())) { score += 3; reasons.push(`学习到的关键词「${kw}」`); }
      }
      for (const t of lowTags) {
        if (r.tags[t] === nb.folder) { score += 3; reasons.push(`标签 #${t}（学习）`); }
        else if (nb.keywords.map((k) => String(k).toLowerCase()).includes(t) || t === nb.title.toLowerCase()) { score += 2; reasons.push(`标签 #${t}`); }
      }
      if (source && r.sources[source]) {
        const counts = r.sources[source];
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (best && best[0] === nb.folder && best[1] >= 3) { score += 2; reasons.push(`${source} 通常记到这里`); }
      }
      if (hay.includes(nb.title.toLowerCase())) { score += 1; reasons.push(`提到「${nb.title}」`); }
      if (score > 0) candidates.push({ folder: nb.folder, title: nb.title, icon: nb.icon, kind: nb.kind, score, reasons });
    }
    candidates.sort((a, b) => b.score - a.score);
    const [top, second] = candidates;
    const decision = top && top.score >= 2 && (!second || top.score - second.score >= 1) ? top.folder : null;
    return { decision, candidates: candidates.slice(0, 3) };
  }
}

export function keywordsOf(title) {
  const out = new Set();
  for (const m of String(title).matchAll(CJK_RUN)) out.add(m[0]);
  for (const m of String(title).matchAll(LATIN_WORD)) out.add(m[0].toLowerCase());
  return [...out].slice(0, 6);
}

export function ensureInbox(vault) {
  const existing = vault.inboxFolder();
  if (existing) return existing;
  vault.createNotebook({ folder: INBOX_FOLDER, title: '收件箱', icon: '📥', kind: 'pages', description: '自动归类拿不准的内容先放这里。点一下分配到正确的笔记本，系统会记住。', inbox: true, order: 0 });
  return INBOX_FOLDER;
}

function deriveTitle(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '未命名';
  const clean = first
    .replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '')
    .replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, n, l) => (l || n).trim())
    .replace(/[*_`]/g, '').trim();
  const sentence = clean.split(/[。！？；!?;]|(?:\s[-—]\s)/)[0].trim() || clean;
  return (sentence.length > 50 ? sentence.slice(0, 50) + '…' : sentence) || '未命名';
}

function hashtags(text) {
  return [...String(text || '').matchAll(/(?:^|\s)#([^\s#]{1,20})/g)].map((m) => m[1]);
}

/**
 * The one call agents make. Decides where the text belongs, files it in the notebook's own
 * shape (journal entry / card / page) and reports related notes the agent may want to link.
 */
export function capture(vault, router, { text, title, notebook, tags = [], source, properties = {}, date } = {}) {
  if (!text && !title) throw Object.assign(new Error('text is required'), { status: 400 });
  text = String(text || '');
  // `[amount:: 35]` / `weight:: 71.5` typed inside the text count as properties too (Obsidian Dataview syntax)
  const inText = extractFields(text);
  properties = { ...inText, ...(properties || {}) };
  const titleGiven = !!title;
  title = title || deriveTitle(text);
  tags = Array.from(new Set([...(tags || []), ...hashtags(text)]));

  let folder;
  let mode;
  let classification = { decision: null, candidates: [] };
  if (notebook) {
    if (!vault.isNotebook(notebook)) throw Object.assign(new Error(`Notebook not found: ${notebook}. Call notebook_list_notebooks to see what exists.`), { status: 404 });
    folder = notebook;
    mode = 'explicit';
    router.learn({ tags, source }, folder, { strong: false });
  } else {
    classification = router.classify({ text, title, tags, source });
    if (classification.decision) { folder = classification.decision; mode = 'auto'; }
    else { folder = ensureInbox(vault); mode = 'inbox'; }
  }

  const meta = vault.getNotebookMeta(folder);
  const common = { source, tags, captured: mode, ...(mode === 'inbox' && classification.candidates.length ? { suggested: classification.candidates.map((c) => c.folder) } : {}) };
  let note;
  let entry = null;
  if (meta.kind === 'journal') {
    const entryProps = Object.fromEntries(Object.entries(properties).filter(([k]) => !(k in inText))); // fields already in the text stay where they are
    const r = vault.appendJournal(folder, { title: titleGiven ? title : undefined, text, source, tags, properties: entryProps, date });
    note = r; entry = r.entry;
  } else {
    note = vault.createNote({ folder, title, body: text, properties: { ...properties, ...common } });
  }

  const idx = vault.titleIndex();
  const links = vault.extractLinks(text, idx);
  const related = vault.search(title, { limit: 6 }).filter((n) => n.path !== note.path).slice(0, 5)
    .map((n) => ({ path: n.path, title: n.title, folder: n.folder }));

  return {
    path: note.path,
    title: note.title,
    notebook: { folder, title: meta.title, icon: meta.icon, kind: meta.kind },
    mode,
    entry,
    candidates: classification.candidates,
    links,
    related,
    hint: mode === 'inbox'
      ? '归类拿不准，已放入收件箱。如果你知道它属于哪个笔记本，下次直接传 notebook 参数。'
      : mode === 'auto' ? `已自动归入「${meta.title}」（${classification.candidates[0]?.reasons.join('，') || ''}）。` : `已记入「${meta.title}」。`
  };
}

/** What landed in the vault on a given day, grouped by notebook. The owner's morning read. */
export function digest(vault, date = localDate(new Date())) {
  const notebooks = vault.listNotebooks();
  const groups = [];
  for (const nb of notebooks) {
    const notes = vault.listNotes({ folder: nb.folder, recursive: false, limit: 500 })
      .filter((n) => n.date === date || String(n.updated || '').slice(0, 10) === date || String(n.created || '').slice(0, 10) === date);
    if (!notes.length) continue;
    const items = notes.map((n) => nb.kind === 'journal' ? { ...n, body: vault.getNote(n.path).body } : n);
    groups.push({ notebook: { folder: nb.folder, title: nb.title, icon: nb.icon, kind: nb.kind, inbox: nb.inbox }, items });
  }
  const sources = new Set();
  for (const g of groups) for (const i of g.items) if (i.source) sources.add(i.source);
  return { date, groups, total: groups.reduce((n, g) => n + g.items.length, 0), sources: [...sources] };
}
