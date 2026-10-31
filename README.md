# Agent Notebook

A **local-first notebook shared by you and all your AI agents**.

- **Notion-like UI** — pages with properties, kanban boards with drag-and-drop, side-peek editing, search, dark mode.
- **Obsidian-compatible storage** — everything is plain Markdown + YAML frontmatter in one folder. Open the vault in Obsidian any time. No database, no lock-in.
- **Built for agents** — an MCP server (stdio for local agents, Streamable HTTP for remote ones) with per-agent **tokens**, **read / write / admin scopes**, optional **folder restrictions**, and an **audit log** of everything each agent did.
- **GitHub backup** — optional scheduled `git commit` + `push` to any remote. Off by default: then your notes stay on your disk only.
- **Skill included** — `skills/agent-notebook/SKILL.md` teaches agents the conventions (which board for what, always tag `source`, dedupe before writing).

## Quick start

```bash
npm install
node src/cli.js init            # creates ./vault with example boards (Alpha看板, 选题会, 灵感)
node src/cli.js serve           # http://127.0.0.1:3777
```

Open the web UI. The home page tells you which local agents it detected; **接入 Agent** lets you connect each one with one click.

## Connect your agents

```bash
node src/cli.js agents              # detect local agents and show their status
node src/cli.js connect claude-code # create a token, write the MCP entry, install the skill
node src/cli.js connect codex --scopes read --folders "Alpha看板"
```

| Agent | How it is connected |
|---|---|
| Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, Antigravity, Kiro, Devin, VS Code | writes `mcpServers.agent-notebook` into its JSON config |
| Codex CLI, Grok CLI | writes a `[mcp_servers.agent-notebook]` block into its `config.toml` |
| OpenCode | writes `mcp.agent-notebook` (`type: local`) into `opencode.json` |
| Grok Bot, Cue, Hermes, Muse, anything else that speaks MCP | **其他 agent**: name it, get a token plus HTTP / stdio JSON / TOML snippets to paste into that app |

Every write backs up the original file as `<file>.agent-notebook.bak` and only touches the `agent-notebook` entry. Each agent gets its own token, so you can revoke one without affecting the others, and the activity log shows which agent did what.

The old manual path still works: **设置 → Agent 访问令牌 → 创建令牌** prints ready-to-paste config.

Or from the CLI:

```bash
node src/cli.js token create claude-code --scopes read,write
node src/cli.js token create alpha-bot --scopes read,write --folders "Alpha看板"
node src/cli.js token create reader --scopes read
```

### Connect Claude Code

```bash
claude mcp add agent-notebook \
  -e AGENT_NOTEBOOK_TOKEN=nb_xxx \
  -e AGENT_NOTEBOOK_VAULT="/path/to/agent-notebook/vault" \
  -- node /path/to/agent-notebook/src/cli.js mcp
```

Copy `skills/agent-notebook/` into `~/.claude/skills/` so Claude Code knows the house rules.

### Connect any MCP client (Codex, Cursor, Claude Desktop, …)

```json
{
  "mcpServers": {
    "agent-notebook": {
      "command": "node",
      "args": ["/path/to/agent-notebook/src/cli.js", "mcp"],
      "env": { "AGENT_NOTEBOOK_TOKEN": "nb_xxx", "AGENT_NOTEBOOK_VAULT": "/path/to/agent-notebook/vault" }
    }
  }
}
```

### Remote agents (HTTP)

While `serve` runs, `POST http://127.0.0.1:3777/mcp` with `Authorization: Bearer nb_xxx` is a Streamable HTTP MCP endpoint. Bind to another host with `--host 0.0.0.0` (put it behind a tunnel or reverse proxy with TLS; the web UI is owner-only from loopback, everything else needs a token).

## MCP tools

| Tool | Scope | What it does |
|---|---|---|
| `notebook_whoami` | — | token name, scopes, folder limits |
| `notebook_list_boards` / `notebook_get_board` | read | boards, columns, cards (optionally one `date`) |
| `notebook_list_notes` / `notebook_read_note` / `notebook_search` | read | browse and read |
| `notebook_create_note` | write | new page or card (`source` = agent) |
| `notebook_update_note` | write | replace / append body, rename, change properties |
| `notebook_move_card` | write | change a card's column |
| `notebook_create_board` | write | new kanban board |
| `notebook_delete_note` | write | move to `.trash/` |

## Vault layout

```
vault/
  欢迎.md                      # a page: Markdown + frontmatter
  灵感/                        # a plain folder of pages
  Alpha看板/
    _board.md                  # columns: [新发现, 关注中, 已验证, 归档]
    Hyperliquid ….md           # a card: status / tags / source / date / url …
  .notebook/
    config.json                # port, token hashes (sha256), backup settings  (git-ignored)
    audit.jsonl                # who did what, when
  .trash/                      # deleted notes
```

A card:

```markdown
---
title: Hyperliquid 新上线永续合约交易量激增
status: 新发现
tags: [DeFi, 永续]
source: alpha-bot
date: '2026-10-31'
created: '2026-10-31T09:12:00.000Z'
updated: '2026-10-31T09:12:00.000Z'
url: https://…
---
## 线索
- …
```

## Backup

```bash
node src/cli.js backup init https://github.com/you/my-notes.git   # git init + remote, enables scheduled backup
node src/cli.js backup now
node src/cli.js backup status
```

Or in the UI under **设置 → 备份**. Interval defaults to 30 minutes. Pushing uses your normal git credentials (`gh auth login` or SSH keys). `.notebook/config.json` is git-ignored so token hashes never leave the machine.

## Security model (MVP)

- Requests from loopback **without** a bearer token are treated as the owner (full access). Requests with a token get that token's scopes/folders. Non-loopback requests without a token are rejected.
- Tokens are stored as SHA-256 hashes; the plaintext is shown once.
- Every write and every denied call is appended to `.notebook/audit.jsonl`, visible under **活动日志**.

## Roadmap ideas

Block-level editor, backlinks graph, per-column WIP limits, webhooks (notify Slack when an agent adds a card), MCP resources for `notebook://` URIs, OAuth for remote agents, Tauri/Electron shell.

MIT.
