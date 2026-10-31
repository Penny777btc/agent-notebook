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
const today = () => new Date().toISOString().slice(0, 10);
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '';
const SYSTEM_PROPS = ['title', 'status', 'tags', 'source', 'date', 'created', 'updated'];

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const get = (u) => api('GET', u);
const notePath = (p) => '/api/notes/' + p.split('/').map(encodeURIComponent).join('/');

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden'); t.style.background = isErr ? 'var(--danger)' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

function renderMd(md) {
  const html = marked.parse(md || '', { gfm: true, breaks: true });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,style').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => { for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (a.name === 'href' && /^javascript:/i.test(a.value))) n.removeAttribute(a.name); });
  doc.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  return doc.body.innerHTML;
}

// ---------------------------------------------------------------- state
const state = { boards: [], tree: [], route: null, openFolders: new Set(JSON.parse(localStorage.getItem('openFolders') || '[]')) };

async function loadSidebar() {
  [state.boards, state.tree] = await Promise.all([get('/api/boards'), get('/api/tree')]);
  renderSidebar();
}

function renderSidebar() {
  const bl = $('#board-list'); bl.innerHTML = '';
  for (const b of state.boards) {
    bl.append(el('a', { class: 'side-item', href: `#/board/${encodeURIComponent(b.folder)}`, 'data-route': `board:${b.folder}` }, el('span', { class: 'emoji' }, b.icon), b.title));
  }
  if (!state.boards.length) bl.append(el('div', { class: 'empty' }, '还没有看板'));
  const tree = $('#tree'); tree.innerHTML = '';
  tree.append(renderTree(state.tree));
  markActive();
}

