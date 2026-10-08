const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// BINDER_HOME=<folder>: run with separate Documents, Downloads and app data (testing, demo screenshots)
if (process.env.BINDER_HOME)
  for (const k of ['userData', 'documents', 'downloads']) {
    fs.mkdirSync(path.join(process.env.BINDER_HOME, k), { recursive: true });
    app.setPath(k, path.join(process.env.BINDER_HOME, k));
  }
const DOCS = app.getPath('documents');
const DOWNLOADS = app.getPath('downloads');
const DATA_FILE = path.join(app.getPath('userData'), 'data.json');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';
// [user data folder, possible .exe locations] of browsers that can run the Digi4School Offline extension
const BROWSERS = [
  [path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'), [path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]],
  [path.join(LOCAL, 'Google', 'Chrome', 'User Data'), [path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe')]],
  [path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'), [path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]],
];
const OFFICE_NEW = path.join(PF, 'Microsoft Office', 'Root', 'VFS', 'Windows', 'ShellNew');
const SHELLNEW = { docx: path.join(OFFICE_NEW, 'word.docx'), pptx: path.join(OFFICE_NEW, 'powerpoint.pptx'), xlsx: path.join(OFFICE_NEW, 'excel12.xlsx') };
const EXTS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.odt', '.odp', '.xls', '.xlsx'];
const TYPE_WORDS = {
  'Arbeitsblätter': ['ab', 'arbeitsblatt', 'arbeitsblätter', 'arbeitsblaetter', 'worksheet', 'handout', 'übung', 'uebung', 'aufgaben', 'skript'],
  'Mitschrift': ['mitschrift', 'notes', 'notizen', 'zusammenfassung'],
  'Hausübung': ['hü', 'hue', 'hausübung', 'hausuebung', 'hausaufgabe', 'homework', 'hw'],
  'Tests': ['test', 'schularbeit', 'sa', 'lernzettel', 'prüfung', 'pruefung', 'quiz'],
};

// ---------- data.json ----------
let data = {
  year: null, types: Object.keys(TYPE_WORDS), lastScan: 0,
  inbox: [], ignored: [], learned: {}, pins: [], meta: {}, homework: [], notes: [],
  colors: {}, subjectOrder: [], fileOrder: {}, sort: 'new', theme: 'dark',
};
const SAVED = ['pins', 'meta', 'homework', 'notes', 'colors', 'subjectOrder', 'fileOrder', 'sort', 'theme'];
const THEMES = { dark: { color: '#161922', symbolColor: '#8c92a5' }, light: { color: '#f3f4f7', symbolColor: '#636a7c' } };
try {
  Object.assign(data, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) {
  // keep a broken file instead of silently overwriting it
  if (e.code !== 'ENOENT') fs.copyFileSync(DATA_FILE, `${DATA_FILE}.broken-${Date.now()}`);
}
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data, null, 1));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

// ---------- folders & files ----------
const badName = n => !n || /[<>:"/\\|?*]/.test(n) || /^\.*$/.test(n.trim());
const words = name => path.parse(name).name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !/^\d+$/.test(w));

function dirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}
const years = () => dirs(DOCS).filter(n => /_\d{4}-\d{4}$/.test(n)).sort((a, b) => a.slice(-9).localeCompare(b.slice(-9)));

function stat(p) {
  try {
    const st = fs.statSync(p);
    return { path: p, name: path.basename(p), ext: path.extname(p).slice(1).toLowerCase(), size: st.size, mtime: st.mtimeMs };
  } catch { return null; }
}
// Documents\<year>\<subject>\<folder...>\file
function fileInfo(p) {
  const f = stat(p);
  if (!f) return null;
  const rel = path.relative(DOCS, p).split(path.sep);
  return { ...f, year: rel[0], subject: rel.length > 2 ? rel[1] : '', folder: rel.slice(2, -1).join('/') };
}
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue; // hidden + Office lock files
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const listYear = year => walk(path.join(DOCS, year)).map(fileInfo).filter(Boolean);

// dir\name.ext, or "name (2).ext" etc. if that's taken
function freePath(dir, file) {
  const { name, ext } = path.parse(file);
  let dst = path.join(dir, name + ext);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(dir, `${name} (${i})${ext}`);
  return dst;
}
async function moveFile(src, dir, copy = false) {
  await fsp.mkdir(dir, { recursive: true });
  const dst = freePath(dir, path.basename(src));
  if (copy) {
    await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    return dst;
  }
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(src);
  }
  return dst;
}

// first run: a folder for the current school year (September to August), named after last
// year's folder if there is one ("7CR_2025-2026" -> "8CR_2026-2027") and with the same subjects
function setup() {
  if (data.year) return;
  const now = new Date(), y = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const span = `${y}-${y + 1}`;
  const existing = years().find(n => n.endsWith('_' + span));
  const prev = years().filter(n => n !== existing).pop();
  const m = prev?.match(/^(\d+)(.*)_\d{4}-\d{4}$/);
  const year = existing || (m ? `${+m[1] + 1}${m[2]}_${span}` : `School_${span}`);
  const root = path.join(DOCS, year);
  fs.mkdirSync(root, { recursive: true });
  if (!existing)
    for (const s of prev ? dirs(path.join(DOCS, prev)) : [])
      for (const t of data.types) fs.mkdirSync(path.join(root, s, t), { recursive: true });
  data.year = year;
  data.lastScan = Date.now() - 7 * 864e5; // first run: offer the last week of downloads
  save();
}

// ---------- inbox ----------
function scan(since = data.lastScan) {
  const now = Date.now();
  let entries = [];
  try { entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    const p = path.join(DOWNLOADS, e.name);
    if (!e.isFile() || e.name.startsWith('~$') || !EXTS.includes(path.extname(e.name).toLowerCase())) continue;
    if (data.inbox.includes(p) || data.ignored.includes(p)) continue;
    try {
      const st = fs.statSync(p);
      if (Math.max(st.mtimeMs, st.birthtimeMs) > since) data.inbox.push(p);
    } catch {}
  }
  data.inbox = data.inbox.filter(p => fs.existsSync(p));
  data.ignored = data.ignored.filter(p => fs.existsSync(p));
  data.lastScan = Math.max(data.lastScan, now);
  save();
}

function guess(file) {
  const ws = words(file);
  const lower = path.parse(file).name.toLowerCase();
  const subs = dirs(path.join(DOCS, data.year));
  const score = {};
  for (const w of ws) for (const [k, n] of Object.entries(data.learned[w] || {})) score[k] = (score[k] || 0) + n;
  const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
  let [subject, type] = best ? best.split('/') : [];
  if (!subs.includes(subject))
    subject = subs.find(s => ws.includes(s.toLowerCase()) || (s.length > 3 && lower.includes(s.toLowerCase())));
  type = Object.keys(TYPE_WORDS).find(t => TYPE_WORDS[t].some(k => ws.includes(k))) || type || 'Arbeitsblätter';
  return { subject: subject || '', type };
}

// keep pins, tags/due dates and custom file order pointing at the right files after a rename/delete
const under = (p, a) => p === a || p.startsWith(a + path.sep);
function repath(a, b) {
  const fix = p => (under(p, a) ? b + p.slice(a.length) : p);
  data.pins = data.pins.map(fix);
  data.meta = Object.fromEntries(Object.entries(data.meta).map(([k, v]) => [fix(k), v]));
  for (const k in data.fileOrder) data.fileOrder[k] = data.fileOrder[k].map(fix);
}
function forget(a) {
  data.pins = data.pins.filter(p => !under(p, a));
  for (const k in data.meta) if (under(k, a)) delete data.meta[k];
  for (const k in data.fileOrder) data.fileOrder[k] = data.fileOrder[k].filter(p => !under(p, a));
}

// the browser + profile where the Digi4School Offline extension is loaded (unpacked from a "digi4school…" folder)
function findEbooks() {
  for (const [userData, exes] of BROWSERS) {
    const exe = exes.find(e => fs.existsSync(e));
    if (!exe) continue;
    for (const profile of dirs(userData).filter(d => d === 'Default' || d.startsWith('Profile ')))
      for (const file of ['Secure Preferences', 'Preferences']) {
        try {
          const ext = JSON.parse(fs.readFileSync(path.join(userData, profile, file), 'utf8')).extensions?.settings || {};
          const id = Object.keys(ext).find(k => /digi4school/i.test(ext[k].path || ''));
          if (id) return { exe, profile, url: `chrome-extension://${id}/src/ui/app.html` };
        } catch {}
      }
  }
  return null;
}

// ---------- IPC ----------
const handlers = {
  state: () => ({ year: data.year, years: years(), types: data.types, ...Object.fromEntries(SAVED.map(k => [k, data[k]])) }),
  subjects: year => dirs(path.join(DOCS, year)),
  folders: (year, subject) => dirs(path.join(DOCS, year, subject)),
  files: (year, subject) => listYear(year).filter(f => f.subject === subject),
  recent: () => listYear(data.year).sort((a, b) => b.mtime - a.mtime).slice(0, 12),
  stat: paths => paths.map(fileInfo).filter(Boolean),
  search: (q, year) => {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const tag = q.startsWith('#') && q.slice(1);
    return (year ? [year] : years()).flatMap(listYear)
      .filter(f => tag ? (data.meta[f.path]?.tags || []).some(t => t.toLowerCase() === tag) : f.name.toLowerCase().includes(q))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  },
  inbox: () => data.inbox.map(p => { const f = stat(p); return f && { ...f, guess: guess(p) }; }).filter(Boolean),
  scanAll: () => scan(0),
  move: async (src, subject, type) => {
    if (!data.inbox.includes(src)) throw new Error('This file is no longer in the inbox.');
    if (badName(subject) || badName(type)) throw new Error('Choose a subject and a type first.');
    for (const w of words(src).filter(w => w.length > 2)) {
      const m = (data.learned[w] ||= {});
      m[`${subject}/${type}`] = (m[`${subject}/${type}`] || 0) + 1;
    }
    const dst = await moveFile(src, path.join(DOCS, data.year, subject, type));
    data.inbox = data.inbox.filter(p => p !== src);
    save();
    return dst;
  },
  // drag & drop: files from Explorer or from Binder itself into <year>\<subject>\<folder>.
  // folder null = keep the file's current type folder (or guess one for outside files).
  // Like Explorer: same drive moves, another drive (USB stick...) copies.
  moveTo: async (paths, year, subject, folder) => {
    const base = path.join(DOCS, year, subject);
    if (badName(subject) || (folder && folder.split('/').some(badName)) || !fs.existsSync(base)) throw new Error('That subject folder doesn\'t exist.');
    let moved = 0, copied = 0;
    const failed = [];
    for (let p of paths) {
      try {
        p = path.resolve(p);
        if (!fs.statSync(p).isFile()) { failed.push(`${path.basename(p)} (folders can't be dropped)`); continue; }
        const rel = path.relative(DOCS, p);
        const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
        const sub = folder ?? (inside ? fileInfo(p).folder : guess(p).type);
        const dir = path.join(base, ...sub.split('/').filter(Boolean));
        if (path.dirname(p).toLowerCase() === dir.toLowerCase()) continue;
        const copy = path.parse(p).root.toLowerCase() !== path.parse(dir).root.toLowerCase();
        const dst = await moveFile(p, dir, copy);
        if (copy) copied++; else { moved++; repath(p, dst); }
        data.inbox = data.inbox.filter(x => x !== p);
      } catch (e) {
        failed.push(path.basename(p) + (e.code === 'EBUSY' || e.code === 'EPERM' ? ' (open in another program?)' : ''));
      }
    }
    save();
    return { moved, copied, failed };
  },
  newFile: async (year, subject, folder, name, ext) => {
    name = name.trim().replace(/\.(docx|pptx|xlsx)$/i, '');
    if (!SHELLNEW[ext] || badName(name) || badName(subject) || folder.split('/').filter(Boolean).some(badName))
      throw new Error('File names can\'t contain < > : " / \\ | ? *');
    const dir = path.join(DOCS, year, subject, ...folder.split('/').filter(Boolean));
    await fsp.mkdir(dir, { recursive: true });
    const dst = freePath(dir, `${name}.${ext}`);
    // Office's own blank file (what Explorer's New menu uses); Office also opens an empty file as a new document
    if (fs.existsSync(SHELLNEW[ext])) {
      await fsp.copyFile(SHELLNEW[ext], dst, fs.constants.COPYFILE_EXCL);
      await fsp.utimes(dst, new Date(), new Date()); // Windows copies keep the template's old date
    } else await fsp.writeFile(dst, '', { flag: 'wx' });
    const err = await shell.openPath(dst);
    if (err) throw new Error(err);
    return dst;
  },
  ignore: src => {
    data.inbox = data.inbox.filter(p => p !== src);
    data.ignored.push(src);
    save();
  },
  open: async p => { const err = await shell.openPath(p); if (err) throw new Error(err); },
  reveal: p => shell.showItemInFolder(p),
  ebooks: () => {
    const e = findEbooks();
    if (!e) throw new Error('Digi4School Offline isn\'t installed in Brave, Chrome or Edge.');
    spawn(e.exe, [`--profile-directory=${e.profile}`, e.url], { detached: true, stdio: 'ignore' }).unref();
  },
  openFolder: (year, subject) => shell.openPath(path.join(DOCS, year, subject || '')),
  rename: async (p, name) => {
    name = name.trim();
    if (badName(name)) throw new Error('File names can\'t contain < > : " / \\ | ? *');
    if (!path.extname(name)) name += path.extname(p);
    const dst = path.join(path.dirname(p), name);
    if (dst === p) return p;
    if (fs.existsSync(dst)) throw new Error('A file with that name already exists.');
    await fsp.rename(p, dst);
    repath(p, dst);
    save();
    return dst;
  },
  addSubject: (year, name) => {
    name = name.trim();
    if (badName(name)) throw new Error('Subject names can\'t contain < > : " / \\ | ? *');
    for (const t of data.types) fs.mkdirSync(path.join(DOCS, year, name, t), { recursive: true });
  },
  renameSubject: async (year, from, to) => {
    to = to.trim();
    if (badName(to)) throw new Error('Subject names can\'t contain < > : " / \\ | ? *');
    if (to === from) return;
    const a = path.join(DOCS, year, from), b = path.join(DOCS, year, to);
    if (to.toLowerCase() !== from.toLowerCase() && fs.existsSync(b)) throw new Error(`There is already a subject called ${to}.`);
    await fsp.rename(a, b);
    repath(a, b);
    if (data.fileOrder[`${year}/${from}`]) {
      data.fileOrder[`${year}/${to}`] = data.fileOrder[`${year}/${from}`];
      delete data.fileOrder[`${year}/${from}`];
    }
    data.colors[to] ||= data.colors[from];
    data.subjectOrder = data.subjectOrder.map(s => (s === from ? to : s));
    for (const x of [...data.homework, ...data.notes]) if (x.subject === from) x.subject = to;
    for (const m of Object.values(data.learned))
      for (const k of Object.keys(m)) if (k.startsWith(from + '/')) {
        const nk = to + k.slice(from.length);
        m[nk] = (m[nk] || 0) + m[k];
        delete m[k];
      }
    save();
  },
  deleteSubject: async (year, name) => {
    const dir = path.join(DOCS, year, name);
    if (badName(name) || !fs.existsSync(dir)) throw new Error(`${name} doesn't exist.`);
    await shell.trashItem(dir); // Recycle Bin, so it can be restored
    forget(dir);
    delete data.fileOrder[`${year}/${name}`];
    save();
  },
  save: (key, value) => {
    if (!SAVED.includes(key)) return;
    data[key] = value;
    save();
    if (key === 'theme') applyTheme();
  },
};
for (const [k, f] of Object.entries(handlers)) ipcMain.handle(k, (_e, ...a) => f(...a));

// ---------- app ----------
function shortcuts() {
  // only when run from source on Windows; installed builds get their shortcuts from the installer
  if (process.platform !== 'win32' || app.isPackaged || process.env.NO_SHORTCUT || process.env.BINDER_HOME) return;
  const opts = {
    target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath(),
    icon: path.join(__dirname, 'icon.ico'), iconIndex: 0, description: 'Binder',
  };
  for (const dir of [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')])
    shell.writeShortcutLink(path.join(dir, 'Binder.lnk'), 'create', opts);
}

let win;
function applyTheme() {
  const t = THEMES[data.theme] || THEMES.dark;
  win?.setTitleBarOverlay({ ...t, height: 44 });
  win?.setBackgroundColor(t.color);
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setup();
  scan();
  shortcuts();
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600,
    title: 'Binder', icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'docs/icon.png'), backgroundColor: (THEMES[data.theme] || THEMES.dark).color,
    titleBarStyle: 'hidden', titleBarOverlay: { ...(THEMES[data.theme] || THEMES.dark), height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault()); // a stray file drop must never replace the app
  win.loadFile('index.html');

  let t;
  fs.watch(DOWNLOADS, () => {
    clearTimeout(t);
    t = setTimeout(() => { scan(); win?.webContents.send('inbox'); }, 1500);
  });
});
app.on('window-all-closed', () => app.quit());
