// Works out which agent is talking, so entries carry the agent's name even when several agents share one token.
// Precedence: an explicit `source` (unless it just repeats the token name) → X-Agent-Name header →
// MCP clientInfo.name from the handshake → a recognisable User-Agent → the token name.

const UA_PATTERNS = [
  [/hermes/i, 'Hermes'], [/\bgrok\b|x\.ai|xai-/i, 'Grok'], [/\bmuse\b/i, 'Muse'], [/\bcue\b/i, 'Cue'],
  [/chatgpt|openai/i, 'ChatGPT'], [/claude|anthropic/i, 'Claude'], [/gemini|google-genai|generativelanguage/i, 'Gemini'],
  [/cursor/i, 'Cursor'], [/codex/i, 'Codex'], [/windsurf/i, 'Windsurf'], [/perplexity/i, 'Perplexity'], [/manus/i, 'Manus'],
  [/shortcuts/i, 'iOS 快捷指令'], [/\bn8n\b/i, 'n8n'], [/zapier/i, 'Zapier'], [/integromat|make\.com/i, 'Make'],
  [/\bdify\b/i, 'Dify'], [/\bcoze\b/i, 'Coze'], [/telegram/i, 'Telegram'], [/discord/i, 'Discord'], [/slack/i, 'Slack']
];

const CLIENT_NAMES = {
  'claude-ai': 'Claude', 'claude-desktop': 'Claude', 'claude-code': 'Claude Code', 'claude': 'Claude',
  'cursor-vscode': 'Cursor', 'cursor': 'Cursor', 'codex-mcp-client': 'Codex', 'codex': 'Codex', 'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI', 'gemini-cli-mcp-client': 'Gemini CLI', 'windsurf': 'Windsurf', 'cline': 'Cline', 'roo-code': 'Roo Code',
  'opencode': 'OpenCode', 'kiro': 'Kiro', 'antigravity': 'Antigravity', 'devin': 'Devin', 'mcp-inspector': 'MCP Inspector',
  'chatgpt': 'ChatGPT', 'openai-mcp': 'ChatGPT', 'hermes': 'Hermes', 'grok': 'Grok', 'muse': 'Muse', 'cue': 'Cue'
};

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 40);

/** Known agent names that a token list contributes (so a UA mentioning "cue" maps to the owner's "cue" token name). */
export function agentFromUserAgent(ua, knownNames = []) {
  if (!ua) return null;
  for (const name of knownNames) {
    if (name && name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ua)) return name;
  }
  for (const [re, label] of UA_PATTERNS) if (re.test(ua)) return label;
  return null;
}

export function agentFromClientInfo(info) {
  const raw = clean(info?.name);
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (CLIENT_NAMES[key]) return CLIENT_NAMES[key];
  for (const [k, v] of Object.entries(CLIENT_NAMES)) if (key.startsWith(k + '-') || key.startsWith(k + '/')) return v;
  return raw.replace(/[-_]+/g, ' ');
}

/**
 * @param {object} o
 * @param {string} [o.explicit]   `source` passed in the request body / tool args
 * @param {string} [o.header]     X-Agent-Name header
 * @param {object} [o.clientInfo] MCP clientInfo from the initialize handshake
 * @param {string} [o.userAgent]
 * @param {{name:string}} o.principal
 * @param {string[]} [o.knownNames]
 */
export function resolveSource({ explicit, header, clientInfo, userAgent, principal, knownNames = [] }) {
  const token = principal?.name || '';
  const ex = clean(explicit);
  if (ex && ex.toLowerCase() !== token.toLowerCase()) return ex; // the agent said who it is
  const h = clean(header);
  if (h) return h;
  const c = agentFromClientInfo(clientInfo);
  if (c) return c;
  const u = agentFromUserAgent(userAgent, knownNames.filter((n) => n.toLowerCase() !== token.toLowerCase()));
  if (u) return u;
  return ex || token;
}
