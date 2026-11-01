// Agent Notebook web UI — vanilla JS, hash routing, talks to /api.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const localDate = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => localDate();
const shiftDate = (iso, days) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days); return localDate(d); };
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '';
const fmtClock = (iso) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
const SYSTEM_PROPS = ['title', 'status', 'tags', 'source', 'sources', 'date', 'created', 'updated', 'captured', 'suggested', 'entries'];
const KIND_LABEL = { board: '看板', journal: '日志', pages: '页面集' };
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

const TOKEN_KEY = 'nb_token';
const authToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
async function api(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const tok = authToken();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new Error(data.error || '需要登录'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------------------------------------------------------- phone / remote login
let loginShown = false;
async function showLogin() {
  if (loginShown) return;
  loginShown = true;
  if (authToken()) { try { localStorage.removeItem(TOKEN_KEY); } catch {} }
  const access = await fetch('/api/access').then((r) => r.json()).catch(() => ({}));
  const overlay = el('div', { class: 'login' });
  const pw = el('input', { type: 'password', placeholder: '访问密码', autocomplete: 'current-password', style: 'width:100%;height:44px;font-size:16px;border-radius:12px;padding:0 14px' });
  const msg = el('div', { class: 'muted', style: 'font-size:13px;min-height:18px' });
  const go = async () => {
    if (!pw.value) { pw.focus(); return; }
    msg.textContent = '登录中…';
    try {
      const device = /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : /Android/.test(navigator.userAgent) ? 'android' : 'browser';
      const r = await api('POST', '/api/login', { password: pw.value, device });
      localStorage.setItem(TOKEN_KEY, r.token);
      location.reload();
    } catch (err) { msg.textContent = err.message; msg.className = 'err'; pw.select(); }
  };
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  overlay.append(el('div', { class: 'login-box' },
    el('div', { style: 'font-size:44px;line-height:1' }, '📓'),
    el('h1', { style: 'font-size:24px;font-weight:700;letter-spacing:-.02em;margin:10px 0 4px' }, 'Agent Notebook'),
    access.passwordSet
      ? [el('p', { class: 'muted', style: 'margin:0 0 18px;font-size:14px' }, '输入在 Mac 上设置的访问密码'), pw, el('button', { class: 'btn primary', style: 'width:100%;height:44px;font-size:16px;border-radius:12px;margin-top:12px', onclick: go }, '登录'), el('div', { style: 'margin-top:10px' }, msg)]
      : el('p', { class: 'muted', style: 'font-size:14px;line-height:1.6' }, '这台笔记本还没有设置访问密码。请先在 Mac 上打开 Agent Notebook，到 设置 → 手机访问 里设置一个，再回来登录。')));
  document.body.append(overlay);
  setTimeout(() => pw.focus(), 50);
}
function logout() { try { localStorage.removeItem(TOKEN_KEY); } catch {} location.reload(); }
const get = (u) => api('GET', u);
const notePath = (p) => '/api/notes/' + encPath(p);

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden'); t.style.background = isErr ? 'var(--danger)' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------- markdown + [[wikilinks]]
/** "news.google.com/rss/articles/CBMi…" — a short, readable stand-in for a bare URL. */
function urlLabel(href, max = 28) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '');
    let path = (u.pathname + (u.search && u.pathname.length < 8 ? u.search : '')).replace(/\/$/, '');
    if (path.length <= 1) return host;
    const room = Math.max(6, max - host.length);
    return host + (path.length > room ? path.slice(0, room - 1) + '…' : path);
  } catch { return href; }
}
const cleanExcerpt = (t, n = 140) => String(t || '').replace(/https?:\/\/[^\s)）\]]+/g, (m) => urlLabel(m, 22)).slice(0, n);

function linkify(md) {
  return String(md || '').replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, name, label) => {
    const target = state.linkIndex[name.trim().toLowerCase()];
    const text = esc((label || name).trim());
    return target
      ? `<a class="wikilink" href="#/note/${encodeURIComponent(target)}" title="${esc(target)}">${text}</a>`
      : `<a class="wikilink missing" href="#" data-missing="${esc(name.trim())}" title="还没有这一页">${text}</a>`;
  }).replace(/\[([^\[\]:\n]{1,40}?)::\s*([^\]\n]+?)\]/g, (m, k, v) => `<span class="field"><span class="fk">${esc(k.trim())}</span>${esc(v.trim())}</span>`); // [amount:: 35] inline fields
}
function renderMd(md, { journal = false } = {}) {
  const html = marked.parse(linkify(md), { gfm: true, breaks: true });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,style').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => { for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (a.name === 'href' && /^javascript:/i.test(a.value))) n.removeAttribute(a.name); });
  doc.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = '_blank'; a.rel = 'noopener';
    const text = a.textContent.trim();
    if (/^https?:\/\//.test(text) || text === a.getAttribute('href')) { a.title = a.getAttribute('href'); a.textContent = urlLabel(a.getAttribute('href')); a.classList.add('url'); }
  });
  if (journal) journalEntriesHtml(doc);
  return doc.body.innerHTML;
}
/** Journal pages: each "## HH:MM · title <small>source</small>" plus what follows becomes a readable entry block. */
function journalEntriesHtml(doc) {
  const body = doc.body;
  let ebody = null;
  const nodes = [...body.childNodes];
  const isHead = (n) => n.nodeType === 1 && n.tagName === 'H2' && /^\s*\d{2}:\d{2}/.test(n.textContent);
  if (!nodes.some(isHead)) return;
  body.innerHTML = '';
  let section = null;
  for (const n of nodes) {
    if (isHead(n)) {
      section = doc.createElement('section'); section.className = 'entry';
      const small = n.querySelector('small'); const source = small ? small.textContent.trim() : ''; if (small) small.remove();
      const m = n.textContent.trim().match(/^(\d{2}:\d{2})\s*(?:·\s*(.*))?$/s);
      const head = doc.createElement('div'); head.className = 'entry-head';
      const time = doc.createElement('span'); time.className = 'time'; time.textContent = m ? m[1] : '';
      const title = doc.createElement('span'); title.className = 'etitle'; title.textContent = (m && m[2] ? m[2] : '').trim();
      head.append(time, title);
      if (source) { const chip = doc.createElement('span'); chip.className = 'chip source'; chip.textContent = source; head.append(chip); }
      ebody = doc.createElement('div'); ebody.className = 'ebody';
      section.append(head, ebody);
      body.append(section);
    } else if (section) ebody.append(n);
    else body.append(n);
  }
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a.wikilink.missing');
  if (!a) return;
  e.preventDefault();
  const name = a.dataset.missing;
  if (!confirm(`还没有「${name}」这一页，现在创建？`)) return;
  const n = await api('POST', '/api/notes', { folder: state.notebooks.find((x) => x.kind === 'pages' && !x.inbox)?.folder || '', title: name, body: '' });
  await loadSidebar(); location.hash = `#/note/${encodeURIComponent(n.path)}`;
});

// ---------------------------------------------------------------- state
const state = { notebooks: [], tree: [], linkIndex: {}, route: null, routeKey: '', openFolders: new Set(JSON.parse(localStorage.getItem('openFolders') || '[]')), feedDate: today() };

async function loadSidebar() {
  [state.notebooks, state.tree, state.linkIndex] = await Promise.all([get('/api/notebooks'), get('/api/tree'), get('/api/links/index')]);
  get('/api/ai').then((a) => { state.ai = a; }).catch(() => { state.ai = null; });
  renderSidebar();
}
const nbOf = (folder) => state.notebooks.find((n) => n.folder === folder);
const nbHref = (folder) => `#/nb/${encodeURIComponent(folder)}`;

function renderSidebar() {
  const list = $('#notebook-list'); list.innerHTML = '';
  for (const nb of state.notebooks) {
    list.append(el('a', { class: 'side-item', href: nbHref(nb.folder), 'data-route': `nb:${nb.folder}` },
      el('span', { class: 'emoji' }, nb.icon), nb.title,
      nb.inbox && nb.count ? el('span', { class: 'badge' }, nb.count) : el('span', { class: 'count' }, nb.count || '')));
  }
  const tree = $('#tree'); tree.innerHTML = '';
  const rest = state.tree.filter((it) => !(it.type === 'folder' && it.isNotebook));
  tree.append(renderTree(rest));
  if (!rest.length) tree.append(el('div', { class: 'empty' }, '没有笔记本之外的页面'));
  markActive();
}

function renderTree(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.type === 'folder') {
      const wrap = el('div', { class: 'tree-folder' + (state.openFolders.has(it.path) ? ' open' : '') });
      const row = el('a', { class: 'side-item', href: it.isNotebook ? nbHref(it.path) : `#/folder/${encodeURIComponent(it.path)}`, 'data-route': (it.isNotebook ? 'nb:' : 'folder:') + it.path },
        el('span', { class: 'caret', onclick: (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.toggle('open'); wrap.classList.contains('open') ? state.openFolders.add(it.path) : state.openFolders.delete(it.path); localStorage.setItem('openFolders', JSON.stringify([...state.openFolders])); } }, '▶'),
        el('span', { class: 'emoji' }, it.isNotebook ? it.notebook.icon : '📁'), it.name,
        el('span', { class: 'count' }, countNotes(it)));
      wrap.append(row, el('div', { class: 'tree-children' }, renderTree(it.children)));
      frag.append(wrap);
    } else {
      frag.append(el('a', { class: 'side-item', href: `#/note/${encodeURIComponent(it.path)}`, 'data-route': 'note:' + it.path }, el('span', { class: 'emoji' }, '📄'), it.title));
    }
  }
  return frag;
}
const countNotes = (f) => f.children.reduce((n, c) => n + (c.type === 'note' ? 1 : countNotes(c)), 0);
function markActive() { document.querySelectorAll('.side-item').forEach((a) => a.classList.toggle('active', a.dataset.route === state.routeKey)); }

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [kind, ...restParts] = h.split('/');
  return { kind: kind || 'home', arg: restParts.join('/') };
}
async function route() {
  const r = parseHash();
  if (r.kind === 'board') { location.replace(nbHref(r.arg)); return; }
  state.route = r;
  state.routeKey = ['settings', 'activity', 'agents', 'graph'].includes(r.kind) ? r.kind : r.kind === 'home' ? '' : `${r.kind}:${r.arg}`;
  markActive();
  const main = $('#main'); main.innerHTML = '';
  try {
    if (r.kind === 'nb') await viewNotebook(main, r.arg);
    else if (r.kind === 'note') await viewNote(main, r.arg);
    else if (r.kind === 'folder') await viewFolder(main, r.arg);
    else if (r.kind === 'settings') await viewSettings(main);
    else if (r.kind === 'activity') await viewActivity(main);
    else if (r.kind === 'agents') await viewAgents(main);
    else if (r.kind === 'graph') await viewGraph(main, r.arg);
    else await viewHome(main);
  } catch (err) {
    main.append(el('div', { class: 'page' }, el('h1', { class: 'page-title' }, '出错了'), el('p', { class: 'err' }, err.message)));
  }
}
function topbar(crumbs, ...actions) {
  const bar = el('div', { class: 'topbar' });
  bar.append(el('button', { class: 'icon-btn menu-btn', title: '菜单', onclick: () => document.body.classList.toggle('drawer-open') }, '☰'));
  const c = el('div', { class: 'crumb' });
  crumbs.forEach((x, i) => { if (i) c.append(el('span', { class: 'muted' }, '/')); c.append(x.href ? el('a', { href: x.href }, x.label) : el('span', {}, x.label)); });
  bar.append(c, el('div', { class: 'spacer' }), ...actions);
  return bar;
}
const chipSource = (s) => s && el('span', { class: 'chip source' }, s);

// ---------------------------------------------------------------- home: capture + inbox + today's feed
function captureBox({ notebook } = {}) {
  const ta = el('textarea', { placeholder: notebook ? `记一条到「${nbOf(notebook)?.title}」…` : '记点什么… 会自动归到对应的笔记本（支持 Markdown 和 [[链接]]）', rows: 2 });
  const sel = el('select', {}, el('option', { value: '' }, '自动归类'), state.notebooks.filter((n) => !n.inbox).map((n) => el('option', { value: n.folder, selected: n.folder === notebook }, `${n.icon} ${n.title}`)));
  const status = el('span', { class: 'muted', style: 'font-size:12px' });
  const send = async () => {
    const text = ta.value.trim(); if (!text) return;
    try {
      const r = await api('POST', '/api/capture', { text, notebook: sel.value || undefined, source: 'owner' });
      ta.value = ''; status.textContent = r.hint;
      toast(r.mode === 'inbox' ? '归类拿不准，已放入收件箱' : `已记入 ${r.notebook.icon} ${r.notebook.title}`);
      await loadSidebar(); route();
    } catch (err) { toast(err.message, true); }
  };
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
  const box = el('div', { class: 'capture' + (notebook ? ' compact' : '') }, ta, el('div', { class: 'row' }, sel, status, el('div', { style: 'flex:1' }), el('span', { class: 'muted', style: 'font-size:12px' }, '⌘↵'), el('button', { class: 'btn small primary', onclick: send }, '记录')));
  if (notebook) { ta.rows = 1; box.addEventListener('focusin', () => box.classList.add('open')); box.addEventListener('focusout', () => { if (!ta.value.trim()) box.classList.remove('open'); }); }
  return box;
}

function aiOrganizeButton() {
  if (!state.ai?.enabled) return el('a', { class: 'btn small', href: '#/settings', title: '在设置里开启智能归类（可直接用本机已登录的 Claude Code），即可一键让 AI 整理收件箱' }, '✨ 开启 AI 整理');
  return el('button', { class: 'btn small primary', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '✨ 整理中…';
    try {
      const r = await api('POST', '/api/ai/organize', {});
      toast(r.done.length ? `AI 归入了 ${r.done.length} 条${r.left.length ? `，${r.left.length} 条还拿不准` : ''}` : (r.left.length ? `AI 对这 ${r.left.length} 条都不确定，留在收件箱` : '收件箱是空的'));
      await loadSidebar(); route();
    } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = '✨ AI 整理'; }
  } }, '✨ AI 整理');
}

