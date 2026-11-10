// Smoke test for a notebook's fixed tags (route_tags) and its default view. Uses only a temp dir.
// Run: node scripts/smoke-route.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault.js';
import { Auth } from '../src/auth.js';
import { Router, capture } from '../src/notebooks.js';
import { createApp } from '../src/web-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-route-'));
let server;
try {
  const vault = new Vault(tmp);
  const auth = new Auth(tmp);
  auth.update((c) => { c.trustLoopback = false; });
  const router = new Router(vault);
  vault.createNotebook({ folder: 'Topics', title: 'Topics', kind: 'board', keywords: ['content', 'release', 'article'] });
  vault.createNotebook({ folder: 'Leads', title: 'Leads', kind: 'board', keywords: ['token', 'etf'] });
  router.learn({ tags: ['ai', 'crypto'] }, 'Topics', { strong: false });

  // 1. the fields are stored clean, come back from the meta, and can be cleared
  const news = vault.createNotebook({ folder: 'News', title: 'News', kind: 'pages', route_tags: ['#Brief', ' brief ', '', 'X监控'], view: 'timeline' });
  assert.deepEqual([news.route_tags, news.view], [['Brief', 'X监控'], 'timeline']);
  assert.throws(() => vault.updateNotebook('News', { view: 'sideways' }), /view must be one of/);
  assert.deepEqual(vault.updateNotebook('News', { title: 'Daily news' }).route_tags, ['Brief', 'X监控'], 'an unrelated edit keeps them');
  const cleared = vault.updateNotebook('News', { route_tags: [], view: null });
  assert.deepEqual([cleared.route_tags, cleared.view], [[], null]);
  assert.ok(!/route_tags|view/.test(fs.readFileSync(path.join(tmp, 'News', '_notebook.md'), 'utf8')), 'unset fields are not written');
  vault.updateNotebook('News', { route_tags: ['Brief', 'X监控'], view: 'timeline' });
  assert.deepEqual(vault.getNotebookMeta('Topics').route_tags, []);
  console.log('ok 1  route_tags and view are cleaned, validated, kept across edits and can be cleared');

  // 2. a fixed tag beats learned tags and keyword hits, whatever its case
  const item = { title: 'New model release', text: 'An article about the release, with content on ETF flows and a token.', tags: ['brief', 'ai', 'crypto'] };
  const without = router.classify({ ...item, tags: ['ai', 'crypto'] });
  assert.equal(without.pinned, false);
  assert.notEqual(without.decision, 'News');
  const hit = router.classify(item);
  assert.deepEqual([hit.decision, hit.pinned, hit.strong], ['News', true, true]);
  assert.match(hit.candidates[0].reasons[0], /#Brief/);
  assert.equal(router.classify({ title: 'x', text: 'y', tags: ['x监控'] }).decision, 'News');
  console.log('ok 2  a note carrying a fixed tag goes to that notebook ahead of learned rules and keywords');

  // 3. two notebooks claiming the same note cancel out; a tag in the text alone is not a tag
  vault.updateNotebook('Leads', { route_tags: ['brief'] });
  const clash = router.classify(item);
  assert.equal(clash.pinned, false);
  vault.updateNotebook('Leads', { route_tags: [] });
  assert.equal(router.classify({ title: 'The brief was late', text: 'brief brief', tags: [] }).pinned, false);
  console.log('ok 3  a clash between two notebooks is not settled by the tag, and only real tags count');

  // 4. capture files it there as a page; an explicit notebook still wins; untagged captures behave as before
  const filed = await capture(vault, router, { ...item, source: 'bot' }, { auth });
  assert.deepEqual([filed.notebook.folder, filed.mode], ['News', 'auto']);
  assert.ok(filed.path.startsWith('News/'));
  assert.equal(vault.getNote(filed.path).properties.captured, 'auto');
  const hashed = await capture(vault, router, { title: 'Tagged in the text', text: 'Markets fell again #brief', source: 'bot' }, { auth });
  assert.equal(hashed.notebook.folder, 'News', 'a #hashtag in the text is a tag');
  const told = await capture(vault, router, { ...item, title: 'Sent elsewhere', notebook: 'Leads', source: 'bot' }, { auth });
  assert.deepEqual([told.notebook.folder, told.mode], ['Leads', 'explicit']);
  console.log('ok 4  capture follows the fixed tag, and an explicit notebook still overrides it');

  // 5. REST: the fields round-trip through create, read and update
  const app = createApp({ vault, auth, backup: { status: async () => ({}), health: () => ({}) } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = auth.createToken('admin', { scopes: ['read', 'write', 'admin'] }).token;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const made = await call('POST', '/api/notebooks', { folder: 'Watch', title: 'Watch', kind: 'pages', route_tags: ['watchlist'], view: 'timeline' });
  assert.deepEqual([made.status, made.body.route_tags, made.body.view], [201, ['watchlist'], 'timeline']);
  assert.equal((await call('PATCH', '/api/notebooks/Watch', { view: 'grid' })).status, 400);
  const patched = await call('PATCH', '/api/notebooks/Watch', { route_tags: ['watchlist', 'handles'], view: null });
  assert.deepEqual([patched.body.route_tags, patched.body.view], [['watchlist', 'handles'], null]);
  const listed = (await call('GET', '/api/notebooks')).body.find((n) => n.folder === 'Watch');
  assert.deepEqual(listed.route_tags, ['watchlist', 'handles']);
  const viaApi = await call('POST', '/api/capture', { text: 'someone followed someone', title: 'A new follow', tags: ['handles'] });
  assert.equal(viaApi.body.notebook.folder, 'Watch');
  console.log('ok 5  the REST API creates, updates and lists the fields, and captures follow them');

  console.log('\nall fixed-tag routing checks passed');
} finally {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
