// Smoke test for the weekly review, "ask my notes" and the chatter guard on AI summaries. Uses only a temp dir;
// the model is a local fake speaking the Messages API, so no real AI call is made.
// Run: node scripts/smoke-review.mjs
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Vault, localDate } from '../src/vault.js';
import { Auth } from '../src/auth.js';
import { Router, capture } from '../src/notebooks.js';
import { isChatter, aiSettings } from '../src/enrich.js';
import { REVIEW_FOLDER, weekOf, addDays, reviewFacts, writeReview, listReviews, splitReview, autoReview, ensureReviewNotebook } from '../src/review.js';
import { timeWindow, retrieve, ask } from '../src/ask.js';
import { createApp } from '../src/web-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-review-'));
const NARRATIVE = ['## 这周你在关注什么', '你在看 agent 的记忆设计，见 [[Agent memory design]] 和 [[No such page]]。', '## 你自己的数据', '睡眠平均 6.5 小时。', '## 处理了什么，积压了什么', '待选里有 2 条。', '## 值得跟进的 3 件事', '1. 写完 [[Fresh draft]]。', '## 记录缺口', '周三没有健康记录。'].join('\n\n');
let server, fake, mode = 'ok', calls = 0;
try {
  // a stand-in model: answers by what the system prompt asks for
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls++;
      const { system = '' } = JSON.parse(raw || '{}');
      if (mode === 'down') { res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"type":"error","error":{"type":"api_error","message":"boom"}}'); return; }
      const text = /每周回顾助手/.test(system) ? (mode === 'chatter' ? '我先查看一下笔记本里的可用接口，然后把回顾写入。' : `好的，下面是回顾：\n\n${NARRATIVE}`)
        : /问答助手/.test(system) ? '这周你在看 agent 的记忆设计 [1]，另外睡眠偏少 [2, 9]。' : '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));

  const vault = new Vault(tmp);
  const auth = new Auth(tmp);
  auth.update((c) => { c.trustLoopback = false; });
  const router = new Router(vault);
  const now = new Date(2026, 10, 12, 10, 0); // Thursday; the week is 11-09 … 11-15

  // 1. chatter guard
  assert.ok(isChatter('Looking up the notebook tools to save this note.'));
  assert.ok(isChatter('我先查看一下笔记工具，再把这条写入。'));
  assert.ok(isChatter('已调用 agent-notebook 写入接口记录该条目', '今天睡了 7 小时'));
  assert.ok(!isChatter('作者认为摆脱上瘾要靠更大的正反馈，而不是自律。'));
  assert.ok(!isChatter('正在上涨的三只代币及其成交量对比。'), 'a summary may start with 正在 when it is about the note');
  assert.ok(!isChatter('agent-notebook 的 MCP 接口新增了周回顾工具', '给 agent-notebook 加一个 notebook_review 工具'), 'a note about the notebook may name it');
  console.log('ok 1  summaries that narrate the model\'s own actions are recognised, real ones are not');

  // 2. weeks
  assert.deepEqual(weekOf('2026-11-12'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(weekOf('2026-11-15'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(weekOf('2026-11-16'), { from: '2026-11-16', to: '2026-11-22' });
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  console.log('ok 2  weeks run Monday to Sunday');

  // data
  vault.createNotebook({ folder: 'Inbox', title: 'Inbox', kind: 'pages', inbox: true });
  vault.createNotebook({ folder: 'Topics', title: 'Topics', kind: 'board', columns: ['Waiting', 'Writing', 'Done'], keywords: ['agent', 'memory', 'draft'] });
  vault.createNotebook({ folder: 'Health', title: 'Health', kind: 'journal', keywords: ['sleep'] });
  vault.createNotebook({ folder: 'Empty', title: 'Empty', kind: 'pages' });
  const note = (folder, title, date, properties = {}, body = '') => vault.createNote({ folder, title, body: body || `${title} body`, properties: { date, ...properties } });
  note('Topics', 'Agent memory design', '2026-11-10', { source: 'Hermes', tags: ['ai'], concepts: ['memory'] }, 'How agents keep long-term memory across sessions.');
  note('Topics', 'Old idea', '2026-10-20', { source: 'Hermes' });
  note('Topics', 'Shipped piece', '2026-11-03', { source: 'Hermes', status: 'Done', tags: ['ai'] });
  note('Topics', 'Fresh draft', '2026-11-11', { source: 'owner', status: 'Writing' }, 'A draft about review habits.');
  note('Inbox', 'Unsorted thing', '2026-11-12', { source: 'Muse' });
  for (const [date, h] of [['2026-11-09', 7], ['2026-11-11', 6], ['2026-11-03', 8]]) await capture(vault, router, { text: `Slept badly, woke twice. [sleep_hours:: ${h}]`, title: 'Sleep', notebook: 'Health', source: 'Cue', date });

  // 3. the generated notebook is not a filing target
  ensureReviewNotebook(vault);
  assert.equal(vault.getNotebookMeta(REVIEW_FOLDER).auto, false);
  assert.equal(vault.getNotebookMeta('Topics').auto, true);
  vault.updateNotebook(REVIEW_FOLDER, { keywords: ['weekly', 'review'] });
  assert.equal(vault.getNotebookMeta(REVIEW_FOLDER).auto, false, 'an edit keeps the flag');
  assert.notEqual(router.classify({ title: 'weekly review of my week', text: 'weekly review review weekly' }).decision, REVIEW_FOLDER);
  console.log('ok 3  a notebook with auto: false is never chosen by the router');

  // 4. facts for a week in progress
  const f = reviewFacts(vault, auth, { now });
  assert.deepEqual(f.period, { from: '2026-11-09', to: '2026-11-15', through: '2026-11-12', days: 4, span: 7, complete: false, prevFrom: '2026-11-02', prevTo: '2026-11-05' });
  assert.deepEqual([f.totals.added, f.totals.prev, f.totals.own], [5, 2, 1], 'two topics, two sleep entries and one inbox item this week; one topic and one entry in the same days last week');
  assert.ok(!f.notebooks.some((n) => n.folder === REVIEW_FOLDER), 'the reviews are not counted as records');
  const board = f.backlog.boards[0];
  assert.deepEqual([board.waiting, board.stale, board.addedWaiting, board.columns.map((c) => c.count)], [2, 1, 1, [2, 1, 1]]);
  assert.deepEqual([f.backlog.inbox.count, f.backlog.inbox.added], [1, 1]);
  const sleep = f.metrics[0].keys.find((k) => k.key === 'sleep_hours');
  assert.deepEqual([sleep.avg, sleep.prevAvg, sleep.delta, sleep.days], [6.5, 8, -1.5, 2]);
  assert.deepEqual([f.coverage[0].days, f.coverage[0].of, f.coverage[0].silent], [2, 4, 1]);
  assert.deepEqual(f.quiet.map((q) => q.title), ['Empty']);
  assert.deepEqual(f.themes.tags.find((t) => t.name === 'ai'), { name: 'ai', count: 1, new: false });
  assert.deepEqual(f.themes.concepts[0], { name: 'memory', count: 1, new: true });
  const limited = reviewFacts(vault, auth, { now, can: (p) => !p.startsWith('Health'), activity: false });
  assert.deepEqual([limited.totals.added, limited.metrics.length, limited.activity], [3, 0, null], 'a token sees only its own notebooks and never the audit trail');
  console.log('ok 4  review facts: counts, same-days comparison, backlog, metrics, coverage, themes, scoping');

  // 5. AI off: a data-only page, rewritten in place
  assert.equal(aiSettings(auth).enabled, false);
  const first = await writeReview(vault, auth, { now });
  assert.deepEqual([first.created, first.narrative, first.path.startsWith(REVIEW_FOLDER + '/')], [true, false, true]);
  let page = vault.getNote(first.path);
  assert.deepEqual([page.properties.period_from, page.properties.through, page.properties.complete, page.properties.notes_added, page.properties.waiting], ['2026-11-09', '2026-11-12', false, 5, 2]);
  assert.deepEqual([splitReview(page.body).narrative, /AI 未开启/.test(splitReview(page.body).head), /Topics \|/.test(page.body)], ['', true, true]);
  const again = await writeReview(vault, auth, { now });
  assert.deepEqual([again.created, again.path, listReviews(vault).length], [false, first.path, 1]);
  assert.equal(reviewFacts(vault, auth, { now }).totals.added, 5, 'the review page itself is not a record of the week');
  console.log('ok 5  with AI off the review is a data page, one per week, updated in place');

  // 6. AI on: narrative first, dead links defused, kept when a later attempt fails
  auth.update((c) => { c.ai = { enabled: true, provider: 'api', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'fake-model' }; });
  assert.equal(aiSettings(auth).enabled, true);
  const logged = [];
  const written = await writeReview(vault, auth, { now, log: (e) => logged.push(e) });
  assert.deepEqual([written.narrative, written.model, written.created], [true, 'fake-model', false]);
  page = vault.getNote(written.path);
  let parts = splitReview(page.body);
  assert.ok(parts.narrative.startsWith('## 这周你在关注什么'), 'the preamble before the first section is dropped');
  assert.ok(parts.narrative.includes('[[Agent memory design]]') && parts.narrative.includes('「No such page」') && !parts.narrative.includes('[[No such page]]'));
  assert.ok(parts.data.startsWith('## 数据') && /fake-model/.test(parts.head));
  assert.deepEqual([page.properties.ai_model, page.properties.narrative_through, page.properties.attempts], ['fake-model', '2026-11-12', undefined]);
  assert.ok(logged.some((e) => e.event === 'ai:review' && e.ok));
  mode = 'chatter';
  const chatter = await writeReview(vault, auth, { now: new Date(2026, 10, 13, 10, 0), log: (e) => logged.push(e) });
  assert.deepEqual([chatter.narrative, !!chatter.error], [false, true]);
  assert.ok(logged.some((e) => e.event === 'ai:chatter'));
  page = vault.getNote(written.path);
  parts = splitReview(page.body);
  assert.ok(parts.narrative.startsWith('## 这周你在关注什么') && /文字是 2026-11-12 写的/.test(parts.head), 'a failed rewrite keeps the earlier words and says how old they are');
  assert.deepEqual([page.properties.through, page.properties.narrative_through, page.properties.ai_model], ['2026-11-13', '2026-11-12', 'fake-model']);
  mode = 'ok';
  console.log('ok 6  with AI on the page leads with the narrative; self-talk is rejected and never replaces a good one');

  // 7. the scheduler writes last week's review once it is over, and stops retrying
  const monday = new Date(2026, 10, 16, 9, 0);
  assert.equal(await autoReview(vault, auth, { now: new Date(2026, 10, 16, 6, 0) }), null, 'Monday before 07:00 waits for the night\'s records');
  const auto = await autoReview(vault, auth, { now: monday });
  assert.deepEqual([auto.period.from, auto.period.complete, auto.narrative, auto.created], ['2026-11-09', true, true, false]);
  assert.equal(vault.getNote(auto.path).properties.narrative_through, '2026-11-15');
  const before = calls;
  assert.equal(await autoReview(vault, auth, { now: monday }), null, 'a finished review is not rewritten');
  assert.equal(calls, before);
  mode = 'down';
  vault.deleteNote(auto.path);
  for (let i = 1; i <= 3; i++) assert.equal((await autoReview(vault, auth, { now: monday })).narrative, false);
  assert.equal(vault.getNote(listReviews(vault)[0].path).properties.attempts, 3);
  assert.equal(await autoReview(vault, auth, { now: monday }), null, 'three failed attempts are enough');
  auth.update((c) => { c.review = { auto: false }; });
  vault.deleteNote(listReviews(vault)[0].path);
  assert.equal(await autoReview(vault, auth, { now: monday }), null, 'review.auto: false turns the schedule off');
  auth.update((c) => { delete c.review; });
  mode = 'ok';
  console.log('ok 7  the weekly schedule: waits for Monday morning, writes once, gives up after three failures, can be disabled');

  // 8. asking: time words, ranking, scoping, citations
  assert.deepEqual(timeWindow('上周睡得怎么样', '2026-11-12'), { from: '2026-11-02', to: '2026-11-08', label: '上周' });
  assert.deepEqual(timeWindow('这周我关注了什么', '2026-11-12'), { from: '2026-11-09', to: '2026-11-12', label: '这周' });
  assert.deepEqual(timeWindow('11月3日发生了什么', '2026-11-12'), { from: '2026-11-03', to: '2026-11-03', label: '2026-11-03' });
  assert.deepEqual(timeWindow('12月3日发生了什么', '2026-11-12').from, '2025-12-03', 'a date later this year means last year');
  assert.equal(timeWindow('agent memory', '2026-11-12'), null);
  const found = retrieve(vault, 'agent memory design', { now });
  assert.equal(found.hits[0].title, 'Agent memory design');
  assert.ok(found.hits[0].n === 1 && found.hits[0].notebook.title === 'Topics' && found.hits[0].excerpt.includes('long-term memory'));
  const lastWeekSleep = retrieve(vault, '上周 sleep 怎么样', { now });
  assert.deepEqual([lastWeekSleep.hits[0].date, lastWeekSleep.hits[0].notebook.title, lastWeekSleep.window.label], ['2026-11-03', 'Health', '上周'], 'a journal page is searched entry by entry and the time window wins');
  assert.ok(retrieve(vault, 'sleep', { now, can: (p) => !p.startsWith('Health') }).hits.every((h) => h.notebook?.title !== 'Health'));
  assert.equal(retrieve(vault, 'zzzz qqqq', { now }).hits.length, 0);
  const answered = await ask(vault, auth, 'agent memory design', { now });
  assert.deepEqual([answered.ai, answered.model, /\[1\]/.test(answered.answer), answered.sources[0].title, 'score' in answered.sources[0]], [true, 'fake-model', true, 'Agent memory design', false]);
  const nothing = await ask(vault, auth, 'zzzz qqqq', { now });
  assert.deepEqual([nothing.answer, nothing.empty, nothing.sources.length], [null, true, 0]);
  mode = 'down';
  const failed = await ask(vault, auth, 'agent memory design', { now });
  assert.deepEqual([failed.answer, failed.ai, !!failed.error, failed.sources.length > 0], [null, false, true, true], 'a failed call still returns the notes it found');
  mode = 'ok';
  console.log('ok 8  ask: time windows, per-entry retrieval, read scoping, cited answer, graceful failure');

  // 9. REST round trip
  const app = createApp({ vault, auth });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = auth.createToken('admin', { scopes: ['read', 'write', 'admin'] }).token;
  const narrow = auth.createToken('topics-only', { scopes: ['read', 'write'], folders: ['Topics'] }).token;
  const call = async (method, url, body, token = admin) => {
    const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const thisWeek = weekOf(localDate(new Date()));
  let r = await call('GET', '/api/review');
  assert.deepEqual([r.status, r.body.latest, r.body.thisWeek, r.body.aiEnabled], [200, null, thisWeek, true]);
  r = await call('POST', '/api/review', { period: 'this' });
  assert.deepEqual([r.status, r.body.narrative, r.body.period.from, r.body.title.startsWith('周回顾 ')], [201, true, thisWeek.from, true]);
  r = await call('POST', '/api/review', { period: 'this' });
  assert.equal(r.status, 200, 'the second run updates the same page');
  r = await call('GET', '/api/review');
  assert.deepEqual([r.body.latest.from, r.body.latest.narrative.startsWith('## 这周你在关注什么'), r.body.latest.data.startsWith('## 数据'), r.body.list.length], [thisWeek.from, true, true, 1]);
  r = await call('GET', '/api/review/facts?from=2026-11-09');
  assert.deepEqual([r.status, r.body.period.to, r.body.totals.added, typeof r.body.activity.total], [200, '2026-11-15', 5, 'number']);
  r = await call('POST', '/api/ask', { question: 'agent memory design' });
  assert.deepEqual([r.status, r.body.ai, r.body.sources[0].title, r.body.aiEnabled], [200, true, 'Agent memory design', true]);
  assert.ok(listReviews(vault).length === 1 && !retrieve(vault, '这周你在关注什么 agent 记忆设计').hits.some((h) => h.path.startsWith(REVIEW_FOLDER + '/')), 'a review is never its own source');
  assert.ok(!(await call('GET', `/api/today?date=${localDate(new Date())}`)).body.groups.some((g) => g.notebook.folder === REVIEW_FOLDER), 'nor part of the day\'s feed');
  assert.equal((await call('POST', '/api/ask', {})).status, 400);
  // a token limited to one notebook cannot run vault-wide questions or write reviews
  assert.equal((await call('POST', '/api/ask', { question: 'sleep' }, narrow)).status, 403);
  assert.equal((await call('POST', '/api/review', { period: 'this' }, narrow)).status, 403);
  assert.equal((await call('GET', '/api/review', null, narrow)).status, 403);
  const nbs = (await call('GET', '/api/notebooks')).body;
  assert.equal(nbs.find((n) => n.folder === REVIEW_FOLDER).auto, false, 'the UI can tell generated notebooks apart');
  const spec = await (await fetch(base + '/openapi.json')).json();
  assert.ok(JSON.stringify(spec).includes('/api/ask') && !JSON.stringify(spec.paths['/api/capture'] || {}).includes(REVIEW_FOLDER), 'agents are not offered the review notebook as a capture target');
  assert.ok(auth.readAudit({ limit: 50 }).some((e) => e.action === 'review'));
  console.log('ok 9  REST: /api/review, /api/review/facts and /api/ask, with folder-limited tokens kept out');

  console.log('\nall review checks passed');
} finally {
  server?.close();
  fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
