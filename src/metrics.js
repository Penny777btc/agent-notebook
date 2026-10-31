// Numeric metrics: agents put facts in `properties` ({ amount: 35, weight: 71.5 }). Journal entries keep
// them as Obsidian/Dataview-style inline fields `[amount:: 35]` inside the entry, pages keep them in
// frontmatter. This module extracts them as time series so the UI can chart them per notebook.
import { localDate } from './vault.js';

// `[key:: value]` anywhere in a line, or `key:: value` on a line of its own (both Dataview syntaxes).
export const INLINE_FIELD_RE = /\[([^\[\]:\n]{1,40}?)::\s*([^\]\n]+?)\]/g;
const LINE_FIELD_RE = /^([A-Za-z一-鿿_][\w一-鿿-]{0,39})::\s+(.+?)\s*$/gm;
// journal entry heading written by Vault.appendJournal: "## 09:12 · title  <small>source</small>"
export const ENTRY_HEADING_RE = /^## (\d{2}:\d{2})(?:\s*·\s*(.*?))?(?:\s*<small>(.*?)<\/small>)?\s*$/;
const NON_METRIC_KEYS = new Set(['title', 'status', 'tags', 'source', 'sources', 'date', 'created', 'updated', 'captured', 'suggested', 'entries', 'url', 'id', 'order', 'icon', 'kind', 'columns', 'keywords', 'inbox']);

/** "35", "¥35", "71.5 kg", "1,200元", "3.5h" → { value, unit } ; anything else → null. */
export function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unit: '' } : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[,，]/g, '');
  const m = s.match(/^([¥￥$€£]?)\s*([-+]?\d+(?:\.\d+)?)\s*([^\d\s.]{0,8})$/u);
  if (!m) return null;
  return { value: Number(m[2]), unit: m[1] || m[3] || '' };
}

/** Inline fields in a piece of text → { key: value } (later occurrences win). */
export function extractFields(text) {
  const out = {};
  for (const m of String(text || '').matchAll(INLINE_FIELD_RE)) out[m[1].trim()] = m[2].trim();
  for (const m of String(text || '').matchAll(LINE_FIELD_RE)) out[m[1].trim()] = m[2].trim();
  return out;
}

/** Scalar properties → one line of inline fields for a journal entry: "[amount:: 35] [category:: 餐饮]". */
export function fieldsLine(props = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
    if (/[\[\]:\n]/.test(k)) continue;
    parts.push(`[${k}:: ${String(v).replace(/[\[\]\n]/g, ' ').trim()}]`);
  }
  return parts.join(' ');
}

/** Split a journal page body into its timestamped entries. */
export function journalEntries(body) {
  const entries = [];
  let cur = null;
  for (const line of String(body || '').split('\n')) {
    const h = line.match(ENTRY_HEADING_RE);
    if (h) { cur = { time: h[1], title: (h[2] || '').trim(), source: (h[3] || '').trim(), lines: [] }; entries.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return entries.map((e) => { const text = e.lines.join('\n').trim(); return { time: e.time, title: e.title, source: e.source, text, fields: extractFields(text) }; });
}

/**
 * All numeric series of a notebook. Journals: one point per entry field (date + time); pages / cards:
 * numeric frontmatter properties and body fields, one point per note at its date.
 * Returns { folder, from, to, keys: [{ key, count, unit, sum, avg, min, max, latest }], series: { key: [points] } }.
 */
export function metrics(vault, folder, { from, to, key: onlyKey } = {}) {
  const meta = vault.getNotebookMeta(folder);
  const series = {};
  const add = (key, raw, point) => {
    if (NON_METRIC_KEYS.has(key) || (onlyKey && key !== onlyKey)) return;
    const n = parseNumber(raw);
    if (!n) return;
    if (point.date < (from || '') || (to && point.date > to)) return;
    (series[key] = series[key] || []).push({ ...point, value: n.value, unit: n.unit });
  };
  for (const n of vault.listNotes({ folder, recursive: false, limit: 10000 })) {
    const note = vault.getNote(n.path);
    const date = n.date || localDate(new Date(note.mtime));
    const base = { date, path: note.path };
    if (meta.kind === 'journal') {
      const seen = new Set();
      for (const e of journalEntries(note.body)) {
        for (const [k, v] of Object.entries(e.fields)) { seen.add(k); add(k, v, { ...base, time: e.time, title: e.title || note.title, source: e.source }); }
      }
      // legacy day pages that kept the number in frontmatter
      for (const [k, v] of Object.entries(note.properties)) if (!seen.has(k)) add(k, v, { ...base, time: '', title: note.title, source: note.properties.source });
    } else {
      const fields = { ...extractFields(note.body), ...note.properties };
      for (const [k, v] of Object.entries(fields)) add(k, v, { ...base, time: (note.properties.created || '').slice(11, 16), title: note.title, source: note.properties.source });
    }
  }
  const keys = [];
  for (const [key, pts] of Object.entries(series)) {
    pts.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const values = pts.map((p) => p.value);
    const unitCounts = {};
    for (const p of pts) if (p.unit) unitCounts[p.unit] = (unitCounts[p.unit] || 0) + 1;
    const unit = Object.entries(unitCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const sum = values.reduce((a, b) => a + b, 0);
    keys.push({ key, count: pts.length, unit, sum: round(sum), avg: round(sum / pts.length), min: Math.min(...values), max: Math.max(...values), latest: pts[pts.length - 1].value, first: pts[0].date, last: pts[pts.length - 1].date });
  }
  keys.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { folder, title: meta.title, kind: meta.kind, from: from || null, to: to || null, keys, series };
}

const round = (x) => Math.round(x * 1000) / 1000;
