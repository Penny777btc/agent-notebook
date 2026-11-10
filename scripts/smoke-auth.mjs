// Smoke test for config.json handling (src/auth.js) and agent-name resolution (src/agent-id.js). Uses only a temp dir.
// Run: node scripts/smoke-auth.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Auth } from '../src/auth.js';
import { resolveSource, decodeHeader } from '../src/agent-id.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-auth-'));
try {
  const auth = new Auth(tmp);
  const cfgPath = path.join(tmp, '.notebook', 'config.json');
  const files = () => fs.readdirSync(path.join(tmp, '.notebook')).sort();
  const onDisk = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  // 1. writes are atomic: no temp files left behind, private mode on a fresh file, an existing mode is kept
  const { token } = auth.createToken('bot', { scopes: ['read', 'write'] });
  auth.setPassword('correct horse');
  assert.deepEqual(files(), ['config.json']);
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
  fs.chmodSync(cfgPath, 0o640);
  auth.update((c) => { c.marker = 1; });
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o640);
  assert.equal(onDisk().marker, 1);
  console.log('ok 1  config.json is replaced by rename, leaves no temp files and keeps its mode');

  // 2. a write that fails part-way leaves the previous file untouched and cleans up
  const before = fs.readFileSync(cfgPath, 'utf8');
  const cyclic = {}; cyclic.self = cyclic; // JSON.stringify throws after the temp file was opened
  assert.throws(() => auth.update((c) => { c.bad = cyclic; }));
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);
  assert.deepEqual(files(), ['config.json']);
  assert.ok(auth.verifyPassword('correct horse') && auth.authenticate(token));
  console.log('ok 2  a failed write keeps the old config (tokens and password still work)');

  // 3. authenticating does not rewrite the file on every request
  let writes = 0;
  const realWrite = auth.write.bind(auth);
  auth.write = (c) => { writes += 1; realWrite(c); };
  auth.update((c) => { c.tokens[0].lastUsed = null; }); writes = 0;
  for (let i = 0; i < 50; i += 1) assert.equal(auth.authenticate(token).name, 'bot');
  assert.equal(writes, 1, `expected one lastUsed write for 50 requests, got ${writes}`);
  assert.ok(Date.now() - Date.parse(onDisk().tokens[0].lastUsed) < 5000);
  auth.update((c) => { c.tokens[0].lastUsed = new Date(Date.now() - 6 * 60 * 1000).toISOString(); }); writes = 0;
  auth.authenticate(token); auth.authenticate(token);
  assert.equal(writes, 1);
  assert.equal(auth.authenticate('nb_wrong'), null);
  console.log('ok 3  50 authenticated requests cause one write; lastUsed refreshes again after five minutes');

  // 4. agent names: UTF-8 headers, percent-encoding, look-alike folding
  const latin1 = (s) => Buffer.from(s, 'utf8').toString('latin1'); // what Node hands us for a UTF-8 header
  const principal = { name: 'phone-agents' };
  assert.equal(resolveSource({ header: latin1('热门搜索'), principal }), '热门搜索');
  assert.equal(resolveSource({ header: latin1('𝕏'), principal }), 'X');
  assert.equal(resolveSource({ header: '%E7%83%AD%E9%97%A8%E6%90%9C%E7%B4%A2', principal }), '热门搜索');
  assert.equal(resolveSource({ header: 'Grok Bot', principal }), 'Grok Bot');
  assert.equal(decodeHeader('caf\xe9'), 'caf\xe9');            // real latin1 is not valid UTF-8: left alone
  assert.equal(decodeHeader('100% done'), '100% done');        // a stray percent sign is not an escape
  assert.equal(resolveSource({ explicit: 'Ｇｒｏｋ', principal }), 'Grok');
  assert.equal(resolveSource({ explicit: 'phone-agents', header: '', principal }), 'phone-agents');
  assert.equal([...resolveSource({ explicit: '😀'.repeat(60), principal })].length, 40); // cut on a code point, never mid-emoji
  assert.ok(!resolveSource({ explicit: '😀'.repeat(60), principal }).includes('�'));
  console.log('ok 4  non-ASCII agent names arrive intact; "𝕏" and full-width forms fold into the plain name');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