function renderTree(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.type === 'folder') {
      const wrap = el('div', { class: 'tree-folder' + (state.openFolders.has(it.path) ? ' open' : '') });
      const row = el('a', { class: 'side-item', href: it.isBoard ? `#/board/${encodeURIComponent(it.path)}` : `#/folder/${encodeURIComponent(it.path)}`, 'data-route': (it.isBoard ? 'board:' : 'folder:') + it.path },
        el('span', { class: 'caret', onclick: (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.toggle('open'); wrap.classList.contains('open') ? state.openFolders.add(it.path) : state.openFolders.delete(it.path); localStorage.setItem('openFolders', JSON.stringify([...state.openFolders])); } }, '▶'),
        el('span', { class: 'emoji' }, it.isBoard ? '📋' : '📁'), it.name,
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

function markActive() {
  document.querySelectorAll('.side-item').forEach((a) => a.classList.toggle('active', a.dataset.route === state.routeKey));
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [kind, ...restParts] = h.split('/');
  const rest = restParts.join('/');
  return { kind: kind || 'home', arg: rest };
}

async function route() {
  const r = parseHash();
  state.route = r;
  state.routeKey = r.kind === 'home' ? '' : `${r.kind}:${r.arg}`;
  if (r.kind === 'settings' || r.kind === 'activity' || r.kind === 'agents') state.routeKey = r.kind;
  markActive();
  const main = $('#main'); main.innerHTML = '';
  try {
    if (r.kind === 'board') await viewBoard(main, r.arg);
    else if (r.kind === 'note') await viewNote(main, r.arg);
    else if (r.kind === 'folder') await viewFolder(main, r.arg);
    else if (r.kind === 'settings') await viewSettings(main);
    else if (r.kind === 'activity') await viewActivity(main);
    else if (r.kind === 'agents') await viewAgents(main);
    else await viewHome(main);
  } catch (err) {
    main.append(el('div', { class: 'page' }, el('h1', { class: 'page-title' }, '出错了'), el('p', { class: 'err' }, err.message)));
  }
}

function topbar(crumbs, ...actions) {
  const bar = el('div', { class: 'topbar' });
  const c = el('div', { class: 'crumb' });
  crumbs.forEach((x, i) => { if (i) c.append(el('span', { class: 'muted' }, '/')); c.append(x.href ? el('a', { href: x.href }, x.label) : el('span', {}, x.label)); });
  bar.append(c, el('div', { class: 'spacer' }), ...actions);
  return bar;
}

// ---------------------------------------------------------------- home
async function viewHome(main) {
  const status = await get('/api/status');
  const recent = await get('/api/notes?limit=12');
  const page = el('div', { class: 'page' });
  page.append(el('div', { class: 'page-icon' }, '📓'), el('h1', { class: 'page-title' }, 'Agent Notebook'),
    el('p', { class: 'page-desc' }, `本地笔记库：${status.vault}`));
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:16px 0 28px' });
  for (const b of state.boards) {
    grid.append(el('a', { class: 'card-box', href: `#/board/${encodeURIComponent(b.folder)}`, style: 'margin:0' },
      el('div', { style: 'font-size:28px' }, b.icon), el('div', { style: 'font-weight:600;margin:6px 0 2px' }, b.title),
      el('div', { class: 'muted', style: 'font-size:13px' }, b.description || b.columns.join(' · '))));
  }
  grid.append(el('a', { class: 'card-box', href: '#', style: 'margin:0;color:var(--text-3)', onclick: (e) => { e.preventDefault(); newBoardDialog(); } }, el('div', { style: 'font-size:28px' }, '＋'), el('div', { style: 'font-weight:600;margin:6px 0 2px' }, '新建看板')));
  try {
    const ag = await get('/api/agents');
    const todo = ag.agents.filter((a) => a.detected && !a.connected);
    const done = ag.agents.filter((a) => a.connected);
    page.append(el('a', { class: 'card-box banner', href: '#/agents' },
      el('span', { style: 'font-size:22px' }, '🔌'),
      el('div', {}, el('div', { style: 'font-weight:600' }, todo.length ? `检测到 ${todo.length} 个本地 agent 可以接入` : (done.length ? `已接入 ${done.length} 个 agent` : '接入你的 AI agent')),
        el('div', { class: 'muted', style: 'font-size:13px' }, todo.length ? todo.map((a) => a.name).join(' · ') + '  —  点一下即可一键接入' : '查看接入状态或添加其他 agent')),
      el('span', { class: 'muted', style: 'margin-left:auto' }, '→')));
  } catch {}
  page.append(el('h2', { style: 'font-size:16px;margin:0 0 8px' }, '看板'), grid);
  page.append(el('h2', { style: 'font-size:16px;margin:0 0 8px' }, '最近更新'), noteTable(recent));
  const bk = status.backup;
  page.append(el('p', { class: 'muted', style: 'font-size:13px;margin-top:24px' },
    bk.isRepo ? `备份：${bk.enabled ? `每 ${bk.intervalMinutes} 分钟自动` : '手动'} · ${bk.remote || '仅本地 git'} · ${bk.dirty ? `${bk.dirty} 个文件待提交` : '已全部提交'}` : '备份：未开启，内容仅保存在本地。到 设置 中配置 GitHub 备份。'));
  main.append(topbar([{ label: '首页' }]), page);
}

function noteTable(notes, { showFolder = true } = {}) {
  if (!notes.length) return el('div', { class: 'empty' }, '暂无内容');
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, '标题'), showFolder && el('th', {}, '位置'), el('th', {}, '状态'), el('th', {}, '标签'), el('th', {}, '来源'), el('th', {}, '更新'))));
  const tb = el('tbody');
  for (const n of notes) {
    tb.append(el('tr', { onclick: () => openPeek(n.path) },
      el('td', {}, el('div', { style: 'font-weight:500' }, n.title), el('div', { class: 'muted', style: 'font-size:12px' }, n.excerpt.slice(0, 90))),
      showFolder && el('td', { class: 'muted' }, n.folder || '/'),
      el('td', {}, n.status && el('span', { class: 'chip status' }, n.status)),
      el('td', {}, n.tags.map((x) => el('span', { class: 'chip' }, x))),
      el('td', {}, n.source && el('span', { class: 'chip source' }, n.source)),
      el('td', { class: 'muted', style: 'white-space:nowrap;font-size:12px' }, fmtTime(n.updated))));
  }
  t.append(tb);
  return el('div', { class: 'list' }, t);
}

// ---------------------------------------------------------------- folder (list view)
async function viewFolder(main, folder) {
  const notes = await get(`/api/notes?folder=${encodeURIComponent(folder)}&recursive=false`);
  const page = el('div', { class: 'page wide' });
  page.append(el('h1', { class: 'page-title' }, '📁 ' + folder.split('/').pop()));
  page.append(el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, `${notes.length} 个页面`), el('div', { class: 'spacer' }),
    el('button', { class: 'btn small', onclick: () => newNoteDialog({ folder }) }, '＋ 新建页面')));
  page.append(noteTable(notes, { showFolder: false }));
  main.append(topbar([{ label: '首页', href: '#/' }, { label: folder }]), page);
}