function assignChips(note, { onDone } = {}) {
  const wrap = el('div', { class: 'assign' }, el('span', { class: 'muted', style: 'font-size:12px' }, '归入：'));
  const move = async (folder) => {
    try { await api('POST', '/api/move', { path: note.path, folder, learn: true }); toast(`已归入 ${nbOf(folder)?.icon || ''} ${nbOf(folder)?.title || folder}，并记住了`); onDone ? onDone() : (await loadSidebar(), route()); }
    catch (err) { toast(err.message, true); }
  };
  const suggested = (note.suggested || []).filter((f) => nbOf(f));
  for (const f of suggested) wrap.append(el('span', { class: 'chip btn-chip', onclick: () => move(f) }, `${nbOf(f).icon} ${nbOf(f).title}`));
  const sel = el('select', { onchange: (e) => e.target.value && move(e.target.value) }, el('option', { value: '' }, suggested.length ? '其他…' : '选择笔记本…'),
    state.notebooks.filter((n) => !n.inbox && !suggested.includes(n.folder)).map((n) => el('option', { value: n.folder }, `${n.icon} ${n.title}`)));
  wrap.append(sel);
  return wrap;
}

async function viewHome(main) {
  const page = el('div', { class: 'page' });
  page.append(el('h1', { class: 'page-title' }, '今天'));
  page.append(captureBox());

  // agents banner
  try {
    const ag = await get('/api/agents');
    const todo = ag.agents.filter((a) => a.detected && !a.connected && a.canWrite);
    const dismissed = localStorage.getItem('banner:agents') || '';
    const key = todo.map((a) => a.name).sort().join(',');
    if (todo.length && dismissed !== key) page.append(el('div', { class: 'card-box banner' }, el('span', { style: 'font-size:20px' }, '🔌'),
      el('a', { href: '#/agents', style: 'flex:1;min-width:0' }, el('div', { style: 'font-weight:600' }, `检测到 ${todo.length} 个本地 agent 还没接入`), el('div', { class: 'muted', style: 'font-size:13px' }, todo.map((a) => a.name).join(' · ') + ' · 点击一键接入')),
      el('button', { class: 'icon-btn', title: '不再提示', onclick: (e) => { localStorage.setItem('banner:agents', key); e.currentTarget.closest('.banner').remove(); } }, '✕')));
  } catch {}

  // inbox
  const inbox = state.notebooks.find((n) => n.inbox);
  if (inbox && inbox.count) {
    const items = await get(`/api/notes?folder=${encodeURIComponent(inbox.folder)}&recursive=false&limit=50`);
    page.append(el('div', { class: 'feed-head' }, el('a', { href: nbHref(inbox.folder) }, `${inbox.icon} 收件箱`), el('span', { class: 'n' }, `${items.length} 条待归类`), el('div', { class: 'spacer' }), aiOrganizeButton()));
    for (const n of items) {
      page.append(el('div', { class: 'inbox-item' },
        el('span', { class: 't', onclick: () => openPeek(n.path) }, n.title), chipSource(n.source), el('span', { class: 'muted', style: 'font-size:11px' }, fmtClock(n.created)),
        n.excerpt && n.excerpt !== n.title && el('div', { class: 'ex' }, cleanExcerpt(n.excerpt, 140)),
        assignChips(n)));
    }
  }

  // today's feed with date nav
  const d = state.feedDate;
  const nav = el('div', { class: 'date-nav' },
    el('button', { class: 'btn small', onclick: () => { state.feedDate = shiftDate(d, -1); route(); } }, '‹'),
    el('span', { style: 'min-width:150px;text-align:center;font-weight:500' }, d === today() ? `今天 ${d}` : d === shiftDate(today(), -1) ? `昨天 ${d}` : d),
    el('button', { class: 'btn small', disabled: d >= today(), onclick: () => { state.feedDate = shiftDate(d, 1); route(); } }, '›'),
    d !== today() && el('button', { class: 'btn small', onclick: () => { state.feedDate = today(); route(); } }, '回到今天'));
  const feed = await get(`/api/today?date=${d}`);
  page.append(el('div', { class: 'toolbar', style: 'margin-top:8px' }, nav, el('div', { class: 'spacer' }), el('span', { class: 'muted', style: 'font-size:13px' }, feed.total ? `${feed.total} 条 · 来自 ${feed.sources.join('、') || '—'}` : '')));
  const groups = feed.groups.filter((g) => !g.notebook.inbox);
  if (!groups.length) page.append(el('div', { class: 'empty', style: 'padding:24px 0' }, d === today() ? '今天还没有 agent 记录任何内容。在上面记一条，或者让某个 agent 帮你记。' : '这一天没有记录。'));
  for (const g of groups) page.append(feedGroup(g));

  // notebooks: a table of contents
  page.append(el('div', { class: 'feed-head', style: 'margin-top:34px' }, el('span', {}, '笔记本'), el('div', { class: 'spacer' }), el('button', { class: 'btn small', onclick: () => notebookDialog() }, '＋ 新建')));
  const toc = el('div', { class: 'toc' });
  for (const nb of state.notebooks) toc.append(el('a', { class: 'toc-item', href: nbHref(nb.folder) },
    el('span', { class: 'emoji' }, nb.icon), el('span', { class: 't' }, nb.title), el('span', { class: 'd' }, KIND_LABEL[nb.kind] + (nb.description ? ' · ' + nb.description.slice(0, 48) : '')), el('span', { class: 'n' }, nb.count ?? nb.total ?? '')));
  page.append(toc);
  main.append(topbar([{ label: '今天' }]), page);
}

/** Journal cards in lists: clamp long entry bodies to a few lines with a 展开 toggle. */
function clampEntries(card) {
  requestAnimationFrame(() => {
    for (const eb of card.querySelectorAll('.ebody')) {
      eb.classList.add('clamp');
      if (eb.scrollHeight <= eb.clientHeight + 6) { eb.classList.remove('clamp'); continue; }
      const btn = el('button', { class: 'more-btn', onclick: (e) => { e.stopPropagation(); const open = eb.classList.toggle('clamp'); btn.textContent = open ? '展开' : '收起'; } }, '展开');
      eb.after(btn);
    }
  });
  return card;
}

function feedGroup(g) {
  const nb = g.notebook;
  const box = el('div', { class: 'feed-group' });
  box.append(el('div', { class: 'feed-head' }, el('a', { href: nbHref(nb.folder) }, `${nb.icon} ${nb.title}`), el('span', { class: 'n' }, nb.kind === 'journal' ? `${g.items.reduce((n, i) => n + (i.entries || 1), 0)} 条` : `${g.items.length} 条`)));
  for (const it of g.items) {
    if (nb.kind === 'journal') box.append(clampEntries(el('div', { class: 'journal-day', onclick: (e) => { if (!e.target.closest('a,button')) openPeek(it.path); } }, el('div', { class: 'md', html: renderMd(it.body, { journal: true }) }))));
    else box.append(el('div', { class: 'feed-item', onclick: () => openPeek(it.path) }, el('span', { class: 'dot' }),
      el('div', {}, el('div', { class: 't' }, it.title), it.excerpt && it.excerpt !== it.title && el('div', { class: 'ex' }, cleanExcerpt(it.excerpt, 120))),
      el('div', { class: 'meta' }, it.status && el('span', { class: 'chip status' }, it.status), it.tags.slice(0, 2).map((t) => el('span', { class: 'chip' }, t)), chipSource(it.source), el('span', {}, fmtClock(it.updated)))));
  }
  return box;
}

// ---------------------------------------------------------------- tables
function noteTable(notes, { showFolder = true, extraProps = [] } = {}) {
  if (!notes.length) return el('div', { class: 'empty' }, '暂无内容');
  const cols = [
    { k: 'title', label: '标题', render: (n) => el('td', {}, el('div', { style: 'font-weight:500' }, n.title), el('div', { class: 'muted', style: 'font-size:12px' }, cleanExcerpt(n.excerpt, 90))) },
    showFolder && { k: 'folder', label: '位置', render: (n) => el('td', { class: 'muted' }, nbOf(n.folder)?.title || n.folder || '/') },
    notes.some((n) => n.status) && { k: 'status', label: '状态', render: (n) => el('td', {}, n.status && el('span', { class: 'chip status' }, n.status)) },
    { k: 'tags', label: '标签', render: (n) => el('td', {}, n.tags.map((x) => el('span', { class: 'chip' }, x))) },
    { k: 'source', label: '来源', render: (n) => el('td', {}, chipSource(n.source)) },
    ...extraProps.map((k) => ({ k: 'p:' + k, label: k, render: (n) => el('td', {}, n.props?.[k] === undefined ? '' : String(n.props[k])) })),
    { k: 'date', label: '日期', render: (n) => el('td', { class: 'muted', style: 'white-space:nowrap;font-size:12px' }, n.date) },
    { k: 'updated', label: '更新', render: (n) => el('td', { class: 'muted', style: 'white-space:nowrap;font-size:12px' }, fmtTime(n.updated)) }
  ].filter(Boolean);
  let sortKey = 'updated', dir = -1;
  const wrap = el('div', { class: 'list' });
  const draw = () => {
    const sorted = [...notes].sort((a, b) => { const va = sortKey.startsWith('p:') ? a.props?.[sortKey.slice(2)] : a[sortKey]; const vb = sortKey.startsWith('p:') ? b.props?.[sortKey.slice(2)] : b[sortKey]; return (String(va ?? '')).localeCompare(String(vb ?? ''), 'zh', { numeric: true }) * dir; });
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: 'sortable', onclick: () => { if (sortKey === c.k) dir = -dir; else { sortKey = c.k; dir = 1; } draw(); } }, c.label + (sortKey === c.k ? (dir > 0 ? ' ↑' : ' ↓') : ''))))));
    const tb = el('tbody');
    for (const n of sorted) tb.append(el('tr', { onclick: () => openPeek(n.path) }, cols.map((c) => c.render(n))));
    t.append(tb);
    wrap.innerHTML = ''; wrap.append(t);
  };
  draw();
  return wrap;
}

async function viewFolder(main, folder) {
  const notes = await get(`/api/notes?folder=${encodeURIComponent(folder)}&recursive=false`);
  const page = el('div', { class: 'page wide' });
  page.append(el('h1', { class: 'page-title' }, '📁 ' + folder.split('/').pop()));
  page.append(el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, `${notes.length} 个页面`), el('div', { class: 'spacer' }),
    el('button', { class: 'btn small', onclick: () => { if (confirm(`把「${folder}」变成一个笔记本？`)) notebookDialog({ folder }); } }, '设为笔记本'),
    el('button', { class: 'btn small', onclick: () => newNoteDialog({ folder }) }, '＋ 新建页面')));
  page.append(noteTable(notes, { showFolder: false }));
  main.append(topbar([{ label: '今天', href: '#/' }, { label: folder }]), page);
}

// ---------------------------------------------------------------- notebook: kanban / timeline / table
async function viewNotebook(main, folder) {
  const dateFilter = state.nbDate?.[folder] ?? '';
  const [nb, mx] = await Promise.all([get(`/api/notebooks/${encPath(folder)}${dateFilter ? `?date=${dateFilter}` : ''}`), get(`/api/metrics/${encPath(folder)}`).catch(() => null)]);
  const hasChart = nb.kind === 'journal' || !!mx?.keys?.length;
  const defaultView = nb.kind === 'board' ? 'kanban' : nb.kind === 'journal' ? 'timeline' : 'table';
  let view = localStorage.getItem('view:' + folder) || defaultView;
  if ((view === 'kanban' && nb.kind !== 'board') || (view === 'chart' && !hasChart)) view = defaultView;
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'nb-head' }, el('span', { class: 'page-icon' }, nb.icon),
    el('div', { style: 'min-width:0' }, el('h1', { class: 'page-title' }, nb.title),
      el('div', { class: 'nb-meta' }, `${KIND_LABEL[nb.kind]} · ${nb.total} 条${nb.keywords?.length ? ' · 关键词 ' + nb.keywords.slice(0, 8).join('、') + (nb.keywords.length > 8 ? '…' : '') : ''}`))));
  if (nb.description) page.append(el('p', { class: 'standfirst' }, nb.description));

  const setDate = (d) => { state.nbDate = { ...(state.nbDate || {}), [folder]: d }; route(); };
  const setView = (v) => { localStorage.setItem('view:' + folder, v); route(); };
  const tb = el('div', { class: 'toolbar' },
    el('div', { class: 'segmented' },
      nb.kind === 'board' && el('button', { class: 'btn small' + (view === 'kanban' ? ' active' : ''), onclick: () => setView('kanban') }, '看板'),
      el('button', { class: 'btn small' + (view === 'timeline' ? ' active' : ''), onclick: () => setView('timeline') }, '时间线'),
      el('button', { class: 'btn small' + (view === 'table' ? ' active' : ''), onclick: () => setView('table') }, '表格'),
      hasChart && el('button', { class: 'btn small' + (view === 'chart' ? ' active' : ''), onclick: () => setView('chart') }, '图表')),
    el('span', { style: 'width:8px' }),
    el('button', { class: 'btn small' + (dateFilter === today() ? ' active' : ''), onclick: () => setDate(dateFilter === today() ? '' : today()) }, '今天'),
    el('input', { type: 'date', value: dateFilter, onchange: (e) => setDate(e.target.value) }),
    dateFilter && el('button', { class: 'btn small', onclick: () => setDate('') }, '✕'),
    el('div', { class: 'spacer' }),
    nb.inbox && aiOrganizeButton(),
    el('button', { class: 'btn small', onclick: () => notebookDialog({ folder, meta: nb }) }, '⚙ 设置'),
    nb.kind !== 'journal' && el('button', { class: 'btn small', onclick: () => newNoteDialog({ folder, columns: nb.columns || undefined }) }, nb.kind === 'board' ? '＋ 新建卡片' : '＋ 新建页面'));
  page.append(tb);
  if (!nb.inbox) page.append(captureBox({ notebook: folder }));

  if (nb.inbox) {
    for (const n of nb.notes) page.append(el('div', { class: 'inbox-item' }, el('span', { class: 't', onclick: () => openPeek(n.path) }, n.title), chipSource(n.source), el('span', { class: 'muted', style: 'font-size:11px' }, fmtTime(n.created)), n.excerpt && n.excerpt !== n.title && el('div', { class: 'ex' }, cleanExcerpt(n.excerpt, 160)), assignChips(n)));
    if (!nb.notes.length) page.append(el('div', { class: 'empty' }, '收件箱是空的 🎉'));
  } else if (view === 'kanban') {
    page.append(await kanban(folder, dateFilter));
  } else if (view === 'table') {
    const extra = [...new Set(nb.notes.flatMap((n) => Object.keys(n.props || {})))].slice(0, 6);
    page.append(noteTable(nb.notes, { showFolder: false, extraProps: extra }));
  } else if (view === 'chart') {
    page.append(chartView(folder, nb, mx));
  } else {
    page.append(timeline(nb));
  }
  main.append(topbar([{ label: '今天', href: '#/' }, { label: nb.title }]), page);
}

