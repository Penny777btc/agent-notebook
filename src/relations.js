// Relations between notes that nobody typed: content similarity (tf-idf over title + body), shared
// tags, shared entities (tickers, @handles, contract hashes) and shared AI-extracted concepts
// (frontmatter `concepts`, filled by extractConcepts / the capture flow). Feeds the 关系图's dashed
// "related" edges next to the solid [[link]] edges.
import crypto from 'node:crypto';
import { tokenCounts } from './content.js';
import { complete, aiSettings, isChatter, NOT_A_TASK } from './enrich.js';

const ENTITY_RE = /\$?[A-Z][A-Z0-9]{2,9}\b|@[A-Za-z0-9_]{2,}|\b0x[a-fA-F0-9]{6,}/g;
const ENTITY_STOP = new Set(['HTTP', 'HTTPS', 'JSON', 'API', 'URL', 'MCP', 'GET', 'POST', 'PATCH', 'DELETE', 'TODO', 'README', 'UTC', 'JST', 'AM', 'PM', 'OK', 'AI', 'LLM', 'PDF', 'CSV', 'PNG', 'JPG', 'HTML', 'CSS', 'RSS', 'HN', 'HF', 'IPO', 'CEO', 'CTO', 'USD', 'CNY', 'JPY', 'USDT', 'USDC', 'ETH', 'BTC', 'BNB', 'SOL']);

export function bodyHash(text) { return crypto.createHash('sha1').update(String(text || '').slice(0, 6000)).digest('hex').slice(0, 12); }

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function entities(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(ENTITY_RE)) {
    let e = m[0].replace(/^\$/, '');
    if (e.startsWith('0x')) e = e.slice(0, 10).toLowerCase();
    if (ENTITY_STOP.has(e.toUpperCase())) continue;
    out.add(e);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return { j: 0, shared: [] };
  const shared = [...a].filter((x) => b.has(x));
  return { j: shared.length / (a.size + b.size - shared.length), shared };
}

let cache = { sig: '', at: 0, result: null };

/**
 * Semantic edges for the whole vault. Each edge: { source, target, weight 0..1, reasons:
 * { similarity (0..100), concepts: [...], tags: [...], entities: [...] } }. Cached for a minute per vault signature.
 */
export function relatedEdges(vault, { maxPerNode = 6, minScore = 0.18 } = {}) {
  const notes = vault.listNotes({ limit: 10000 });
  const sig = notes.length + ':' + notes.reduce((m, n) => (n.updated > m ? n.updated : m), '') + ':' + notes.filter((n) => n.props?.concepts || n.concepts).length;
  if (cache.result && cache.sig === sig && Date.now() - cache.at < 60000) return cache.result;

  const docs = [];
  const display = new Map(); // normalized concept → original spelling
  for (const n of notes) {
    let full; try { full = vault.getNote(n.path); } catch { continue; }
    const body = String(full.body || '');
    const p = full.properties || {};
    const conceptList = (Array.isArray(p.concepts) ? p.concepts : []).map((c) => String(c).trim()).filter(Boolean);
    const concepts = new Set(conceptList.map(norm));
    for (const c of conceptList) if (!display.has(norm(c))) display.set(norm(c), c); // keep the first-seen spelling for labels
    const tags = new Set((Array.isArray(p.tags) ? p.tags : []).map(norm).filter(Boolean));
    const tf = tokenCounts(`${full.title} ${full.title} ${body.slice(0, 4000)}`);
    docs.push({ path: n.path, title: full.title, tf, concepts, tags, ents: entities(`${full.title} ${body.slice(0, 6000)}`), norm: 0, vec: null });
  }
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const index = new Map(); // token → [[docIdx, weight]]
  docs.forEach((d, i) => {
    const vec = new Map();
    let sum = 0;
    for (const [t, c] of d.tf) {
      if ((df.get(t) || 0) > Math.max(2, N * 0.5)) continue; // too common to mean anything
      const w = (1 + Math.log(c)) * idf(t); vec.set(t, w); sum += w * w;
    }
    d.norm = Math.sqrt(sum) || 1; d.vec = vec;
    for (const [t, w] of vec) (index.get(t) || index.set(t, []).get(t)).push([i, w]);
  });
  // cosine via the inverted index
  const cos = docs.map(() => new Map());
  for (const postings of index.values()) {
    if (postings.length < 2 || postings.length > 60) continue;
    for (let a = 0; a < postings.length; a++) for (let b = a + 1; b < postings.length; b++) {
      const [i, wi] = postings[a], [j, wj] = postings[b];
      const key = i < j ? j : i, row = cos[i < j ? i : j];
      row.set(key, (row.get(key) || 0) + wi * wj);
    }
  }
  const candidates = []; // per pair
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = docs[i], b = docs[j];
      const sim = (cos[i].get(j) || 0) / (a.norm * b.norm);
      const c = jaccard(a.concepts, b.concepts), t = jaccard(a.tags, b.tags), e = jaccard(a.ents, b.ents);
      if (sim < 0.12 && !c.shared.length && !e.shared.length) continue;
      const score = Math.min(1, 0.5 * sim + 0.3 * Math.min(1, c.j * 1.5 + c.shared.length * 0.1) + 0.1 * t.j + 0.1 * Math.min(1, e.shared.length * 0.5));
      if (score < minScore) continue;
      candidates.push({ i, j, score, reasons: { similarity: Math.round(sim * 100), concepts: c.shared.slice(0, 4).map((x) => display.get(x) || x), tags: t.shared.slice(0, 3), entities: e.shared.slice(0, 3) } });
    }
  }
  // keep each node's strongest few
  const perNode = new Map();
  for (const cnd of candidates) { for (const k of [cnd.i, cnd.j]) (perNode.get(k) || perNode.set(k, []).get(k)).push(cnd); }
  const keep = new Set();
  for (const list of perNode.values()) { list.sort((x, y) => y.score - x.score); for (const cnd of list.slice(0, maxPerNode)) keep.add(cnd); }
  const edges = [...keep].sort((x, y) => y.score - x.score).map((cnd) => ({ source: docs[cnd.i].path, target: docs[cnd.j].path, weight: Math.round(cnd.score * 100) / 100, reasons: cnd.reasons }));
  const concepts = Object.fromEntries(docs.filter((d) => d.concepts.size).map((d) => [d.path, [...d.concepts].map((x) => display.get(x) || x)]));
  const result = { edges, coverage: { withConcepts: Object.keys(concepts).length, total: N }, concepts };
  cache = { sig, at: Date.now(), result };
  return result;
}