// ---------------------------------------------------------------- board
async function viewBoard(main, folder) {
  const view = localStorage.getItem('view:' + folder) || 'kanban';
  const dateFilter = state.boardDate?.[folder] ?? '';
  const board = await get(`/api/boards/${folder.split('/').map(encodeURIComponent).join('/')}${dateFilter ? `?date=${dateFilter}` : ''}`);
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-icon', style: 'font-size:48px' }, board.icon), el('h1', { class: 'page-title' }, board.title));
  if (board.description) page.append(el('p', { class: 'page-desc' }, board.description));

  const setDate = (d) => { state.boardDate = { ...(state.boardDate || {}), [folder]: d }; route(); };
  const dateInput = el('input', { type: 'date', value: dateFilter, onchange: (e) => setDate(e.target.value) });
  const tb = el('div', { class: 'toolbar' },
    el('button', { class: 'btn small' + (view === 'kanban' ? ' active' : ''), onclick: () => { localStorage.setItem('view:' + folder, 'kanban'); route(); } }, '▦ 看板'),
    el('button', { class: 'btn small' + (view === 'list' ? ' active' : ''), onclick: () => { localStorage.setItem('view:' + folder, 'list'); route(); } }, '☰ 列表'),
    el('span', { style: 'width:12px' }),
    el('button', { class: 'btn small' + (dateFilter === today() ? ' active' : ''), onclick: () => setDate(dateFilter === today() ? '' : today()) }, '今天'),
    dateInput,
    dateFilter && el('button', { class: 'btn small', onclick: () => setDate('') }, '✕ 清除'),
    el('span', { class: 'muted', style: 'margin-left:8px;font-size:13px' }, `${board.total} 张卡片`),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn small primary', onclick: () => newNoteDialog({ folder, columns: board.columns.map((c) => c.name) }) }, '＋ 新建卡片'));
  page.append(tb);

  if (view === 'list') {
    page.append(noteTable(board.columns.flatMap((c) => c.cards), { showFolder: false }));
  } else {
    const kb = el('div', { class: 'board' });
    for (const col of board.columns) {
      const colEl = el('div', { class: 'col', 'data-col': col.name });
      colEl.append(el('div', { class: 'col-head' }, el('span', { class: 'chip status' }, col.name), el('span', { class: 'count' }, col.cards.length),
        el('button', { class: 'mini-btn add', title: '在此列新建', onclick: () => newNoteDialog({ folder, columns: board.columns.map((c) => c.name), status: col.name }) }, '＋')));
      for (const card of col.cards) colEl.append(cardEl(card));
      if (!col.cards.length) colEl.append(el('div', { class: 'empty' }, '拖动卡片到这里'));
      colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
      colEl.addEventListener('drop', async (e) => {
        e.preventDefault(); colEl.classList.remove('drag-over');
        const p = e.dataTransfer.getData('text/plain');
        if (!p) return;
        try { await api('PATCH', notePath(p), { status: col.name }); toast(`已移动到「${col.name}」`); route(); } catch (err) { toast(err.message, true); }
      });
      kb.append(colEl);
    }
    page.append(kb);
  }
  main.append(topbar([{ label: '首页', href: '#/' }, { label: board.title }]), page);
}

function cardEl(card) {
  const c = el('div', { class: 'card', draggable: 'true', onclick: () => openPeek(card.path) },
    el('div', { class: 't' }, card.title),
    card.excerpt && el('div', { class: 'ex' }, card.excerpt),
    el('div', { class: 'meta' }, card.tags.slice(0, 4).map((t) => el('span', { class: 'chip' }, t)), card.source && el('span', { class: 'chip source' }, card.source), el('span', { class: 'date' }, card.date)));
  c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', card.path); c.classList.add('dragging'); });
  c.addEventListener('dragend', () => c.classList.remove('dragging'));
  return c;
}

// ---------------------------------------------------------------- note editor (full page & peek)
async function viewNote(main, path) {
  const note = await get(notePath(path));
  const crumbs = [{ label: '首页', href: '#/' }];
  if (note.folder) {
    const b = state.boards.find((x) => x.folder === note.folder);
    crumbs.push({ label: b ? b.title : note.folder, href: b ? `#/board/${encodeURIComponent(b.folder)}` : `#/folder/${encodeURIComponent(note.folder)}` });
  }
  crumbs.push({ label: note.title });
  main.append(topbar(crumbs, el('button', { class: 'btn small danger', onclick: () => deleteNote(note.path) }, '删除')));
  main.append(await noteEditor(note));
}

async function noteEditor(note, { onSaved } = {}) {
  const page = el('div', { class: 'page' });
  const board = state.boards.find((b) => b.folder === note.folder);
  let saving = false;
  let updatedEl = null;
  const save = async (patch) => {
    if (saving) return;
    saving = true;
    try {
      const updated = await api('PATCH', notePath(note.path), patch);
      Object.assign(note, updated);
      if (updatedEl) updatedEl.textContent = `${fmtTime(note.properties.updated)}  ·  创建 ${fmtTime(note.properties.created)}  ·  ${note.path}`;
      toast('已保存');
      onSaved?.(note);
    } catch (err) { toast(err.message, true); }
    finally { saving = false; }
  };

  const title = el('h1', { class: 'page-title', contenteditable: 'true', spellcheck: 'false' }, note.title);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { const t = title.textContent.trim(); if (t && t !== note.title) save({ title: t }); });
  page.append(title);

  // properties
  const props = el('div', { class: 'props' });
  const p = note.properties;
  const row = (label, icon, valueNode) => props.append(el('div', { class: 'k' }, el('span', {}, icon), label), el('div', { class: 'v' }, valueNode));
  if (board) {
    const sel = el('select', { onchange: (e) => save({ status: e.target.value }) }, board.columns.map((c) => el('option', { value: c, selected: c === p.status }, c)));
    row('状态', '◎', sel);
  } else if (p.status) row('状态', '◎', el('span', { class: 'chip status' }, p.status));
  const tagsInput = el('input', { value: (p.tags || []).join(', '), placeholder: '逗号分隔', onblur: (e) => { const v = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); if (JSON.stringify(v) !== JSON.stringify(p.tags || [])) save({ tags: v }); } });
  row('标签', '#', tagsInput);
  row('来源', '🤖', p.source ? el('span', { class: 'chip source' }, p.source) : el('span', { class: 'muted' }, '—'));
  row('日期', '📅', el('input', { type: 'date', value: p.date || '', onchange: (e) => save({ date: e.target.value }) }));
  for (const [k, v] of Object.entries(p)) {
    if (SYSTEM_PROPS.includes(k)) continue;
    const inp = el('input', { value: typeof v === 'object' ? JSON.stringify(v) : String(v), onblur: (e) => { if (e.target.value !== String(v)) save({ [k]: e.target.value }); } });
    const del = el('button', { class: 'mini-btn', title: '删除属性', onclick: () => save({ [k]: null }).then(() => { inp.closest('.v').remove(); del._k.remove(); }) }, '✕');
    const kEl = el('div', { class: 'k' }, el('span', {}, '≡'), k); del._k = kEl;
    props.append(kEl, el('div', { class: 'v' }, inp, del));
  }
  props.append(el('div', { class: 'add-prop', onclick: async () => { const k = prompt('属性名'); if (!k) return; const v = prompt(`「${k}」的值`) ?? ''; await save({ [k]: v }); page.replaceWith(await noteEditor(note, { onSaved })); } }, '＋ 添加属性'));
  updatedEl = el('div', { class: 'v muted', style: 'font-size:13px' }, `${fmtTime(p.updated)}  ·  创建 ${fmtTime(p.created)}  ·  ${note.path}`);
  props.append(el('div', { class: 'k' }, el('span', {}, '🕒'), '更新'), updatedEl);
  page.append(props, el('hr', { class: 'divider' }));

  // body
  const bodyWrap = el('div');
  const showView = () => {
    bodyWrap.innerHTML = '';
    const v = el('div', { class: 'body-view md', html: renderMd(note.body) });
    v.addEventListener('click', (e) => { if (e.target.closest('a,input')) return; showEdit(); });
    bodyWrap.append(v);
  };
  const showEdit = () => {
    bodyWrap.innerHTML = '';
    const ta = el('textarea', { class: 'body-edit', spellcheck: 'false' }, note.body);
    const bar = el('div', { class: 'editbar' }, el('span', {}, 'Markdown · ⌘/Ctrl+S 保存 · Esc 取消'),
      el('button', { class: 'btn small', onclick: showView }, '取消'),
      el('button', { class: 'btn small primary', onclick: () => commit() }, '保存'));
    const commit = async () => { if (ta.value !== note.body) await save({ body: ta.value }); showView(); };
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') showView();
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); }
    });
    bodyWrap.append(bar, ta);
    ta.focus(); ta.style.height = Math.max(300, ta.scrollHeight + 40) + 'px';
  };
  showView();
  page.append(bodyWrap);
  return page;
}

