// Content understanding without a model: a tf-idf profile per notebook built from the notes already in
// it (so routing learns from the vault's own content), and conservative extraction of numbers written
// in prose ("花了 42 元", "体重 71.5kg") into chartable properties.

const CJK_STOP = new Set(['笔记', '记录', '今天', '昨天', '明天', '一下', '一个', '一些', '关于', '什么', '怎么', '可以', '我们', '你们', '他们', '这个', '那个', '这些', '已经', '还是', '以及', '然后', '因为', '所以', '如果', '但是', '没有', '不是', '就是', '需要', '进行', '问题', '时候', '现在', '继续', '开始', '完成', '内容', '东西', '一点', '比较', '非常', '觉得', '感觉', '可能', '应该', '这样', '那样', '自己', '对于', '通过', '以后', '之前', '之后', '的话', '是否', '不过', '而且', '或者', '其他', '所有', '每天', '最近', '建议']);
const LATIN_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'you', 'not', 'but', 'has', 'have', 'into', 'about', 'http', 'https', 'www', 'com']);

/** Text → bag of tokens (latin words ≥3 chars, CJK bigrams) with counts. */
export function tokenCounts(text) {
  const counts = new Map();
  const add = (t) => counts.set(t, (counts.get(t) || 0) + 1);
  const s = String(text || '').toLowerCase().replace(/\[\[[^\]]*\]\]/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const m of s.matchAll(/[a-z][a-z0-9+#.-]{2,}/g)) if (!LATIN_STOP.has(m[0])) add(m[0]);
  for (const m of s.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length; i++) { const bg = run.slice(i, i + 2); if (!CJK_STOP.has(bg)) add(bg); }
  }
  return counts;
}

/** tf-idf centroid per notebook, rebuilt lazily when the vault changes. */
export class NotebookProfiles {
  constructor(vault) { this.vault = vault; this.built = 0; this.signature = ''; this.profiles = new Map(); this.idf = new Map(); }

  refresh() {
    const notebooks = this.vault.listNotebooks().filter((n) => !n.inbox && n.auto !== false);
    const sig = notebooks.map((n) => `${n.folder}:${n.count}`).join('|');
    if (sig === this.signature && Date.now() - this.built < 120000) return;
    const tf = new Map(); // folder → Map(token → count)
    const docCount = new Map(); // folder → notes used
    for (const nb of notebooks) {
      const bag = new Map();
      let docs = 0;
      for (const n of this.vault.listNotes({ folder: nb.folder, recursive: false, limit: 400 })) {
        let body = '';
        try { body = this.vault.getNote(n.path).body.slice(0, 1500); } catch { continue; }
        docs++;
        const parts = tokenCounts(`${n.title} ${n.title} ${(n.tags || []).join(' ')} ${body}`); // title counts double
        for (const [t, c] of parts) bag.set(t, (bag.get(t) || 0) + Math.min(c, 5)); // cap per-note repetition
      }
      // the notebook's own description and keywords count as seed documents
      for (const [t, c] of tokenCounts(`${nb.title} ${nb.description} ${nb.keywords.join(' ')}`)) bag.set(t, (bag.get(t) || 0) + c * 2);
      tf.set(nb.folder, bag);
      docCount.set(nb.folder, docs);
    }
    // idf over notebooks: tokens that appear in every notebook say nothing about where something belongs
    const N = notebooks.length || 1;
    const df = new Map();
    for (const bag of tf.values()) for (const t of bag.keys()) df.set(t, (df.get(t) || 0) + 1);
    this.idf = new Map([...df].map(([t, d]) => [t, Math.log((N + 1) / (d + 0.5))]));
    this.profiles = new Map();
    for (const [folder, bag] of tf) {
      const vec = new Map();
      let norm = 0;
      for (const [t, c] of bag) { const w = (1 + Math.log(c)) * (this.idf.get(t) || 0); if (w > 0) { vec.set(t, w); norm += w * w; } }
      norm = Math.sqrt(norm) || 1;
      for (const [t, w] of vec) vec.set(t, w / norm);
      this.profiles.set(folder, { vec, docs: docCount.get(folder) || 0 });
    }
    this.signature = sig; this.built = Date.now();
  }

  /** Cosine similarity of a piece of text to every notebook: [{ folder, similarity, docs }] sorted desc. */
  similar({ title = '', text = '' } = {}) {
    this.refresh();
    const q = new Map();
    let norm = 0;
    for (const [t, c] of tokenCounts(`${title} ${title} ${text}`)) { const w = (1 + Math.log(c)) * (this.idf.get(t) || 0); if (w > 0) { q.set(t, w); norm += w * w; } }
    norm = Math.sqrt(norm) || 1;
    const out = [];
    for (const [folder, p] of this.profiles) {
      let dot = 0;
      for (const [t, w] of q) { const pw = p.vec.get(t); if (pw) dot += (w / norm) * pw; }
      out.push({ folder, similarity: Math.round(dot * 1000) / 1000, docs: p.docs });
    }
    return out.sort((a, b) => b.similarity - a.similarity);
  }
}

// ---- numbers in prose → properties -----------------------------------------------------------
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?';
const toNum = (m) => Number(String(m[1]).replace(/,/g, '') + (m[2] ? '.' + m[2] : ''));
const PATTERNS = [
  { key: 'amount', re: new RegExp(`[¥￥$]\\s*${NUM}`, 'g') },
  { key: 'amount', re: new RegExp(`${NUM}\\s*(?:元|块钱|块|人民币|rmb|美元|美金|刀|usd|usdt|港币|日元|欧元)(?![a-z])`, 'gi') },
  { key: 'weight', re: new RegExp(`${NUM}\\s*(?:kg|公斤|千克)(?![a-z])`, 'gi') },
  { key: 'weight', re: new RegExp(`${NUM}\\s*斤`, 'g'), scale: 0.5 },
  { key: 'steps', re: new RegExp(`${NUM}\\s*步(?!骤|行|伐)`, 'g') },
  { key: 'sleep_hours', re: new RegExp(`睡(?:了|眠)?[^\\d]{0,6}${NUM}\\s*(?:个?小时|h|hrs?|hours?)(?![a-z])`, 'gi') },
  { key: 'distance_km', re: new RegExp(`${NUM}\\s*(?:km|公里|千米)(?![a-z])`, 'gi') },
  { key: 'pages', re: new RegExp(`${NUM}\\s*页`, 'g') },
  { key: 'calories', re: new RegExp(`${NUM}\\s*(?:kcal|大卡|千卡|卡路里)(?![a-z])`, 'gi') },
  { key: 'minutes', re: new RegExp(`${NUM}\\s*分钟`, 'g') }
];
/** Conservative: a key is extracted only when the text states it exactly once. */
export function extractNumbers(text) {
  const s = String(text || '');
  const found = {};
  const counts = {};
  for (const p of PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      const v = toNum(m) * (p.scale || 1);
      if (!Number.isFinite(v)) continue;
      counts[p.key] = (counts[p.key] || 0) + 1;
      found[p.key] = Math.round(v * 100) / 100;
    }
  }
  for (const k of Object.keys(found)) if (counts[k] !== 1) delete found[k];
  // "睡了 7 小时" would also match minutes/hours patterns elsewhere? keep sleep_hours only when it is the only hours figure
  return found;
}
