// Smoke test for the MCP stdio server. Usage: node scripts/smoke-mcp.mjs <rw-token> <folder-limited-token> <read-token>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = async (token, label, calls) => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [cli, 'mcp'], env: { ...process.env, AGENT_NOTEBOOK_TOKEN: token }, stderr: 'pipe' }));
  console.log(`\n=== ${label} ===`);
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    const txt = r.content[0].text;
    console.log(`${r.isError ? '✗' : '✓'} ${name}(${JSON.stringify(args)}) → ${txt.slice(0, 160).replace(/\n/g, ' ')}`);
  }
  await client.close();
};
const today = new Date().toISOString().slice(0, 10);
const tools = new Client({ name: 't', version: '0' });
await tools.connect(new StdioClientTransport({ command: 'node', args: [cli, 'mcp'], env: { ...process.env, AGENT_NOTEBOOK_TOKEN: process.argv[2] }, stderr: 'pipe' }));
console.log('tools:', (await tools.listTools()).tools.map((t) => t.name).join(', '));
await tools.close();
await run(process.argv[2], 'claude-code (read,write,*)', [
  ['notebook_whoami', {}],
  ['notebook_list_boards', {}],
  ['notebook_get_board', { folder: 'Alpha看板', date: today }],
  ['notebook_create_note', { folder: '选题会', title: 'MCP 测试卡片', body: '来自测试客户端', tags: ['test'] }],
  ['notebook_search', { query: '测试客户端' }],
  ['notebook_move_card', { path: '选题会/MCP 测试卡片.md', status: '讨论中' }],
  ['notebook_move_card', { path: '选题会/MCP 测试卡片.md', status: '不存在的列' }],
  ['notebook_update_note', { path: '选题会/MCP 测试卡片.md', append: '## 追加\n- ok', properties: { score: 9 } }],
  ['notebook_read_note', { path: '选题会/MCP 测试卡片.md' }],
  ['notebook_read_note', { path: '../../package.json' }],
]);
await run(process.argv[3], 'alpha-bot (read,write, only Alpha看板)', [
  ['notebook_create_note', { folder: 'Alpha看板', title: 'alpha-bot 写入', body: 'ok' }],
  ['notebook_create_note', { folder: '选题会', title: '越权写入', body: 'should fail' }],
  ['notebook_read_note', { path: '欢迎.md' }],
  ['notebook_list_notes', { limit: 50 }],
]);
await run(process.argv[4], 'reader (read only)', [
  ['notebook_read_note', { path: '欢迎.md' }],
  ['notebook_create_note', { folder: '灵感', title: 'x', body: 'should fail' }],
]);