async function openPeek(path) {
  const peek = $('#peek');
  peek.innerHTML = '';
  peek.classList.remove('hidden');
  try {
    const note = await get(notePath(path));
    peek.append(el('div', { class: 'peek-bar' },
      el('button', { class: 'btn small', onclick: () => { location.hash = `#/note/${encodeURIComponent(path)}`; closePeek(); } }, '⤢ 全页打开'),
      el('div', { class: 'spacer' }),
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
  const box = el('div', { class: 'box' }, el('h3', {}, title), el('div', { class: 'content' }, content),
    onOk && el('div', { class: 'footer' }, el('button', { class: 'btn', onclick: close }, '取消'), el('button', { class: 'btn primary', onclick: async () => { try { if ((await onOk()) !== false) close(); } catch (err) { toast(err.message, true); } } }, okLabel)));
  m.append(box);
  m.onclick = (e) => { if (e.target === m) close(); };
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  return close;
}

function newNoteDialog({ folder = '', columns, status } = {}) {
  const title = el('input', { type: 'text', placeholder: '标题', autofocus: true });
  const folderIn = el('input', { type: 'text', value: folder, placeholder: '文件夹（留空 = 根目录）' });
  const statusSel = columns ? el('select', {}, columns.map((c) => el('option', { value: c, selected: c === status }, c))) : null;
  const tags = el('input', { type: 'text', placeholder: '标签，逗号分隔' });
  const body = el('textarea', { class: 'body-edit', style: 'min-height:140px;border:1px solid var(--border);border-radius:6px;padding:8px', placeholder: 'Markdown 正文（可选）' });
  const form = el('div', { class: 'form' }, el('label', {}, '标题'), title, el('label', {}, '文件夹'), folderIn, statusSel && el('label', {}, '列'), statusSel, el('label', {}, '标签'), tags, el('label', {}, '正文'), body);
  modal(columns ? '新建卡片' : '新建页面', form, {
    okLabel: '创建',
    onOk: async () => {
      if (!title.value.trim()) { title.focus(); return false; }
      const n = await api('POST', '/api/notes', { folder: folderIn.value.trim(), title: title.value.trim(), body: body.value, status: statusSel?.value, tags: tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
      toast('已创建'); await loadSidebar();
      if (columns) { route(); openPeek(n.path); } else location.hash = `#/note/${encodeURIComponent(n.path)}`;
    }
  });
  setTimeout(() => title.focus(), 30);
}

function newBoardDialog() {
  const folder = el('input', { type: 'text', placeholder: '例如：Alpha看板（即文件夹名）' });
  const icon = el('input', { type: 'text', value: '📋', style: 'width:60px' });
  const cols = el('input', { type: 'text', value: '待处理, 进行中, 已完成' });
  const desc = el('input', { type: 'text', placeholder: '一句话说明（可选）' });
  modal('新建看板', el('div', { class: 'form' }, el('label', {}, '名称'), folder, el('label', {}, '图标'), icon, el('label', {}, '列'), cols, el('label', {}, '说明'), desc), {
    okLabel: '创建',
    onOk: async () => {
      if (!folder.value.trim()) return false;
      const b = await api('POST', '/api/boards', { folder: folder.value.trim(), title: folder.value.trim(), icon: icon.value, columns: cols.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean), description: desc.value });
      await loadSidebar(); location.hash = `#/board/${encodeURIComponent(b.folder)}`;
    }
  });
  setTimeout(() => folder.focus(), 30);
}

function searchDialog() {
  const input = el('input', { type: 'text', placeholder: '搜索标题、属性和正文…', style: 'width:100%;border:none;outline:none;font-size:16px;padding:4px 0' });
  const results = el('div', { style: 'margin-top:8px;max-height:50vh;overflow:auto' });
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    const q = input.value.trim(); results.innerHTML = '';
    if (!q) return;
    const hits = await get(`/api/search?q=${encodeURIComponent(q)}`);
    if (!hits.length) results.append(el('div', { class: 'empty' }, '没有结果'));
    for (const h of hits) results.append(el('div', { class: 'search-hit', onclick: () => { close(); openPeek(h.path); } }, el('div', { class: 't' }, h.title), el('div', { class: 's' }, h.snippet), el('div', { class: 'p' }, h.path)));
  }, 180); });
  const close = modal('搜索', el('div', {}, input, results));
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------- settings
async function viewSettings(main) {
  const [status, tokens] = await Promise.all([get('/api/status'), get('/api/tokens')]);
  const page = el('div', { class: 'page settings' });
  page.append(el('h1', { class: 'page-title' }, '设置'), el('p', {}, `笔记库位置：${status.vault}`));

  // tokens
  page.append(el('h2', {}, 'Agent 访问令牌'), el('p', {}, '每个 agent 一个 token。read 只能读取，write 可以创建 / 修改 / 移动卡片，admin 可以管理令牌和备份。可限制只能访问某些文件夹。'));
  const tokBox = el('div', { class: 'card-box' });
  if (tokens.length) {
    const t = el('table', { style: 'width:100%;font-size:14px;border-collapse:collapse' });
    t.append(el('thead', {}, el('tr', {}, ...['名称', '前缀', '权限', '文件夹', '最近使用', ''].map((h) => el('th', { style: 'text-align:left;color:var(--text-3);font-weight:500;font-size:12px;padding:4px 6px;border-bottom:1px solid var(--border-2)' }, h)))));
    for (const tk of tokens) {
      t.append(el('tr', {}, el('td', { style: 'padding:6px;font-weight:500' }, tk.name), el('td', { style: 'padding:6px;font-family:var(--mono);font-size:12px' }, tk.prefix + '…'),
        el('td', { style: 'padding:6px' }, tk.scopes.map((s) => el('span', { class: 'chip status' }, s))), el('td', { style: 'padding:6px' }, tk.folders.map((f) => el('span', { class: 'chip' }, f === '*' ? '全部' : f))),
        el('td', { style: 'padding:6px;font-size:12px;color:var(--text-3)' }, tk.lastUsed ? fmtTime(tk.lastUsed) : '从未'),
        el('td', { style: 'padding:6px;text-align:right' }, el('button', { class: 'btn small danger', onclick: async () => { if (!confirm(`撤销「${tk.name}」？`)) return; await api('DELETE', `/api/tokens/${encodeURIComponent(tk.name)}`); route(); } }, '撤销'))));
    }
    tokBox.append(t);
  } else tokBox.append(el('div', { class: 'empty' }, '还没有令牌。创建一个让 agent 接入。'));
  page.append(tokBox);

  const name = el('input', { type: 'text', placeholder: '例如 claude-code、codex、alpha-bot' });
  const sRead = el('input', { type: 'checkbox', checked: true, disabled: true }), sWrite = el('input', { type: 'checkbox', checked: true }), sAdmin = el('input', { type: 'checkbox' });
  const folders = el('input', { type: 'text', placeholder: '留空 = 全部；或填 Alpha看板, 灵感' });
  const out = el('div');
  page.append(el('div', { class: 'card-box' }, el('div', { class: 'form' },
    el('label', {}, '名称'), name,
    el('label', {}, '权限'), el('div', { class: 'row' }, el('label', {}, sRead, ' read'), el('label', {}, sWrite, ' write'), el('label', {}, sAdmin, ' admin')),
    el('label', {}, '限制文件夹'), folders,
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', onclick: async () => {
      try {
        const scopes = ['read', sWrite.checked && 'write', sAdmin.checked && 'admin'].filter(Boolean);
        const r = await api('POST', '/api/tokens', { name: name.value.trim(), scopes, folders: folders.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
        out.innerHTML = '';
        const vault = status.vault;
        out.append(el('div', { class: 'token-box' },
          el('div', { style: 'font-weight:600;margin-bottom:6px' }, `「${r.name}」的令牌（只显示一次，请立即保存）`),
          el('div', { class: 'code' }, r.token),
          el('div', { style: 'font-weight:500;margin-top:12px' }, 'Claude Code（stdio）：'),
          el('div', { class: 'code' }, `claude mcp add agent-notebook -e AGENT_NOTEBOOK_TOKEN=${r.token} -e AGENT_NOTEBOOK_VAULT="${vault}" -- node "${vault.replace(/\/vault$/, '')}/src/cli.js" mcp`),
          el('div', { style: 'font-weight:500;margin-top:12px' }, '通用 MCP 配置（stdio，Codex / Cursor / Claude Desktop 等）：'),
          el('div', { class: 'code' }, JSON.stringify({ mcpServers: { 'agent-notebook': { command: 'node', args: [`${vault.replace(/\/vault$/, '')}/src/cli.js`, 'mcp'], env: { AGENT_NOTEBOOK_TOKEN: r.token, AGENT_NOTEBOOK_VAULT: vault } } } }, null, 2)),
          el('div', { style: 'font-weight:500;margin-top:12px' }, '远程 / HTTP 方式：'),
          el('div', { class: 'code' }, `URL: ${location.origin}/mcp\nAuthorization: Bearer ${r.token}`)));
        name.value = ''; folders.value = '';
        const list = await get('/api/tokens'); // refresh table without wiping the token box
        tokBox.replaceWith(await (async () => { const tmp = el('div'); await viewSettingsTokensOnly(tmp, list); return tmp.firstChild; })());
      } catch (err) { toast(err.message, true); }
    } }, '创建令牌'))), out));

  // backup
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

  page.append(el('h2', {}, '给 agent 的说明（Skill）'), el('p', {}, el('span', {}, '项目里的 '), el('code', {}, 'skills/agent-notebook/SKILL.md'), el('span', {}, ' 描述了工具用法和约定（哪个看板放什么、写卡片时要带 source），可以直接装到 Claude Code / Codex 的 skills 目录。')));
  main.append(topbar([{ label: '设置' }]), page);
}
async function viewSettingsTokensOnly(container, tokens) {
  const tmp = el('div', { class: 'card-box' });
  if (!tokens.length) { tmp.append(el('div', { class: 'empty' }, '还没有令牌。')); container.append(tmp); return; }
  const t = el('table', { style: 'width:100%;font-size:14px;border-collapse:collapse' });
  for (const tk of tokens) t.append(el('tr', {}, el('td', { style: 'padding:6px;font-weight:500' }, tk.name), el('td', { style: 'padding:6px;font-family:var(--mono);font-size:12px' }, tk.prefix + '…'), el('td', { style: 'padding:6px' }, tk.scopes.map((s) => el('span', { class: 'chip status' }, s))), el('td', { style: 'padding:6px' }, tk.folders.map((f) => el('span', { class: 'chip' }, f === '*' ? '全部' : f)))));
  tmp.append(t); container.append(tmp);
}

