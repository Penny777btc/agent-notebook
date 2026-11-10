// What the owner has already seen, so the UI can point at what agents wrote since.
// There is one reader (the owner) and the marks are shared by all their devices: <vault>/.notebook/seen.json holds
//   { all: iso, notebooks: { folder: iso }, notes: { path: iso } }
// and a note is unread while its `updated` time is later than every mark that covers it. The file is re-read on each
// access (the CLI and the server share the vault) and stays out of the git backup: it changes on every visit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_NOTE_MARKS = 2000;
const iso = (v) => { const t = new Date(v || 0).getTime(); return Number.isNaN(t) ? '' : new Date(t).toISOString(); };
const later = (a, b) => ((a || '') > (b || '') ? a : b);

export class ReadState {
  constructor(vault) {
    this.vault = vault;
    this.file = path.join(vault.root, '.notebook', 'seen.json');
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { all: iso(s.all), notebooks: { ...(s.notebooks || {}) }, notes: { ...(s.notes || {}) } };
    } catch {
      // first run (or an unreadable file): what is already in the vault counts as seen, only later writes are news
      const s = { all: new Date().toISOString(), notebooks: {}, notes: {} };
      this.save(s);
      return s;
    }
  }

  save(s) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, this.file); }
    catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
  }

  /** The latest mark covering a note: everything, its notebook (or a folder above it), or the note itself. */
  static seenAt(s, notePath) {
    let t = later(s.all, s.notes[notePath]);
    for (const [folder, at] of Object.entries(s.notebooks)) if (at > t && notePath.startsWith(folder + '/')) t = at;
    return t;
  }

  /** Unread notes, counted per notebook. `can(path)` limits the answer to what the caller may read. */
  unread({ can } = {}) {
    const s = this.load();
    const paths = [];
    const folders = {};
    const home = new Map(); // folder → the notebook it belongs to
    for (const n of this.vault.listNotes({ limit: 1e6 })) {
      if (iso(n.updated) <= ReadState.seenAt(s, n.path)) continue;
      if (can && !can(n.path)) continue;
      if (!home.has(n.folder)) home.set(n.folder, this.vault.notebookOf(n.folder)?.folder ?? n.folder);
      const nb = home.get(n.folder);
      folders[nb] = (folders[nb] || 0) + 1;
      paths.push(n.path);
    }
    return { now: new Date().toISOString(), total: paths.length, folders, paths };
  }

  /**
   * Mark one note, one notebook (everything below a folder) or everything as seen. `at` lets a client mark only up to the
   * moment its list was loaded, so a note that arrived a second later is not swallowed. Marks never move backwards.
   */
  mark({ path: notePath, folder, all, at } = {}) {
    const now = new Date().toISOString();
    const t = at && iso(at) && iso(at) < now ? iso(at) : now;
    const s = this.load();
    if (all) s.all = later(s.all, t);
    else if (folder) s.notebooks[folder] = later(s.notebooks[folder], t);
    else if (notePath) s.notes[notePath] = later(s.notes[notePath], t);
    else throw Object.assign(new Error('nothing to mark: pass path, folder or all'), { status: 400 });
    // drop marks a wider one already covers, and cap the per-note marks (deleted or moved notes leave theirs behind)
    for (const [f, v] of Object.entries(s.notebooks)) if (v <= s.all) delete s.notebooks[f];
    for (const [p, v] of Object.entries(s.notes)) if (v <= ReadState.seenAt({ ...s, notes: {} }, p)) delete s.notes[p];
    const marks = Object.entries(s.notes);
    if (marks.length > MAX_NOTE_MARKS) s.notes = Object.fromEntries(marks.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, MAX_NOTE_MARKS));
    this.save(s);
    return s;
  }

  /** mtime of the marks file, for the UI's change counter (a mark made on the phone refreshes the desktop tab). */
  stamp() {
    try { return Math.round(fs.statSync(this.file).mtimeMs); } catch { return 0; }
  }
}