function timeline(nb) {
  const box = el('div');
  const byDate = new Map();
  for (const n of nb.notes) { const d = n.date || String(n.updated).slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(n); }
  if (!byDate.size) box.append(el('div', { class: 'empty', style: 'padding:24px 0' }, '还没有内容'));
  for (const [d, items] of [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    box.append(el('div', { class: 'timeline-date' }, d === today() ? `今天 · ${d}` : d));
    for (const it of items) {
      if (nb.kind === 'journal') box.append(clampEntries(el('div', { class: 'journal-day', onclick: (e) => { if (!e.target.closest('a,button')) openPeek(it.path); } }, el('div', { class: 'md', html: renderMd(it.body, { journal: true }) }))));
      else box.append(el('div', { class: 'feed-item', onclick: () => openPeek(it.path) }, el('span', { class: 'dot' }),
        el('div', {}, el('div', { class: 't' }, it.title), it.excerpt && it.excerpt !== it.title && el('div', { class: 'ex' }, cleanExcerpt(it.excerpt, 140))),
        el('div', { class: 'meta' }, it.status && el('span', { class: 'chip status' }, it.status), it.tags.slice(0, 3).map((t) => el('span', { class: 'chip' }, t)), chipSource(it.source), el('span', {}, fmtClock(it.updated)))));
    }
  }
  return box;
}

// ---------------------------------------------------------------- charts: numeric properties over time
const svg = (tag, attrs = {}, ...children) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
};
// keys that are amounts to add up per day (spend, steps…); everything else is a level to average (weight, blood pressure…)
const SUM_KEY_RE = /amount|金额|花费|支出|收入|cost|expense|spend|income|revenue|pages|页|steps|步数|calories|卡路里|distance|公里|km|minutes|分钟|hours|小时|count|次数|杯|ml|毫升|volume|qty|quantity|数量/i;
const RANGES = [['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['all', '全部']];
const AGGS = [['sum', '求和'], ['avg', '平均'], ['last', '最新']];
const fmtNum = (v, unit = '') => { if (v === undefined || v === null || Number.isNaN(v)) return '—'; const a = Math.abs(v); const s = a >= 10000 ? (v / 10000).toFixed(a >= 1e6 ? 0 : 1) + '万' : a >= 100 ? Math.round(v).toLocaleString('en-US') : a >= 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v * 100) / 100); return unit && /^[¥￥$€£]$/.test(unit) ? unit + s : s + (unit ? ' ' + unit : ''); };
const fmtShortDate = (d) => d.slice(5).replace('-', '/');

function chartView(folder, nb, mx) {
  const box = el('div', { class: 'charts' });
  const rangeKey = 'range:' + folder;
  const range = localStorage.getItem(rangeKey) || '30';
  box.append(el('div', { class: 'toolbar', style: 'border:none;margin-bottom:4px;padding-top:0' },
    el('span', { class: 'muted', style: 'font-size:13px' }, '时间范围'),
    el('div', { class: 'segmented' }, RANGES.map(([v, label]) => el('button', { class: 'btn small' + (range === v ? ' active' : ''), onclick: () => { localStorage.setItem(rangeKey, v); route(); } }, label))),
    el('div', { class: 'spacer' }),
    el('span', { class: 'muted', style: 'font-size:12px' }, mx?.keys?.length ? `${mx.keys.length} 个数字属性` : '')));
  if (!mx || !mx.keys.length) {
    box.append(el('div', { class: 'card-box', style: 'color:var(--text-2);font-size:14px;line-height:1.7' },
      el('div', { style: 'font-weight:600;color:var(--text)' }, '还没有可以画图的数字'),
      el('div', {}, 'agent 调用 notebook_capture 时把数字放进 ', el('code', {}, 'properties'), '（例如 ', el('code', {}, '{ amount: 35 }'), '、', el('code', {}, '{ weight: 71.5 }'), '），或者你在记录框里直接写 ', el('code', {}, '午饭 [amount:: 35]'), ' / ', el('code', {}, 'weight:: 71.5'), '。'),
      el('div', {}, '每个数字属性会在这里变成一张按天的图表。')));
    return box;
  }
  for (const k of mx.keys) box.append(metricCard(folder, nb, k, mx.series[k.key] || [], range));
  return box;
}

