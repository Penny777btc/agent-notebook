// Smoke test for 「原文与解读」 (src/analyze.js): the two-step analysis of one record (the original fetched word for word,
// then read), its sidecar file, the job API, the tool limits of the web step and the automatic queue. Uses only a temp dir; the models are a local fake speaking the Messages API and a stand-in
// `grok` on PATH, so no real AI call and no network request is made.
// Run: node scripts/smoke-analyze.mjs
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault.js';
import { Auth } from '../src/auth.js';
import { aiSettings, complete, webCapable } from '../src/enrich.js';
import { analyze, readAnalysis, parseWebPart, parseOriginal, parseLocalPart, spread, startAnalysis, analysisStatus, analysisSettled, autoCandidates, autoTick, autoWaiting, autoStatus, backlog, runBacklog } from '../src/analyze.js';
import { createApp } from '../src/web-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-analyze-'));
const LOCAL = '## 和已有记录的关联\n- 和之前记的 ETH 持仓复盘是同一个话题 [1]。\n- 和睡眠没有关系 [7]。\n\n## 对我意味着什么\n- 值得继续跟：可以做一期「拿了五年不涨」的选题。\n- 下一步：核对原帖的持仓截图。';
const ORIGINAL = 'ETH 2021: $20k\nETH 2026: $20k\n\nFive years of holding. **Number go sideways.**';
const WEB = '我先打开链接看看。\n\n## 原文\n### https://x.com/someone/status/1\n@someone · 2026-11-12\n' + ORIGINAL + '\n\n## 解读\n- 原帖说的是 2021 年买入的仓位，现在市值仍是 2 万美元。\n- 核对：记录写的是「买 $2 万」，原文是持仓市值 2 万美元，不是单价。\n\n## 背景\n- 作者是加密圈的讽刺账号。\n\nSOURCES: https://x.com/someone/status/1 https://example.com/a.';
let server, fake, mode = 'ok', calls = 0, lastUser = '', lastSystem = '';
const oldPath = process.env.PATH, oldHome = process.env.HOME;
try {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls++;
      const { system = '', messages = [] } = JSON.parse(raw || '{}');
      lastSystem = system; lastUser = String(messages[0]?.content || '');
      const text = mode === 'plan' || (mode === 'plan-once' && calls === 1) ? '我先看一下笔记本里有哪些相关记录。' : `好的。\n\n${LOCAL}`;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));

  // the stand-in grok goes on PATH before anything looks for a CLI: the lookup is cached, and the real one must never be found
  const bin = path.join(tmp, 'fakebin'), home = path.join(tmp, 'fakehome'), out = path.join(tmp, 'grok');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'config.toml'), '[mcp_servers.agent-notebook]\ncommand = "node"\n');
  // it tells the two kinds of call apart by --disable-web-search and keeps each one's arguments
  fs.writeFileSync(path.join(bin, 'grok'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok 0.0-test"; exit 0; fi
kind=web; for a in "$@"; do [ "$a" = "--disable-web-search" ] && kind=local; done
n=$(cat "$FAKE_OUT.$kind.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_OUT.$kind.count"
printf "%s\\n" "$@" > "$FAKE_OUT.$kind.args"
printf "%s" "$GROK_CONFIG" > "$FAKE_OUT.$kind.env"
[ -f "$FAKE_OUT.$kind.stderr" ] && cat "$FAKE_OUT.$kind.stderr" >&2
if [ -f "$FAKE_OUT.$kind.reply.$n" ]; then cat "$FAKE_OUT.$kind.reply.$n"; else cat "$FAKE_OUT.$kind.reply"; fi
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`; process.env.HOME = home; process.env.FAKE_OUT = out;

  const vault = new Vault(tmp);
  const auth = new Auth(tmp);
  auth.update((c) => { c.trustLoopback = false; c.ai = { enabled: true, provider: 'api', apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'fake-model' }; });
  vault.createNotebook({ folder: '快讯', title: '快讯', icon: '⚡', kind: 'pages', description: '每天的行业快讯' });
  vault.createNotebook({ folder: '财务', title: '财务', icon: '💰', kind: 'journal', description: '收支和仓位' });
  vault.createNotebook({ folder: '回顾', title: '回顾', icon: '🗓', kind: 'pages', auto: false });
  const target = vault.createNote({ folder: '快讯', title: '某账号嘲讽 ETH：2021 年买 $2 万，2026 年还是 $2 万', body: '4.2 万浏览。原帖 https://x.com/someone/status/1 说 ETH 拿了五年没涨。', properties: { source: 'phone-agents', date: '2026-11-12', tags: ['ETH'] } });
  const other = vault.createNote({ folder: '财务', title: 'ETH 持仓复盘', body: '私密内容-不该上网：ETH 持仓成本和这轮回撤的复盘，ETH 仓位占比偏高。', properties: { source: 'owner', date: '2026-11-10' } });
  vault.createNote({ folder: '快讯', title: '睡眠', body: '昨晚睡了 6 小时。', properties: { source: 'owner', date: '2026-11-11' } });
  const review = vault.createNote({ folder: '回顾', title: '周回顾', body: '这周看了 ETH。', properties: { source: 'system' } });
  const updatedBefore = vault.getNote(target.path).properties.updated;

  // 1. parsing: the preamble and the SOURCES line come off, the headings are required
  const w = parseWebPart(WEB);
  assert.ok(w.ok && w.text.startsWith('## 解读') && !w.text.includes('SOURCES') && !w.text.includes('我先打开') && !w.text.includes('Five years'));
  assert.deepEqual(parseOriginal(w.original), [{ url: 'https://x.com/someone/status/1', meta: '@someone · 2026-11-12', text: ORIGINAL }], 'the original comes out per link, word for word');
  assert.deepEqual(parseOriginal('### https://a.example/x\n没能打开。\n\n### <https://b.example/y>\nA first line that ends with a full stop.\nSecond line.'), [{ url: 'https://a.example/x', text: '没能打开。', failed: true }, { url: 'https://b.example/y', text: 'A first line that ends with a full stop.\nSecond line.' }]);
  const glued = parseWebPart('我先打开记录里的两条原文链接，把帖子内容读回来再按三节整理。## 原文\n\n### https://a.example/x\nThe post itself, word for word.\n\n## 解读\n- 一条足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读。\n\n## 背景\n- 背景\n\nSOURCES: https://a.example/x');
  assert.equal(glued.ok, true, 'a remark run straight into the first heading does not cost the original');
  assert.equal(parseOriginal(glued.original)[0].text, 'The post itself, word for word.');
  assert.equal(parseWebPart('## 原文要点\n- 旧格式的一条细节，写得足够长足够长足够长足够长足够长足够长足够长足够长足够长。\n\n## 背景\n- 别的').ok, false, 'the older heading is not the original');
  const tail = parseWebPart('## 原文\n### https://a.example/x\nSOURCES: are overrated, the post says.\n\n## 解读\n- 一条足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读足够长的解读。\n\n## 背景\n- 背景\n\nSOURCES: https://a.example/x');
  assert.ok(tail.ok && tail.original.includes('are overrated') && tail.sources.length === 1, 'a SOURCES line inside the copied text is not the end');
  assert.deepEqual(w.sources, ['https://x.com/someone/status/1', 'https://example.com/a'], 'URLs lose their trailing punctuation');
  assert.equal(parseWebPart('## 原文\n### https://a.example/x\n原帖正文。\n\n## 解读\n- 一条细节，写得足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长。\n\n## 互动要点\n- 别的').ok, false, 'a second section under another name is not accepted');
  assert.ok(parseLocalPart(`好的。\n${LOCAL}`).ok);
  assert.equal(parseLocalPart('我先看一下笔记本。').ok, false);
  // a daily card must not take every place among the related records
  const daily = [7.14, 7.74, 7.39, 7.37, 7.53].map((p, i) => ({ path: `d${i}.md`, title: `比特币 ${p} 万美元（24 小时 -${i}.58%），资金净流出 ${8 + i}.28 亿美元，情绪 2${i}` }));
  const mixed = spread([...daily.slice(0, 4), { path: 'a.md', title: '@someone：NVDA 没有底' }, daily[4], { path: 'b.md', title: 'ETH 质押收益率下降' }], 8);
  assert.deepEqual(mixed.map((h) => h.path), ['d0.md', 'd1.md', 'a.md', 'b.md']);
  assert.equal(spread(daily, 1).length, 1);
  console.log('ok 1  the two parts are cut out of what the model returned');

  // 2. a provider that cannot go online: the vault half alone, stored beside the note
  assert.equal(webCapable(auth), false);
  const a = await analyze(vault, auth, target.path, {});
  assert.equal(a.web, false);
  assert.ok(a.text.startsWith('## 和已有记录的关联') && a.text.includes('## 对我意味着什么'));
  assert.deepEqual(a.related.map((r) => [r.n, r.path]), [[1, other.path]], 'only the cited records are kept, and only numbers that exist');
  assert.ok(lastUser.includes('<record>') && lastUser.includes('私密内容') && lastUser.includes('<notebooks>') && !lastUser.includes('<supplement>'));
  assert.ok(!lastUser.includes('这周看了 ETH'), 'a generated review is not used as a related record');
  assert.ok(lastUser.trimEnd().endsWith('全文不超过 600 字。'), 'the format is asked for again after the material');
  const files = fs.readdirSync(path.join(tmp, '.notebook', 'analysis'));
  assert.equal(files.length, 1);
  const after = vault.getNote(target.path);
  assert.equal(after.properties.updated, updatedBefore, 'the record itself is not touched');
  assert.ok(!('analysis' in after.properties) && !after.body.includes('对我意味着什么'));
  assert.equal(readAnalysis(vault, after).stale, false);
  console.log('ok 2  offline analysis: related records cited, stored under .notebook/analysis, the note untouched');

  // 3. it follows the note: stale after an edit, still there after a move; a limited reader does not get the vault half
  vault.updateNote(target.path, { body: after.body + '\n补充一句。' });
  assert.equal(readAnalysis(vault, vault.getNote(target.path)).stale, true);
  const moved = vault.moveNote(target.path, '财务');
  assert.ok(readAnalysis(vault, vault.getNote(moved.path)), 'found again under the new path');
  const back = vault.moveNote(moved.path, '快讯');
  const limited = readAnalysis(vault, vault.getNote(back.path), { can: (p) => p.startsWith('快讯') });
  assert.equal(limited, null, 'nothing but the vault half was written, and this reader may not see the record it cites');
  console.log('ok 3  stale after an edit, kept across a move, hidden from a reader who cannot see the cited records');

  // 4. a plan instead of an answer is asked again once; twice is a failure and the earlier analysis stays
  calls = 0; mode = 'plan-once';
  const b = await analyze(vault, auth, back.path, {});
  assert.equal(calls, 2);
  assert.ok(lastUser.includes('你上一次的输出开头是') && b.text.includes('## 对我意味着什么'));
  mode = 'plan';
  await assert.rejects(analyze(vault, auth, back.path, {}), /分析没有成功/);
  assert.ok(readAnalysis(vault, vault.getNote(back.path)), 'a failed run does not erase the last good one');
  await assert.rejects(analyze(vault, auth, review.path, {}), /自动生成的回顾/);
  mode = 'ok';
  console.log('ok 4  a reply that is only a plan is retried once, then reported as a failure');

  // 5. grok as the provider: the web step gets this record only, with web tools only; the vault step gets no tools
  assert.equal(aiSettings(auth).cli.grok.path, path.join(bin, 'grok'));
  auth.update((c) => { c.ai = { enabled: true, provider: 'grok-cli', grokModel: 'grok-test' }; });
  assert.equal(webCapable(auth), true);
  const reply = (text, extra = {}) => JSON.stringify({ text, stopReason: 'end_turn', num_turns: 3, total_cost_usd: 0.05, modelUsage: { 'grok-test': {} }, ...extra });
  const count = (kind) => Number(fs.readFileSync(`${out}.${kind}.count`, 'utf8'));
  const reset = () => { for (const f of fs.readdirSync(tmp)) if (f.startsWith('grok.')) fs.rmSync(path.join(tmp, f)); };
  fs.writeFileSync(`${out}.web.reply`, reply(WEB));
  fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const c = await analyze(vault, auth, back.path, {});
  assert.equal(c.web, true);
  assert.deepEqual(c.original, [{ url: 'https://x.com/someone/status/1', meta: '@someone · 2026-11-12', text: ORIGINAL }], 'the fetched original is stored and handed out on its own, unchanged');
  assert.ok(c.text.indexOf('## 解读') === 0 && c.text.indexOf('## 背景') > 0 && c.text.indexOf('## 和已有记录的关联') > c.text.indexOf('## 背景') && c.text.includes('核对：'));
  assert.deepEqual(c.sources, ['https://x.com/someone/status/1', 'https://example.com/a']);
  const webArgs = fs.readFileSync(`${out}.web.args`, 'utf8').split('\n');
  const at = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(at(webArgs, '--tools'), 'web_search,web_fetch', 'only names the installed CLI is known to accept');
  assert.equal(at(webArgs, '--permission-mode'), 'dontAsk');
  for (const rule of ['Bash', 'Read', 'Edit', 'Grep', 'MCPTool']) assert.ok(webArgs.some((x, i) => x === rule && webArgs[i - 1] === '--deny'), `${rule} is denied by rule`);
  for (const rule of ['WebFetch', 'WebSearch']) assert.ok(webArgs.some((x, i) => x === rule && webArgs[i - 1] === '--allow'));
  for (const flag of ['--no-subagents', '--no-plan']) assert.ok(webArgs.includes(flag));
  for (const flag of ['--always-approve', '--yolo', '--disable-web-search']) assert.ok(!webArgs.includes(flag), `${flag} is not used`);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${out}.web.env`, 'utf8')).disabled_mcp_servers, ['agent-notebook'], 'the notebook\'s own MCP server is off for the web step');
  const webPrompt = webArgs.join('\n');
  assert.ok(webPrompt.includes('https://x.com/someone/status/1') && webPrompt.includes('资料核查助手'));
  assert.ok(!webPrompt.includes('私密内容') && !webPrompt.includes('ETH 持仓复盘') && !webPrompt.includes('<notes>'), 'no other record reaches the model that can go online');
  const localArgs = fs.readFileSync(`${out}.local.args`, 'utf8');
  assert.ok(localArgs.includes('--disable-web-search') && localArgs.includes('</supplement>') && localArgs.includes('</original>') && localArgs.includes('Five years of holding') && localArgs.includes('私密内容') && localArgs.includes('核对：记录写的是'), 'the vault step reads the other records and what the web step found, offline');
  console.log('ok 5  grok: the web step sees one record and has web tools only; the vault step has the records and no tools');

  // 6. web step failures: a void allowlist is an error; a wrong format is asked again; with the web down the vault half still comes
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply(WEB)); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  fs.writeFileSync(`${out}.web.stderr`, 'warning: --tools "web_fetch" names no tool, so other tools stay available\n');
  await assert.rejects(complete(auth, { system: 's', user: 'u', web: true }), /工具限制没有生效/);
  const d = await analyze(vault, auth, back.path, {});
  assert.equal(d.web, false);
  assert.match(d.webError, /工具限制没有生效/);
  assert.ok(d.text.startsWith('## 和已有记录的关联') && !d.text.includes('解读') && !d.original.length, 'what a run with unrestricted tools returned is thrown away');
  assert.ok(!fs.readFileSync(`${out}.local.args`, 'utf8').includes('</supplement>'));
  reset();
  fs.writeFileSync(`${out}.web.reply.1`, reply('## 原文\n### https://x.com/someone/status/1\n原帖正文。\n\n## 解读\n- 原帖有一张持仓截图，写明了买入时间和现在的市值，细节足够长。\n\n## 互动要点\n- 有人接梗。\n\nSOURCES: https://x.com/someone/status/1'));
  fs.writeFileSync(`${out}.web.reply`, reply(WEB)); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const e = await analyze(vault, auth, back.path, {});
  assert.equal(count('web'), 2, 'asked again when the second section is not 背景');
  assert.ok(e.web && e.text.includes('## 背景') && !e.text.includes('互动要点'));
  assert.ok(fs.readFileSync(`${out}.web.args`, 'utf8').includes('格式不对'));
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply('permission required', { stopReason: 'cancelled' })); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const f = await analyze(vault, auth, back.path, {});
  assert.equal(f.web, false);
  assert.match(f.webError, /没有被允许/);
  console.log('ok 6  a void tool allowlist discards the web result; a wrong format is retried; without the web the rest still comes');

  // 7. a journal page stays offline unless asked; `web: false` always does
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply(WEB)); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const g = await analyze(vault, auth, other.path, {});
  assert.equal(g.web, false);
  assert.ok(!fs.existsSync(`${out}.web.count`), 'a health or money journal is not taken online by default');
  const h = await analyze(vault, auth, back.path, { web: false });
  assert.equal(h.web, false);
  assert.ok(!fs.existsSync(`${out}.web.count`) && !h.webError);
  // no record cited → one plain sentence, not the model's reasons why nothing fitted
  fs.writeFileSync(`${out}.local.reply`, reply('## 和已有记录的关联\n- 这条和别的记录只是同一天写下的，不算关联，因此不附编号。\n\n## 对我意味着什么\n- 先核对是否佩戴。'));
  const k = await analyze(vault, auth, back.path, { web: false });
  assert.deepEqual(k.related, []);
  assert.ok(k.text.includes('## 和已有记录的关联\n\n笔记本里还没有和它直接相关的记录。\n\n## 对我意味着什么\n- 先核对是否佩戴。') && !k.text.includes('不附编号'));
  fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  console.log('ok 7  journal pages are analysed inside the vault only; web: false keeps any record offline');

  // 8. REST: POST starts a job, GET follows it; tokens are held to their scopes
  const app = createApp({ vault, auth, backup: { status: async () => ({}), start() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = auth.createToken('owner-test', { scopes: ['read', 'write', 'admin'], folders: ['*'] }).token;
  const reader = auth.createToken('reader', { scopes: ['read'], folders: ['快讯'] }).token;
  const call = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const url = '/api/analysis/' + back.path.split('/').map(encodeURIComponent).join('/');
  const fresh = vault.createNote({ folder: '快讯', title: 'ETH 持仓复盘的后续', body: '持仓成本和回撤的复盘还要补一段，仓位占比偏高 https://example.com/b', properties: { source: 'owner' } });
  const freshUrl = '/api/analysis/' + fresh.path.split('/').map(encodeURIComponent).join('/');
  assert.deepEqual([(await call('GET', freshUrl, owner)).body.status, (await call('GET', freshUrl, owner)).body.canWeb], ['none', true]);
  assert.equal((await call('POST', freshUrl, reader, {})).status, 403, 'a read-only token cannot start an analysis');
  assert.equal((await call('GET', '/api/analysis/' + encodeURIComponent('财务') + '/' + encodeURIComponent(path.basename(other.path)), reader)).status, 403);
  const startRes = await call('POST', freshUrl, owner, {});
  assert.deepEqual([startRes.status, startRes.body.status], [202, 'running']);
  assert.equal((await call('POST', freshUrl, owner, {})).body.startedAt, startRes.body.startedAt, 'a second click joins the running job');
  assert.equal((await call('GET', freshUrl, owner)).body.status, 'running');
  await analysisSettled(vault, fresh.path);
  const done = (await call('GET', freshUrl, owner)).body;
  assert.equal(done.status, 'done');
  assert.ok(done.analysis.web && done.analysis.text.includes('## 对我意味着什么') && done.analysis.related.length === 1 && done.analysis.related[0].path === other.path);
  const seenByReader = (await call('GET', freshUrl, reader)).body;
  assert.ok(seenByReader.analysis.limited && seenByReader.analysis.text.includes('## 解读') && seenByReader.analysis.original.length === 1 && !seenByReader.analysis.text.includes('关联') && !seenByReader.analysis.related.length, 'a folder-limited token gets the web half only');
  assert.ok(auth.readAudit({ limit: 50 }).some((x) => x.action === 'analyze' && x.target === fresh.path));
  // a failure is reported by GET and leaves the earlier result in place
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply('permission required', { stopReason: 'cancelled' })); fs.writeFileSync(`${out}.local.reply`, reply('我先看一下笔记本。'));
  startAnalysis(vault, auth, fresh.path, {});
  await analysisSettled(vault, fresh.path);
  const failed = analysisStatus(vault, fresh.path);
  assert.equal(failed.status, 'error');
  assert.ok(/分析没有成功/.test(failed.error) && failed.analysis.text.includes('## 解读'));
  console.log('ok 8  REST: start, follow, scopes, and a failure that keeps the last good analysis');

  // 9. when the original is the point, a failed web step stores nothing; a sidecar from before the original was kept still reads
  const dir = path.join(tmp, '.notebook', 'analysis');
  const sidecars = () => fs.readdirSync(dir).filter((x) => x.endsWith('.md'));
  const old = vault.createNote({ folder: '快讯', title: '旧格式的一条', body: '旧记录 https://example.com/old', properties: { source: 'owner' } });
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply('permission required', { stopReason: 'cancelled' })); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const before9 = sidecars();
  await assert.rejects(analyze(vault, auth, old.path, { requireWeb: true }), /没能读到原文/);
  assert.deepEqual(sidecars(), before9, 'nothing is stored without the original');
  await analyze(vault, auth, old.path, { web: false });
  const oldFile = path.join(dir, sidecars().find((x) => !before9.includes(x)));
  fs.writeFileSync(oldFile, fs.readFileSync(oldFile, 'utf8').replace('## 和已有记录的关联', '## 原文要点\n- 旧要点。\n\n## 背景\n- 旧背景。\n\n## 和已有记录的关联'));
  const o = readAnalysis(vault, vault.getNote(old.path));
  assert.ok(o.text.startsWith('## 原文要点') && o.text.includes('## 对我意味着什么') && o.original.length === 0, 'shown as it was written');
  console.log('ok 9  requireWeb stores nothing when the original could not be fetched; older sidecars still read');

  // 10. on its own: only notebooks the owner set to `analyze: auto`, only new records with a link, one at a time, twice at most
  const writer = auth.createToken('writer', { scopes: ['read', 'write'], folders: ['*'] }).token;
  const isAuto = (f) => vault.listNotebooks().find((n) => n.folder === f).analyze === 'auto';
  const nbUrl = (f) => '/api/notebooks/' + encodeURIComponent(f);
  await call('PATCH', nbUrl('快讯'), writer, { analyze: 'auto' });
  assert.equal(isAuto('快讯'), false, 'an agent token cannot make a notebook fetch on its own');
  assert.equal((await call('PATCH', nbUrl('快讯'), owner, { analyze: 'auto' })).status, 200);
  assert.equal(isAuto('快讯'), true);
  await call('PATCH', nbUrl('快讯'), writer, { description: '每天的行业快讯。' });
  assert.equal(isAuto('快讯'), true, 'another edit leaves the setting alone');
  await call('PATCH', nbUrl('财务'), owner, { analyze: 'auto' });
  assert.equal(isAuto('财务'), false, 'never for a journal');
  for (const c of autoCandidates(vault)) await analyze(vault, auth, c.path, { web: false }); // records left over from the checks above
  const n1 = vault.createNote({ folder: '快讯', title: '新的一条快讯', body: '有人发了长文 https://x.com/someone/status/2', properties: { source: 'phone-agents' } });
  vault.createNote({ folder: '快讯', title: '没有链接的一条', body: '只是一句话。', properties: { source: 'owner' } });
  vault.createNote({ folder: '财务', title: '今天的仓位', body: '仓位 https://example.com/p', properties: { source: 'owner' } });
  assert.deepEqual(autoCandidates(vault).map((x) => x.path), [n1.path], 'a new record with a link and no analysis, in an auto notebook');
  assert.deepEqual(autoCandidates(vault, { now: new Date(Date.now() + 3 * 86400000) }), [], 'older records wait for the button');
  const n1Url = '/api/analysis/' + n1.path.split('/').map(encodeURIComponent).join('/');
  assert.equal((await call('GET', n1Url, owner)).body.queued, true, 'the page is told the record is in line');
  assert.equal(await autoTick(vault, auth, { cap: 0 }), null, 'the daily ceiling holds');
  reset();
  fs.writeFileSync(`${out}.web.reply`, reply(WEB)); fs.writeFileSync(`${out}.local.reply`, reply(LOCAL));
  const done1 = [];
  assert.deepEqual(await autoTick(vault, auth, { onDone: (x, p) => done1.push(p) }), { path: n1.path, ok: true });
  assert.deepEqual(done1, [n1.path]);
  assert.equal(readAnalysis(vault, vault.getNote(n1.path)).original[0].text, ORIGINAL);
  assert.equal((await call('GET', n1Url, owner)).body.queued, undefined);
  assert.equal(await autoTick(vault, auth, {}), null, 'nothing left');
  assert.deepEqual([autoStatus(vault).waiting, autoStatus(vault).today], [0, 1]);
  const n2 = vault.createNote({ folder: '快讯', title: '打不开的一条', body: '链接 https://x.com/someone/status/3', properties: { source: 'phone-agents' } });
  fs.writeFileSync(`${out}.web.reply`, reply('permission required', { stopReason: 'cancelled' }));
  const before10 = sidecars();
  const t1 = await autoTick(vault, auth, {});
  assert.ok(t1.path === n2.path && t1.ok === false && /没能读到原文/.test(t1.error));
  assert.deepEqual(sidecars(), before10);
  assert.equal(analysisStatus(vault, n2.path).status, 'none', 'a failure nobody asked for is not shown on the page');
  assert.equal(autoWaiting(vault, n2.path), true);
  assert.equal(await autoTick(vault, auth, {}), null, 'not again right away');
  const later = new Date(Date.now() + 11 * 60000);
  assert.equal((await autoTick(vault, auth, { now: later })).ok, false, 'once more after a while');
  assert.equal(autoWaiting(vault, n2.path, { now: later }), false);
  assert.equal(await autoTick(vault, auth, { now: new Date(Date.now() + 40 * 60000) }), null, 'twice is enough: it waits for the button');
  console.log('ok 10 automatic: owner-only switch, new linked records only, one at a time, two tries, a daily ceiling');

  // ---- 11. the backlog: older records of those notebooks, taken one at a time on request ----
  const future = new Date(Date.now() + 3 * 86400000); // from here every record above is older than the queue's window
  assert.deepEqual(backlog(vault).map((r) => r.path), [], 'new records belong to the queue');
  const stale = backlog(vault, { now: future }).map((r) => r.path);
  assert.ok(stale.includes(n2.path) && !stale.includes(n1.path), 'with a link and no original stored, and only those');
  fs.writeFileSync(`${out}.web.reply`, reply(WEB));
  const steps = [];
  const r1 = await runBacklog(vault, auth, { now: () => future, pauseMs: 0, onStep: (s) => steps.push(s) });
  assert.deepEqual([r1.done, r1.failed, r1.left, r1.stopped], [stale.length, 0, 0, undefined]);
  assert.ok(steps.every((s) => s.ok && s.chars > 0) && steps.length === stale.length);
  assert.equal(readAnalysis(vault, vault.getNote(n2.path)).original[0].text, ORIGINAL);
  for (let i = 0; i < 4; i++) vault.createNote({ folder: '快讯', title: `旧记录 ${i}`, body: `链接 https://x.com/someone/status/9${i}`, properties: { source: 'phone-agents' } });
  fs.writeFileSync(`${out}.web.reply`, reply('permission required', { stopReason: 'cancelled' }));
  const r2 = await runBacklog(vault, auth, { now: () => future, pauseMs: 0 });
  assert.deepEqual([r2.done, r2.failed, r2.left], [0, 3, 4], 'three failures in a row end the run, and nothing is stored for them');
  assert.ok(/连续三条失败/.test(r2.stopped));
  console.log('ok 11 backlog: older linked records without an original, one at a time, stopping when the web is down');

  console.log('\nall analyze checks passed');
} finally {
  process.env.PATH = oldPath; process.env.HOME = oldHome;
  server?.close();
  fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
