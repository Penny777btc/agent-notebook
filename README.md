# Agent Notebook

A **local-first notebook shared by you and all your AI agents**.

- **Notion-like UI** — pages with properties, kanban boards with drag-and-drop, side-peek editing, search, dark mode.
- **Obsidian-compatible storage** — everything is plain Markdown + YAML frontmatter in one folder. Open the vault in Obsidian any time. No database, no lock-in.
- **Built for agents** — an MCP server (stdio for local agents, Streamable HTTP for remote ones) with per-agent **tokens**, **read / write / admin scopes**, optional **folder restrictions**, and an **audit log** of everything each agent did.
- **GitHub backup** — optional scheduled `git commit` + `push` to any remote. Off by default: then your notes stay on your disk only.
- **Skill included** — `skills/agent-notebook/SKILL.md` teaches agents the conventions (which board for what, always tag `source`, dedupe before writing).

## How it is organised (v0.2)

- **Notebooks** (领域) are top-level folders with a `_notebook.md`: 收件箱, 健康, 阅读, 思维, 财务, Alpha看板, 选题会 … each with an icon, a description, **routing keywords** and a *kind*:
  - `journal` — one page per day, entries appended with a timestamp (健康, 财务)
  - `board` — kanban cards with columns (Alpha看板, 选题会)
  - `pages` — one page per note (阅读, 思维)
- **Agents call one tool**: `notebook_capture { text }`. The router scores every notebook by keywords and by rules learned from your corrections, files the text in the notebook's own shape, or drops it in **收件箱** with suggestions. Assign an inbox item once and the router remembers (`.notebook/rules.json`); **设置 → 归类规则** lists every learned keyword / tag / source rule and lets you forget one (or all). The capture result's `related` ranks existing notes by shared title words, shared tags, titles mentioned in the new text and recency in the same notebook, each with the reasons.
- **Links**: write `[[Page title]]` anywhere; it resolves by title across notebooks, renders as a link, and the target shows **backlinks**.
- **Reading**: the home page is a quick-capture box, the inbox, and *today's feed* grouped by notebook; each notebook has kanban / timeline / table views.
- **Graph**: **关系图** draws every note as a node and every `[[link]]` as an edge — coloured by notebook (legend doubles as a filter), sized by link count, hover to see neighbours, click to open, drag / zoom / pan, optional orphan notes; a note's page links to the graph centred on it. `GET /api/graph` returns nodes, edges and unresolved link names.
- **Charts**: numbers an agent passes in `properties` (`{ amount: 35 }`, `{ weight: 71.5 }`) — or that you type as `[amount:: 35]` / `weight:: 71.5` — are kept per entry as Obsidian/Dataview inline fields and plotted per day in the notebook's **图表** view (sum / average / latest, 7 / 30 / 90 days / all, hover for the entries, click to open the day). `notebook_metrics` gives agents the same series.

## Quick start

```bash
npm install
node src/cli.js init            # creates ./vault with example boards (Alpha看板, 选题会, 灵感)
node src/cli.js serve           # http://127.0.0.1:3777
```

Open the web UI. The home page tells you which local agents it detected; **接入 Agent** lets you connect each one with one click.

## Use it on your phone

Your notes live on your Mac, so the phone talks to the Mac's server — no cloud copy.

1. **设置 → 手机访问**: set an access password, tick 局域网访问 (binds `0.0.0.0`), restart `serve`.
2. Same Wi-Fi: open `http://<your-mac-ip>:3777` on the phone (the settings page lists the URLs), log in once, **Add to Home Screen** — it runs as a standalone app with its own icon.
3. Away from home: put the port behind a tunnel — `tailscale serve --bg 3777` (private, recommended) or `cloudflared tunnel --url http://127.0.0.1:3777` (temporary public URL). Requests arriving through a tunnel always need the password; only a direct local connection is treated as the owner.

Every phone login mints a revocable device token (📱 in the token list). The UI is responsive: drawer sidebar, snap-scrolling kanban columns, full-screen note view, safe-area aware.

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

While `serve` runs, `POST http://127.0.0.1:3777/mcp` with `Authorization: Bearer nb_xxx` is a Streamable HTTP MCP endpoint. Clients that cannot set headers — the **custom connectors in the Claude and ChatGPT phone apps** — use the token-in-URL form instead: `https://<your-tunnel-host>/mcp/nb_xxx` (shown as 方式 A′ on the 接入 Agent page; over HTTPS it is as private as the header). Hosted agents (a Grok bot, a Zapier/Make flow, …) need a public HTTPS address: a Cloudflare named tunnel on your own domain is the durable option, `cloudflared tunnel --url http://127.0.0.1:3777` the quick one (the address changes on every run).

### Capture from any phone app (iOS Shortcut)

Create a token (接入 Agent → 其他 agent, name it `iphone-shortcut`, write scope), then a Shortcut with one action **Get Contents of URL**: method `POST`, URL `https://<host>/api/capture`, header `Authorization: Bearer nb_xxx`, JSON body `{ "text": Shortcut Input, "source": "iphone-shortcut" }`. Enable *Show in Share Sheet* for text — selecting text in Grok, Safari or WeChat → Share → the Shortcut files it through the same router as every other agent. Bind to another host with `--host 0.0.0.0` (put it behind a tunnel or reverse proxy with TLS; the web UI is owner-only from loopback, everything else needs a token).

## MCP tools

| Tool | Scope | What it does |
|---|---|---|
| `notebook_capture` | write | **the one call**: route text to the right notebook (journal entry / card / page), returns related notes |
| `notebook_list_notebooks` / `notebook_create_notebook` | read / write | areas with kind, keywords, columns |
| `notebook_today` | read | everything recorded on a day, grouped by notebook |
| `notebook_metrics` | read | numeric series of a notebook (`amount`, `weight` …): count / sum / avg / min / max / latest + points, optional `key`, `from`, `to` |
| `notebook_move_note` | write | move a note (e.g. out of the inbox); the router learns |
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
  收件箱/_notebook.md          # inbox: true
  健康/
    _notebook.md               # kind: journal, keywords: [睡眠, 运动, …]
    2026-10-31.md              # one page per day, "## 09:12 · title" entries, numbers as "[weight:: 71.5]" fields
  阅读/_notebook.md            # kind: pages
  Alpha看板/
    _notebook.md               # kind: board, columns: [新发现, 关注中, 已验证, 归档]
    Hyperliquid ….md           # a card: status / tags / source / date / url …
  .notebook/
    config.json                # port, token hashes (sha256), backup settings  (git-ignored)
    rules.json                 # learned routing rules (keyword / tag / source → notebook)
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

- Requests from loopback **without** a bearer token and without a forwarding header (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`, `Tailscale-User-Login`) are treated as the owner (full access). Requests with a token get that token's scopes/folders. Everything else without a token is rejected, except `POST /api/login` (owner password → device token, 5 failures lock an IP for a minute).
- The owner password is stored as a scrypt hash in `.notebook/config.json`.
- Tokens are stored as SHA-256 hashes; the plaintext is shown once.
- Every write and every denied call is appended to `.notebook/audit.jsonl`, visible under **活动日志**.

## Roadmap ideas

Block-level editor, per-column WIP limits, webhooks (notify Slack when an agent adds a card), MCP resources for `notebook://` URIs, OAuth for remote agents, Tauri/Electron shell.

MIT.