function metricCard(folder, nb, info, points, range) {
  const aggKey = `agg:${folder}:${info.key}`;
  const agg = localStorage.getItem(aggKey) || (SUM_KEY_RE.test(info.key) ? 'sum' : 'avg');
  const unit = info.unit || '';
  const todayStr = today();
  const from = range === 'all' ? (points[0]?.date || todayStr) : shiftDate(todayStr, -(Number(range) - 1));
  const to = range === 'all' ? (points[points.length - 1]?.date > todayStr ? points[points.length - 1].date : todayStr) : todayStr;
  const inRange = points.filter((p) => p.date >= from && p.date <= to);

  // one value per day
  const byDay = new Map();
  for (const p of inRange) { if (!byDay.has(p.date)) byDay.set(p.date, []); byDay.get(p.date).push(p); }
  const days = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    const items = byDay.get(d) || [];
    const vals = items.map((p) => p.value);
    const value = !vals.length ? null : agg === 'sum' ? vals.reduce((a, b) => a + b, 0) : agg === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : vals[vals.length - 1];
    days.push({ date: d, value, items });
    if (days.length > 2000) break;
  }
  const have = days.filter((d) => d.value !== null);
  const total = inRange.reduce((a, p) => a + p.value, 0);
  const latest = inRange[inRange.length - 1];

  const card = el('div', { class: 'metric-card' });
  const head = el('div', { class: 'metric-head' },
    el('div', { class: 'metric-title' }, el('span', { class: 'mk' }, info.key), unit && el('span', { class: 'muted', style: 'font-size:12px' }, unit)),
    el('div', { class: 'spacer' }),
    el('div', { class: 'seg' }, AGGS.map(([v, label]) => el('button', { class: v === agg ? 'active' : '', onclick: () => { localStorage.setItem(aggKey, v); route(); } }, label))));
  card.append(head);
  const stat = (label, v) => el('div', { class: 'stat' }, el('div', { class: 'sv' }, v), el('div', { class: 'sl' }, label));
  card.append(el('div', { class: 'metric-stats' },
    agg === 'sum' ? stat('合计', fmtNum(total, unit)) : stat('最低', fmtNum(inRange.length ? Math.min(...inRange.map((p) => p.value)) : null, unit)),
    stat('平均', fmtNum(inRange.length ? total / inRange.length : null, unit)),
    stat('最新', latest ? fmtNum(latest.value, unit) : '—'),
    stat('最高', fmtNum(inRange.length ? Math.max(...inRange.map((p) => p.value)) : null, unit)),
    stat('记录', `${inRange.length} 条 · ${have.length} 天`)));

  if (!have.length) { card.append(el('div', { class: 'empty', style: 'padding:24px 0;text-align:center' }, `这 ${range === 'all' ? '' : range + ' 天'}里没有「${info.key}」的记录`)); return card; }

  const wrap = el('div', { class: 'chart-wrap' });
  const tip = el('div', { class: 'chart-tip hidden' });
  let drawnW = 0;
  const draw = () => {
  // ---- geometry: 1 viewBox unit = 1 CSS px, redrawn when the card is resized ----
  const W = Math.max(320, Math.round(wrap.clientWidth) || 760), H = 220, padL = 52, padR = 16, padT = 14, padB = 28;
  if (W === drawnW) return; drawnW = W;
  wrap.innerHTML = '';
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bars = agg === 'sum';
  const vals = have.map((d) => d.value);
  let yMin = bars ? Math.min(0, ...vals) : Math.min(...vals), yMax = bars ? Math.max(0, ...vals) : Math.max(...vals);
  if (!bars) { const pad = (yMax - yMin) * 0.25 || Math.abs(yMax) * 0.1 || 1; yMin -= pad; yMax += pad; }
  if (yMax === yMin) yMax = yMin + 1;
  const ticks = niceTicks(yMin, yMax, 4);
  yMin = Math.min(yMin, ticks[0]); yMax = Math.max(yMax, ticks[ticks.length - 1]);
  const n = days.length;
  const slot = plotW / n;
  const x = (i) => padL + slot * (i + 0.5);
  const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart' });
  for (const t of ticks) {
    g.append(svg('line', { x1: padL, x2: W - padR, y1: y(t), y2: y(t), class: 'grid' }));
    g.append(svg('text', { x: padL - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, fmtNum(t)));
  }
  // x labels: ~6 of them
  const every = Math.max(1, Math.ceil(n / 6));
  days.forEach((d, i) => { if (i % every === 0 || i === n - 1) g.append(svg('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle' }, n > 400 ? d.date.slice(0, 7) : fmtShortDate(d.date))); });

  if (bars) {
    const bw = Math.max(2, Math.min(28, slot - 2));
    const y0 = y(0);
    days.forEach((d, i) => { if (d.value === null) return; const yy = y(d.value); const top = Math.min(yy, y0), h = Math.max(1.5, Math.abs(yy - y0)); g.append(svg('rect', { x: x(i) - bw / 2, y: top, width: bw, height: h, rx: Math.min(3, bw / 2), class: 'bar', 'data-i': i })); });
  } else {
    // line through recorded days (gaps where nothing was recorded), area fill, dots
    let dPath = '', aPath = '';
    let runStart = null;
    const segs = [];
    days.forEach((d, i) => { if (d.value === null) { if (runStart !== null) { segs.push([runStart, i - 1]); runStart = null; } } else if (runStart === null) runStart = i; });
    if (runStart !== null) segs.push([runStart, n - 1]);
    for (const [a, b] of segs) {
      const pts = []; for (let i = a; i <= b; i++) pts.push([x(i), y(days[i].value)]);
      dPath += pts.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ') + ' ';
      aPath += `M${pts[0][0].toFixed(1)} ${(padT + plotH).toFixed(1)} ` + pts.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`).join(' ') + ` L${pts[pts.length - 1][0].toFixed(1)} ${(padT + plotH).toFixed(1)} Z `;
    }
    g.append(svg('path', { d: aPath, class: 'area' }), svg('path', { d: dPath, class: 'line' }));
    days.forEach((d, i) => { if (d.value !== null) g.append(svg('circle', { cx: x(i), cy: y(d.value), r: n > 120 ? 2 : 3.5, class: 'dot', 'data-i': i })); });
  }
  // direct label on the latest value
  const lastIdx = days.length - 1 - [...days].reverse().findIndex((d) => d.value !== null);
  const last = days[lastIdx];
  g.append(svg('text', { x: Math.min(x(lastIdx), W - padR - 4), y: y(last.value) - 8, class: 'label', 'text-anchor': x(lastIdx) > W - 80 ? 'end' : 'middle' }, fmtNum(last.value, unit)));

  // hover layer: one hit column per day
  const cursor = svg('line', { y1: padT, y2: padT + plotH, class: 'cursor hidden' });
  g.append(cursor);
  wrap.append(g, tip);
  days.forEach((d, i) => {
    const hit = svg('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH, class: 'hit' });
    hit.addEventListener('mouseenter', () => {
      cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.classList.remove('hidden');
      g.querySelectorAll('.bar.on,.dot.on').forEach((m) => m.classList.remove('on'));
      g.querySelector(`[data-i="${i}"]`)?.classList.add('on');
      tip.innerHTML = '';
      tip.append(el('div', { class: 'td' }, d.date + (d.date === todayStr ? ' · 今天' : '')));
      if (d.value === null) tip.append(el('div', { class: 'muted' }, '没有记录'));
      else {
        tip.append(el('div', { class: 'tv' }, fmtNum(d.value, unit), el('span', { class: 'muted', style: 'font-size:11px;margin-left:6px' }, d.items.length > 1 ? `${AGGS.find((a) => a[0] === agg)[1]} · ${d.items.length} 条` : '')));
        for (const it of d.items.slice(0, 6)) tip.append(el('div', { class: 'ti' }, el('span', { class: 'muted' }, it.time ? it.time + ' ' : ''), it.title, el('span', { style: 'margin-left:auto;padding-left:10px' }, fmtNum(it.value, it.unit || unit))));
        if (d.items.length > 6) tip.append(el('div', { class: 'muted' }, `… 还有 ${d.items.length - 6} 条`));
        tip.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, '点击打开这一天'));
      }
      tip.classList.remove('hidden');
      const px = x(i);
      tip.style.left = (px > W * 0.6 ? px - tip.offsetWidth - 12 : px + 12) + 'px';
    });
    hit.addEventListener('click', () => { if (d.items.length) openPeek(d.items[0].path); });
    g.append(hit);
  });
  g.addEventListener('mouseleave', () => { tip.classList.add('hidden'); cursor.classList.add('hidden'); g.querySelectorAll('.on').forEach((m) => m.classList.remove('on')); });
  };
  card.append(wrap);
  requestAnimationFrame(draw);
  if (window.ResizeObserver) new ResizeObserver(() => draw()).observe(wrap);
  return card;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const rough = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) || mag * 10;
  const start = Math.floor(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.001 && out.length < 12; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

async function kanban(folder, dateFilter) {
  const board = await get(`/api/boards/${encPath(folder)}${dateFilter ? `?date=${dateFilter}` : ''}`);
  const kb = el('div', { class: 'board' });
  for (const col of board.columns) {
    const colEl = el('div', { class: 'col', 'data-col': col.name });
    colEl.append(el('div', { class: 'col-head' }, el('span', { class: 'chip status' }, col.name), el('span', { class: 'count' }, col.cards.length),
      el('button', { class: 'mini-btn add', title: '在此列新建', onclick: () => newNoteDialog({ folder, columns: board.columns.map((c) => c.name), status: col.name }) }, '＋')));
    for (const card of col.cards) colEl.append(cardEl(card));
    if (!col.cards.length) colEl.append(el('div', { class: 'empty well' }, '空 · 把卡片拖到这里'));
    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', async (e) => {
      e.preventDefault(); colEl.classList.remove('drag-over');
      const p = e.dataTransfer.getData('text/plain'); if (!p) return;
      try { await api('PATCH', notePath(p), { status: col.name }); toast(`已移动到「${col.name}」`); route(); } catch (err) { toast(err.message, true); }
    });
    kb.append(colEl);
  }
  return kb;
}
function cardEl(card) {
  const c = el('div', { class: 'card', draggable: 'true', onclick: () => openPeek(card.path) },
    el('div', { class: 't' }, card.title), card.excerpt && card.excerpt !== card.title && el('div', { class: 'ex' }, cleanExcerpt(card.excerpt, 200)),
    el('div', { class: 'meta' }, card.tags.slice(0, 4).map((t) => el('span', { class: 'chip' }, t)), chipSource(card.source), el('span', { class: 'date' }, card.date)));
  c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.path); c.classList.add('dragging'); });
  c.addEventListener('dragend', () => c.classList.remove('dragging'));
  return c;
}

// ---------------------------------------------------------------- note editor (full page & peek)
async function viewNote(main, path) {
  const note = await get(notePath(path));
  const crumbs = [{ label: '今天', href: '#/' }];
  if (note.notebook) crumbs.push({ label: note.notebook.title, href: nbHref(note.notebook.folder) });
  else if (note.folder) crumbs.push({ label: note.folder, href: `#/folder/${encodeURIComponent(note.folder)}` });
  crumbs.push({ label: note.title });
  main.append(topbar(crumbs, moveSelect(note), el('button', { class: 'btn small danger', onclick: () => deleteNote(note.path) }, '删除')));
  main.append(await noteEditor(note));
}

function moveSelect(note) {
  return el('select', { class: 'btn small', title: '移动到其他笔记本', onchange: async (e) => {
    const f = e.target.value; if (!f) return;
    try { const r = await api('POST', '/api/move', { path: note.path, folder: f, learn: true }); toast(`已移动到 ${nbOf(f)?.title || f}`); await loadSidebar(); closePeek(); location.hash = `#/note/${encodeURIComponent(r.path)}`; } catch (err) { toast(err.message, true); }
  } }, el('option', { value: '' }, '移动到…'), state.notebooks.filter((n) => n.folder !== note.folder).map((n) => el('option', { value: n.folder }, `${n.icon} ${n.title}`)));
}

async function noteEditor(note, { onSaved } = {}) {
  const page = el('div', { class: 'page article-page' });
  const nb = note.notebook ? nbOf(note.notebook.folder) : null;
  let saving = false;
  let updatedEl = null;
  let drawDateline = null;
  const save = async (patch) => {
    if (saving) return;
    saving = true;
    try {
      const updated = await api('PATCH', notePath(note.path), patch);
      Object.assign(note, updated);
      if (updatedEl) updatedEl.textContent = `更新 ${fmtTime(note.properties.updated)} · 创建 ${fmtTime(note.properties.created)} · ${note.path}`;
      drawDateline?.();
      toast('已保存'); onSaved?.(note);
    } catch (err) { toast(err.message, true); }
    finally { saving = false; }
  };

  const title = el('h1', { class: 'page-title', contenteditable: 'true', spellcheck: 'false' }, note.title);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { const t = title.textContent.trim(); if (t && t !== note.title) save({ title: t }); });
  page.append(title);

  const p = note.properties;
  if (nb?.inbox) page.append(el('div', { class: 'inbox-item', style: 'margin-bottom:14px' }, el('span', { class: 'muted', style: 'font-size:13px' }, '这条还在收件箱。'), assignChips({ path: note.path, suggested: p.suggested || [] }, { onDone: async () => { await loadSidebar(); closePeek(); location.hash = '#/'; } })));

  // Masthead: one quiet line of metadata under the headline; the editable property grid unfolds on demand.
  const props = el('div', { class: 'props collapsed' });
  const dateline = el('div', { class: 'dateline' });
  drawDateline = () => {
    const q = note.properties; const parts = [];
    if (nb) parts.push(el('a', { href: nbHref(nb.folder) }, `${nb.icon} ${nb.title}`));
    if (q.status) parts.push(el('span', { class: 'chip status' }, q.status));
    if (q.date) parts.push(el('span', {}, q.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1 年 $2 月 $3 日')));
    for (const src of (q.sources?.length ? q.sources : q.source ? [q.source] : [])) parts.push(chipSource(src));
    if (q.tags?.length) parts.push(el('span', { class: 'tags', title: q.tags.join(', ') }, q.tags.slice(0, 6).map((t) => '#' + t).join('  ') + (q.tags.length > 6 ? `  +${q.tags.length - 6}` : '')));
    dateline.innerHTML = '';
    dateline.append(el('div', { class: 'dl' }, parts.flatMap((x, i) => i ? [el('span', { class: 'dot' }, '·'), x] : [x])),
      el('button', { class: 'mini-btn', title: '编辑标签、日期等属性', onclick: () => { props.classList.toggle('collapsed'); drawDateline(); } }, props.classList.contains('collapsed') ? '属性 ▾' : '收起 ▴'));
  };
  const row = (label, icon, valueNode) => props.append(el('div', { class: 'k' }, el('span', {}, icon), label), el('div', { class: 'v' }, valueNode));
  if (nb?.kind === 'board' && nb.columns) {
    row('状态', '◎', el('select', { onchange: (e) => save({ status: e.target.value }) }, nb.columns.map((c) => el('option', { value: c, selected: c === p.status }, c))));
  } else if (p.status) row('状态', '◎', el('span', { class: 'chip status' }, p.status));
  row('标签', '#', el('input', { value: (p.tags || []).join(', '), placeholder: '逗号分隔', onblur: (e) => { const v = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); if (JSON.stringify(v) !== JSON.stringify(p.tags || [])) save({ tags: v }); } }));
  row('来源', '🤖', p.sources?.length ? p.sources.map((s) => chipSource(s)) : p.source ? chipSource(p.source) : el('span', { class: 'muted' }, '—'));
  row('日期', '📅', el('input', { type: 'date', value: p.date || '', onchange: (e) => save({ date: e.target.value }) }));
  for (const [k, v] of Object.entries(p)) {
    if (SYSTEM_PROPS.includes(k)) continue;
    const kEl = el('div', { class: 'k' }, el('span', {}, typeof v === 'number' ? '#' : Array.isArray(v) ? '☰' : '≡'), k);
    const cell = el('div', { class: 'v' });
    const del = el('button', { class: 'mini-btn', title: '删除属性', onclick: () => save({ [k]: null }).then(() => { cell.remove(); kEl.remove(); }) }, '✕');
    if (v !== null && typeof v === 'object') {
      // arrays / objects: show as readable chips; edit as JSON on demand
      const showChips = () => {
        cell.innerHTML = '';
        cell.append(propChips(v), el('button', { class: 'mini-btn', title: '以 JSON 编辑', onclick: showJson }, '✎'), del);
      };
      const showJson = () => {
        cell.innerHTML = '';
        const ta = el('textarea', { class: 'body-edit', style: 'min-height:60px;font-size:12.5px;padding:6px 8px;flex:1' }, JSON.stringify(v, null, 1));
        cell.append(ta, el('button', { class: 'btn small', onclick: showChips }, '取消'), el('button', { class: 'btn small primary', onclick: async () => { let parsed; try { parsed = JSON.parse(ta.value); } catch { toast('不是合法的 JSON', true); return; } await save({ [k]: parsed }); Object.assign(v, parsed); showChips(); } }, '保存'));
      };
      showChips();
    } else {
      const inp = el('input', { value: String(v), onblur: (e) => { if (e.target.value !== String(v)) save({ [k]: e.target.value }); } });
      cell.append(inp, del);
    }
    props.append(kEl, cell);
  }
  props.append(el('div', { class: 'add-prop', onclick: async () => { const k = prompt('属性名'); if (!k) return; const v = prompt(`「${k}」的值`) ?? ''; await save({ [k]: v }); page.replaceWith(await noteEditor(note, { onSaved })); } }, '＋ 添加属性'));
  updatedEl = el('div', { class: 'colophon' }, `更新 ${fmtTime(p.updated)} · 创建 ${fmtTime(p.created)} · ${note.path}`);
  drawDateline();
  page.append(dateline, props);

  const bodyWrap = el('div');
  const linksBox = el('div', { class: 'links-box' });
  const drawLinks = () => {
    linksBox.innerHTML = '';
    const links = (note.links || []);
    const back = (note.backlinks || []);
    if (!links.length && !back.length) { linksBox.append(el('div', { class: 'muted' }, '在正文里写 [[页面标题]] 可以链接到其他笔记。')); return; }
    linksBox.append(el('a', { href: `#/graph/${encodeURIComponent(note.path)}`, style: 'float:right;font-size:12px', onclick: closePeek }, '🕸 在关系图中查看'));
    if (links.length) linksBox.append(el('h4', {}, '链接到'), el('div', {}, links.map((l) => l.path ? el('a', { href: `#/note/${encodeURIComponent(l.path)}` }, '→ ' + l.label) : el('span', { class: 'muted', style: 'margin-right:8px' }, '→ ' + l.label + '（未创建）'))));
    if (back.length) linksBox.append(el('h4', {}, `被引用 · ${back.length}`), el('div', {}, back.map((b) => el('a', { href: `#/note/${encodeURIComponent(b.path)}` }, `← ${b.title}`, el('span', { class: 'muted' }, nbOf(b.folder) ? `  ${nbOf(b.folder).icon}` : '')))));
  };
  const showView = () => {
    bodyWrap.innerHTML = '';
    const v = el('div', { class: 'body-view md' + (nb?.kind === 'journal' ? ' journal-body' : ''), html: renderMd(note.body, { journal: nb?.kind === 'journal' }) });
    // a drop cap only when the article opens with a real paragraph of prose (plain text first, long enough)
    const first = v.firstElementChild;
    if (nb?.kind !== 'journal' && first?.tagName === 'P' && first.firstChild?.nodeType === 3 && /^\p{L}/u.test(first.textContent) && first.textContent.length >= 60) v.classList.add('dropcap');
    v.addEventListener('click', (e) => { if (e.target.closest('a,input')) return; showEdit(); });
    bodyWrap.append(v);
  };
  const showEdit = () => {
    bodyWrap.innerHTML = '';
    const ta = el('textarea', { class: 'body-edit', spellcheck: 'false' }, note.body);
    const commit = async () => { if (ta.value !== note.body) { await save({ body: ta.value }); try { const fresh = await get(notePath(note.path)); note.links = fresh.links; note.backlinks = fresh.backlinks; drawLinks(); } catch {} } showView(); };
    const bar = el('div', { class: 'editbar' }, el('span', {}, 'Markdown · [[链接]] · ⌘/Ctrl+S 保存 · Esc 取消'), el('button', { class: 'btn small', onclick: showView }, '取消'), el('button', { class: 'btn small primary', onclick: commit }, '保存'));
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') showView();
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); }
    });
    bodyWrap.append(bar, ta);
    ta.focus(); ta.style.height = Math.max(300, ta.scrollHeight + 40) + 'px';
  };
  showView(); drawLinks();
  page.append(bodyWrap, updatedEl, linksBox);
  return page;
}

/** Array → chips, object → key: value chips, used for structured property values. */
function propChips(v) {
  const wrap = el('div', { class: 'prop-chips' });
  const fmt = (x) => typeof x === 'number' ? x.toLocaleString('en-US', { maximumFractionDigits: 3 }) : typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x);
  if (Array.isArray(v)) { for (const x of v) wrap.append(el('span', { class: 'chip' }, fmt(x))); if (!v.length) wrap.append(el('span', { class: 'muted' }, '空')); }
  else for (const [kk, x] of Object.entries(v)) wrap.append(el('span', { class: 'chip' }, el('b', {}, kk + ': '), fmt(x)));
  return wrap;
}

