// stdio ⇄ remote bridge: local MCP clients that only speak stdio (Claude Desktop, Cursor, Codex, …) keep
// their `node cli.js mcp` entry, and this forwards every tool call to the notebook server over
// Streamable HTTP. Set AGENT_NOTEBOOK_URL (+ AGENT_NOTEBOOK_TOKEN) and the CLI picks this mode.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function mcpEndpoint(base) {
  const u = String(base || '').replace(/\/+$/, '');
  return /\/mcp(\/|$)/.test(u) ? u : `${u}/mcp`;
}

/** Probe the server with the token: resolves { ok, name } or { ok:false, error }. */
export async function probeRemote(base, token) {
  try {
    const api = mcpEndpoint(base).replace(/\/mcp.*$/, '');
    const r = await fetch(`${api}/api/access`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401) return { ok: false, error: 'token 在服务器上无效' };
    const j = await r.json();
    return j.authenticated ? { ok: true, name: j.principal?.name } : { ok: false, error: '服务器没有认出这把 token' };
  } catch (err) { return { ok: false, error: err.message }; }
}

export async function runRemoteProxy({ url, token }) {
  const client = new Client({ name: 'agent-notebook-bridge', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint(url)), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Agent-Name': process.env.AGENT_NOTEBOOK_AGENT || '' } } });
  await client.connect(transport);
  const server = new Server({ name: 'agent-notebook', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool({ name: req.params.name, arguments: req.params.arguments || {} }));
  await server.connect(new StdioServerTransport());
  console.error(`[agent-notebook] MCP bridge → ${mcpEndpoint(url)}`);
}
