// Optional AI layer: ask Claude to file a capture (notebook + confidence), give it a one-line title,
// tags and numeric properties. Off until an API key is set in 设置 → 智能归类. Every failure falls
// back to the keyword / similarity router, so the notebook never depends on the network.
import Anthropic from '@anthropic-ai/sdk';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（默认，最准）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最便宜，约为 Opus 的 1/40）' }
];
const DEFAULT_MODEL = 'claude-opus-5-5';

// Three ways to reach a model: an Anthropic API key, or the Claude Code / Codex CLI already logged in
// on this Mac (no key, billed to that subscription). The CLIs run headless: `claude -p` / `codex exec`.
export const AI_PROVIDERS = [
  { id: 'claude-cli', label: '本机 Claude Code（用已登录的账号，不用 key）', cli: 'claude' },
  { id: 'codex-cli', label: '本机 Codex CLI（用已登录的 ChatGPT 账号）', cli: 'codex' },
  { id: 'api', label: 'Anthropic API key' }
];

const CLI_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), path.join(os.homedir(), 'bin')];
const cliCache = new Map(); // name → { at, info }

/** Find a CLI on PATH or in the usual install dirs, with its version. Cached for 10 minutes. */
export function detectCli(name) {
  const hit = cliCache.get(name);
  if (hit && Date.now() - hit.at < 600000) return hit.info;
  let info = null;
  const dirs = [...(process.env.PATH || '').split(':'), ...CLI_DIRS].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; }
    let version = null;
    try { version = execFileSync(p, ['--version'], { env: cliEnv(), timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].slice(0, 60); } catch { /* still usable */ }
    info = { path: p, version };
    break;
  }
  cliCache.set(name, { at: Date.now(), info });
  return info;
}

/** The CLIs must not inherit this process's Claude / Anthropic / Codex variables (a nested Claude Code
 *  session or a host-provided auth token would override the user's own login). */
function cliEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC_|CODEX_|OPENAI_)/.test(k)) env[k] = v;
  env.PATH = [...new Set([...(env.PATH || '').split(':'), ...CLI_DIRS])].filter(Boolean).join(':');
  return env;
}

export function aiSettings(auth) {
  const c = auth.config.ai || {};
  const provider = AI_PROVIDERS.some((p) => p.id === c.provider) ? c.provider : (c.apiKey ? 'api' : 'claude-cli');
  const cli = { claude: detectCli('claude'), codex: detectCli('codex') };
  const configured = provider === 'api' ? !!c.apiKey : provider === 'claude-cli' ? !!cli.claude : !!cli.codex;
  return { provider, enabled: !!c.enabled && configured, configured, cli, keyPrefix: c.apiKey ? c.apiKey.slice(0, 10) + '…' : null, hasKey: !!c.apiKey, model: c.model || DEFAULT_MODEL, baseUrl: c.baseUrl || null, mode: c.mode || 'unsure' };
}

function client(auth) {
  const c = auth.config.ai || {};
  if (!c.apiKey) throw new Error('AI 未配置 API key');
  return new Anthropic({ apiKey: c.apiKey, baseURL: c.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined, timeout: 20000, maxRetries: 1 });
}

function run(bin, args, { input, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env: cliEnv(), cwd: os.tmpdir(), timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`${path.basename(bin)} 调用失败：${(stderr || err.message).trim().split('\n').pop().slice(0, 200)}`));
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input ?? ''); // CLIs read stdin when it is not a TTY: always close it
  });
}

/** One completion through whichever provider is configured → { text, model, usage, refusal? }. */
export async function complete(auth, { system, user, maxTokens = 800 }) {
  const s = aiSettings(auth);
  if (s.provider === 'claude-cli') {
    if (!s.cli.claude) throw new Error('本机没有找到 claude 命令：先安装 Claude Code 并登录（终端运行 claude）');
    const { stdout } = await run(s.cli.claude.path, ['-p', '--output-format', 'json', '--model', s.model, '--no-session-persistence', '--setting-sources', '', '--tools', '', '--system-prompt', system], { input: user, timeout: 90000 });
    const json = parseJson(stdout.slice(stdout.indexOf('{')));
    if (!json) throw new Error('claude 输出无法解析：' + stdout.slice(0, 160));
    if (json.is_error || json.subtype !== 'success') throw new Error('claude 返回错误：' + String(json.result || json.subtype || json.terminal_reason).slice(0, 200));
    const model = Object.keys(json.modelUsage || {})[0] || s.model;
    return { text: String(json.result || ''), model, usage: json.usage ? { input: json.usage.input_tokens, output: json.usage.output_tokens } : undefined, cost: json.total_cost_usd };
  }
  if (s.provider === 'codex-cli') {
    if (!s.cli.codex) throw new Error('本机没有找到 codex 命令：先安装 Codex CLI 并登录（终端运行 codex）');
    const { stdout } = await run(s.cli.codex.path, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', os.tmpdir(), `${system}\n\n${user}`], { timeout: 90000 });
    let text = '', usage, error;
    for (const line of stdout.split('\n')) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text || text;
      else if (ev.type === 'turn.completed') usage = ev.usage ? { input: ev.usage.input_tokens, output: ev.usage.output_tokens } : undefined;
      else if (ev.type === 'error' || ev.type === 'turn.failed') error = ev.message || ev.error?.message;
    }
    if (!text) throw new Error('codex 返回错误：' + String(error || stdout.slice(-200)).slice(0, 200));
    return { text, model: 'codex', usage };
  }
  const c = client(auth);
  const req = { model: s.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { effort: 'low' } };
  let res;
  if (/opus-5-5|sonnet-5-5|fable/.test(s.model)) res = await c.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  else res = await c.messages.create(req);
  if (res.stop_reason === 'refusal') return { text: '', model: res.model, refusal: res.stop_details?.category || true };
  return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), model: res.model || s.model, usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : undefined };
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
    const body = `记录内容：\n${String(text || '').slice(0, 6000)}${title ? `\n\n已有标题：${title}` : ''}${tags.length ? `\n已有标签：${tags.join('、')}` : ''}`;
    const res = await complete(auth, { system: systemPrompt(notebooks), user: body, maxTokens: 800 });
    if (res.refusal) { log?.({ event: 'ai:refusal', category: res.refusal }); return null; }
    const textOut = res.text;
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
      usage: res.usage
    };
    log?.({ event: 'ai:enrich', provider: s.provider, model: out.model, ms: out.ms, notebook: out.notebook, confidence: out.confidence, usage: out.usage });
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
  const res = await complete(auth, { system: '你是连通性测试。', user: '回复“ok”两个字母即可。', maxTokens: 20 });
  return { ok: true, provider: s.provider, model: res.model, ms: Date.now() - started, reply: res.text.slice(0, 40) };
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
