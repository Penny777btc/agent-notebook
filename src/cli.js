#!/usr/bin/env node
// agent-notebook CLI: serve the web UI, run the MCP stdio server, manage tokens and backups.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Vault } from './vault.js';
import { Auth } from './auth.js';
import { Backup } from './backup.js';
import { buildMcpServer } from './mcp.js';
import { createApp } from './web-server.js';
import { listAgents, connectAgent } from './agents.js';
import { reviewFacts, writeReview, startReviewSchedule, weekOf, addDays } from './review.js';
import { localDate } from './vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  } else positional.push(a);
}
const [cmd, sub, ...rest] = positional;

function resolveVault() {
  const candidate = flags.vault || process.env.AGENT_NOTEBOOK_VAULT || (fs.existsSync(path.join(here, '..', 'vault')) ? path.join(here, '..', 'vault') : path.join(os.homedir(), 'AgentNotebook'));
  return path.resolve(candidate);
}

const HELP = `agent-notebook — local notebook for you and your AI agents

Usage:
  agent-notebook serve   [--vault DIR] [--port 3777] [--host 127.0.0.1]   start web UI + REST + MCP(HTTP) at /mcp
  agent-notebook mcp     [--vault DIR] [--token nb_...]                      MCP over stdio (token via --token or $AGENT_NOTEBOOK_TOKEN)
  agent-notebook token create NAME [--scopes read,write] [--folders "Alpha看板,灵感"]
  agent-notebook token list | revoke NAME
  agent-notebook agents                                                      detect local agents (Claude Code, Codex, Grok, Cursor…) and their status
  agent-notebook connect AGENT_ID [--scopes read,write] [--folders ...] [--no-skill]   one-shot: create token + write that agent's MCP config
  agent-notebook backup init [REMOTE_URL] | now | status
  agent-notebook review  [--last | --from YYYY-MM-DD] [--facts]              write this week's review page (--last: the week before; --facts: print the numbers only)
  agent-notebook init    [--vault DIR]                                       create an empty vault with example boards

Vault directory: --vault, $AGENT_NOTEBOOK_VAULT, ./vault (if exists), else ~/AgentNotebook`;