// ---------------------------------------------------------------- agents
function snippetBlocks(r) {
  return el('div', {},
    el('div', { style: 'font-weight:500;margin-top:12px' }, '方式 A · HTTP（适合桌面应用 / 远程 agent，服务需保持运行）：'),
    el('div', { class: 'code' }, `URL: ${r.httpUrl}\nAuthorization: Bearer ${r.token}`),
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
    for (const a of list) grid.append(agentCard(a, data));
    page.append(grid);
  };
  const detectedTodo = data.agents.filter((a) => a.detected && !a.connected && a.canWrite);
  const connectedList = data.agents.filter((a) => a.connected);
  const manual = data.agents.filter((a) => a.detected && !a.canWrite);
  const notFound = data.agents.filter((a) => !a.detected);
  section('可一键接入', detectedTodo, null);
  section('已接入', connectedList, '再次接入会生成新的 token 并覆盖该 agent 配置里的 agent-notebook 条目。');
  section('需要在应用内手动添加', manual, '这些应用的 MCP 设置在它们自己的界面里。点「生成配置」拿到地址和 token，粘贴进去即可。');

  page.append(el('h2', {}, '其他 agent（Hermes、Muse、自写的 bot…）'),
    el('p', {}, '任何支持 MCP 的 agent 都能接入。起个名字生成 token，然后把下面给出的配置粘到它的 MCP 设置里。'));
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
        const r = await api('POST', '/api/agents/snippets', { name: name.value.trim(), scopes: ['read', sWrite.checked && 'write'].filter(Boolean), folders: folders.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
        out.innerHTML = '';
        out.append(el('div', { class: 'token-box' }, el('div', { style: 'font-weight:600' }, `「${r.name}」的接入配置（token 只显示这一次）`), snippetBlocks(r)));
        name.value = '';
      } catch (err) { toast(err.message, true); }
    } }, '生成配置'))), out));

  if (notFound.length) {
    page.append(el('h2', {}, '未检测到'), el('p', { class: 'muted', style: 'font-size:13px' }, notFound.map((a) => `${a.icon} ${a.name}`).join('　')));
  }
  main.append(topbar([{ label: '接入 Agent' }]), page);
}

