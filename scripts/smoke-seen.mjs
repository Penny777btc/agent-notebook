// Smoke test for unread marks (src/seen.js) and their REST surface. Uses only a temp dir.
// Run: node scripts/smoke-seen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault.js';
import { Auth } from '../src/auth.js';
import { ReadState } from '../src/seen.js';
import { createApp } from '../src/web-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-seen-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
try {
  const vault = new Vault(tmp);
  const auth = new Auth(tmp);
  auth.update((c) => { c.trustLoopback = false; });
  vault.createNotebook({ folder: 'Ideas', title: 'Ideas', kind: 'pages' });
  vault.createNotebook({ folder: 'Board', title: 'Board', kind: 'board' });
  const old = vault.createNote({ folder: 'Ideas', title: 'Old note', body: 'was here before' });
  await sleep(5);

  // 1. first run: what is already in the vault is not news
  const seen = new ReadState(vault);
  assert.equal(seen.unread().total, 0);
  assert.ok(fs.existsSync(path.join(tmp, '.notebook', 'seen.json')));
  console.log('ok 1  on first run the existing notes count as seen');

  // 2. later writes are unread, counted per notebook; a note mark, a notebook mark and "all" each clear their part
  await sleep(5);
  const a = vault.createNote({ folder: 'Ideas', title: 'A', body: 'x' });
  const b = vault.createNote({ folder: 'Ideas', title: 'B', body: 'x' });
  const c = vault.createNote({ folder: 'Board', title: 'C', body: 'x' });
  let u = seen.unread();
  assert.deepEqual([u.total, u.folders], [3, { Ideas: 2, Board: 1 }]);
  await sleep(5);
  seen.mark({ path: a.path });
  assert.deepEqual(seen.unread().paths.sort(), [b.path, c.path].sort());
  seen.mark({ folder: 'Ideas' });
  assert.deepEqual(seen.unread().paths, [c.path]);
  assert.deepEqual(seen.load().notes, {}, 'the note mark is dropped once the notebook mark covers it');
  await sleep(5);
  vault.updateNote(old.path, { append: 'an agent added this' });
  assert.deepEqual(seen.unread().paths.sort(), [old.path, c.path].sort());
  seen.mark({ all: true });
  assert.equal(seen.unread().total, 0);
  assert.deepEqual(seen.load().notebooks, {});
  console.log('ok 2  note / notebook / all marks clear exactly what they cover, and an update makes a read note unread again');

  // 3. `at` marks only up to that moment, and marks never move backwards
  await sleep(5);
  const loadedAt = new Date().toISOString();
  await sleep(5);
  const late = vault.createNote({ folder: 'Ideas', title: 'Arrived after the list was loaded', body: 'x' });
  seen.mark({ all: true, at: loadedAt });
  assert.deepEqual(seen.unread().paths, [late.path]);
  seen.mark({ all: true });
  seen.mark({ all: true, at: loadedAt });
  assert.equal(seen.unread().total, 0);
  console.log('ok 3  marking with a load time keeps later arrivals unread; an older mark cannot undo a newer one');

  // 4. REST: agents see the list but cannot mark; the owner's browser can; the owner's own edits are not news
  const app = createApp({ vault, auth, backup: { status: async () => ({}), health: () => ({}) } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = auth.createToken('bot', { scopes: ['read', 'write'] }).token;
  auth.setPassword('correct horse');
  const device = auth.login('correct horse', { device: 'browser' }).token;
  const call = async (token, method, url, body) => {
    const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  await sleep(5);
  const made = (await call(agent, 'POST', '/api/notes', { folder: 'Ideas', title: 'From the bot', body: 'news' })).body;
  assert.deepEqual((await call(device, 'GET', '/api/unread')).body.paths, [made.path]);
  const withItems = (await call(device, 'GET', '/api/unread?items=1')).body;
  assert.equal(withItems.items[0].title, 'From the bot');
  assert.equal((await call(agent, 'POST', '/api/seen', { all: true })).status, 403);
  assert.equal((await call(device, 'GET', '/api/unread')).body.total, 1, 'an agent cannot mark things read');
  const v1 = (await call(device, 'GET', '/api/version')).body.v;
  await sleep(20);
  assert.equal((await call(device, 'POST', '/api/seen', { path: made.path })).body.total, 0);
  assert.notEqual((await call(device, 'GET', '/api/version')).body.v, v1, 'marking read moves the change counter so other devices refresh');
  console.log('ok 4  agents can read the unread list but only the owner\'s browser can mark it');

  await sleep(5);
  const mine = (await call(device, 'POST', '/api/notes', { folder: 'Ideas', title: 'Written by the owner', body: 'x' })).body;
  await call(device, 'PATCH', '/api/notes/' + encodeURIComponent(old.path), { append: 'the owner edits a note they had read' });
  const moved = (await call(device, 'POST', '/api/move', { path: mine.path, folder: 'Board', learn: false })).body;
  assert.equal((await call(device, 'GET', '/api/unread')).body.total, 0, 'the owner\'s own create / edit / move is not news');
  await sleep(5);
  await call(agent, 'PATCH', '/api/notes/' + encodeURIComponent(old.path), { append: 'the agent adds something' });
  await sleep(5);
  await call(device, 'PATCH', '/api/notes/' + encodeURIComponent(old.path), { append: 'the owner edits before reading it' });
  const movedAgain = (await call(device, 'POST', '/api/move', { path: old.path, folder: 'Board', learn: false })).body;
  assert.deepEqual((await call(device, 'GET', '/api/unread')).body.paths, [movedAgain.path], 'unseen agent writes stay unread through the owner\'s edit and move');
  assert.ok(moved.path.startsWith('Board/'));
  console.log('ok 5  the owner\'s own writes do not create unread marks, and do not hide unseen agent writes');

  console.log('\nall unread-mark checks passed');
} finally {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