async function main() {
  const vaultDir = resolveVault();
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  const vault = new Vault(vaultDir);
  const auth = new Auth(vaultDir);
  const backup = new Backup(vaultDir, auth, (m) => console.error(`[agent-notebook] ${m}`));

  switch (cmd) {
    case 'init': {
      seedVault(vault);
      console.log(`Vault ready at ${vaultDir}`);
      return;
    }
    case 'serve': {
      const port = Number(flags.port || process.env.PORT || auth.config.port || 3777);
      const host = flags.host || auth.config.host || '127.0.0.1';
      const app = createApp({ vault, auth, backup });
      backup.start();
      // the weekly review of a finished week is written on its own (config.json: "review": { "auto": false } turns that off)
      startReviewSchedule(vault, auth, {
        log: (e) => auth.audit({ name: 'ai' }, e.event, '', e),
        onWritten: (r) => { auth.audit({ name: 'system' }, 'review', r.path, { via: 'schedule', from: r.period.from, to: r.period.through, narrative: r.narrative, ms: r.ms }); console.log(`[agent-notebook] weekly review written: ${r.path}`); }
      });
      app.listen(port, host, () => {
        console.log(`agent-notebook  vault=${vaultDir}`);
        console.log(`  web UI : http://${host}:${port}/`);
        console.log(`  MCP    : http://${host}:${port}/mcp  (Authorization: Bearer <token>)`);
        if (!auth.config.tokens.length) console.log(`  no agent tokens yet → agent-notebook token create <name> --scopes read,write`);
      });
      return;
    }
    case 'mcp': {
      const remote = flags.url || process.env.AGENT_NOTEBOOK_URL;
      if (remote) { // the notebook lives on another machine: bridge stdio to its HTTP MCP endpoint
        const { runRemoteProxy } = await import('./remote-mcp.js');
        const t = flags.token || process.env.AGENT_NOTEBOOK_TOKEN;
        if (!t) { console.error('agent-notebook mcp: AGENT_NOTEBOOK_TOKEN is required with AGENT_NOTEBOOK_URL'); process.exit(1); }
        await runRemoteProxy({ url: remote, token: t });
        return;
      }
      const token = flags.token || process.env.AGENT_NOTEBOOK_TOKEN;
      const principal = auth.authenticate(token);
      if (!principal) {
        console.error('agent-notebook mcp: missing or invalid token. Create one with: agent-notebook token create <name> --scopes read,write');
        process.exit(1);
      }
      const server = buildMcpServer({ vault, auth, principal });
      await server.connect(new StdioServerTransport());
      console.error(`[agent-notebook] MCP stdio ready as "${principal.name}" (${principal.scopes.join(',')}) vault=${vaultDir}`);
      return;
    }
    case 'token': {
      if (sub === 'create') {
        const name = rest[0];
        const scopes = String(flags.scopes || 'read').split(',').map((s) => s.trim()).filter(Boolean);
        const folders = flags.folders ? String(flags.folders).split(',').map((s) => s.trim()).filter(Boolean) : ['*'];
        const t = auth.createToken(name, { scopes, folders });
        console.log(`Token for "${t.name}" (scopes: ${t.scopes.join(',')}; folders: ${t.folders.join(',')}) — shown once, store it now:\n\n  ${t.token}\n`);
        console.log(`Claude Code:  claude mcp add agent-notebook -e AGENT_NOTEBOOK_TOKEN=${t.token} -e AGENT_NOTEBOOK_VAULT="${vaultDir}" -- node "${path.join(here, 'cli.js')}" mcp`);
        console.log(`HTTP clients: POST http://127.0.0.1:${auth.config.port}/mcp  with  Authorization: Bearer ${t.token}`);
        return;
      }
      if (sub === 'list') return console.table(auth.listTokens());
      if (sub === 'revoke') { auth.revokeToken(rest[0]); return console.log(`revoked ${rest[0]}`); }
      return console.log(HELP);
    }
    case 'agents': {
      const { agents } = listAgents({ vault: vaultDir, port: auth.config.port });
      console.table(agents.map((a) => ({ id: a.id, name: a.name, detected: a.detected ? 'yes' : '', connected: a.connected ? 'yes' : '', mode: a.canWrite ? 'auto' : 'manual', config: (a.configPath || '').replace(os.homedir(), '~') })));
      console.log(`Connect one with: agent-notebook connect <id>`);
      return;
    }
    case 'connect': {
      if (flags.remote) { // re-point this machine's agents at a notebook server (keeps each agent's existing token)
        const { repointAgents } = await import('./agents.js');
        const { probeRemote } = await import('./remote-mcp.js');
        const rows = repointAgents({ url: String(flags.remote), only: sub });
        if (!rows.length) return console.log('没有找到已接入的 agent 配置');
        for (const r of rows) {
          const probe = r.token ? await probeRemote(String(flags.remote), r.token) : { ok: false, error: '配置里没有 token' };
          console.log(`${probe.ok ? '✓' : '✗'} ${r.agent.padEnd(18)} ${r.configPath}${probe.ok ? `  (token ${probe.name})` : `  ${probe.error}`}`);
        }
        console.log(`\n各 agent 重启后生效；以后它们的读写都走 ${flags.remote}`);
        return;
      }
      const scopes = String(flags.scopes || 'read,write').split(',').map((s) => s.trim()).filter(Boolean);
      const folders = flags.folders ? String(flags.folders).split(',').map((s) => s.trim()).filter(Boolean) : ['*'];
      const r = connectAgent({ id: sub, auth, vault: vaultDir, scopes, folders, skill: !flags['no-skill'] });
      console.log(`Connected ${r.agent}: token "${r.tokenName}" (${r.scopes.join(',')}; ${r.folders.join(',')})`);
      console.log(`  config : ${r.configPath}${r.backupPath ? `  (backup: ${r.backupPath})` : ''}`);
      if (r.skillPath) console.log(`  skill  : ${r.skillPath}`);
      if (r.restart) console.log(`  next   : ${r.restart}`);
      return;
    }
    case 'review': {
      const thisWeek = weekOf(localDate(new Date()));
      const period = flags.last ? weekOf(addDays(thisWeek.from, -1)) : flags.from ? { from: String(flags.from), to: flags.to ? String(flags.to) : undefined } : thisWeek;
      if (flags.facts) return console.log(JSON.stringify(reviewFacts(vault, auth, period), null, 2));
      const { facts, ...r } = await writeReview(vault, auth, { ...period, log: (e) => auth.audit({ name: 'ai' }, e.event, '', e) });
      auth.audit({ name: 'system' }, 'review', r.path, { via: 'cli', from: r.period.from, to: r.period.through, narrative: r.narrative, ms: r.ms });
      console.log(`${r.created ? 'written' : 'updated'}: ${r.path}  (${r.narrative ? `narrative by ${r.model}` : `data only${r.error ? ': ' + r.error : ''}`}, ${facts.totals.added} items, ${r.ms} ms)`);
      return;
    }
    case 'backup': {
      if (sub === 'init') console.log(await backup.init(rest[0]));
      else if (sub === 'now') console.log(await backup.run('manual'));
      else console.log(await backup.status());
      return;
    }
    default:
      console.log(HELP);
      process.exit(1);
  }
}