function agentCard(a, data) {
  const status = a.connected ? el('span', { class: 'chip source' }, '已接入') : a.canWrite ? el('span', { class: 'chip status' }, '可一键接入') : el('span', { class: 'chip' }, '手动');
  const body = el('div', { class: 'muted', style: 'font-size:12px;margin:6px 0 10px;word-break:break-all' }, a.configPath ? `配置：${a.configPath.replace(/^\/Users\/[^/]+/, '~')}` : (a.note || ''));
  const result = el('div');
  const card = el('div', { class: 'card-box', style: 'margin:0;display:flex;flex-direction:column' },
    el('div', { style: 'display:flex;align-items:center;gap:8px' }, el('span', { style: 'font-size:22px' }, a.icon), el('span', { style: 'font-weight:600;flex:1' }, a.name), status),
    body);
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
        result.append(el('div', { class: 'token-box', style: 'margin-top:10px;font-size:13px' },
          el('div', { style: 'font-weight:600' }, `✓ 已接入 ${r.agent}`),
          el('div', {}, `token「${r.tokenName}」（${r.scopes.join(', ')}）`),
          el('div', { style: 'word-break:break-all' }, `已写入 ${r.configPath}`),
          r.backupPath && el('div', { class: 'muted' }, `原文件备份：${r.backupPath}`),
          r.skillPath && el('div', { class: 'muted' }, `Skill 已装到 ${r.skillPath}`),
          r.restart && el('div', { style: 'margin-top:6px' }, `下一步：${r.restart}`)));
        btn.textContent = '重新接入'; btn.disabled = false; btn.classList.remove('primary');
        status.replaceWith(el('span', { class: 'chip source' }, '已接入'));
      } catch (err) { toast(err.message, true); btn.textContent = a.connected ? '重新接入' : '一键接入'; btn.disabled = false; }
    } }, a.connected ? '重新接入' : '一键接入'));
  } else {
    actions.append(el('div', { style: 'flex:1' }));
    actions.append(el('button', { class: 'btn small primary', onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const r = await api('POST', '/api/agents/snippets', { name: a.id, scopes: ['read', 'write'], folders: [] });
        result.innerHTML = '';
        result.append(el('div', { class: 'token-box', style: 'margin-top:10px;font-size:13px' }, el('div', { style: 'font-weight:600' }, `「${r.name}」的接入配置（token 只显示这一次）`), snippetBlocks(r)));
      } catch (err) { toast(err.message, true); }
      btn.disabled = false;
    } }, '生成配置'));
  }
  card.append(actions, result);
  return card;
}

