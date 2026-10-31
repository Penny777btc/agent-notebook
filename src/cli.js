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
      app.listen(port, host, () => {
        console.log(`agent-notebook  vault=${vaultDir}`);
        console.log(`  web UI : http://${host}:${port}/`);
        console.log(`  MCP    : http://${host}:${port}/mcp  (Authorization: Bearer <token>)`);
        if (!auth.config.tokens.length) console.log(`  no agent tokens yet → agent-notebook token create <name> --scopes read,write`);
      });
      return;
    }
    case 'mcp': {
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
      const scopes = String(flags.scopes || 'read,write').split(',').map((s) => s.trim()).filter(Boolean);
      const folders = flags.folders ? String(flags.folders).split(',').map((s) => s.trim()).filter(Boolean) : ['*'];
      const r = connectAgent({ id: sub, auth, vault: vaultDir, scopes, folders, skill: !flags['no-skill'] });
      console.log(`Connected ${r.agent}: token "${r.tokenName}" (${r.scopes.join(',')}; ${r.folders.join(',')})`);
      console.log(`  config : ${r.configPath}${r.backupPath ? `  (backup: ${r.backupPath})` : ''}`);
      if (r.skillPath) console.log(`  skill  : ${r.skillPath}`);
      if (r.restart) console.log(`  next   : ${r.restart}`);
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

export function seedVault(vault) {
  if (!vault.isBoard('Alpha看板')) {
    vault.createBoard({ folder: 'Alpha看板', title: 'Alpha 看板', icon: '📈', columns: ['新发现', '关注中', '已验证', '归档'], description: 'Agent 每天收集的 Alpha 线索。按日期筛选可以看当天的看板。' });
  }
  if (!vault.isBoard('选题会')) {
    vault.createBoard({ folder: '选题会', title: '选题会', icon: '🎬', columns: ['灵感池', '讨论中', '已定稿', '已发布'], description: '内容选题流水线：agent 投稿到灵感池，我在这里挑选和定稿。' });
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

- **页面**：任意文件夹里的 \`.md\` 文件，frontmatter 存属性（标签、来源 agent、日期…）。
- **看板**：带 \`_board.md\` 的文件夹。文件夹里的每个笔记就是一张卡片，\`status\` 属性决定它在哪一列。
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
