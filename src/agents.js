// Detect locally installed AI agents / MCP hosts and connect them to this notebook
// by writing an `agent-notebook` MCP server entry into their config files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = path.join(here, 'cli.js');
export const SKILL_SRC = path.join(here, '..', 'skills', 'agent-notebook');
export const SERVER_NAME = 'agent-notebook';

const HOME = () => process.env.AGENT_NOTEBOOK_HOME || os.homedir();
const h = (p) => path.join(HOME(), p);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((d) => exists(path.join(d, bin)));

/**
 * Known agents. `kind` decides how we write the config:
 *  json       – <key>[SERVER_NAME] = { command, args, env }
 *  opencode   – mcp[SERVER_NAME] = { type:'local', command:[...], environment }
 *  toml       – [mcp_servers.SERVER_NAME] block (Codex / Grok CLI style)
 *  manual     – detected, but configured through the app's own UI; we only show snippets
 */
export const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', icon: '✴️', kind: 'json', config: '.claude.json', key: 'mcpServers', detect: ['.claude', 'bin:claude'], skillsDir: '.claude/skills', restart: '新开一个 claude 会话，输入 /mcp 可看到 agent-notebook' },
  { id: 'codex', name: 'Codex CLI', icon: '🟢', kind: 'toml', config: '.codex/config.toml', detect: ['.codex', 'bin:codex'], skillsDir: '.codex/skills', restart: '重新启动 codex' },
  { id: 'grok', name: 'Grok CLI', icon: '⚫', kind: 'toml', config: '.grok/config.toml', detect: ['.grok', 'bin:grok'], restart: '重新启动 grok' },
  { id: 'gemini-cli', name: 'Gemini CLI', icon: '💎', kind: 'json', config: '.gemini/settings.json', key: 'mcpServers', detect: ['.gemini/settings.json', 'bin:gemini'], restart: '重新启动 gemini' },
  { id: 'claude-desktop', name: 'Claude Desktop', icon: '🟤', kind: 'json', config: 'Library/Application Support/Claude/claude_desktop_config.json', key: 'mcpServers', detect: ['Library/Application Support/Claude', 'app:Claude.app'], restart: '完全退出并重新打开 Claude Desktop' },
  { id: 'cursor', name: 'Cursor', icon: '🟦', kind: 'json', config: '.cursor/mcp.json', key: 'mcpServers', detect: ['.cursor', 'app:Cursor.app'], restart: '在 Cursor 设置 → MCP 里刷新' },
  { id: 'windsurf', name: 'Windsurf', icon: '🌊', kind: 'json', config: '.codeium/windsurf/mcp_config.json', key: 'mcpServers', detect: ['.codeium/windsurf', 'app:Windsurf.app'], restart: '在 Windsurf 的 MCP 面板里刷新' },
  { id: 'antigravity', name: 'Antigravity', icon: '🪐', kind: 'json', config: '.gemini/antigravity/mcp_config.json', key: 'mcpServers', detect: ['.gemini/antigravity'], restart: '重新打开 Antigravity' },
  { id: 'kiro', name: 'Kiro', icon: '👻', kind: 'json', config: '.kiro/settings/mcp.json', key: 'mcpServers', detect: ['.kiro'], restart: '重新打开 Kiro' },
  { id: 'opencode', name: 'OpenCode', icon: '🧩', kind: 'opencode', config: '.config/opencode/opencode.json', key: 'mcp', detect: ['.config/opencode', 'bin:opencode'], restart: '重新启动 opencode' },
  { id: 'devin', name: 'Devin', icon: '🤖', kind: 'json', config: '.config/devin/mcp_config.json', key: 'mcpServers', detect: ['.config/devin'], restart: '重新启动 Devin' },
  { id: 'vscode', name: 'VS Code (Copilot)', icon: '🔷', kind: 'json', config: 'Library/Application Support/Code/User/mcp.json', key: 'servers', detect: ['app:Visual Studio Code.app'], restart: '在 VS Code 命令面板运行 MCP: List Servers' },
  { id: 'grok-bot', name: 'Grok Bot', icon: '🤖', kind: 'manual', detect: ['.grokbot', 'app:Grok Bot.app'], note: '在 Grok Bot 的 MCP 设置里添加一个 HTTP 服务器，填下面的地址和 Bearer token。' },
  { id: 'cue', name: 'Cue', icon: '🎯', kind: 'manual', detect: ['.cue', 'app:Cue.app'], note: '在 Cue 的 MCP / 工具设置里添加服务器，填下面的地址和 Bearer token。' }
];

function detected(agent) {
  return agent.detect.some((d) => {
    if (d.startsWith('bin:')) return onPath(d.slice(4));
    if (d.startsWith('app:')) return exists(path.join('/Applications', d.slice(4))) || exists(h(path.join('Applications', d.slice(4))));
    return exists(h(d));
  });
}

function connected(agent) {
  if (!agent.config) return false;
  const p = h(agent.config);
  if (!exists(p)) return false;
  const txt = fs.readFileSync(p, 'utf8');
  return agent.kind === 'toml' ? new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(txt) : txt.includes(`"${SERVER_NAME}"`);
}

export function listAgents({ vault, port }) {
  return {
    cli: CLI_PATH,
    vault,
    httpUrl: `http://127.0.0.1:${port}/mcp`,
    agents: AGENTS.map((a) => ({
      id: a.id, name: a.name, icon: a.icon, kind: a.kind,
      configPath: a.config ? h(a.config) : null,
      detected: detected(a),
      connected: connected(a),
      canWrite: a.kind !== 'manual',
      hasSkills: !!a.skillsDir,
      restart: a.restart || null,
      note: a.note || null
    }))
  };
}

