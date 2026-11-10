// Smoke test for the git backup: two copies of a vault pushing to one remote. Uses only temp dirs.
// Run: node scripts/smoke-backup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Backup } from '../src/backup.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-backup-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const auth = () => ({ config: { backup: { enabled: true } }, update(fn) { fn(this.config); } });
const other = (root, msg) => { sh(root, 'add', '-A'); sh(root, '-c', 'user.name=other', '-c', 'user.email=other@localhost', 'commit', '-q', '-m', msg); sh(root, 'push', '-q', 'origin', 'main'); };

try {
  const remote = path.join(tmp, 'remote.git');
  const a = path.join(tmp, 'server');
  const b = path.join(tmp, 'laptop');
  fs.mkdirSync(a);
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', remote);

  // first backup from the "server" copy
  write(a, 'notes/one.md', 'line 1\nline 2\nline 3\n');
  write(a, '.notebook/audit.jsonl', '{"ts":"1","n":"base"}\n');
  const bk = new Backup(a, auth());
  await bk.init(remote);
  let st = await bk.run('test');
  assert.equal(st.lastError, null, st.lastError);
  assert.equal(st.lastResult.pushed, true);
  assert.match(read(a, '.gitattributes'), /audit\.jsonl merge=union/);
  sh(tmp, 'clone', '-q', remote, b);

  // 1. the other copy pushes a different file and appends to the audit log; this copy appends too
  write(b, 'notes/two.md', 'from laptop\n');
  fs.appendFileSync(path.join(b, '.notebook/audit.jsonl'), '{"ts":"2","n":"laptop"}\n');
  other(b, 'laptop change');
  write(a, 'notes/three.md', 'from server\n');
  fs.appendFileSync(path.join(a, '.notebook/audit.jsonl'), '{"ts":"3","n":"server"}\n');
  st = await bk.run('test');
  assert.equal(st.lastError, null, st.lastError);
  assert.deepEqual([st.lastResult.pushed, st.lastResult.merged, st.failures], [true, true, 0]);
  assert.equal(read(a, 'notes/two.md'), 'from laptop\n');
  const audit = read(a, '.notebook/audit.jsonl');
  assert.ok(audit.includes('"laptop"') && audit.includes('"server"') && !audit.includes('<<<<'), audit);
  assert.equal(sh(a, 'rev-parse', 'HEAD'), sh(remote, 'rev-parse', 'main'));
  assert.equal((await bk.status()).ahead, 0);
  console.log('ok 1  diverged histories are merged and pushed; audit log keeps both sides');

  // 2. a real conflict: both copies rewrite the same line
  sh(b, 'pull', '-q', 'origin', 'main');
  write(b, 'notes/one.md', 'line 1\nLAPTOP\nline 3\n');
  other(b, 'laptop edits line 2');
  write(a, 'notes/one.md', 'line 1\nSERVER\nline 3\n');
  st = await bk.run('test');
  assert.match(st.lastError, /conflict.*notes\/one\.md/);
  assert.equal(st.failures, 1);
  assert.equal(bk.health().failing, false);
  assert.equal(read(a, 'notes/one.md'), 'line 1\nSERVER\nline 3\n');           // local content untouched
  assert.equal(fs.existsSync(path.join(a, '.git/MERGE_HEAD')), false);          // merge was aborted
  assert.equal(sh(a, 'status', '--porcelain'), '');
  st = await bk.run('test');
  assert.equal(st.failures, 2);
  assert.equal(bk.health().failing, true);
  assert.ok((await bk.status()).ahead >= 1);
  console.log('ok 2  a content conflict is reported, the vault is left untouched, health turns to failing');

  // 3. once someone resolves it, the next run recovers and clears the alarm
  sh(a, 'fetch', '-q', 'origin');
  try { sh(a, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'merge', '-q', 'origin/main'); } catch {}
  write(a, 'notes/one.md', 'line 1\nSERVER\nLAPTOP\nline 3\n');
  sh(a, 'add', '-A'); sh(a, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'resolve');
  st = await bk.run('test');
  assert.equal(st.lastError, null, st.lastError);
  assert.deepEqual([st.failures, bk.health().failing, (await bk.status()).ahead], [0, false, 0]);
  console.log('ok 3  after a manual resolve the backup pushes again and the alarm clears');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