// ---------------------------------------------------------------- activity
async function viewActivity(main) {
  const rows = await get('/api/audit?limit=300');
  const page = el('div', { class: 'page wide' });
  page.append(el('h1', { class: 'page-title' }, '活动日志'), el('p', { class: 'page-desc' }, '每个 agent 通过 MCP 或网页做的写操作，以及被拒绝的请求。'));
  const list = el('div', { class: 'audit' });
  list.append(el('div', { class: 'row', style: 'color:var(--text-3);font-size:12px' }, el('div', {}, '时间'), el('div', {}, 'Agent'), el('div', {}, '操作'), el('div', {}, '对象')));
  for (const r of rows) {
    list.append(el('div', { class: 'row' }, el('div', { class: 'ts' }, fmtTime(r.ts)), el('div', {}, el('span', { class: 'chip source' }, r.agent)),
      el('div', { class: 'act' + (r.action.includes('denied') ? ' denied' : '') }, r.action + (r.via ? ` · ${r.via}` : '')),
      el('div', { class: 'tgt' }, r.target ? el('a', { href: r.target.endsWith('.md') ? `#/note/${encodeURIComponent(r.target)}` : '#', onclick: (e) => { if (r.target.endsWith('.md')) { e.preventDefault(); openPeek(r.target); } } }, r.target) : '', r.error && el('div', { class: 'err', style: 'font-size:12px' }, r.error))));
  }
  if (!rows.length) list.append(el('div', { class: 'empty' }, '还没有活动'));
  page.append(list);
  main.append(topbar([{ label: '活动日志' }]), page);
}

// ---------------------------------------------------------------- boot
$('#new-page').onclick = () => newNoteDialog({});
$('#new-board').onclick = newBoardDialog;
$('#search').addEventListener('focus', (e) => { e.target.blur(); searchDialog(); });
$('#collapse').onclick = () => $('#sidebar').classList.add('collapsed');
$('#expand').onclick = () => $('#sidebar').classList.remove('collapsed');
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchDialog(); } });
window.addEventListener('hashchange', () => { closePeek(); route(); });
loadSidebar().then(route);
setInterval(async () => { // light auto-refresh so agent writes show up while you watch a board
  if (document.hidden || !$('#peek').classList.contains('hidden') || !$('#modal').classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  if (state.route?.kind === 'board' || state.route?.kind === 'home') { await loadSidebar(); route(); }
}, 20000);
