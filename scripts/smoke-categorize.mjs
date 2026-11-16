// Smoke test for a board's categories (src/categorize.js): the setting on the notebook, the `category` property of a
// card, sorting unplaced cards by tag and by the model, and the REST job. Uses only a temp dir; the model is a local
// fake speaking the Messages API, so no real AI call and no network request is made.
// Run: node scripts/smoke-categorize.mjs
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault.js';
import { Auth } from '../src/auth.js';
import { Router, capture } from '../src/notebooks.js';
import { categorize, uncategorized, categoryFromTags, categorizeSettled } from '../src/categorize.js';
import { createApp } from '../src/web-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-categorize-'));
let server, fake, calls = 0, lastUser = '', lastSystem = '', mode = 'ok';
try {
  // the fake sorts by what a card's line says, so the test does not depend on the order of the batch
  const pick = (line) => (/美联储|降息/.test(line) ? '财经' : /脚本|口播/.test(line) ? '内容创作' : /怪/.test(line) ? '不存在的类别' : /模型/.test(line) ? 'AI' : null);
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls++;
      const { system = '', messages = [] } = JSON.parse(raw || '{}');
      lastSystem = system; lastUser = String(messages[0]?.content || '');
      const items = [...lastUser.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: Number(m[1]), category: pick(m[2]) }));
      const text = mode === 'garbage' ? '我先看看这些卡片。' : '```json\n' + JSON.stringify({ items }) + '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));

  const vault = new Vault(tmp);
  const auth = new Auth(tmp);
  auth.update((c) => { c.trustLoopback = false; c.ai = { enabled: true, provider: 'api', apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'fake-model' }; });

  // ---- 1. the setting ----
  const nb = vault.createNotebook({ folder: '选题会', title: '选题会', kind: 'board', columns: ['灵感池', '已定稿'], categories: [' AI ', '财经', '财经', '', '内容创作'] });
  assert.deepEqual(nb.categories, ['AI', '财经', '内容创作'], 'trimmed, no repeats, no blanks');
  assert.deepEqual(vault.createNotebook({ folder: '健康', kind: 'journal', categories: ['睡眠'] }).categories, [], 'a journal has none');
  assert.deepEqual(vault.createNotebook({ folder: '灵感', kind: 'pages' }).categories, []);
  assert.deepEqual(vault.updateNotebook('选题会', { title: '选题会议' }).categories, ['AI', '财经', '内容创作'], 'kept across other edits');
  assert.deepEqual(vault.updateNotebook('灵感', { categories: ['甲'] }).categories, ['甲']);
  assert.deepEqual(vault.updateNotebook('灵感', { categories: [] }).categories, [], 'an empty list clears them');
  assert.ok(!/categories/.test(fs.readFileSync(path.join(tmp, '灵感', '_notebook.md'), 'utf8')));
  console.log('ok 1  categories are a notebook setting: cleaned, kept, cleared, never on a journal');

  // ---- 2. the card ----
  const note = (title, tags = [], extra = {}) => vault.createNote({ folder: '选题会', title, body: `${title}的正文。`, properties: { source: 'bot', tags, ...extra } });
  const tagged = note('新模型发布', ['HN', 'ai']);
  const fed = note('美联储降息对科技股的影响');
  const script = note('三分钟口播脚本怎么写');
  const weather = note('周末天气不错');
  const odd = note('一张奇怪的卡片');
  const placed = note('手动放好的一张', [], { category: '财经' });
  const stale = note('类别已经不在列表里', [], { category: '旧类别' });
  assert.equal(vault.listNotes({ folder: '选题会' }).find((n) => n.path === placed.path).category, '财经');
  assert.equal(vault.getBoard('选题会').columns[0].cards.find((c) => c.path === placed.path).category, '财经', 'the board hands the category out with each card');
  assert.deepEqual(vault.getBoard('选题会').categories, ['AI', '财经', '内容创作']);
  assert.deepEqual(uncategorized(vault, '选题会').map((c) => c.path).sort(), [tagged, fed, script, weather, odd, stale].map((n) => n.path).sort(), 'a name that is no longer on the list counts as unplaced');
  assert.deepEqual(uncategorized(vault, '灵感'), []);
  assert.equal(categoryFromTags(['AI', '财经'], ['hn', 'Ai']), 'AI');
  assert.equal(categoryFromTags(['AI', '财经'], ['模型']), null);
  console.log('ok 2  a card carries its category; unplaced means none, or one that is not on the list');

  // ---- 3. sorting ----
  const updatedBefore = vault.getNote(fed.path).properties.updated;
  const r = await categorize(vault, auth, '选题会');
  const cat = (n) => vault.getNote(n.path).properties.category;
  assert.deepEqual([cat(tagged), cat(fed), cat(script), cat(weather), cat(odd), cat(placed), cat(stale)], ['AI', '财经', '内容创作', undefined, undefined, '财经', '旧类别']);
  assert.deepEqual(r, { done: 3, skipped: 3, left: 3 }, 'the model\'s null and its made-up name place nothing');
  assert.equal(calls, 1, 'one call for the batch; the tagged card needed none');
  assert.ok(!lastUser.includes('新模型发布') && lastUser.includes('美联储') && /- AI\n- 财经\n- 内容创作/.test(lastSystem));
  assert.equal(vault.getNote(fed.path).properties.updated, updatedBefore, 'sorting does not make a card look edited');
  mode = 'garbage';
  assert.deepEqual(await categorize(vault, auth, '选题会'), { done: 0, skipped: 3, left: 3 }, 'an answer that is not the JSON places nothing');
  mode = 'ok';
  await assert.rejects(() => categorize(vault, auth, '灵感'), /还没有设置类别/);
  auth.update((c) => { c.ai.enabled = false; });
  const byTagOnly = note('只靠标签的一张', ['财经']);
  await assert.rejects(() => categorize(vault, auth, '选题会'), /AI 未开启/);
  assert.equal(cat(byTagOnly), '财经', 'with AI off the tag still settles what it can');
  auth.update((c) => { c.ai.enabled = true; });
  console.log('ok 3  sorting: by tag for free, the rest in one batch, only names on the list, cards left unedited');

  // ---- 4. a new card ----
  const router = new Router(vault);
  const c1 = await capture(vault, router, { title: '降息预期升温', text: '市场押注下次会议降息。', notebook: '选题会', tags: ['财经'], source: 'bot' }, { auth });
  assert.equal(vault.getNote(c1.path).properties.category, '财经', 'a tag that names a category settles it at once');
  const c2 = await capture(vault, router, { title: '自己带了类别', text: '正文。', notebook: '选题会', properties: { category: '内容创作' }, source: 'bot' }, { auth });
  assert.equal(vault.getNote(c2.path).properties.category, '内容创作');
  console.log('ok 4  a new card: its tag or its own category property decide');

  // ---- 5. REST ----
  const app = createApp({ vault, auth });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r2) => server.once('listening', r2));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = auth.createToken('owner-test', { scopes: ['read', 'write', 'admin'], folders: ['*'] }).token;
  const reader = auth.createToken('reader', { scopes: ['read'], folders: ['选题会'] }).token;
  const call = async (method, p, token, body) => { const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const url = '/api/categorize/' + encodeURIComponent('选题会');
  note('大模型价格战');
  assert.deepEqual([(await call('GET', url, reader)).body.status, (await call('GET', url, reader)).body.left], ['idle', 4]);
  assert.equal((await call('POST', url, reader, {})).status, 403, 'a read-only token cannot start it');
  const started = await call('POST', url, owner, {});
  assert.deepEqual([started.status, started.body.status], [202, 'running']);
  await categorizeSettled('选题会');
  const after = (await call('GET', url, owner)).body;
  assert.deepEqual([after.status, after.result.done, after.left], ['done', 1, 3]);
  const patched = await call('PATCH', '/api/notes/' + weather.path.split('/').map(encodeURIComponent).join('/'), owner, { category: 'AI' });
  assert.equal(patched.body.properties.category, 'AI', 'dragging a card writes the property');
  const cleared = await call('PATCH', '/api/notes/' + weather.path.split('/').map(encodeURIComponent).join('/'), owner, { category: null });
  assert.equal(cleared.body.properties.category, undefined, 'and dropping it on 未分类 removes it');
  const set = await call('PATCH', '/api/notebooks/' + encodeURIComponent('选题会'), owner, { categories: ['AI', '财经', '内容创作', '生活'] });
  assert.deepEqual(set.body.categories, ['AI', '财经', '内容创作', '生活']);
  assert.deepEqual((await call('GET', '/api/boards/' + encodeURIComponent('选题会'), reader)).body.categories, ['AI', '财经', '内容创作', '生活']);
  console.log('ok 5  REST: start, follow, read-only tokens kept out, the property and the setting through the API');

  console.log('\nall categorize checks passed');
} finally {
  server?.close();
  fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
