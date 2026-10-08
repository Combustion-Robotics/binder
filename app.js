const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

let S;                 // saved state from main: year, years, types, pins, meta, homework, notes
let view = 'home';     // home | inbox | homework | notes | search | subject:<name>
let viewYear;          // year shown in the sidebar (current or archive)
let subjects = [], curSubjects = [];
let tab = 'All', tagFilter = '';

// ---------- helpers ----------
const today = () => new Date().toLocaleDateString('sv');
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
const daysUntil = d => Math.round((new Date(d + 'T00:00') - new Date(today() + 'T00:00')) / 864e5);
const persist = key => api.invoke('save', key, S[key]);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const color = s => S.colors[s] || '#9aa0ae';
// dark or white text, whichever reads better on the subject colour
function ink(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#15171d' : '#ffffff';
}
const cvars = s => `--c:${color(s)};--ink:${ink(color(s))}`;
function hslHex(h, sat, l) {
  sat /= 100; l /= 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    return Math.round((l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}
const ordered = list => {
  const rank = s => (S.subjectOrder.indexOf(s) + 1 || 1e9);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};
const reorder = (list, from, to) => {
  const l = list.filter(x => x !== from);
  l.splice(list.indexOf(to), 0, from);
  return l;
};
const SORTS = { new: 'Newest first', old: 'Oldest first', az: 'Name A–Z', za: 'Name Z–A', custom: 'Custom order' };
function sortFiles(list, key) {
  const name = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const by = { new: (a, b) => b.mtime - a.mtime, old: (a, b) => a.mtime - b.mtime, az: name, za: (a, b) => name(b, a) };
  if (S.sort !== 'custom' || !key) return list.sort(by[S.sort] || by.new);
  const order = S.fileOrder[key] || [];
  const rank = p => { const i = order.indexOf(p); return i < 0 ? Infinity : i; };
  return list.sort((a, b) => rank(a.path) - rank(b.path) || b.mtime - a.mtime);
}
const sortSelect = custom => `<select id="sort" aria-label="Sort files">${Object.entries(SORTS)
  .filter(([k]) => custom || k !== 'custom')
  .map(([k, l]) => `<option value="${k}" ${k === S.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
function whenLabel(d) {
  const n = daysUntil(d);
  if (n < 0) return n === -1 ? 'Yesterday' : `${-n} days ago`;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  return new Date(d + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const fmtSize = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const kind = ext => ({ pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc', ppt: 'ppt', pptx: 'ppt', odp: 'ppt', xls: 'xls', xlsx: 'xls' })[ext] || 'other';
const stem = name => name.replace(/\.[^.]+$/, '');
const subjOptions = (sel, empty) =>
  (empty ? `<option value="">${esc(empty)}</option>` : '') +
  curSubjects.map(s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`).join('');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function ask(label, value = '', type = 'text') {
  const d = $('#ask'), i = $('#askInput');
  $('#askLabel').textContent = label;
  i.type = type;
  i.value = value;
  d.showModal();
  if (type === 'text') i.select();
  return dialogResult(d).then(v => (v === 'ok' ? i.value.trim() : null));
}
// Save (or Enter) -> 'ok', a [data-close] button -> its value, Escape -> 'cancel'
function dialogResult(d) {
  return new Promise(r => {
    const ac = new AbortController(), opt = { signal: ac.signal };
    const done = v => { ac.abort(); if (d.open) d.close(); r(v); };
    d.addEventListener('submit', e => { e.preventDefault(); done('ok'); }, opt);
    d.addEventListener('click', e => { const b = e.target.closest('[data-close]'); if (b) done(b.dataset.close); }, opt);
    d.addEventListener('cancel', e => { e.preventDefault(); done('cancel'); }, opt);
  });
}

// ---------- pieces ----------
function chips(f) {
  const m = S.meta[f.path] || {};
  const due = m.due ? `<span class="chip due ${daysUntil(m.due) < 0 ? 'late' : daysUntil(m.due) <= 2 ? 'soon' : ''}">Due ${esc(whenLabel(m.due))}</span>` : '';
  const tags = (m.tags || []).map(t => `<button class="chip" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  return due || tags ? `<div class="chips">${due}${tags}</div>` : '';
}
const extBadge = f => `<span class="ext ${kind(f.ext)}">${esc(f.ext.slice(0, 4))}</span>`;

const card = f => `
  <div class="card" data-open="${esc(f.path)}" draggable="true" data-drag="file:${esc(f.path)}" style="${cvars(f.subject)}" tabindex="0" title="${esc(f.name)}">
    ${extBadge(f)}
    <div class="info">
      <div class="name">${esc(stem(f.name))}</div>
      <div class="sub">
        ${f.subject ? `<span class="subj">${esc(f.subject)}</span>` : ''}
        ${f.folder ? `<span>${esc(f.folder)}</span>` : ''}
        <span>${fmtDate(f.mtime)}</span>
      </div>
      ${chips(f)}
    </div>
    ${S.pins.includes(f.path) ? '<span class="pin" aria-label="Pinned">★</span>' : ''}
    <button class="more" data-menu="${esc(f.path)}" aria-label="More actions">⋯</button>
  </div>`;
const files = list => `<div class="files">${list.map(card).join('')}</div>`;

const hwRow = h => `
  <div class="hw ${h.done ? 'done' : ''}" style="${cvars(h.subject)}">
    <input type="checkbox" data-hw="${h.id}" ${h.done ? 'checked' : ''} aria-label="Done">
    <span class="subj">${esc(h.subject || 'General')}</span>
    <span class="text">${esc(h.text)}</span>
    <span class="when ${!h.done && daysUntil(h.due) < 0 ? 'late' : ''}">${esc(whenLabel(h.due))}</span>
    <button class="x" data-act="hwDel" data-id="${h.id}" aria-label="Delete">×</button>
  </div>`;

const noteHtml = n => `
  <div class="note c${n.color}" data-note="${n.id}">
    <textarea placeholder="Write something…" aria-label="Note">${esc(n.text)}</textarea>
    <div class="note-bar">
      <select data-notesubj aria-label="Subject">${subjOptions(n.subject, 'No subject')}</select>
      <button data-act="noteColor" aria-label="Change color">◐</button>
      <button data-act="noteDel" aria-label="Delete note">×</button>
    </div>
  </div>`;

// ---------- views ----------
const views = {
  async home() {
    const dueFiles = Object.keys(S.meta).filter(p => S.meta[p].due && daysUntil(S.meta[p].due) <= 7);
    const [recent, pinned, due, inbox] = await Promise.all([
      api.invoke('recent'), api.invoke('stat', S.pins), api.invoke('stat', dueFiles), api.invoke('inbox'),
    ]);
    const hw = S.homework.filter(h => !h.done && daysUntil(h.due) <= 7).sort((a, b) => a.due.localeCompare(b.due));
    const notes = S.notes.filter(n => n.text.trim()).slice(0, 4);
    const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return `
      <h1 class="date">${esc(date)}</h1>
      <p class="lead">${hw.length ? `${hw.length} homework ${hw.length === 1 ? 'task' : 'tasks'} due this week.` : 'No homework due this week.'}</p>
      ${inbox.length ? `<button class="banner" data-go="inbox"><b>${inbox.length}</b> new ${inbox.length === 1 ? 'download' : 'downloads'} to sort <span>Sort now</span></button>` : ''}
      <div class="home-grid">
        <section>
          <h2>Due this week</h2>
          ${hw.length || due.length ? hw.map(hwRow).join('') + (due.length ? files(due) : '') : '<p class="empty">Nothing due. Add homework on the Homework page.</p>'}
        </section>
        <section>
          <h2>Pinned</h2>
          ${pinned.length ? files(pinned) : '<p class="empty">Pin a file from its ⋯ menu to keep it here.</p>'}
        </section>
      </div>
      <h2>Recently changed</h2>
      ${recent.length ? files(recent) : '<p class="empty">Files you add to this year’s folders show up here.</p>'}
      ${notes.length ? `<h2>Notes</h2><div class="board small">${notes.map(n => `<button class="note c${n.color}" data-go="notes"><span>${esc(n.text)}</span></button>`).join('')}</div>` : ''}`;
  },

  async inbox() {
    const items = await api.invoke('inbox');
    if (!items.length)
      return `<h1>Inbox</h1>
        <div class="empty big">
          <p>No new downloads. PDFs, Word and PowerPoint files you download show up here so you can sort them.</p>
          <button class="ghost" data-act="scanAll">Check older downloads</button>
        </div>`;
    return `<h1>Inbox</h1>
      <p class="lead">Check where each download goes, then move it. The app learns from your choices.</p>
      ${items.map(it => `
        <div class="inbox-item" data-src="${esc(it.path)}" style="${cvars(it.guess.subject)}">
          ${extBadge(it)}
          <div class="info">
            <button class="name link" data-open="${esc(it.path)}" title="Open">${esc(it.name)}</button>
            <div class="sub"><span>${fmtSize(it.size)}</span><span>${fmtDate(it.mtime)}</span></div>
          </div>
          <select class="pick-subj" aria-label="Subject">${subjOptions(it.guess.subject, 'Choose subject')}</select>
          <select class="pick-type" aria-label="Type">${S.types.map(t => `<option ${t === it.guess.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <button class="primary" data-act="move">Move</button>
          <button class="ghost" data-act="ignore">Ignore</button>
        </div>`).join('')}`;
  },

  homework() {
    const open = S.homework.filter(h => !h.done).sort((a, b) => a.due.localeCompare(b.due));
    const groups = [
      ['Overdue', h => daysUntil(h.due) < 0],
      ['Today', h => daysUntil(h.due) === 0],
      ['Tomorrow', h => daysUntil(h.due) === 1],
      ['This week', h => daysUntil(h.due) > 1 && daysUntil(h.due) <= 7],
      ['Later', h => daysUntil(h.due) > 7],
    ];
    const done = S.homework.filter(h => h.done).slice(-15).reverse();
    return `<h1>Homework</h1>
      <form id="hwForm" class="hw-add">
        <select name="subject" aria-label="Subject">${subjOptions(homeworkDraft.subject, 'General')}</select>
        <input name="text" placeholder="What’s the homework?" required autocomplete="off" aria-label="Homework">
        <input name="due" type="date" value="${homeworkDraft.due || addDays(1)}" required aria-label="Due date">
        <button class="primary">Add</button>
      </form>
      ${open.length ? '' : '<p class="empty big">No open homework. Add each task as you get it, and it’s sorted by due date here.</p>'}
      ${groups.map(([name, fn]) => {
        const list = open.filter(fn);
        return list.length ? `<h2 class="${name === 'Overdue' ? 'late' : ''}">${name} <span class="count">${list.length}</span></h2>${list.map(hwRow).join('')}` : '';
      }).join('')}
      ${done.length ? `<details class="done-list"><summary>Done (${S.homework.filter(h => h.done).length})</summary>${done.map(hwRow).join('')}</details>` : ''}`;
  },

  notes() {
    return `<div class="head-row"><h1>Notes</h1><button class="primary" data-act="newNote">New note</button></div>
      ${S.notes.length ? `<div class="board">${S.notes.map(noteHtml).join('')}</div>` : '<p class="empty big">Notes are for anything that doesn’t belong in a folder. Click New note to write one.</p>'}`;
  },

  async search() {
    const q = $('#q').value;
    const list = sortFiles(await api.invoke('search', q, $('#allYears').checked ? null : viewYear));
    return `<div class="head-row"><h1>${list.length} ${list.length === 1 ? 'result' : 'results'}</h1>${sortSelect(false)}</div>
      <p class="lead">for “${esc(q)}” in ${$('#allYears').checked ? 'all years' : esc(viewYear.replace('_', ' '))}</p>
      ${list.length ? files(list) : '<p class="empty">Nothing found. Try part of the file name, or #tag.</p>'}`;
  },

  async subject(name) {
    const [list, folders] = await Promise.all([api.invoke('files', viewYear, name), api.invoke('folders', viewYear, name)]);
    const order = f => (S.types.indexOf(f) + 1 || 99);
    folders.sort((a, b) => order(a) - order(b));
    const tabs = ['All', ...folders, ...(folders.length && list.some(f => !f.folder) ? ['Other'] : [])];
    if (!tabs.includes(tab)) tab = 'All';
    const inTab = f => tab === 'All' || (tab === 'Other' ? !f.folder : f.folder === tab || f.folder.startsWith(tab + '/'));
    const tags = [...new Set(list.flatMap(f => S.meta[f.path]?.tags || []))].sort();
    if (!tags.includes(tagFilter)) tagFilter = '';
    sortFiles(list, `${viewYear}/${name}`);
    subjectFiles = list.map(f => f.path);
    const shown = list.filter(f => inTab(f) && (!tagFilter || (S.meta[f.path]?.tags || []).includes(tagFilter)));
    const custom = S.sort === 'custom';
    return `
      <div class="subject-head" style="${cvars(name)}">
        <h1>${esc(name)}</h1>
        <div class="head-actions">
          <button data-act="newFile" data-subject="${esc(name)}">New file</button>
          <button data-act="editSubject" data-subject="${esc(name)}">Edit subject</button>
          <button data-act="openFolder" data-subject="${esc(name)}">Open in Explorer</button>
        </div>
      </div>
      <div class="tabrow"><div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" data-tab="${esc(t)}" class="${t === tab ? 'on' : ''}" style="${cvars(name)}">${esc(t)} <span class="count">${list.filter(f => t === 'All' || (t === 'Other' ? !f.folder : f.folder === t || f.folder.startsWith(t + '/'))).length}</span></button>`).join('')}</div>${sortSelect(true)}</div>
      <p class="hint-line">${custom ? 'Drag files to change their order, or onto a tab or subject to move them.' : 'Drag files onto a tab or subject to move them. You can also drop files here from Explorer.'}</p>
      ${tags.length ? `<div class="chips filter">${tags.map(t => `<button class="chip ${t === tagFilter ? 'on' : ''}" data-filter="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
      ${shown.length ? files(shown) : `<p class="empty big">No files in ${esc(tab === 'All' ? name : tab)} yet. Downloads you sort into it, and files you save to its folder, show up here.</p>`}`;
  },
};
const homeworkDraft = {};
let subjectFiles = []; // every file of the open subject, in display order

async function render() {
  document.querySelectorAll('.side [data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === view));
  document.querySelectorAll('#subjects button').forEach(b => b.classList.toggle('on', view === 'subject:' + b.dataset.go.slice(8)));
  const [name, arg] = [view.split(':')[0], view.split(':').slice(1).join(':')];
  // keep inbox choices across re-renders
  const picks = {};
  document.querySelectorAll('.inbox-item').forEach(el => (picks[el.dataset.src] = [el.querySelector('.pick-subj').value, el.querySelector('.pick-type').value]));
  $('#view').innerHTML = await views[name](arg);
  document.querySelectorAll('.inbox-item').forEach(el => {
    const p = picks[el.dataset.src];
    if (p) [el.querySelector('.pick-subj').value, el.querySelector('.pick-type').value] = p;
  });
}
function go(v) {
  if (v !== view) { tab = 'All'; tagFilter = ''; $('#view').scrollTop = 0; }
  view = v;
  render();
}

async function renderSide() {
  subjects = ordered(await api.invoke('subjects', viewYear));
  curSubjects = viewYear === S.year ? subjects : ordered(await api.invoke('subjects', S.year));
  // give every subject a fixed colour the first time it shows up
  const missing = [...new Set([...curSubjects, ...subjects])].filter(s => !S.colors[s]);
  for (const s of missing) S.colors[s] = hslHex(Math.round(Object.keys(S.colors).length * 137.5) % 360, 62, 72);
  if (missing.length) persist('colors');
  $('#themeBtn').textContent = S.theme === 'light' ? 'Dark mode' : 'Light mode';
  $('#year').innerHTML = S.years.slice().reverse().map(y => `<option value="${esc(y)}" ${y === viewYear ? 'selected' : ''}>${esc(y.replace('_', ' '))}${y === S.year ? '' : ' (archive)'}</option>`).join('');
  $('#subjects').innerHTML = subjects.map(s => `<button data-go="subject:${esc(s)}" draggable="true" data-drag="subj:${esc(s)}" style="${cvars(s)}" title="Drag to reorder, or Alt+↑/↓">${esc(s)}</button>`).join('');
}
async function refreshBadge() {
  const n = (await api.invoke('inbox')).length;
  $('#badge').hidden = !n;
  $('#badge').textContent = n;
}

// ---------- file menu ----------
function openMenu(p, anchor) {
  const m = S.meta[p] || {};
  const pop = $('#pop');
  pop.innerHTML = [
    ['pin', S.pins.includes(p) ? 'Unpin' : 'Pin'],
    ['tags', 'Edit tags'],
    ['due', m.due ? 'Change due date' : 'Set due date'],
    ...(m.due ? [['undue', 'Clear due date']] : []),
    ['rename', 'Rename'],
    ['reveal', 'Show in Explorer'],
  ].map(([k, l]) => `<button data-pop="${k}">${l}</button>`).join('');
  pop.dataset.path = p;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px';
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + 'px';
  pop.querySelector('button').focus();
}
async function menuAction(k, p) {
  const m = (S.meta[p] ||= {});
  if (k === 'pin') {
    S.pins = S.pins.includes(p) ? S.pins.filter(x => x !== p) : [...S.pins, p];
    await persist('pins');
  } else if (k === 'tags') {
    const v = await ask('Tags, separated by commas', (m.tags || []).join(', '));
    if (v === null) return;
    m.tags = [...new Set(v.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
  } else if (k === 'due') {
    const v = await ask('Due date', m.due || addDays(1), 'date');
    if (!v) return;
    m.due = v;
  } else if (k === 'undue') {
    delete m.due;
  } else if (k === 'rename') {
    const name = p.split(/[\\/]/).pop();
    const v = await ask('New name', name);
    if (!v || v === name) return;
    try {
      const dst = await api.invoke('rename', p, v);
      Object.assign(S, await api.invoke('state'));
      toast(`Renamed to ${dst.split(/[\\/]/).pop()}`);
    } catch (e) { toast(errMsg(e)); }
  } else if (k === 'reveal') {
    return api.invoke('reveal', p);
  }
  if (S.meta[p] && !S.meta[p].due && !S.meta[p].tags?.length) delete S.meta[p];
  if (k !== 'pin' && k !== 'rename') await persist('meta');
  render();
}
const errMsg = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-swatch],[data-go],[data-menu],[data-pop],[data-tag],[data-filter],[data-tab],[data-act],[data-open]');
  if (!e.target.closest('#pop')) $('#pop').hidden = true;
  if (!t) return;
  const d = t.dataset;
  if (d.swatch) { $('#subjColor').value = d.swatch; return markSwatch(); }
  if (d.go) return go(d.go);
  if (d.menu) return openMenu(d.menu, t);
  if (d.pop) { $('#pop').hidden = true; return menuAction(d.pop, $('#pop').dataset.path); }
  if (d.tag) { $('#q').value = '#' + d.tag; return go('search'); }
  if (d.filter) { tagFilter = tagFilter === d.filter ? '' : d.filter; return render(); }
  if (d.tab) { tab = d.tab; return render(); }
  if (d.open) return api.invoke('open', d.open).catch(err => toast(errMsg(err)));
  try { await actions[d.act]?.(t); } catch (err) { toast(errMsg(err)); }
});

const actions = {
  async move(btn) {
    const row = btn.closest('.inbox-item');
    const subject = row.querySelector('.pick-subj').value, type = row.querySelector('.pick-type').value;
    if (!subject) { row.querySelector('.pick-subj').focus(); return toast('Choose a subject first.'); }
    await api.invoke('move', row.dataset.src, subject, type);
    toast(`Moved to ${subject} › ${type}`);
    row.remove();
    await refreshBadge();
    if (!document.querySelector('.inbox-item')) render();
  },
  async ignore(btn) {
    const row = btn.closest('.inbox-item');
    await api.invoke('ignore', row.dataset.src);
    row.remove();
    await refreshBadge();
    if (!document.querySelector('.inbox-item')) render();
  },
  async scanAll() {
    await api.invoke('scanAll');
    await refreshBadge();
    render();
  },
  async addSubject() {
    const name = await ask(`New subject in ${viewYear.replace('_', ' ')}`);
    if (!name) return;
    await api.invoke('addSubject', viewYear, name);
    await renderSide();
    go('subject:' + name);
  },
  ebooks: () => api.invoke('ebooks'),
  editSubject: btn => editSubject(btn.dataset.subject),
  newFile: btn => newFile(btn.dataset.subject),
  async theme() {
    S.theme = S.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = S.theme;
    $('#themeBtn').textContent = S.theme === 'light' ? 'Dark mode' : 'Light mode';
    await persist('theme');
  },
  openFolder: btn => api.invoke('openFolder', viewYear, btn.dataset.subject),
  async hwDel(btn) {
    S.homework = S.homework.filter(h => h.id !== btn.dataset.id);
    await persist('homework');
    render();
  },
  async newNote() {
    S.notes.unshift({ id: uid(), text: '', color: S.notes.length % 5, subject: '' });
    await persist('notes');
    await render();
    document.querySelector('.note textarea')?.focus();
  },
  async noteColor(btn) {
    const n = S.notes.find(n => n.id === btn.closest('.note').dataset.note);
    n.color = (n.color + 1) % 5;
    btn.closest('.note').className = `note c${n.color}`;
    await persist('notes');
  },
  async noteDel(btn) {
    const id = btn.closest('.note').dataset.note;
    const n = S.notes.find(n => n.id === id);
    if (n.text.trim() && !confirm('Delete this note?')) return;
    S.notes = S.notes.filter(n => n.id !== id);
    await persist('notes');
    render();
  },
};

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.hw) {
    const h = S.homework.find(h => h.id === t.dataset.hw);
    h.done = t.checked;
    await persist('homework');
    setTimeout(render, 250);
  } else if ('notesubj' in t.dataset) {
    S.notes.find(n => n.id === t.closest('.note').dataset.note).subject = t.value;
    persist('notes');
  } else if (t.id === 'year') {
    viewYear = t.value;
    await renderSide();
    go(view.startsWith('subject:') && !subjects.includes(view.slice(8)) ? 'home' : view);
  } else if (t.id === 'allYears' && view === 'search') render();
  else if (t.id === 'sort') {
    S.sort = t.value;
    await persist('sort');
    render();
  }
});

let noteTimer, searchTimer;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('.note textarea')) {
    S.notes.find(n => n.id === t.closest('.note').dataset.note).text = t.value;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => persist('notes'), 400);
  } else if (t.id === 'q') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (t.value.trim() ? go('search') : go('home')), 200);
  }
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'hwForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  Object.assign(homeworkDraft, { subject: f.get('subject'), due: f.get('due') });
  S.homework.push({ id: uid(), subject: f.get('subject'), text: f.get('text').trim(), due: f.get('due'), added: today(), done: false });
  await persist('homework');
  await render();
  $('#hwForm [name=text]').focus();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#pop').hidden = true;
  if (e.key === 'Enter' && e.target.matches('.card')) api.invoke('open', e.target.dataset.open).catch(err => toast(errMsg(err)));
  if (e.key === 'f' && e.ctrlKey) { e.preventDefault(); $('#q').focus(); }
  const sub = e.target.closest?.('#subjects [data-drag]');
  if (sub && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const name = sub.dataset.drag.slice(5), j = subjects.indexOf(name) + (e.key === 'ArrowUp' ? -1 : 1);
    if (j >= 0 && j < subjects.length) moveSubject(name, subjects[j], true);
  }
});

api.on('inbox', async () => {
  await refreshBadge();
  if (view === 'inbox' || view === 'home') render();
});

(async () => {
  S = await api.invoke('state');
  document.documentElement.dataset.theme = S.theme;
  viewYear = S.year;
  await renderSide();
  await refreshBadge();
  render();
})();

// ---------- subject editing ----------
const SWATCHES = ['#f28b82', '#f7b267', '#f4d35e', '#a5d68f', '#6fcf97', '#7fd1c7', '#8ab4f8', '#a79af0', '#e39be0', '#c9b29b', '#b0b6c3', '#2f6fd6'];
function markSwatch() {
  document.querySelectorAll('[data-swatch]').forEach(b => b.classList.toggle('on', b.dataset.swatch === $('#subjColor').value));
}
document.addEventListener('input', e => e.target.id === 'subjColor' && markSwatch());

async function editSubject(name) {
  const d = $('#subjDlg');
  $('#subjTitle').textContent = `Edit ${name}`;
  $('#subjName').value = name;
  $('#subjColor').value = color(name);
  $('#swatches').innerHTML = SWATCHES.map(c => `<button type="button" class="swatch" data-swatch="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
  markSwatch();
  d.showModal();
  const res = await dialogResult(d);

  if (res === 'delete') {
    const n = (await api.invoke('files', viewYear, name)).length;
    if (!confirm(`Move ${name}${n ? ` and its ${n} ${n === 1 ? 'file' : 'files'}` : ''} to the Recycle Bin?`)) return;
    await api.invoke('deleteSubject', viewYear, name);
    S = await api.invoke('state');
    await renderSide();
    toast(`${name} moved to the Recycle Bin`);
    return go('home');
  }
  if (res !== 'ok') return;
  const to = $('#subjName').value.trim();
  if (to !== name) {
    await api.invoke('renameSubject', viewYear, name, to);
    S = await api.invoke('state');
  }
  S.colors[to] = $('#subjColor').value;
  await persist('colors');
  await renderSide();
  view = 'subject:' + to;
  render();
}

// ---------- new Word / PowerPoint / Excel file ----------
async function newFile(subject) {
  const d = $('#newDlg');
  const folders = await api.invoke('folders', viewYear, subject);
  const rank = f => (S.types.indexOf(f) + 1 || 99);
  folders.sort((a, b) => rank(a) - rank(b));
  const start = folders.includes(tab) ? tab : folders.includes('Mitschrift') ? 'Mitschrift' : '';
  $('#newTitle').textContent = `New file in ${subject}`;
  $('#newFolder').innerHTML = [`<option value="">${esc(subject)} (no subfolder)</option>`, ...folders.map(f => `<option ${f === start ? 'selected' : ''}>${esc(f)}</option>`)].join('');
  $('#newName').value = `${subject} ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  d.showModal();
  $('#newName').select();
  if ((await dialogResult(d)) !== 'ok') return;
  const kind = d.querySelector('[name=kind]:checked').value;
  const dst = await api.invoke('newFile', viewYear, subject, $('#newFolder').value, $('#newName').value, kind);
  toast(`Created ${dst.split(/[\\/]/).pop()}`);
  render();
}

function moveSubject(from, to, refocus) {
  S.subjectOrder = reorder(subjects, from, to);
  persist('subjectOrder');
  renderSide().then(() => {
    render();
    if (refocus) document.querySelector(`#subjects [data-drag="subj:${CSS.escape(from)}"]`)?.focus();
  });
}

// ---------- drag & drop ----------
// subjects in the sidebar: reorder. File cards: onto a subject or tab = move there,
// onto another card in custom order = reorder. Files from Explorer: onto a subject, tab or subject page.
let dragging = null;
const dragKind = el => el.dataset.drag.slice(0, el.dataset.drag.indexOf(':'));
const dragVal = el => el.dataset.drag.slice(el.dataset.drag.indexOf(':') + 1);
const tabFolder = t => (t === 'Other' ? '' : t); // 'Other' = loose files in the subject folder itself

function dropTarget(e) {
  const subjectView = view.startsWith('subject:') && view.slice(8);
  if (dragging && dragKind(dragging) === 'subj') {
    const s = e.target.closest('#subjects [data-drag]');
    return s && s !== dragging && { el: s, cls: 'drop', reorderSubject: dragVal(s) };
  }
  const outside = !dragging && e.dataTransfer.types.includes('Files');
  if (!outside && !dragging) return null;
  const s = e.target.closest('#subjects [data-drag]');
  if (s) return { el: s, cls: 'drop-in', subject: dragVal(s), folder: null };
  const tb = subjectView && e.target.closest('.tabs [data-tab]');
  if (tb) return tb.dataset.tab === 'All' && !outside ? null : { el: tb, cls: 'drop-in', subject: subjectView, folder: tb.dataset.tab === 'All' ? null : tabFolder(tb.dataset.tab) };
  const c = dragging && subjectView && S.sort === 'custom' && e.target.closest('.card[data-drag]');
  if (c) return c !== dragging && { el: c, cls: 'drop', reorderFile: dragVal(c) };
  if (outside && subjectView && e.target.closest('#view'))
    return { el: $('#view'), cls: 'drop-in', subject: subjectView, folder: tab === 'All' ? null : tabFolder(tab) };
  return null;
}
const clearDrop = keep => document.querySelectorAll('.drop, .drop-in').forEach(el => el !== keep && el.classList.remove('drop', 'drop-in'));

document.addEventListener('dragstart', e => {
  const t = e.target.closest?.('[data-drag]');
  if (!t) return;
  dragging = t;
  e.dataTransfer.effectAllowed = 'move';
  t.classList.add('dragging');
});
document.addEventListener('dragend', () => {
  clearDrop();
  dragging?.classList.remove('dragging');
  dragging = null;
});
document.addEventListener('dragover', e => {
  e.preventDefault(); // also stops Chromium from opening a dropped file
  const t = dropTarget(e);
  clearDrop(t?.el);
  e.dataTransfer.dropEffect = t ? 'move' : 'none';
  if (t) t.el.classList.add(t.cls);
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) clearDrop(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  const t = dropTarget(e), src = dragging;
  clearDrop();
  if (!t) return;
  if (t.reorderSubject) return moveSubject(dragVal(src), t.reorderSubject);
  if (t.reorderFile) {
    S.fileOrder[`${viewYear}/${view.slice(8)}`] = reorder(subjectFiles, dragVal(src), t.reorderFile);
    persist('fileOrder');
    return render();
  }
  const paths = src ? [dragVal(src)] : [...e.dataTransfer.files].map(f => api.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  try {
    const { moved, copied, failed } = await api.invoke('moveTo', paths, viewYear, t.subject, t.folder);
    const where = t.subject + (t.folder ? ` › ${t.folder}` : '');
    const n = k => `${k} ${k === 1 ? 'file' : 'files'}`;
    toast(failed.length ? `Couldn't move ${failed.join(', ')}`
      : moved + copied === 0 ? `Already in ${where}`
      : [moved && `Moved ${n(moved)}`, copied && `${moved ? 'c' : 'C'}opied ${n(copied)}`].filter(Boolean).join(', ') + ` to ${where}`);
    Object.assign(S, await api.invoke('state'));
    await refreshBadge();
    render();
  } catch (err) { toast(errMsg(err)); }
});