async function openPeek(path) {
  const peek = $('#peek');
  peek.innerHTML = ''; peek.classList.remove('hidden');
  try {
    const note = await get(notePath(path));
    peek.append(el('div', { class: 'peek-bar' },
      el('button', { class: 'btn small', onclick: () => { location.hash = `#/note/${encodeURIComponent(path)}`; closePeek(); } }, '⤢ 全页打开'),
      moveSelect(note), el('div', { class: 'spacer' }),
      el('button', { class: 'btn small danger', onclick: () => deleteNote(path) }, '删除'),
      el('button', { class: 'btn small', onclick: closePeek }, '✕')));
    peek.append(await noteEditor(note, { onSaved: () => route() }));
  } catch (err) { peek.append(el('div', { class: 'page err' }, err.message)); }
}
function closePeek() { $('#peek').classList.add('hidden'); $('#peek').innerHTML = ''; }
async function deleteNote(path) {
  if (!confirm(`把「${path}」移到回收站？`)) return;
  try { await api('DELETE', notePath(path)); toast('已移到 .trash'); closePeek(); await loadSidebar(); location.hash = '#/'; } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- dialogs
function modal(title, content, { okLabel = '确定', onOk } = {}) {
  const m = $('#modal'); m.innerHTML = ''; m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); m.innerHTML = ''; };
  m.append(el('div', { class: 'box' }, el('h3', {}, title), el('div', { class: 'content' }, content),
    onOk && el('div', { class: 'footer' }, el('button', { class: 'btn', onclick: close }, '取消'), el('button', { class: 'btn primary', onclick: async () => { try { if ((await onOk()) !== false) close(); } catch (err) { toast(err.message, true); } } }, okLabel))));
  m.onclick = (e) => { if (e.target === m) close(); };
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  return close;
}