/** The MCP server entry in the three shapes we need. */
export function serverEntry({ token, vault, url }) {
  const env = url ? { AGENT_NOTEBOOK_TOKEN: token, AGENT_NOTEBOOK_URL: url } : { AGENT_NOTEBOOK_TOKEN: token, AGENT_NOTEBOOK_VAULT: vault };
  return {
    json: { command: 'node', args: [CLI_PATH, 'mcp'], env },
    opencode: { type: 'local', command: ['node', CLI_PATH, 'mcp'], enabled: true, environment: env },
    toml: [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = "node"`,
      `args = [${JSON.stringify(CLI_PATH)}, "mcp"]`,
      ``,
      `[mcp_servers.${SERVER_NAME}.env]`,
      `AGENT_NOTEBOOK_TOKEN = ${JSON.stringify(token)}`,
      url ? `AGENT_NOTEBOOK_URL = ${JSON.stringify(url)}` : `AGENT_NOTEBOOK_VAULT = ${JSON.stringify(vault)}`,
      ``
    ].join('\n')
  };
}

/** Copy the config to <file>.agent-notebook.bak once: the pristine version before we ever touched it. */
function backup(p) {
  if (!exists(p)) return null;
  const b = `${p}.${SERVER_NAME}.bak`;
  if (!exists(b)) fs.copyFileSync(p, b);
  return b;
}

/** The token an agent's config currently carries for the notebook (null when not connected). */
export function existingToken(agent) {
  if (agent.kind === 'manual') return null;
  const p = h(agent.config);
  if (!exists(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  if (agent.kind === 'toml') {
    const m = txt.match(new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\.env\\][^\\[]*?AGENT_NOTEBOOK_TOKEN\\s*=\\s*"([^"]+)"`));
    return m ? m[1] : null;
  }
  try {
    const data = JSON.parse(txt);
    const e = data[agent.key || 'mcpServers']?.[SERVER_NAME];
    return e?.env?.AGENT_NOTEBOOK_TOKEN || e?.environment?.AGENT_NOTEBOOK_TOKEN || null;
  } catch { return null; }
}

/** Rewrite every connected agent on this machine to talk to a remote notebook server, keeping its token. */
export function repointAgents({ url, only }) {
  const out = [];
  for (const agent of AGENTS) {
    if (agent.kind === 'manual' || (only && agent.id !== only)) continue;
    const token = existingToken(agent);
    if (!token) continue;
    const written = writeAgentConfig(agent, { token, url });
    out.push({ agent: agent.name, id: agent.id, token, ...written });
  }
  return out;
}

/** Write the server entry into the agent's config. Returns { configPath, backupPath }. */
export function writeAgentConfig(agent, { token, vault, url }) {
  if (agent.kind === 'manual') throw new Error(`${agent.name} 需要在应用内手动添加 MCP 服务器`);
  const p = h(agent.config);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = serverEntry({ token, vault, url });
  const backupPath = backup(p);

  if (agent.kind === 'toml') {
    let txt = exists(p) ? fs.readFileSync(p, 'utf8') : '';
    // drop any previous [mcp_servers.agent-notebook] / .env blocks
    const block = new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}(\\.env)?\\]\\n(?:(?!^\\[).*\\n?)*`, 'gm');
    txt = txt.replace(block, '').replace(/\n{3,}/g, '\n\n');
    if (txt && !txt.endsWith('\n')) txt += '\n';
    if (txt && !txt.endsWith('\n\n')) txt += '\n';
    fs.writeFileSync(p, txt + entry.toml);
    return { configPath: p, backupPath };
  }

  let data = {};
  if (exists(p)) {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (raw) {
      try { data = JSON.parse(raw); } catch (err) { throw new Error(`无法解析 ${p}（${err.message}），请手动添加`); }
    }
  }
  const key = agent.key || 'mcpServers';
  if (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key])) data[key] = {};
  data[key][SERVER_NAME] = agent.kind === 'opencode' ? entry.opencode : entry.json;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return { configPath: p, backupPath };
}

/** Copy skills/agent-notebook into the agent's skills folder. */
export function installSkill(agent) {
  if (!agent.skillsDir) return null;
  const dest = h(path.join(agent.skillsDir, SERVER_NAME));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(SKILL_SRC)) fs.copyFileSync(path.join(SKILL_SRC, f), path.join(dest, f));
  return dest;
}

export function getAgent(id) {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`未知 agent: ${id}`);
  return a;
}

/** Full connect flow: create a token named after the agent, write its config, optionally install the skill. */
export function connectAgent({ id, auth, vault, scopes = ['read', 'write'], folders = ['*'], skill = true }) {
  const agent = getAgent(id);
  let name = id;
  for (let n = 2; auth.config.tokens.some((t) => t.name === name); n++) name = `${id}-${n}`;
  const t = auth.createToken(name, { scopes, folders });
  try {
    const written = writeAgentConfig(agent, { token: t.token, vault });
    const skillPath = skill ? installSkill(agent) : null;
    return { agent: agent.name, id, tokenName: name, scopes: t.scopes, folders: t.folders, ...written, skillPath, restart: agent.restart || null };
  } catch (err) {
    auth.revokeToken(name); // don't leave an orphan token behind
    throw err;
  }
}