export const DEFAULT_NOTEBOOKS = [
  { folder: '收件箱', title: '收件箱', icon: '📥', kind: 'pages', inbox: true, order: 0, description: '自动归类拿不准的内容先放这里。点一下分配到正确的笔记本，系统会记住这类内容该去哪。' },
  { folder: '健康', title: '健康', icon: '💪', kind: 'journal', order: 10, keywords: ['健康', '睡眠', '运动', '体重', '饮食', '跑步', '健身', '血压', '心率', '步数', '锻炼', '体检', 'sleep', 'workout', 'health'], description: '身体与习惯：睡眠、运动、饮食、体重、体检、心情。按天记录。' },
  { folder: '阅读', title: '阅读', icon: '📚', kind: 'pages', order: 20, keywords: ['阅读', '读书', '书', '文章', '论文', '笔记', '摘录', '作者', '章节', 'book', 'article', 'paper', 'reading'], description: '读过的书、文章、论文：摘录、感想、要点。一篇内容一页。' },
  { folder: '思维', title: '思维', icon: '🧠', kind: 'pages', order: 30, keywords: ['思考', '想法', '灵感', '洞察', '框架', '模型', '原则', '反思', '复盘', '决策', 'idea', 'insight', 'thinking', 'framework'], description: '想法、洞察、思维模型、反思与复盘。一个想法一页，用 [[链接]] 串起来。' },
  { folder: '财务', title: '财务', icon: '💰', kind: 'journal', order: 40, keywords: ['财务', '花费', '支出', '收入', '预算', '账单', '投资', '仓位', '资产', '理财', '记账', '元', '美元', 'usdt', 'budget', 'expense', 'income', 'portfolio'], description: '收支、预算、资产与仓位变动。按天记录，金额放在 amount 属性里。' },
  { folder: 'Alpha看板', title: 'Alpha 看板', icon: '📈', kind: 'board', order: 50, columns: ['新发现', '关注中', '已验证', '归档'], keywords: ['alpha', '链上', '代币', '交易量', '资金费率', '永续', 'defi', 'meme', '空投', '协议', '叙事', 'ticker', 'onchain', 'token'], description: 'Agent 每天收集的 Alpha 线索：链上、代币、协议、叙事。按日期筛选可以看当天的看板。' },
  { folder: '选题会', title: '选题会', icon: '🎬', kind: 'board', order: 60, columns: ['灵感池', '讨论中', '已定稿', '已发布'], keywords: ['选题', '视频', '文章', '标题', '切入点', '脚本', '内容', '发布', '推文', 'topic', 'video', 'script', 'content'], description: '内容选题流水线：agent 投稿到灵感池，我在这里挑选和定稿。' }
];

/** Create the default notebooks; upgrade legacy boards in place (adds kind/keywords, keeps notes). */
export function seedVault(vault) {
  for (const nb of DEFAULT_NOTEBOOKS) {
    if (vault.isNotebook(nb.folder)) {
      const cur = vault.getNotebookMeta(nb.folder);
      if (!cur.keywords.length) vault.updateNotebook(nb.folder, { keywords: nb.keywords || [], kind: cur.kind, order: nb.order, inbox: nb.inbox });
    } else {
      vault.createNotebook(nb);
    }
  }
  fs.mkdirSync(vault.resolve('灵感'), { recursive: true });
  if (!fs.existsSync(vault.resolve('欢迎.md'))) {
    vault.createNote({ folder: '', title: '欢迎', body: WELCOME, properties: { source: 'owner', tags: ['指南'] } });
  }
}

const WELCOME = `# 欢迎使用 Agent Notebook

这是一个**本地优先**的笔记本：所有内容都是你电脑上的 Markdown 文件（和 Obsidian 完全兼容），
AI agent 通过 **MCP** 接入，经过 token 认证后按权限读写。

## 它是怎么组织的

- **笔记本**：顶层每个文件夹是一个领域（健康、阅读、思维、财务、Alpha看板、选题会…），各带一份说明和关键词，agent 记东西时据此自动归类。
- 三种形态：**日志**（健康、财务：一天一页，按时间追加）、**看板**（卡片 + 列）、**页面集**（一条内容一页）。
- **收件箱**：归类拿不准的先放这里，你点一下分配，系统就记住。
- **链接**：正文里写 \`[[页面标题]]\` 就能跨笔记本互相链接，页面底部显示"被谁引用"。
- **活动日志**：左下角可以看到每个 agent 做了什么。

## 让 agent 接入

1. 在 **设置 → Agent 访问令牌** 里新建一个 token，选择读 / 写权限和可访问的文件夹。
2. 把页面上给出的命令粘贴到 agent 的 MCP 配置里（Claude Code、Codex、Cursor 等都支持）。
3. agent 就能调用 \`notebook_create_note\`、\`notebook_get_board\` 这些工具了。

## 备份到 GitHub

在 **设置 → 备份** 里填入一个空的 GitHub 仓库地址并开启自动备份，笔记会按设定间隔自动 commit 并 push。
不开启的话，所有内容只保存在本地。
`;

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
