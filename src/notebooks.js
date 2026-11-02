// Routing captured text into the right notebook, learning from the owner's corrections,
// and the single `capture` entry point agents use.
import fs from 'node:fs';
import path from 'node:path';
import { localDate } from './vault.js';
import { extractFields } from './metrics.js';
import { NotebookProfiles, extractNumbers } from './content.js';
import { enrich as aiEnrich, aiSettings } from './enrich.js';
import { bodyHash } from './relations.js';

const INBOX_FOLDER = '收件箱';
// whole CJK phrases of 2-6 chars (bounded by non-CJK); longer runs are sentences, not keywords
const CJK_RUN = /(?<![一-鿿])[一-鿿]{2,6}(?![一-鿿])/g;
const LATIN_WORD = /[a-z][a-z0-9+#.-]{2,}/gi;

/** Learns keyword / tag / source → notebook rules from how the owner files things. */
export class Router {
  constructor(vault) {
    this.vault = vault;
    this.rulesPath = path.join(vault.root, '.notebook', 'rules.json');
    this.profiles = new NotebookProfiles(vault);
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

  /** Every learned rule as a flat list the owner can review: [{ type, key, folder, count? }]. */
  listRules() {
    const r = this.rules();
    const out = [];
    for (const [key, folder] of Object.entries(r.keywords)) out.push({ type: 'keyword', key, folder });
    for (const [key, folder] of Object.entries(r.tags)) out.push({ type: 'tag', key, folder });
    for (const [key, counts] of Object.entries(r.sources)) for (const [folder, count] of Object.entries(counts)) out.push({ type: 'source', key, folder, count });
    return out;
  }

  /** Delete one learned rule (type: keyword | tag | source; `folder` only needed for source). Returns what is left. */
  forget({ type, key, folder } = {}) {
    const r = this.rules();
    if (type === 'keyword') delete r.keywords[key];
    else if (type === 'tag') delete r.tags[key];
    else if (type === 'source') {
      if (folder && r.sources[key]) { delete r.sources[key][folder]; if (!Object.keys(r.sources[key]).length) delete r.sources[key]; }
      else delete r.sources[key];
    } else if (type === 'all') { r.keywords = {}; r.tags = {}; r.sources = {}; }
    else throw Object.assign(new Error('type must be keyword, tag, source or all'), { status: 400 });
    this.saveRules(r);
    return this.listRules();
  }

  /** Score every notebook for a piece of text. Returns {decision, candidates}. */
  classify({ text = '', title = '', tags = [], source } = {}) {
    const hay = `${title}\n${text}`.toLowerCase();
    const lowTags = tags.map((t) => String(t).toLowerCase());
    const r = this.rules();
    const candidates = [];
    // content similarity to what already lives in each notebook (tf-idf over the vault's own notes)
    let sims = new Map();
    try { sims = new Map(this.profiles.similar({ title, text }).map((x) => [x.folder, x])); } catch { /* profiles are an optimisation only */ }
    for (const nb of this.vault.listNotebooks()) {
      if (nb.inbox) continue;
      let score = 0;
      const reasons = [];
      const sim = sims.get(nb.folder);
      if (sim && sim.docs >= 2 && sim.similarity >= 0.12) {
        const pts = sim.similarity >= 0.35 ? 4 : sim.similarity >= 0.22 ? 3 : 2;
        score += pts; reasons.push(`内容与「${nb.title}」里的笔记相近（${Math.round(sim.similarity * 100)}%）`);
      }
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
    // one weak signal (a single keyword, a 13% similarity) is a suggestion, not a decision: it takes ≥3 points
    // with a margin to file without asking, and ≥5 with a clear margin before we skip the AI entirely
    const decision = top && top.score >= 3 && (!second || top.score - second.score >= 1) ? top.folder : null;
    const strong = !!(top && top.score >= 5 && (!second || top.score - second.score >= 2));
    return { decision, strong, candidates: candidates.slice(0, 3) };
  }
}

export function keywordsOf(title) {
  const out = new Set();
  for (const m of String(title).matchAll(CJK_RUN)) out.add(m[0]);
  for (const m of String(title).matchAll(LATIN_WORD)) out.add(m[0].toLowerCase());
  return [...out].slice(0, 6);
}

// ---- related notes --------------------------------------------------------------------------
const CJK_STOP = new Set(['笔记', '记录', '今天', '昨天', '明天', '一下', '一个', '一些', '关于', '什么', '怎么', '可以', '我们', '你们', '他们', '这个', '那个', '这些', '已经', '还是', '以及', '然后', '因为', '所以', '如果', '但是', '没有', '不是', '就是', '需要', '进行', '问题', '时候', '现在', '继续', '开始', '完成', '内容', '东西', '一点', '比较', '非常', '觉得', '感觉']);
const LATIN_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'you', 'not', 'but', 'has', 'have', 'into', 'about']);

/** Title → set of comparable tokens: latin words (≥3 chars) and CJK character bigrams, minus stop words. */
export function titleTokens(title) {
  const out = new Set();
  const t = String(title || '').toLowerCase();
  for (const m of t.matchAll(/[a-z0-9][a-z0-9+#.-]{2,}/g)) if (!LATIN_STOP.has(m[0])) out.add(m[0]);
  for (const m of t.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) { const bg = run.slice(i, i + 2); if (!CJK_STOP.has(bg)) out.add(bg); }
  }
  return out;
}

/**
 * Notes an agent may want to [[link]] or append to instead of creating a near-duplicate.
 * Scores every note by shared title tokens, shared tags, whether the new text mentions the note's
 * title, and recency inside the same notebook; returns the best few with the reasons.
 */
export function findRelated(vault, { title = '', text = '', tags = [], folder = '', excludePath = null, limit = 5, since = 7 } = {}) {
  const qTokens = titleTokens(title);
  const qTags = new Set((tags || []).map((t) => String(t).toLowerCase()));
  const lowText = String(text || '').toLowerCase();
  const lowTitle = String(title || '').toLowerCase().trim();
  const recent = new Date(Date.now() - since * 86400000).toISOString();
  const out = [];
  for (const n of vault.listNotes({ limit: 10000 })) {
    if (n.path === excludePath) continue;
    let score = 0;
    const reasons = [];
    const nTitle = String(n.title || '').toLowerCase();
    const isDay = /^\d{4}-\d{2}-\d{2}$/.test(nTitle);
    if (!isDay) {
      if (lowTitle && nTitle && (nTitle === lowTitle)) { score += 8; reasons.push('标题相同'); }
      else if (lowTitle && nTitle && (nTitle.includes(lowTitle) || lowTitle.includes(nTitle)) && Math.min(nTitle.length, lowTitle.length) >= 4) { score += 5; reasons.push('标题包含'); }
      else {
        const nt = titleTokens(n.title);
        const shared = [...qTokens].filter((tok) => nt.has(tok));
        const latin = shared.filter((tok) => /^[a-z0-9]/.test(tok));
        const cjk = shared.length - latin.length;
        const titleScore = latin.length * 3 + Math.min(4, cjk);
        if (titleScore >= 2) { score += titleScore; reasons.push(`标题词「${shared.slice(0, 3).join('」「')}」`); }
      }
      if (lowText && nTitle.length >= 2 && lowText.includes(nTitle)) { score += 4; reasons.push('正文提到它'); }
    }
    const sharedTags = (n.tags || []).filter((t) => qTags.has(String(t).toLowerCase()));
    if (sharedTags.length) { score += Math.min(4, sharedTags.length * 2); reasons.push(`标签 #${sharedTags.slice(0, 2).join(' #')}`); }
    if (folder && n.folder === folder) {
      if (score > 0) { score += 1; reasons.push('同一笔记本'); }
      else if (String(n.updated || '') >= recent && !isDay) { score += 1; reasons.push('同一笔记本 · 最近'); }
    }
    if (score >= 2) out.push({ path: n.path, title: n.title, folder: n.folder, score, reasons, updated: n.updated });
  }
  out.sort((a, b) => b.score - a.score || String(b.updated || '').localeCompare(String(a.updated || '')));
  return out.slice(0, limit);
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
export async function capture(vault, router, { text, title, notebook, tags = [], source, properties = {}, date } = {}, { auth, log } = {}) {
  if (!text && !title) throw Object.assign(new Error('text is required'), { status: 400 });
  text = String(text || '');
  // `[amount:: 35]` / `weight:: 71.5` typed inside the text count as properties too (Obsidian Dataview syntax)
  const inText = extractFields(text);
  // numbers stated in prose ("花了 42 元", "体重 71.5kg") become properties unless the agent already set that key
  const numbers = extractNumbers(`${title || ''}\n${text}`);
  properties = { ...numbers, ...inText, ...(properties || {}) };
  const titleGiven = !!title;
  title = title || deriveTitle(text);
  tags = Array.from(new Set([...(tags || []), ...hashtags(text)]));

  let folder;
  let mode;
  let classification = { decision: null, strong: false, candidates: [] };
  let ai = null;
  if (notebook) {
    if (!vault.isNotebook(notebook)) throw Object.assign(new Error(`Notebook not found: ${notebook}. Call notebook_list_notebooks to see what exists.`), { status: 404 });
    folder = notebook;
    mode = 'explicit';
    router.learn({ tags, source }, folder, { strong: false });
  } else {
    classification = router.classify({ text, title, tags, source });
    if (classification.decision) { folder = classification.decision; mode = 'auto'; }
  }
  // AI layer (optional): decides when the router could not, and writes a headline / tags / numbers
  const aiOn = auth && aiSettings(auth).enabled;
  const needsTitle = !titleGiven && (text.length > 40 || text.includes('\n')); // Chinese is dense: 40 chars is already a paragraph
  const weakAuto = mode === 'auto' && !classification.strong; // filed on thin evidence: let the model confirm
  if (aiOn && (!folder || weakAuto || needsTitle || (aiSettings(auth).mode === 'always' && mode !== 'explicit'))) {
    ai = await aiEnrich(auth, { text, title: titleGiven ? title : '', tags, notebooks: vault.listNotebooks() }, { log });
    if (ai) {
      if ((!folder || weakAuto) && ai.notebook && ai.confidence >= 0.6) { folder = ai.notebook; mode = 'ai'; }
      else if (weakAuto && !ai.notebook && ai.confidence < 0.4) { folder = null; mode = 'inbox'; } // the model doesn't buy the heuristic either
      else if (folder && mode === 'auto' && aiSettings(auth).mode === 'always' && ai.notebook && ai.confidence >= 0.8 && ai.notebook !== folder) { folder = ai.notebook; mode = 'ai'; }
      if (!titleGiven && ai.title) title = ai.title;
      if (!tags.length && ai.tags.length) tags = ai.tags;
      properties = { ...ai.properties, ...properties };
      if (!folder && ai.notebook) classification.candidates = [{ folder: ai.notebook, title: vault.getNotebookMeta(ai.notebook).title, icon: vault.getNotebookMeta(ai.notebook).icon, kind: vault.getNotebookMeta(ai.notebook).kind, score: Math.round(ai.confidence * 10), reasons: [`AI 判断（${Math.round(ai.confidence * 100)}%）`] }, ...classification.candidates.filter((c) => c.folder !== ai.notebook)].slice(0, 3);
    }
  }
  if (!folder) { folder = ensureInbox(vault); mode = 'inbox'; }

  const meta = vault.getNotebookMeta(folder);
  const common = { source, tags, captured: mode, ...(mode === 'inbox' && classification.candidates.length ? { suggested: classification.candidates.map((c) => c.folder) } : {}) };
  const titleForEntry = titleGiven || (ai && ai.title) ? title : undefined;
  let note;
  let entry = null;
  if (meta.kind === 'journal') {
    const entryProps = Object.fromEntries(Object.entries(properties).filter(([k]) => !(k in inText))); // fields already in the text stay where they are
    const r = vault.appendJournal(folder, { title: titleForEntry, text, source, tags, properties: entryProps, date });
    note = r; entry = r.entry;
  } else {
    note = vault.createNote({ folder, title, body: text, properties: { ...properties, ...common } });
  }

  if (ai?.concepts?.length) {
    try {
      const cur = vault.getNote(note.path);
      const merged = [...new Set([...(Array.isArray(cur.properties?.concepts) ? cur.properties.concepts : []), ...ai.concepts])].slice(0, 20);
      vault.updateNote(note.path, { properties: { concepts: merged, concepts_hash: bodyHash(cur.body), ...(ai.summary && !cur.properties?.summary && meta.kind !== 'journal' ? { summary: ai.summary } : {}) } });
    } catch { /* concepts are a nicety; never fail the capture */ }
  }

  const idx = vault.titleIndex();
  const links = vault.extractLinks(text, idx);
  const related = findRelated(vault, { title, text, tags, folder, excludePath: note.path });

  return {
    path: note.path,
    title: note.title,
    notebook: { folder, title: meta.title, icon: meta.icon, kind: meta.kind },
    mode,
    entry,
    candidates: classification.candidates,
    links,
    related,
    ai: ai ? { notebook: ai.notebook, confidence: ai.confidence, title: ai.title, summary: ai.summary, model: ai.model } : null,
    hint: mode === 'inbox'
      ? '归类拿不准，已放入收件箱。如果你知道它属于哪个笔记本，下次直接传 notebook 参数。'
      : mode === 'auto' ? `已自动归入「${meta.title}」（${classification.candidates[0]?.reasons.join('，') || ''}）。`
      : mode === 'ai' ? `AI 判断归入「${meta.title}」（${Math.round((ai?.confidence || 0) * 100)}%）。` : `已记入「${meta.title}」。`
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

/** 收件箱 → AI 整理：file, retitle and tag every inbox note the AI is confident about. */
export async function organizeInbox(vault, router, auth, { paths, log } = {}) {
  const inbox = vault.inboxFolder();
  if (!inbox) return { done: [], left: [] };
  const notes = vault.listNotes({ folder: inbox, recursive: false, limit: 200 }).filter((n) => !paths || paths.includes(n.path));
  const notebooks = vault.listNotebooks();
  const done = [];
  const left = [];
  for (const n of notes) {
    const note = vault.getNote(n.path);
    const ai = await aiEnrich(auth, { text: note.body || note.title, title: note.title, tags: note.properties.tags || [], notebooks }, { log });
    if (!ai || !ai.notebook || ai.confidence < 0.6) { left.push({ path: n.path, title: n.title, reason: ai ? `不确定（${Math.round(ai.confidence * 100)}%）` : 'AI 不可用' }); continue; }
    const meta = vault.getNotebookMeta(ai.notebook);
    const props = { ...(ai.title && ai.title !== note.title ? { title: ai.title } : {}), ...(!(note.properties.tags || []).length && ai.tags.length ? { tags: ai.tags } : {}), ...ai.properties, captured: 'ai', suggested: null };
    let moved;
    if (meta.kind === 'journal') {
      const r = vault.appendJournal(ai.notebook, { title: ai.title || note.title, text: note.body, source: note.properties.source, tags: ai.tags, properties: ai.properties, date: note.properties.date });
      vault.deleteNote(n.path);
      moved = r;
    } else {
      vault.updateNote(n.path, { properties: props });
      moved = vault.moveNote(n.path, ai.notebook);
    }
    router.learn({ tags: ai.tags, source: note.properties.source }, ai.notebook, { strong: false });
    done.push({ from: n.path, to: moved.path, notebook: { folder: ai.notebook, title: meta.title, icon: meta.icon }, title: ai.title || note.title, confidence: ai.confidence });
  }
  return { done, left };
}