function newNoteDialog({ folder = '', columns, status } = {}) {
  const title = el('input', { type: 'text', placeholder: '标题' });
  const folderIn = el('select', {}, el('option', { value: '', selected: !folder }, '根目录'), state.notebooks.filter((n) => n.kind !== 'journal').map((n) => el('option', { value: n.folder, selected: n.folder === folder }, `${n.icon} ${n.title}`)));
  const statusSel = columns ? el('select', {}, columns.map((c) => el('option', { value: c, selected: c === status }, c))) : null;
  const tags = el('input', { type: 'text', placeholder: '标签，逗号分隔' });
  const body = el('textarea', { class: 'body-edit', style: 'min-height:140px;border:1px solid var(--border);border-radius:6px;padding:8px', placeholder: 'Markdown 正文（可选），支持 [[链接]]' });
  const form = el('div', { class: 'form' }, el('label', {}, '标题'), title, el('label', {}, '笔记本'), folderIn, statusSel && el('label', {}, '列'), statusSel, el('label', {}, '标签'), tags, el('label', {}, '正文'), body);
  modal(columns ? '新建卡片' : '新建页面', form, {
    okLabel: '创建',
    onOk: async () => {
      if (!title.value.trim()) { title.focus(); return false; }
      const n = await api('POST', '/api/notes', { folder: folderIn.value, title: title.value.trim(), body: body.value, status: statusSel?.value, tags: tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
      toast('已创建'); await loadSidebar();
      if (columns) { route(); openPeek(n.path); } else location.hash = `#/note/${encodeURIComponent(n.path)}`;
    }
  });
  setTimeout(() => title.focus(), 30);
}

function notebookDialog({ folder, meta } = {}) {
  const editing = !!meta;
  const folderIn = el('input', { type: 'text', value: folder || '', placeholder: '例如：健康（即文件夹名）', disabled: editing });
  const title = el('input', { type: 'text', value: meta?.title || '', placeholder: '显示名称（默认同文件夹名）' });
  const icon = el('input', { type: 'text', value: meta?.icon || '📁', style: 'width:60px' });
  const kind = el('select', {}, ['pages', 'journal', 'board'].map((k) => el('option', { value: k, selected: (meta?.kind || 'pages') === k }, `${KIND_LABEL[k]} — ${k === 'journal' ? '一天一页，按时间追加（健康、财务）' : k === 'board' ? '卡片 + 列（看板）' : '一条内容一页（阅读、思维）'}`)));
  const cols = el('input', { type: 'text', value: (meta?.columns || ['待处理', '进行中', '已完成']).join(', ') });
  const colsRow = [el('label', {}, '列'), cols];
  const kw = el('input', { type: 'text', value: (meta?.keywords || []).join(', '), placeholder: '用于自动归类，逗号分隔：睡眠, 运动, 体重' });
  const desc = el('textarea', { class: 'body-edit', style: 'min-height:70px;border:1px solid var(--border);border-radius:6px;padding:8px', placeholder: '什么内容属于这里？一句话。agent 和归类器都会参考。' }, meta?.description || '');
  const syncCols = () => colsRow.forEach((n) => n.classList.toggle('hidden', kind.value !== 'board'));
  kind.onchange = syncCols; syncCols();
  modal(editing ? `设置 · ${meta.title}` : '新建笔记本', el('div', { class: 'form' }, el('label', {}, '文件夹'), folderIn, el('label', {}, '名称'), title, el('label', {}, '图标'), icon, el('label', {}, '形态'), kind, ...colsRow, el('label', {}, '关键词'), kw, el('label', {}, '说明'), desc), {
    okLabel: editing ? '保存' : '创建',
    onOk: async () => {
      const f = folderIn.value.trim(); if (!f) return false;
      const payload = { title: title.value.trim() || f, icon: icon.value.trim() || '📁', kind: kind.value, keywords: kw.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean), description: desc.value.trim(), columns: kind.value === 'board' ? cols.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined };
      if (editing) await api('PATCH', `/api/notebooks/${encPath(f)}`, payload); else await api('POST', '/api/notebooks', { folder: f, ...payload });
      await loadSidebar(); location.hash = nbHref(f); route();
    }
  });
  setTimeout(() => (editing ? title : folderIn).focus(), 30);
}

function searchDialog() {
  const input = el('input', { type: 'text', placeholder: '搜索标题、属性和正文…', style: 'width:100%;border:none;outline:none;font-size:16px;padding:4px 0' });
  const results = el('div', { style: 'margin-top:8px;max-height:50vh;overflow:auto' });
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    const q = input.value.trim(); results.innerHTML = ''; if (!q) return;
    const hits = await get(`/api/search?q=${encodeURIComponent(q)}`);
    if (!hits.length) results.append(el('div', { class: 'empty' }, '没有结果'));
    for (const h of hits) results.append(el('div', { class: 'search-hit', onclick: () => { close(); openPeek(h.path); } }, el('div', { class: 't' }, h.title), el('div', { class: 's' }, h.snippet), el('div', { class: 'p' }, (nbOf(h.folder)?.title || h.folder || '/') + ' · ' + h.path)));
  }, 180); });
  const close = modal('搜索', el('div', {}, input, results));
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- settings
async function viewSettings(main) {
  const [status, tokens] = await Promise.all([get('/api/status'), get('/api/tokens')]);
  const page = el('div', { class: 'page settings' });
  page.append(el('h1', { class: 'page-title' }, '设置'), el('p', {}, `笔记库位置：${status.vault}`));

  // phone / remote access
  const acc = await get('/api/access/settings');
  page.append(el('h2', {}, '手机访问'), el('p', {}, '在手机浏览器里打开这台 Mac 上的服务，用访问密码登录后就能用（可「添加到主屏幕」当 app 用）。每次登录生成一个设备令牌，列在下面的令牌表里，随时可撤销。'));
  const pw1 = el('input', { type: 'password', placeholder: acc.passwordSet ? '输入新密码可更换' : '至少 6 位', autocomplete: 'new-password' });
  const lanChk = el('input', { type: 'checkbox', checked: !!acc.lan });  const trustChk = el('input', { type: 'checkbox', checked: acc.trustLoopback !== false });

  const accMsg = el('div', { class: 'muted', style: 'font-size:13px' });
  const saveAccess = async (body) => { try { const r = await api('POST', '/api/access/settings', body); toast('已保存'); pw1.value = ''; route(); return r; } catch (err) { toast(err.message, true); } };
  const steps = el('div', { class: 'kv', style: 'margin-top:14px;grid-template-columns:150px 1fr' },
    el('div', { class: 'k' }, '访问密码'), el('div', {}, acc.passwordSet ? el('span', { class: 'ok' }, `已设置（${fmtTime(acc.passwordSetAt).slice(0, 16)}）`) : el('span', { class: 'err' }, '未设置 — 手机无法登录')),
    el('div', { class: 'k' }, '同一 Wi-Fi'), el('div', {}, acc.lan ? [acc.boundLan ? el('span', { class: 'ok' }, '已开启。') : el('span', { class: 'err' }, '已开启，重启服务后生效。'), el('div', { style: 'margin-top:4px' }, '手机浏览器打开：', acc.lanUrls.map((u) => el('a', { href: u, target: '_blank', style: 'color:var(--accent-text);margin-right:10px;font-family:var(--mono);font-size:13px' }, u)))] : el('span', { class: 'muted' }, '未开启（服务只监听 127.0.0.1）')),
    el('div', { class: 'k' }, '固定地址'), el('div', {}, acc.funnelUrl
      ? [el('span', { class: 'ok' }, 'Tailscale Funnel 已开启：'), el('a', { href: acc.funnelUrl, target: '_blank', style: 'color:var(--accent-text);font-family:var(--mono);font-size:13px' }, acc.funnelUrl), el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' }, '手机和远程 agent 都用这个地址；Mac 重启后不变。接入 Agent 页生成的 skill 默认带这个地址。')]
      : el('span', { class: 'muted' }, '未开启')),
    el('div', { class: 'k' }, '不在同一网络'), el('div', { style: 'font-size:13px;line-height:1.7' },
      el('div', {}, el('b', {}, 'Tailscale Funnel'), '（推荐：固定公网 https 地址，没有机器人验证页，远程 agent 都能直连）：'), el('div', { class: 'code' }, `tailscale funnel --bg ${acc.port}`),
      el('div', {}, el('b', {}, 'Tailscale Serve'), '（只给自己的设备，手机装 Tailscale 登录同一账号）：'), el('div', { class: 'code' }, `tailscale serve --bg ${acc.port}`),
      el('div', {}, el('b', {}, 'Cloudflare 临时隧道'), '（地址每次都变，且会拦截部分 agent 的请求）：'), el('div', { class: 'code' }, `cloudflared tunnel --url http://127.0.0.1:${acc.port}`),
      el('div', { class: 'muted' }, '隧道过来的请求一律要密码或 token；只有本机直连不需要。')));
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, acc.passwordSet ? '更换密码' : '设置密码'), el('div', { class: 'row' }, pw1, el('button', { class: 'btn primary', onclick: () => { if (pw1.value.length < 6) { toast('密码至少 6 位', true); return; } saveAccess({ password: pw1.value }); } }, acc.passwordSet ? '更换' : '设置'), acc.passwordSet && el('button', { class: 'btn danger', onclick: () => { if (confirm('清除访问密码？已登录的手机不受影响，可在令牌表里撤销。')) saveAccess({ clearPassword: true }); } }, '清除')),
    el('label', {}, '本机免密'), el('div', { class: 'row' }, el('label', {}, trustChk, ' 本机浏览器不用密码即为 owner（个人电脑开着方便；放在服务器上请关掉，否则同机任何进程都是 owner）'), el('button', { class: 'btn small', onclick: () => saveAccess({ trustLoopback: trustChk.checked }) }, '保存')),
    el('label', {}, '局域网访问'), el('div', { class: 'row' }, el('label', {}, lanChk, ' 允许同一 Wi-Fi 的设备连接（监听 0.0.0.0，需重启服务）'), el('button', { class: 'btn small', onclick: () => saveAccess({ lan: lanChk.checked }) }, '保存')),
    status.principal?.kind === 'token' && el('label', {}, '本设备'), status.principal?.kind === 'token' && el('div', { class: 'row' }, el('span', { class: 'muted', style: 'font-size:13px' }, `以设备令牌「${status.principal.name}」登录`), el('button', { class: 'btn small', onclick: logout }, '退出登录'))),
    steps, accMsg));

  // AI classification
  const ai = await get('/api/ai');
  state.ai = ai;
  page.append(el('h2', {}, '智能归类（AI）'), el('p', {}, '不填也能用：系统靠关键词、学到的规则和「与各笔记本已有内容的相似度」归类。开启后，拿不准的记录会交给模型判断归属，并为没有标题的长记录提炼一句话标题、补标签和数字属性；收件箱也可一键「AI 整理」。最省事的是直接用本机已登录的 Claude Code：不用 key，走你现有的订阅。设置保存在本机 vault/.notebook/config.json（不进 git）。'));
  const isApi = ai.provider === 'api';
  const cliInfo = ai.provider === 'claude-cli' ? ai.cli.claude : ai.provider === 'codex-cli' ? ai.cli.codex : ai.provider === 'grok-cli' ? ai.cli.grok : null;
  const cliName = ai.provider === 'codex-cli' ? 'codex' : ai.provider === 'grok-cli' ? 'grok' : 'claude';
  const isGrok = ai.provider === 'grok-cli';
  const grokSel = el('select', {}, (ai.grokModels || []).map((m) => el('option', { value: m.id, selected: m.id === (ai.grokModel || '') }, m.label)));
  const providerSel = el('select', {}, ai.providers.map((p) => el('option', { value: p.id, selected: p.id === ai.provider }, p.label)));
  const keyIn = el('input', { type: 'password', placeholder: ai.hasKey ? `已保存 ${ai.keyPrefix}，输入新 key 可替换` : 'sk-ant-…', autocomplete: 'off' });
  const modelSel = el('select', {}, ai.models.map((m) => el('option', { value: m.id, selected: m.id === ai.model }, m.label)));
  const modeSel = el('select', {}, el('option', { value: 'unsure', selected: ai.mode !== 'always' }, '只在规则拿不准时问 AI（省钱）'), el('option', { value: 'always', selected: ai.mode === 'always' }, '每条都让 AI 复核（更准）'));
  const enabledChk = el('input', { type: 'checkbox', checked: !!ai.enabled, disabled: !ai.configured });
  const aiOut = el('div', { class: 'muted', style: 'font-size:13px;margin-top:10px' });
  const saveAi = async (body) => { try { const r = await api('POST', '/api/ai', body); toast('已保存'); state.ai = r; route(); } catch (err) { toast(err.message, true); } };
  providerSel.onchange = () => saveAi({ provider: providerSel.value });
  const testBtn = el('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; aiOut.textContent = '测试中…（CLI 第一次可能要十几秒）'; try { const r = await api('POST', '/api/ai/test', {}); aiOut.innerHTML = ''; aiOut.append(el('span', { class: 'ok' }, `✓ 连接正常 · ${r.model} · ${r.ms} ms · 回复「${r.reply}」`)); } catch (err) { aiOut.innerHTML = ''; aiOut.append(el('span', { class: 'err' }, '连接失败：' + err.message)); } b.disabled = false; } }, '测试连接');
  const cliStatus = !isApi && (cliInfo
    ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, el('span', { class: 'chip source' }, '已找到'), el('span', { style: 'font-family:var(--mono);font-size:12px' }, cliInfo.path), cliInfo.version && el('span', { class: 'muted', style: 'font-size:12px' }, cliInfo.version),
        !ai.enabled && el('button', { class: 'btn primary small', onclick: () => saveAi({ provider: ai.provider, enabled: true }) }, '开启'))
    : el('div', {}, el('span', { class: 'err' }, `本机没找到 ${cliName} 命令。`), el('span', { class: 'muted', style: 'font-size:13px' }, cliName === 'claude' ? ' 安装并登录：终端运行 npm i -g @anthropic-ai/claude-code && claude ，登录后回到这里刷新。' : cliName === 'grok' ? ' 安装并登录：终端运行 curl -fsSL https://x.ai/cli/install.sh | bash 再运行 grok 登录，登录后回到这里刷新。' : ' 安装并登录：终端运行 npm i -g @openai/codex && codex ，登录后回到这里刷新。')));
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, '方式'), providerSel,
    isApi && el('label', {}, 'API key'), isApi && el('div', { class: 'row' }, keyIn, el('button', { class: 'btn primary', onclick: () => { if (!keyIn.value.trim()) { toast('先粘贴 key', true); return; } saveAi({ provider: 'api', apiKey: keyIn.value.trim(), enabled: true }); } }, ai.hasKey ? '替换' : '保存并开启'), ai.hasKey && el('button', { class: 'btn danger', onclick: () => { if (confirm('删除已保存的 API key？')) saveAi({ clearKey: true }); } }, '删除')),
    !isApi && el('label', {}, '本机 CLI'), cliStatus,
    isGrok && el('label', {}, '模型'), isGrok && el('div', { class: 'row' }, grokSel, el('span', { class: 'muted', style: 'font-size:12px' }, '走 grok.com 的登录账号；归类这种小活选 build-fast 即可')),
    ai.provider !== 'codex-cli' && !isGrok && el('label', {}, '模型'), ai.provider !== 'codex-cli' && !isGrok && el('div', { class: 'row' }, modelSel, el('span', { class: 'muted', style: 'font-size:12px' }, isApi ? '一条记录约 1k token，Opus 约 ¥0.03/条，Haiku 约 ¥0.001/条' : '走 Claude Code 的登录账号，占用订阅额度，不另外计费；归类这种小活用 Haiku 足够')),
    el('label', {}, '何时使用'), modeSel,
    el('label', {}, '开关'), el('div', { class: 'row' }, el('label', {}, enabledChk, ai.configured ? ' 启用 AI 归类' : isApi ? ' 启用 AI 归类（先保存 key）' : ` 启用 AI 归类（先安装并登录 ${cliName}）`)),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => saveAi({ provider: ai.provider, model: modelSel.value, grokModel: isGrok ? grokSel.value : undefined, mode: modeSel.value, enabled: enabledChk.checked }) }, '保存设置'),
      ai.configured && testBtn)),
    aiOut));

  page.append(el('h2', {}, 'Agent 访问令牌'), el('p', {}, el('a', { href: '#/agents', style: 'color:var(--accent)' }, '接入 Agent 页'), ' 可以自动检测并一键接入本机 agent。这里管理已有令牌：read 只能读取，write 可以记录 / 修改，admin 可以管理令牌和备份。'));
  const tokBox = el('div', { class: 'card-box' });
  if (tokens.length) {
    const t = el('table', { style: 'width:100%;font-size:14px;border-collapse:collapse' });
    t.append(el('thead', {}, el('tr', {}, ...['名称', '前缀', '权限', '文件夹', '最近使用', ''].map((h) => el('th', {}, h)))));
    for (const tk of tokens) {
      t.append(el('tr', {}, el('td', { style: 'padding:6px;font-weight:500' }, tk.device ? '📱 ' : '', tk.name), el('td', { style: 'padding:6px;font-family:var(--mono);font-size:12px' }, tk.prefix + '…'),
        el('td', { style: 'padding:6px' }, tk.scopes.map((s) => el('span', { class: 'chip status' }, s))), el('td', { style: 'padding:6px' }, tk.folders.map((f) => el('span', { class: 'chip' }, f === '*' ? '全部' : f))),
        el('td', { style: 'padding:6px;font-size:12px;color:var(--text-3)' }, tk.lastUsed ? fmtTime(tk.lastUsed) : '从未'),
        el('td', { style: 'padding:6px;text-align:right' }, el('button', { class: 'btn small danger', onclick: async () => { if (!confirm(`撤销「${tk.name}」？`)) return; await api('DELETE', `/api/tokens/${encodeURIComponent(tk.name)}`); route(); } }, '撤销'))));
    }
    tokBox.append(t);
  } else tokBox.append(el('div', { class: 'empty' }, '还没有令牌。'));
  page.append(tokBox);

  const name = el('input', { type: 'text', placeholder: '例如 my-bot' });
  const sWrite = el('input', { type: 'checkbox', checked: true }), sAdmin = el('input', { type: 'checkbox' });
  const folders = el('input', { type: 'text', placeholder: '留空 = 全部；或填 Alpha看板, 灵感' });
  const out = el('div');
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, '名称'), name,
    el('label', {}, '权限'), el('div', { class: 'row' }, el('label', {}, el('input', { type: 'checkbox', checked: true, disabled: true }), ' read'), el('label', {}, sWrite, ' write'), el('label', {}, sAdmin, ' admin')),
    el('label', {}, '限制文件夹'), folders,
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api('POST', '/api/agents/snippets', { name: name.value.trim(), scopes: ['read', sWrite.checked && 'write', sAdmin.checked && 'admin'].filter(Boolean), folders: folders.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
        out.innerHTML = ''; out.append(el('div', { class: 'token-box' }, el('div', { style: 'font-weight:600' }, `「${r.name}」的令牌（只显示一次）`), snippetBlocks(r)));
        name.value = ''; folders.value = '';
      } catch (err) { toast(err.message, true); }
    } }, '创建令牌'))), out));

  // learned routing rules
  const rules = await get('/api/rules');
  page.append(el('h2', {}, '归类规则'), el('p', {}, '你在收件箱里分配内容、或移动笔记时，系统学到的规则。关键词和标签直接决定归类；来源偏好是某个 agent 常记到哪里的统计（3 次以上才生效）。删掉就忘记。各笔记本自带的关键词在笔记本的「⚙ 设置」里改。'));
  const rulesBox = el('div', { class: 'card-box' });
  const forget = async (r) => { try { await api('POST', '/api/rules/forget', { type: r.type, key: r.key, folder: r.folder }); toast('已忘记'); route(); } catch (err) { toast(err.message, true); } };
  const ruleTable = (title, list, keyLabel, keyRender) => {
    if (!list.length) return;
    rulesBox.append(el('div', { style: 'font-weight:600;font-size:13px;margin:4px 0 6px' }, `${title} · ${list.length}`));
    const t = el('table', { style: 'width:100%;font-size:14px;border-collapse:collapse;margin-bottom:14px' });
    t.append(el('thead', {}, el('tr', {}, ...[keyLabel, '归入', ''].map((h) => el('th', {}, h)))));
    for (const r of list) {
      const nb = nbOf(r.folder);
      t.append(el('tr', {}, el('td', { style: 'padding:5px 6px' }, keyRender(r)),
        el('td', { style: 'padding:5px 6px' }, nb ? el('a', { href: nbHref(r.folder) }, `${nb.icon} ${nb.title}`) : el('span', { class: 'muted' }, `${r.folder}（已不存在）`), r.count ? el('span', { class: 'muted', style: 'font-size:12px;margin-left:6px' }, `${r.count} 次`) : ''),
        el('td', { style: 'padding:5px 6px;text-align:right' }, el('button', { class: 'btn small danger', onclick: () => forget(r) }, '忘记'))));
    }
    rulesBox.append(t);
  };
  ruleTable('关键词', rules.filter((r) => r.type === 'keyword'), '标题里出现', (r) => el('span', { class: 'chip' }, r.key));
  ruleTable('标签', rules.filter((r) => r.type === 'tag'), '标签', (r) => el('span', { class: 'chip' }, '#' + r.key));
  ruleTable('来源偏好', rules.filter((r) => r.type === 'source'), 'Agent', (r) => chipSource(r.key));
  if (!rules.length) rulesBox.append(el('div', { class: 'empty' }, '还没有学到任何规则。在首页收件箱里点一次「归入」就会有。'));
  else rulesBox.append(el('div', { style: 'text-align:right' }, el('button', { class: 'btn small', onclick: () => { if (confirm('忘记全部学到的规则？笔记本自带的关键词不受影响。')) forget({ type: 'all' }); } }, '全部忘记')));
  page.append(rulesBox);

  const bk = status.backup;
  page.append(el('h2', {}, '备份'), el('p', {}, '把整个笔记库作为 git 仓库定期 commit，并 push 到 GitHub（或任何 git 远端）。未开启时所有内容只保存在本地。'));
  const remote = el('input', { type: 'url', value: bk.remote || '', placeholder: 'https://github.com/you/my-notes.git（先在 GitHub 新建一个空仓库）' });
  const enabled = el('input', { type: 'checkbox', checked: !!bk.enabled });
  const interval = el('input', { type: 'number', value: bk.intervalMinutes || 30, min: 1, style: 'width:90px' });
  const bkStatus = el('div', { class: 'kv', style: 'margin-top:12px' },
    el('div', { class: 'k' }, 'Git 仓库'), el('div', {}, bk.isRepo ? el('span', { class: 'ok' }, `已初始化（分支 ${bk.branch}）`) : el('span', { class: 'muted' }, '未初始化，保存设置时会自动 git init')),
    el('div', { class: 'k' }, '待提交'), el('div', {}, bk.dirty == null ? '—' : `${bk.dirty} 个文件`),
    el('div', { class: 'k' }, '最近提交'), el('div', {}, bk.lastCommit || '—'),
    el('div', { class: 'k' }, '最近备份'), el('div', {}, bk.lastRun ? `${fmtTime(bk.lastRun)} ${bk.lastResult ? `(提交 ${bk.lastResult.committed ? '✓' : '无变更'}，推送 ${bk.lastResult.pushed ? '✓' : '—'})` : ''}` : '本次运行尚未备份'),
    bk.lastError && el('div', { class: 'k' }, '错误'), bk.lastError && el('div', { class: 'err', style: 'font-family:var(--mono);font-size:12px' }, bk.lastError));
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, '远端仓库'), remote,
    el('label', {}, '自动备份'), el('div', { class: 'row' }, el('label', {}, enabled, ' 开启'), el('span', {}, '每'), interval, el('span', {}, '分钟')),
    el('div', { class: 'actions' },
      el('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/api/backup/config', { remote: remote.value.trim(), enabled: enabled.checked, intervalMinutes: Number(interval.value) }); toast('已保存备份设置'); route(); } catch (err) { toast(err.message, true); } } }, '保存设置'),
      el('button', { class: 'btn', onclick: async () => { toast('备份中…'); const r = await api('POST', '/api/backup/run'); toast(r.lastError ? '备份失败：' + r.lastError : '备份完成', !!r.lastError); route(); } }, '立即备份'))),
    bkStatus));
  main.append(topbar([{ label: '设置' }]), page);
}

