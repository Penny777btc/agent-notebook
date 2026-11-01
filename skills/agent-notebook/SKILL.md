---
name: agent-notebook
description: The owner's single local notebook shared by all their AI agents (Markdown vault, kanban boards, journals, [[links]]), reached through the `agent-notebook` MCP server. Use it whenever something is worth keeping — a finding, an idea, a health / reading / finance / thinking note, an alpha lead, a content topic — or when the owner asks what has been recorded. One call does the filing: `notebook_capture`. Tools are prefixed `notebook_`.
---

# Agent Notebook

The owner talks to many agents. Everything worth keeping goes into **one** local notebook, organised into
**notebooks** (领域): 健康, 阅读, 思维, 财务, Alpha看板, 选题会, … The owner reads; agents write.
Your job is to **capture, not to organise** — the notebook decides where things go.

## The one tool you need: `notebook_capture`

```
notebook_capture { text: "<what to keep, Markdown ok>", title?: "<short headline>", tags?: [...], source?: "<your agent name>" }
```

- Pass the content as `text`. Title is optional (first line is used). Set `source` to **your own** agent name (Hermes, Grok, Muse…), never the token's name — a token may be shared by several agents. Over HTTP also send the header `X-Agent-Name: <your name>` on every request (edits and deletes too) so the audit log names you; MCP clients are recognised from their handshake name when `source` is omitted.
- **Do not pick a folder yourself.** The notebook routes the text to the right notebook by its keywords and by what the owner taught it. The result tells you where it went (`mode: auto`), or that it landed in **收件箱** (`mode: inbox`) with `candidates` the owner will confirm.
- Only pass `notebook` when the owner said where it belongs ("记到财务里") or when it is obvious from the conversation. Use the folder names from `notebook_list_notebooks`.
- Notebook kinds decide the shape, you don't have to care:
  - **journal** (健康, 财务 …): appended to today's page as a timestamped entry.
  - **board** (Alpha看板, 选题会 …): becomes a card in the first column.
  - **pages** (阅读, 思维 …): becomes its own page.
- The result includes `related`: existing notes ranked by shared title words, shared tags, titles your text mentions, and recency in the same notebook, each with `score` and `reasons`. A high score with 标题相同 / 标题包含 usually means the same topic: call `notebook_update_note` with `append` on it instead of leaving a near-duplicate, or add a `[[link]]` to it in your text.

## Linking (Obsidian-style)

Write `[[页面标题]]` anywhere in text to link to another note; the notebook resolves it by title across all notebooks and shows backlinks on the target. Use it when a new entry builds on something that exists (`related` tells you the titles). Unresolved links are fine — they show as pending.

## When the owner asks what was recorded

- `notebook_today { date? }` — everything that landed today (or on a date), grouped by notebook, with journal bodies inline. Summarise per notebook and mention which agent recorded what.
- `notebook_get_board { folder, date? }` for one board; `notebook_search { query }` for anything.
- `notebook_read_note { path }` returns the note with its `links` and `backlinks`.

## Correcting what was recorded

The capture result returns `path` and, for journals, `entry` (its `HH:MM · title` heading). When the owner says a record was wrong, fix that record instead of appending a "更正" entry:
- `notebook_update_entry { path, time, match?, text?, title?, properties?, remove? }` — one timestamped entry of a day page (健康, 财务 …). `properties: { amount: 66.7 }` rewrites its inline fields; `remove: true` deletes it.
- `notebook_update_note { path, body | append | title | properties }` — a page or card; `notebook_delete_note` moves a note to the trash.
Read first with `notebook_read_note` when unsure what is there.

## Housekeeping tools (use when asked)

- `notebook_move_note { path, notebook }` — the owner says "this belongs in 阅读": move it; the notebook learns from the move.
- `notebook_move_card { path, status }` — change a card's column.
- `notebook_create_notebook { folder, title, kind, keywords, description }` — only when the owner asks for a new area.
- `notebook_delete_note` — only on explicit request; it goes to trash.

## Conventions

- One capture = one thought / finding. Keep the title a headline (≤ 60 chars); put detail in `text`.
- **Numbers always go in `properties`** ({ amount: 35, weight: 71.5, steps: 8200, pages: 40 }), not only in the text: the notebook keeps them per entry (as `[amount:: 35]` inline fields in journals) and charts them per day in the notebook's 图表 view. Use one stable key per kind of number (`amount` for money, `weight`, `steps`, `sleep_hours` …) so the series stay continuous; a unit may ride along as a string ("71.5kg", "¥35"). Other facts ({ url, ticker, category }) go in `properties` too and become table columns.
- `notebook_metrics { notebook, key?, from?, to? }` answers "how much did I spend this month" / "weight trend": per key count, sum, avg, min, max, latest and the points. Sum it yourself only when the owner wants a different cut.
- Chinese folder names are normal. Paths are vault-relative and end in `.md`.
- `403 lacks … permission` means your token is read-only or folder-limited: tell the owner, don't retry.