export function invalidateRelations() { cache = { sig: '', at: 0, result: null }; }

const CONCEPT_SYSTEM = `你是私人笔记本的知识图谱助手。读一条笔记，提炼 3 到 8 个「核心概念」，用来把谈同一件事的笔记连起来：
- 概念是具体的实体（项目、代币、产品、人物、机构、地点）、主题或方法名；用原文里的叫法（英文代号保留原样，如 ACARD、Claude Code；中文用常用简称），每个不超过 12 个字。
- 不要泛词（方法、总结、记录、问题、今天、测试、笔记、内容），不要重复，不要把日期和数字当概念。
- 再给一句不超过 40 个字的摘要，陈述事实或结论。
${NOT_A_TASK}
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：{"concepts": ["…"], "summary": "…"}`;

/** Ask the model for a note's concepts + one-line summary. Returns null when AI is off or fails. */
export async function extractConcepts(auth, { title, text }, { log } = {}) {
  if (!aiSettings(auth).enabled) return null;
  const started = Date.now();
  try {
    const res = await complete(auth, { system: CONCEPT_SYSTEM, user: `标题：${title || ''}\n\n<record>\n${String(text || '').slice(0, 5000)}\n</record>`, maxTokens: 400, schema: { type: 'object', properties: { concepts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['concepts', 'summary'] } });
    const m = String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed || !Array.isArray(parsed.concepts)) { log?.({ event: 'ai:concepts:unparsable', sample: String(res.text || '').slice(0, 120) }); return null; }
    const concepts = [...new Set(parsed.concepts.map((c) => String(c).trim()).filter((c) => c && c.length <= 24))].slice(0, 8);
    const out = { concepts, summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 80) : '', model: res.model, ms: Date.now() - started };
    // the model described its own actions instead of the note: keep nothing, the note stays pending for the next pass
    if (isChatter(out.summary, `${title}\n${text}`)) { log?.({ event: 'ai:chatter', stage: 'concepts', sample: out.summary.slice(0, 80) }); return null; }
    log?.({ event: 'ai:concepts', model: res.model, ms: out.ms, n: concepts.length });
    return out;
  } catch (err) { log?.({ event: 'ai:error', stage: 'concepts', error: err.message }); return null; }
}

/** Notes whose concepts are missing or stale (body changed since). */
export function notesNeedingConcepts(vault) {
  const out = [];
  // generated pages (weekly reviews) are about everything at once: concepts on them would link the whole graph together
  const generated = new Set(vault.listNotebooks().filter((n) => n.auto === false).map((n) => n.folder));
  for (const n of vault.listNotes({ limit: 10000 })) {
    if (generated.has(n.folder)) continue;
    let full; try { full = vault.getNote(n.path); } catch { continue; }
    const p = full.properties || {};
    const body = String(full.body || '');
    if (body.trim().length < 20) continue;
    if (Array.isArray(p.concepts) && p.concepts.length && p.concepts_hash === bodyHash(body)) continue;
    out.push({ path: n.path, title: full.title, body, updated: n.updated });
  }
  return out.sort((a, b) => (b.updated > a.updated ? 1 : -1));
}

/** Process up to `limit` notes (newest first). Returns { done: [{path, concepts}], failed: [...], left }. */
export async function conceptsBatch(vault, auth, { limit = 5, paths, log } = {}) {
  let todo = notesNeedingConcepts(vault);
  if (paths?.length) { const want = new Set(paths); todo = todo.filter((n) => want.has(n.path)); }
  const batch = todo.slice(0, limit);
  const done = [], failed = [];
  for (const n of batch) {
    const r = await extractConcepts(auth, { title: n.title, text: n.body }, { log });
    if (!r) { failed.push({ path: n.path }); continue; }
    const props = { concepts: r.concepts, concepts_hash: bodyHash(n.body) };
    const current = vault.getNote(n.path).properties || {};
    if (r.summary && !current.summary) props.summary = r.summary;
    vault.updateNote(n.path, { properties: props });
    done.push({ path: n.path, concepts: r.concepts });
  }
  invalidateRelations();
  return { done, failed, left: Math.max(0, todo.length - batch.length), total: todo.length };
}