// ---------------------------------------------------------------- agents
/** A paste-ready skill / system prompt that teaches any agent to write into this notebook with this token. */
function skillText(r) {
  const nbs = state.notebooks.filter((n) => !n.inbox).map((n) => `${n.title}（${n.folder}，${KIND_LABEL[n.kind]}${n.keywords?.length ? '：' + n.keywords.slice(0, 6).join('、') : ''}）`).join('\n  - ');
  return `# 技能：记到我的 Agent Notebook

我有一个私人笔记本（本地 Markdown，Obsidian 兼容），所有 agent 共用。值得保留的内容请记进去，不要只留在对话里。

## 怎么记（按你能做的方式选一种）
1. 支持 MCP 连接器：服务器地址 ${r.tokenUrl} ，调用工具 notebook_capture { text, title?, tags?, properties?, source: "<你的名字>" }。
2. 能发 HTTP 请求：POST ${r.base}/api/capture ，请求头 Authorization: Bearer ${r.token} 和 X-Agent-Name: <你的名字> ，JSON 正文 { "text": "...", "title": "...", "tags": [], "properties": {}, "source": "<你的名字>" }。
3. 只能打开网址：访问 ${r.quickUrl}?text=<URL 编码后的内容> ，返回 JSON 里的 hint 就是结果。

## 什么时候记
- 我说「记一下 / 记到笔记本 / 存起来 / 帮我记住」时，立刻记，不要反问格式。
- 你自己得出的结论、发现的线索、值得回看的想法，主动记，记完一句话告诉我归到了哪里。

## 怎么写
- 一次一条。title 是一句话结论（≤60 字），细节放 text（可用 Markdown）。
- 数字一律放 properties：花钱 {"amount": 35}，体重 {"weight": 71.5}，步数 {"steps": 8000}，页数 {"pages": 40}，同类数字始终用同一个 key，这样会自动画成图表。
- source 填你自己的名字（比如 Hermes、Grok、Muse），不是 token 名；每个请求（包括改和删）都带请求头 X-Agent-Name: <你的名字>，笔记本靠它标注是谁写的、谁改的。
- 不要自己选笔记本：系统按关键词和我教过的规则自动归类，拿不准会进收件箱由我分配。只有我明确说「记到 X」时才传 notebook。现有笔记本：
  - ${nbs}
- 想引用已有笔记，在 text 里写 [[笔记标题]]。返回结果里的 related 是相似的已有笔记，明显同一主题就别重复新建。

## 改和删（不是只能新增）
- 记录接口会返回 path（笔记路径）和 entry（日志条目的时间标题）。要更正一条已有记录时，改它，不要再新增一条"更正"。
- 改整页：PATCH ${r.base}/api/notes/<path> ，JSON { "body": 整段替换, "append": 末尾追加, "title", "tags", 任意属性 }（MCP：notebook_update_note）。
- 改日志里的某一条（健康、财务这类一天一页）：PATCH ${r.base}/api/entries/<path> ，JSON { "time": "15:59", "match": "可选的标题/正文片段", "text": 新正文, "title": 新标题, "properties": {"amount": 66.7}, "remove": true 表示删除 }（MCP：notebook_update_entry）。
- 删整条笔记：DELETE ${r.base}/api/notes/<path>（MCP：notebook_delete_note），会进回收站。
- 先读再改：GET ${r.base}/api/notes/<path>（MCP：notebook_read_note）。path 里的中文要 URL 编码。

## 回看
- 今天记了什么：GET ${r.base}/api/today （或 MCP 工具 notebook_today）
- 搜索：GET ${r.base}/api/search?q=关键词 （或 notebook_search）
- ChatGPT 自定义 GPT 的 Action 可直接导入 ${r.openapiUrl} ，认证选 API Key → Bearer，填上面的 token。`;
}

function snippetBlocks(r) {
  const skill = skillText(r);
  const copyBtn = el('button', { class: 'btn small primary', onclick: async () => { try { await navigator.clipboard.writeText(skill); toast('已复制 Skill'); } catch { toast('复制失败，请手动选择文本', true); } } }, '复制 Skill');
  return el('div', {},
    el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:12px' }, el('div', { style: 'font-weight:600' }, '最简单：把这段 Skill 粘贴给 agent'), el('div', { class: 'spacer' }), copyBtn),
    el('div', { class: 'muted', style: 'font-size:12.5px;margin:4px 0 8px' }, '放进它的系统提示 / 项目指令 / 自定义指令里即可。里面已经包含地址、token、笔记本列表和记录规则，agent 会按自己能用的方式（MCP / HTTP / 打开网址）去记。'),
    el('textarea', { class: 'body-edit', readonly: true, style: 'min-height:260px;font-size:12.5px', onclick: (e) => e.target.select() }, skill),
    el('details', { style: 'margin-top:14px' }, el('summary', { style: 'cursor:pointer;color:var(--text-2);font-size:13px' }, '手动配置的各种格式'), snippetDetails(r)));
}

function snippetDetails(r) {
  return el('div', {},
    el('div', { style: 'font-weight:500;margin-top:12px' }, '方式 A · HTTP（适合桌面应用 / 远程 agent，服务需保持运行）：'),
    el('div', { class: 'code' }, `URL: ${r.httpUrl}\nAuthorization: Bearer ${r.token}`),
    el('div', { style: 'font-weight:500;margin-top:12px' }, '方式 A′ · 不能设请求头的客户端（Claude / ChatGPT 手机 app 的「自定义连接器」）：token 直接放在地址里，整段当作 MCP 服务器 URL 填入：'),
    el('div', { class: 'code' }, r.tokenUrl),
    el('div', { class: 'muted', style: 'font-size:12px' }, '从手机或隧道地址打开本页生成时，地址会自动用当前访问的域名；从 Mac 本机生成的话要把 127.0.0.1 换成隧道地址。'),
    el('div', { style: 'font-weight:500;margin-top:12px' }, '方式 B · stdio JSON（Cursor / Claude Desktop / Kiro 等通用格式）：'),
    el('div', { class: 'code' }, JSON.stringify(r.json, null, 2)),
    el('div', { style: 'font-weight:500;margin-top:12px' }, '方式 C · TOML（Codex / Grok CLI 格式）：'),
    el('div', { class: 'code' }, r.toml),
    el('div', { style: 'font-weight:500;margin-top:12px' }, 'Claude Code 一行命令：'),
    el('div', { class: 'code' }, r.claudeCmd));
}

async function viewAgents(main) {
  const data = await get('/api/agents');
  const page = el('div', { class: 'page settings' });
  page.append(el('h1', { class: 'page-title' }, '接入 Agent'),
    el('p', {}, '下面是在这台电脑上检测到的 agent。点「一键接入」会：为它生成一个专属 token → 把 MCP 配置写进它的配置文件（原文件先备份为 .bak）→ 装上使用说明 Skill。之后重启那个 agent 就能用了。'));
  const section = (title, list, desc) => {
    if (!list.length) return;
    page.append(el('h2', {}, title));
    if (desc) page.append(el('p', {}, desc));
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-bottom:8px' });
    for (const a of list) grid.append(agentCard(a));
    page.append(grid);
  };
  section('可一键接入', data.agents.filter((a) => a.detected && !a.connected && a.canWrite));
  section('已接入', data.agents.filter((a) => a.connected), '再次接入会生成新的 token 并覆盖该 agent 配置里的 agent-notebook 条目。');
  section('需要在应用内手动添加', data.agents.filter((a) => a.detected && !a.canWrite), '这些应用的 MCP 设置在它们自己的界面里。点「生成配置」拿到地址和 token，粘贴进去即可。');

  page.append(el('h2', {}, '其他 agent（Hermes、Muse、自写的 bot…）'), el('p', {}, '任何支持 MCP 或能发 HTTP 请求的 agent 都能接入。起个名字生成 token，把下面的 Skill 贴给它即可。一个 token 给几个 agent 共用也行：记录上标的是 agent 自报的名字（source / X-Agent-Name），MCP 客户端会按握手里的名字识别，都没有才显示 token 名。'));
  const name = el('input', { type: 'text', placeholder: '例如 hermes、muse、my-bot' });
  const sWrite = el('input', { type: 'checkbox', checked: true });
  const folders = el('input', { type: 'text', placeholder: '留空 = 全部；或填 Alpha看板, 灵感' });
  const out = el('div');
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, '名称'), name,
    el('label', {}, '权限'), el('div', { class: 'row' }, el('label', {}, el('input', { type: 'checkbox', checked: true, disabled: true }), ' read'), el('label', {}, sWrite, ' write')),
    el('label', {}, '限制文件夹'), folders,
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: async () => {
      try {
        const body = { name: name.value.trim(), scopes: ['read', sWrite.checked && 'write'].filter(Boolean), folders: folders.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
        let r;
        try { r = await api('POST', '/api/agents/snippets', body); }
        catch (err) { if (!/already exists/.test(err.message) || !confirm(`「${body.name}」已经有 token 了。重新生成会让旧的失效，继续？`)) throw err; r = await api('POST', '/api/agents/snippets', { ...body, replace: true }); }
        out.innerHTML = ''; out.append(el('div', { class: 'token-box' }, el('div', { style: 'font-weight:600' }, `「${r.name}」的接入配置（token 只显示这一次）`), snippetBlocks(r))); name.value = '';
      } catch (err) { toast(err.message, true); }
    } }, '生成配置'))), out));
  const notFound = data.agents.filter((a) => !a.detected);
  if (notFound.length) page.append(el('h2', {}, '未检测到'), el('p', { class: 'muted', style: 'font-size:13px' }, notFound.map((a) => `${a.icon} ${a.name}`).join('　')));
  main.append(topbar([{ label: '接入 Agent' }]), page);
}

function agentCard(a) {
  const status = a.connected ? el('span', { class: 'chip source' }, '已接入') : a.canWrite ? el('span', { class: 'chip status' }, '可一键接入') : el('span', { class: 'chip' }, '手动');
  const result = el('div');
  const card = el('div', { class: 'card-box', style: 'margin:0;display:flex;flex-direction:column' },
    el('div', { style: 'display:flex;align-items:center;gap:8px' }, el('span', { style: 'font-size:22px' }, a.icon), el('span', { style: 'font-weight:600;flex:1' }, a.name), status),
    el('div', { class: 'muted', style: 'font-size:12px;margin:6px 0 10px;word-break:break-all' }, a.configPath ? `配置：${a.configPath.replace(/^\/Users\/[^/]+/, '~')}` : (a.note || '')));
  const actions = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
  if (a.canWrite) {
    const sWrite = el('input', { type: 'checkbox', checked: true });
    const sSkill = el('input', { type: 'checkbox', checked: a.hasSkills });
    actions.append(el('label', { style: 'font-size:13px' }, sWrite, ' 允许写入'));
    if (a.hasSkills) actions.append(el('label', { style: 'font-size:13px' }, sSkill, ' 安装 Skill'));
    actions.append(el('div', { style: 'flex:1' }));
    actions.append(el('button', { class: 'btn small' + (a.connected ? '' : ' primary'), onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '接入中…';
      try {
        const r = await api('POST', `/api/agents/${a.id}/connect`, { scopes: ['read', sWrite.checked && 'write'].filter(Boolean), skill: sSkill.checked });
        result.innerHTML = '';
        result.append(el('div', { class: 'token-box', style: 'margin-top:10px;font-size:13px' }, el('div', { style: 'font-weight:600' }, `✓ 已接入 ${r.agent}`), el('div', {}, `token「${r.tokenName}」（${r.scopes.join(', ')}）`),
          el('div', { style: 'word-break:break-all' }, `已写入 ${r.configPath}`), r.backupPath && el('div', { class: 'muted' }, `原文件备份：${r.backupPath}`), r.skillPath && el('div', { class: 'muted' }, `Skill 已装到 ${r.skillPath}`), r.restart && el('div', { style: 'margin-top:6px' }, `下一步：${r.restart}`)));
        btn.textContent = '重新接入'; btn.disabled = false; btn.classList.remove('primary'); status.replaceWith(el('span', { class: 'chip source' }, '已接入'));
      } catch (err) { toast(err.message, true); btn.textContent = a.connected ? '重新接入' : '一键接入'; btn.disabled = false; }
    } }, a.connected ? '重新接入' : '一键接入'));
  } else {
    actions.append(el('div', { style: 'flex:1' }));
    actions.append(el('button', { class: 'btn small primary', onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await api('POST', '/api/agents/snippets', { name: a.id, scopes: ['read', 'write'], folders: [], replace: true }); result.innerHTML = ''; result.append(el('div', { class: 'token-box', style: 'margin-top:10px;font-size:13px' }, el('div', { style: 'font-weight:600' }, `「${r.name}」的接入配置（token 只显示这一次）`), snippetBlocks(r))); }
      catch (err) { toast(err.message, true); }
      btn.disabled = false;
    } }, '生成配置'));
  }
  card.append(actions, result);
  return card;
}

// ---------------------------------------------------------------- relation graph ([[links]])
// fixed-order categorical palette (light / dark steps), one slot per notebook in sidebar order; the 9th+ share gray
const PALETTE = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] };
const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
function notebookColor(folder) {
  const pal = PALETTE[isDark() ? 'dark' : 'light'];
  const i = state.notebooks.findIndex((n) => n.folder === folder);
  return i >= 0 && i < pal.length ? pal[i] : (isDark() ? '#8a8a85' : '#9b9a94');
}

