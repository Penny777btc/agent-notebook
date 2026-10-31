---
name: agent-notebook
description: Read and write the owner's local Agent Notebook (Markdown vault with kanban boards) through the `agent-notebook` MCP server. Use whenever you collect information worth keeping (alpha leads, content topic ideas, research notes, daily findings), when the owner asks what is on a board, or when asked to record an idea / inspiration. Tools are prefixed `notebook_`.
---

# Agent Notebook

The owner keeps one local-first notebook shared by all their AI agents. It is a folder of
Markdown files with YAML frontmatter (Obsidian-compatible). Some folders are **boards**:
every note in them is a **card**, and the `status` property is the kanban column.

You reach it through the MCP server `agent-notebook` (tools start with `notebook_`).
Your token decides what you may do: `read`, `write`, maybe restricted to some folders.
Call `notebook_whoami` once if you are unsure what you are allowed to do.

## Conventions

- **Always set `source`** to your agent name when creating notes (defaults to the token name). The owner filters by it.
- **One card = one finding.** Title is a headline (≤ 60 chars). Body is Markdown: a short summary first, then evidence / links / next steps as bullets or checkboxes.
- **Do not create new boards** unless asked. Use `notebook_list_boards` to see what exists and which columns a board has. Put new cards in the **first column** (default) unless the owner told you otherwise.
- **Daily boards are the same board filtered by date.** Cards carry `date` (YYYY-MM-DD, defaults to today). To show "today's Alpha board" call `notebook_get_board` with `date` = today.
- **Avoid duplicates.** Before creating, `notebook_search` for the key term. If a card already exists, `notebook_update_note` with `append` instead of making a new one.
- **Extra facts go in properties**, not prose: `properties: { url, ticker, score, deadline }`. They become filterable columns in the UI.
- **Never delete** unless the owner explicitly asks; `notebook_delete_note` only moves to trash but still surprises people.
- Paths are vault-relative and end in `.md`, e.g. `Alpha看板/Hyperliquid 永续合约交易量激增.md`. Folder names may be Chinese.

## Typical boards

| Board folder | Purpose | Columns |
|---|---|---|
| `Alpha看板` | daily market / crypto / startup alpha leads | 新发现 → 关注中 → 已验证 → 归档 |
| `选题会` | content topic pipeline | 灵感池 → 讨论中 → 已定稿 → 已发布 |
| `灵感` (not a board) | loose ideas and inspiration pages | — |

(Confirm with `notebook_list_boards`; the owner may have renamed or added boards.)

## Recipes

**Record a finding on a board**
```
notebook_create_note { folder: "Alpha看板", title: "...", body: "...", tags: ["DeFi"], properties: { url: "..." } }
```

**Report today's board to the owner**
```
notebook_get_board { folder: "Alpha看板", date: "<today YYYY-MM-DD>" }
```
Summarize per column; mention `source` so they know which agent found what.

**Save an idea the owner just told you**
```
notebook_create_note { folder: "灵感", title: "<short headline>", body: "<their words, lightly cleaned>", tags: [...] }
```

**Promote / move a card**
```
notebook_move_card { path: "选题会/xxx.md", status: "已定稿" }
```

**Add to an existing note**
```
notebook_update_note { path: "...", append: "## 2026-10-31 更新\n- ..." }
```

## Errors

- `401/403 lacks ... permission` → your token is read-only or folder-restricted. Tell the owner which permission you need; do not retry.
- `Unknown column` → fetch the board first and use one of its exact column names.
