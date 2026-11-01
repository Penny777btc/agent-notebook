// Optional AI layer: ask Claude to file a capture (notebook + confidence), give it a one-line title,
// tags and numeric properties. Off until an API key is set in 设置 → 智能归类. Every failure falls
// back to the keyword / similarity router, so the notebook never depends on the network.
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（默认，最准）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最便宜，约为 Opus 的 1/40）' }
];
const DEFAULT_MODEL = 'claude-opus-5-5';

export function aiSettings(auth) {
  const c = auth.config.ai || {};
  return { enabled: !!c.enabled && !!c.apiKey, configured: !!c.apiKey, keyPrefix: c.apiKey ? c.apiKey.slice(0, 10) + '…' : null, model: c.model || DEFAULT_MODEL, baseUrl: c.baseUrl || null, mode: c.mode || 'unsure' };
}

function client(auth) {
  const c = auth.config.ai || {};
  if (!c.apiKey) throw new Error('AI 未配置 API key');
  return new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined, timeout: 20000, maxRetries: 1 });
}

function systemPrompt(notebooks) {
  const list = notebooks.filter((n) => !n.inbox).map((n) => `- folder: ${n.folder} | 名称: ${n.title} | 形态: ${n.kind} | 说明: ${n.description || '—'} | 关键词: ${n.keywords.join('、') || '—'}`).join('\n');
  return `你是一个私人笔记本的归档助手。笔记本按领域分成若干本，agent 记录的内容要归到最合适的一本里。

现有笔记本：
${list}

对给定的一条记录，只输出一个 JSON 对象（不要 Markdown 代码块，不要解释），字段：
{"notebook": "folder 或 null", "confidence": 0 到 1 的小数, "title": "不超过 30 个字的一句话标题，陈述结论或事实，不要以“关于”开头", "tags": ["最多 4 个短标签"], "properties": {"仅数字事实，如 amount/weight/steps/sleep_hours/pages": 数字}, "summary": "不超过 40 个字的摘要，内容本身已经很短时留空"}

规则：
- notebook 只填上面列表里的 folder；拿不准（confidence < 0.6）就填 null，宁可进收件箱也不要乱归。
- 日志类笔记本（健康、财务）收按天发生的事实；看板类收待跟进的线索；页面集收独立成篇的想法和阅读。
- title 用记录本身的语言（中文为主），不要照抄第一句，要概括。
- properties 只放确定的数字，键名用英文小写下划线，同类数字始终用同一个键。`;
}

/** Classify + title + tags + numbers for one capture. Returns null when AI is off or fails. */
export async function enrich(auth, { text, title, tags = [], notebooks }, { log } = {}) {
  const s = aiSettings(auth);
  if (!s.enabled) return null;
  const started = Date.now();
  try {
    const c = client(auth);
    const body = `记录内容：\n${String(text || '').slice(0, 6000)}${title ? `\n\n已有标题：${title}` : ''}${tags.length ? `\n已有标签：${tags.join('、')}` : ''}`;
    const req = { model: s.model, max_tokens: 800, system: systemPrompt(notebooks), messages: [{ role: 'user', content: body }], output_config: { effort: 'low' } };
    let res;
    if (/opus-5-5|sonnet-5-5|fable/.test(s.model)) res = await c.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    else res = await c.messages.create(req);
    if (res.stop_reason === 'refusal') { log?.({ event: 'ai:refusal', category: res.stop_details?.category }); return null; }
    const textOut = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const parsed = parseJson(textOut);
    if (!parsed) { log?.({ event: 'ai:unparsable', sample: textOut.slice(0, 120) }); return null; }
    const folders = new Set(notebooks.filter((n) => !n.inbox).map((n) => n.folder));
    const out = {
      notebook: folders.has(parsed.notebook) ? parsed.notebook : null,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4) : [],
      properties: Object.fromEntries(Object.entries(parsed.properties || {}).filter(([k, v]) => /^[a-z][a-z0-9_]{0,30}$/.test(k) && typeof v === 'number' && Number.isFinite(v))),
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 80) : '',
      model: res.model || s.model,
      ms: Date.now() - started,
      usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : undefined
    };
    log?.({ event: 'ai:enrich', model: out.model, ms: out.ms, notebook: out.notebook, confidence: out.confidence, usage: out.usage });
    return out;
  } catch (err) {
    log?.({ event: 'ai:error', error: err.message, status: err.status });
    return null;
  }
}

/** Settings page "测试连接". */
export async function testConnection(auth) {
  const s = aiSettings(auth);
  const started = Date.now();
  const c = client(auth);
  const res = await c.messages.create({ model: s.model, max_tokens: 20, messages: [{ role: 'user', content: '回复“ok”两个字母即可。' }], output_config: { effort: 'low' } });
  return { ok: true, model: res.model, ms: Date.now() - started, reply: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 40) };
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