async function viewGraph(main, focus) {
  const data = await get('/api/graph');
  const page = el('div', { class: 'page wide', style: 'padding-bottom:16px' });
  const hiddenKey = 'graph:hidden';
  const hidden = new Set(JSON.parse(localStorage.getItem(hiddenKey) || '[]'));
  let showOrphans = localStorage.getItem('graph:orphans') === '1';
  let query = '';
  const focusPath = focus || ''; // parseHash already decoded it

  page.append(el('div', { style: 'display:flex;align-items:baseline;gap:12px' }, el('h1', { class: 'page-title', style: 'font-size:28px;margin:0' }, '关系图'),
    el('span', { class: 'muted', style: 'font-size:13px' }, `${data.nodes.length} 篇笔记 · ${data.edges.length} 条链接${data.unresolved.length ? ` · ${data.unresolved.length} 个未创建的链接` : ''}`)));

  // legend = filter
  const groups = new Map();
  for (const n of data.nodes) { const k = n.notebook || ''; groups.set(k, (groups.get(k) || 0) + 1); }
  const legend = el('div', { class: 'legend' });
  const drawLegend = () => {
    legend.innerHTML = '';
    const order = [...state.notebooks.map((n) => n.folder).filter((f) => groups.has(f)), ...(groups.has('') ? [''] : [])];
    for (const f of order) {
      const nb = nbOf(f);
      legend.append(el('button', { class: 'legend-chip' + (hidden.has(f) ? ' off' : ''), onclick: () => { hidden.has(f) ? hidden.delete(f) : hidden.add(f); localStorage.setItem(hiddenKey, JSON.stringify([...hidden])); drawLegend(); rebuild(); } },
        el('span', { class: 'sw', style: `background:${notebookColor(f)}` }), nb ? `${nb.icon} ${nb.title}` : '📄 笔记本之外', el('span', { class: 'muted' }, groups.get(f))));
    }
  };
  drawLegend();
  const search = el('input', { type: 'search', placeholder: '高亮标题包含…', style: 'font-size:13px;width:180px;height:27px;padding:3px 10px' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); paint(); });
  const orphanBtn = el('button', { class: 'btn small' + (showOrphans ? ' active' : ''), onclick: () => { showOrphans = !showOrphans; localStorage.setItem('graph:orphans', showOrphans ? '1' : '0'); orphanBtn.classList.toggle('active', showOrphans); rebuild(); } }, '显示未链接的笔记');
  page.append(el('div', { class: 'toolbar', style: 'border:none;padding-bottom:6px;margin-bottom:6px' }, legend, el('div', { class: 'spacer' }), search, orphanBtn, el('button', { class: 'btn small', onclick: () => { userView = false; rebuild(true); } }, '↻ 重新布局')));

  const wrap = el('div', { class: 'graph-wrap' });
  const tipEl = el('div', { class: 'chart-tip hidden', style: 'top:auto' });
  const hint = el('div', { class: 'graph-hint muted' }, '拖动节点 · 滚轮缩放 · 拖动空白平移 · 点击打开笔记');
  page.append(wrap);
  main.append(topbar([{ label: '关系图' }]), page);
  if (!data.edges.length) { wrap.append(el('div', { class: 'empty', style: 'padding:40px;text-align:center;font-size:14px' }, '还没有任何 [[链接]]。在正文里写 [[页面标题]] 把笔记连起来，这里就会长出一张图。')); return; }

  // ---- simulation state ----
  const svgRoot = svg('svg', { class: 'graph' });
  const root = svg('g');
  const edgeLayer = svg('g', { class: 'gl' });
  const nodeLayer = svg('g', { class: 'gnodes' });
  root.append(edgeLayer, nodeLayer);
  svgRoot.append(root);
  wrap.append(svgRoot, tipEl, hint);
  let nodes = [], edges = [], byPath = new Map(), neighbors = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let alpha = 0, raf = null, hover = null;
  const W = () => wrap.clientWidth || 800, H = () => wrap.clientHeight || 600;
  const fitHeight = () => { wrap.style.height = Math.max(360, window.innerHeight - wrap.getBoundingClientRect().top - 14) + 'px'; }; // fill the viewport, never scroll
  const applyView = () => root.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);

  function rebuild(reshuffle = false) {
    fitHeight();
    const prev = byPath;
    const visible = data.nodes.filter((n) => !hidden.has(n.notebook || '') && (showOrphans || n.degree > 0 || n.path === focusPath));
    const ok = new Set(visible.map((n) => n.path));
    edges = data.edges.filter((e) => ok.has(e.source) && ok.has(e.target));
    const deg = new Map();
    for (const e of edges) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }
    const w = W(), h = H(), R = Math.min(w, h) * 0.38;
    const nbIndex = new Map(state.notebooks.map((n, i) => [n.folder, i]));
    nodes = visible.map((n) => {
      const old = !reshuffle && prev.get(n.path);
      const ang = ((nbIndex.get(n.notebook) ?? state.notebooks.length) / (state.notebooks.length + 1)) * Math.PI * 2;
      return { ...n, deg: deg.get(n.path) || 0, x: old ? old.x : w / 2 + Math.cos(ang) * R * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 40, y: old ? old.y : h / 2 + Math.sin(ang) * R * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 40, vx: 0, vy: 0, r: 4 + Math.min(10, Math.sqrt(deg.get(n.path) || 0) * 2.2) };
    });
    byPath = new Map(nodes.map((n) => [n.path, n]));
    neighbors = new Map();
    for (const e of edges) { (neighbors.get(e.source) || neighbors.set(e.source, new Set()).get(e.source)).add(e.target); (neighbors.get(e.target) || neighbors.set(e.target, new Set()).get(e.target)).add(e.source); }
    // (re)create elements
    edgeLayer.innerHTML = ''; nodeLayer.innerHTML = '';
    for (const e of edges) { e.el = svg('line'); edgeLayer.append(e.el); }
    for (const n of nodes) {
      n.el = svg('g', { class: 'gn' + (n.path === focusPath ? ' focus' : '') });
      n.circle = svg('circle', { r: n.r, fill: notebookColor(n.notebook) });
      n.label = svg('text', { y: n.r + 11, 'text-anchor': 'middle' }, n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title);
      n.el.append(svg('circle', { r: n.r + 9, class: 'hitarea' }), n.circle, n.label); // hit target larger than the mark
      attachNode(n);
      nodeLayer.append(n.el);
    }
    alpha = 1;
    for (let i = 0; i < 400 && alpha > 0.02; i++) step(); // settle synchronously: the page opens on a finished picture
    alpha = 0; render(); if (focusPath && byPath.has(focusPath)) { focused = true; centerOn(focusPath); } else fitView();
    paint();
  }

  function step() {
    const w = W(), h = H();
    const k = Math.min(170, Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.8); // ideal edge length (Fruchterman–Reingold)
    for (const n of nodes) { n.vx = 0; n.vy = 0; }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1; }
        if ((!a.deg || !b.deg) && d > k) continue; // orphans only avoid collisions; global repulsion would push them out of the picture
        const f = Math.min(k * 2, (k * k) / d) / d; // repulsion k²/d, capped for near-coincident nodes
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const e of edges) {
      const a = byPath.get(e.source), b = byPath.get(e.target);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d * d) / k / d; // attraction d²/k
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    const t = 24 * alpha + 0.3; // temperature: max step per tick
    for (const n of nodes) {
      if (n.fixed) continue;
      const g = n.deg ? 0.08 : 0.6; // gentle gravity so components stay together; orphans (no springs) are held much closer
      n.vx += (w / 2 - n.x) * g; n.vy += (h / 2 - n.y) * g;
      const len = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1;
      const step = Math.min(len, t) / len;
      n.x = Math.max(-w, Math.min(2 * w, n.x + n.vx * step)); n.y = Math.max(-h, Math.min(2 * h, n.y + n.vy * step));
    }
    alpha *= 0.98;
  }
  function tick() {
    step();
    render();
    if (alpha > 0.02) raf = requestAnimationFrame(tick); else { raf = null; alpha = 0; if (focusPath && !focused) { focused = true; centerOn(focusPath); } else if (!userView) fitView(); }
  }
  let userView = false; // once the user pans / zooms we stop auto-fitting
  function fitView() {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 50, maxX = Math.max(...xs) + 50, minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + 50;
    const k = Math.min(1.4, Math.max(0.3, Math.min(W() / (maxX - minX), H() / (maxY - minY))));
    view = { k, x: W() / 2 - ((minX + maxX) / 2) * k, y: H() / 2 - ((minY + maxY) / 2) * k };
    applyView(); paint();
  }
  let focused = false;
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  function render() {
    for (const e of edges) { const a = byPath.get(e.source), b = byPath.get(e.target); e.el.setAttribute('x1', a.x); e.el.setAttribute('y1', a.y); e.el.setAttribute('x2', b.x); e.el.setAttribute('y2', b.y); }
    for (const n of nodes) n.el.setAttribute('transform', `translate(${n.x} ${n.y})`);
  }
  function centerOn(path) {
    const n = byPath.get(path); if (!n) return;
    view.k = Math.max(view.k, 1.2); view.x = W() / 2 - n.x * view.k; view.y = H() / 2 - n.y * view.k; applyView(); paint();
  }
  /** classes: dim / hit / labels, depending on hover, search, zoom */
  function paint() {
    const many = nodes.length > 90;
    const hl = hover ? new Set([hover.path, ...(neighbors.get(hover.path) || [])]) : null;
    for (const n of nodes) {
      const match = query && n.title.toLowerCase().includes(query);
      const dimmed = (hl && !hl.has(n.path)) || (query && !match);
      n.el.classList.toggle('dim', !!dimmed);
      n.el.classList.toggle('hit', !!match);
      n.label.classList.toggle('hidden', dimmed || (many && n.deg < 2 && !(hl && hl.has(n.path)) && view.k < 1.6 && n.path !== focusPath));
    }
    for (const e of edges) e.el.classList.toggle('dim', !!(hl && !(e.source === hover.path || e.target === hover.path)) || !!(query && !(byPath.get(e.source).el.classList.contains('hit') || byPath.get(e.target).el.classList.contains('hit'))));
  }

  // ---- interaction ----
  function attachNode(n) {
    let start = null, moved = false;
    n.el.addEventListener('pointerdown', (e) => { e.stopPropagation(); start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y }; moved = false; n.fixed = true; n.el.setPointerCapture(e.pointerId); });
    n.el.addEventListener('pointermove', (e) => { if (!start) return; const dx = (e.clientX - start.x) / view.k, dy = (e.clientY - start.y) / view.k; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true; n.x = start.nx + dx; n.y = start.ny + dy; alpha = Math.max(alpha, 0.3); kick(); });
    n.el.addEventListener('pointerup', (e) => { if (!start) return; start = null; n.fixed = false; if (!moved) openPeek(n.path); });
    n.el.addEventListener('pointerenter', (e) => {
      hover = n; paint();
      tipEl.innerHTML = ''; tipEl.append(el('div', { class: 'tv', style: 'font-size:13px' }, n.title), el('div', { class: 'td' }, `${nbOf(n.notebook)?.title || n.folder || '/'} · ${n.deg} 条链接${n.date ? ' · ' + n.date : ''}${n.source ? ' · ' + n.source : ''}`));
      tipEl.classList.remove('hidden'); moveTip(e);
    });
    n.el.addEventListener('pointermove', moveTip);
    n.el.addEventListener('pointerleave', () => { hover = null; paint(); tipEl.classList.add('hidden'); });
  }
  function moveTip(e) { const r = wrap.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; tipEl.style.left = (x > r.width - 240 ? x - tipEl.offsetWidth - 14 : x + 14) + 'px'; tipEl.style.top = Math.max(4, y - 10) + 'px'; }
  let pan = null;
  svgRoot.addEventListener('pointerdown', (e) => { pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; svgRoot.setPointerCapture(e.pointerId); });
  svgRoot.addEventListener('pointermove', (e) => { if (!pan) return; userView = true; view.x = pan.vx + (e.clientX - pan.x); view.y = pan.vy + (e.clientY - pan.y); applyView(); });
  svgRoot.addEventListener('pointerup', () => { pan = null; });
  svgRoot.addEventListener('wheel', (e) => {
    e.preventDefault(); userView = true;
    const r = wrap.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(4, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k; applyView(); paint();
  }, { passive: false });
  if (window.ResizeObserver) new ResizeObserver(() => { if (nodes.length && !raf && !userView) fitView(); }).observe(wrap); // resizing only re-fits, never re-runs the layout
  rebuild(); // the page is already in the DOM, so sizes are known; no rAF (background tabs may never fire it)
}

// ---------------------------------------------------------------- activity
async function viewActivity(main) {
  const rows = await get('/api/audit?limit=300');
  const page = el('div', { class: 'page wide' });
  page.append(el('h1', { class: 'page-title' }, '活动日志'), el('p', { class: 'page-desc' }, '每个 agent 通过 MCP 或网页做的写操作，以及被拒绝的请求。'));
  const list = el('div', { class: 'audit' });
  list.append(el('div', { class: 'row', style: 'color:var(--text-3);font-size:12px' }, el('div', {}, '时间'), el('div', {}, 'Agent'), el('div', {}, '操作'), el('div', {}, '对象')));
  for (const r of rows) {
    list.append(el('div', { class: 'row' }, el('div', { class: 'ts' }, fmtTime(r.ts)), el('div', {}, el('span', { class: 'chip source' }, r.source && r.source !== r.agent ? `${r.source} · ${r.agent}` : r.agent)),
      el('div', { class: 'act' + (r.action.includes('denied') ? ' denied' : '') }, r.action + (r.via ? ` · ${r.via}` : '') + (r.mode ? ` · ${r.mode}` : '')),
      el('div', { class: 'tgt' }, r.target ? el('a', { href: r.target.endsWith('.md') ? `#/note/${encodeURIComponent(r.target)}` : '#', onclick: (e) => { if (r.target.endsWith('.md')) { e.preventDefault(); openPeek(r.target); } } }, r.target) : '', r.error && el('div', { class: 'err', style: 'font-size:12px' }, r.error))));
  }
  if (!rows.length) list.append(el('div', { class: 'empty' }, '还没有活动'));
  page.append(list);
  main.append(topbar([{ label: '活动日志' }]), page);
}

// ---------------------------------------------------------------- boot
$('#new-page').onclick = () => newNoteDialog({});
$('#new-notebook').onclick = () => notebookDialog();
$('#search').addEventListener('focus', (e) => { e.target.blur(); searchDialog(); });
$('#collapse').onclick = () => $('#sidebar').classList.add('collapsed');
$('#expand').onclick = () => $('#sidebar').classList.remove('collapsed');
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchDialog(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape' && !typing) { if (!$('#peek').classList.contains('hidden')) closePeek(); document.body.classList.remove('drawer-open'); }
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); searchDialog(); }
});
window.addEventListener('hashchange', () => { closePeek(); document.body.classList.remove('drawer-open'); route(); });
document.addEventListener('click', (e) => { if (document.body.classList.contains('drawer-open') && !e.target.closest('#sidebar') && !e.target.closest('.menu-btn')) document.body.classList.remove('drawer-open'); });
loadSidebar().then(route).catch(() => {}); // a 401 here already opened the login screen
setInterval(async () => { // light auto-refresh so agent writes show up while you read
  if (document.hidden || !$('#peek').classList.contains('hidden') || !$('#modal').classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  if (['nb', 'home'].includes(state.route?.kind)) { await loadSidebar(); route(); }
}, 20000);
