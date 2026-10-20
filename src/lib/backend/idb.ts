import { v4 as uuid } from 'uuid';
import type { Note, Todo, Settings, SyncResult, CommitInfo, Project, Whiteboard, Tag, DayEntry } from '../types';
import type { ApiBackend } from './interface';
import { invoke } from '@tauri-apps/api/core';

// Running inside the Tauri desktop/Android shell (vs. a plain browser).
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ── IndexedDB ─────────────────────────────────────────────────────────────────
//
// Stores:
//   notes   — Note records (keyPath id)
//   todos   — Todo records incl. inline `notes` (keyPath id)
//   images  — { path, blob, sha } keyed by repo-relative path (e.g. img/a.png)
//   meta    — key/value: projects, tags, whiteboards, journal, sync manifest
//
// Everything that sync compares lives in this one database on purpose: if the
// browser evicts it, the manifest goes with the data, so a wiped cache can never
// look like "the user deleted everything" and propagate deletes to GitHub.

const DB_NAME = 'todoto';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('todos')) db.createObjectStore('todos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'path' });
        // v1 stored images as data URLs that were also inlined into the markdown,
        // so the records were never referenced — drop them rather than sync them.
        else if (e.oldVersion < 2) req.transaction!.objectStore('images').clear();
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).then(async (db) => {
      await migrateLocalStorage(db);
      // Ask the browser not to evict our data under storage pressure.
      void navigator.storage?.persist?.().catch(() => {});
      return db;
    });
  }
  return dbPromise;
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function dbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return reqPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

/**
 * IndexedDB structured-clones what it stores, and Svelte 5 `$state` values are
 * Proxies, which structured clone refuses — the write then rejects and the edit
 * is silently lost. Everything here is plain JSON data, so round-tripping
 * through JSON strips the proxies and any accidental non-clonable field.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(plain(value));
  return txDone(tx);
}

function dbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
}

async function metaGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return reqPromise(db.transaction('meta', 'readonly').objectStore('meta').get(key));
}

function metaSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(plain(value), key);
  return txDone(tx);
}

// Projects, tags and whiteboards used to live in localStorage. Move them into
// the meta store once so they share the database's lifetime with the manifest.
async function migrateLocalStorage(db: IDBDatabase): Promise<void> {
  const legacy: Array<[string, string]> = [
    ['todoto-idb-projects', 'projects'],
    ['todoto-idb-tags', 'tags'],
    ['todoto-idb-whiteboards', 'whiteboards'],
  ];
  for (const [lsKey, metaKey] of legacy) {
    const raw = localStorage.getItem(lsKey);
    if (raw == null) continue;
    if ((await metaGet(db, metaKey)) === undefined) {
      try { await metaSet(db, metaKey, JSON.parse(raw)); } catch { continue; }
    }
    localStorage.removeItem(lsKey);
  }
}

// ── Settings & last-sync (localStorage) ──────────────────────────────────────

const SETTINGS_KEY = 'todoto-idb-settings';
const LAST_SYNC_KEY = 'todoto-idb-last-sync';

const DEFAULT_SETTINGS: Settings = {
  repo_path: '',
  repo_url: '',
  git_username: '',
  git_email: '',
  git_token: '',
  auto_sync: true,
  sync_interval_seconds: 30,
};

function loadSettings(): Settings {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ── Synced JSON files (projects.json, tags.json, whiteboards.json, journal.json)

interface ProjectsFile { projects: Project[]; version: number; updated_at: string; }
interface TagsFile { tags: Tag[]; version: number; updated_at: string; }
interface WhiteboardsFile { whiteboards: Whiteboard[]; version: number; }
interface JournalFile { days: DayEntry[]; version: number; }
interface TodoData { todos: Todo[]; version: number; }

async function loadProjectsFile(db: IDBDatabase): Promise<ProjectsFile> {
  const f = await metaGet<Partial<ProjectsFile>>(db, 'projects');
  return { projects: f?.projects ?? [], version: 1, updated_at: f?.updated_at ?? '' };
}

async function loadTagsFile(db: IDBDatabase): Promise<TagsFile> {
  const f = await metaGet<Partial<TagsFile>>(db, 'tags');
  return { tags: f?.tags ?? [], version: 1, updated_at: f?.updated_at ?? '' };
}

async function loadWhiteboardsFile(db: IDBDatabase): Promise<WhiteboardsFile> {
  const f = await metaGet<Partial<WhiteboardsFile>>(db, 'whiteboards');
  return { whiteboards: f?.whiteboards ?? [], version: 1 };
}

async function loadJournalFile(db: IDBDatabase): Promise<JournalFile> {
  const f = await metaGet<Partial<JournalFile>>(db, 'journal');
  return { days: f?.days ?? [], version: 1 };
}

const serializeProjectsFile = (f: ProjectsFile) =>
  JSON.stringify({ projects: f.projects, version: 1, updated_at: f.updated_at }, null, 2);
const serializeTagsFile = (f: TagsFile) =>
  JSON.stringify({ tags: f.tags, version: 1, updated_at: f.updated_at }, null, 2);
const serializeWhiteboardsFile = (f: WhiteboardsFile) =>
  JSON.stringify({ whiteboards: f.whiteboards, version: 1 }, null, 2);
const serializeJournalFile = (f: JournalFile) =>
  JSON.stringify({ days: [...f.days].sort((a, b) => a.id.localeCompare(b.id)), version: 1 }, null, 2);

function serializeTodos(todos: Todo[]): string {
  // Inline notes live in task-notes/{id}.md; todos.json only points at them.
  const stripped = todos.map((t) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { notes: _notes, ...rest } = t;
    rest.note_path = t.notes && t.notes.trim() !== '' ? taskNotePath(t.id) : null;
    return rest;
  });
  return JSON.stringify({ todos: stripped, version: 1 }, null, 2);
}

// ── Note file format (same as the former Rust backend) ───────────────────────

const taskNotePath = (todoId: string) => `task-notes/${todoId}.md`;
const TASK_NOTE_RE = /^task-notes\/([^/]+)\.md$/;

function sanitizeFilename(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function derivedNotePath(note: Pick<Note, 'title' | 'folder'>, suffix = ''): string {
  const name = `${sanitizeFilename(note.title)}${suffix}.md`;
  return note.folder ? `${note.folder}/${name}` : name;
}

function noteFilePath(note: Note): string {
  return note.file_path || derivedNotePath(note);
}

function serializeNote(note: Note): string {
  const tags = note.tags.join(', ');
  return `---\nid: ${note.id}\ntitle: ${note.title}\npinned: ${note.pinned}\ntags: ${tags}\ncreated_at: ${note.created_at}\nupdated_at: ${note.updated_at}\n---\n${note.content}`;
}

function stripFrontmatter(content: string): string {
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end !== -1) return content.slice(end + 5);
  }
  return content;
}

function parseNoteFile(content: string, filePath: string): Note {
  let fmStr = '';
  let body = content;
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end !== -1) {
      fmStr = content.slice(4, end);
      body = content.slice(end + 5);
    }
  }

  let id = '', title = '', pinned = false, tags: string[] = [];
  let created_at = new Date().toISOString();
  let updated_at = created_at;

  for (const line of fmStr.split('\n')) {
    const colonIdx = line.indexOf(': ');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 2).trim();
    if (key === 'id') id = value;
    else if (key === 'title') title = value;
    else if (key === 'pinned') pinned = value === 'true';
    else if (key === 'tags') tags = value.split(',').map((t) => t.trim()).filter(Boolean);
    else if (key === 'created_at') created_at = value;
    else if (key === 'updated_at') updated_at = value;
  }

  if (!id) id = uuid();
  if (!title) {
    const base = filePath.split('/').pop() ?? filePath;
    title = base.endsWith('.md') ? base.slice(0, -3) : base;
  }
  const parts = filePath.split('/');
  const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  return { id, title, content: body, folder, pinned, tags, created_at, updated_at, file_path: filePath };
}

// Timestamps may be written by JS (…Z) or by the old Rust backend (…+00:00),
// so compare them as instants, not strings.
function time(s: string | undefined | null): number {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ── Images ───────────────────────────────────────────────────────────────────
//
// Markdown always references images by repo-relative path (img/x.png,
// task-notes/img/x.png) so notes stay portable. For display, each stored image
// gets an object URL; resolveImageUrl/unresolveImageUrl map between the two.

interface ImageRecord { path: string; blob: Blob; sha: string; }

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

const urlByPath = new Map<string, string>();
const pathByUrl = new Map<string, string>();
let imageCachePromise: Promise<void> | null = null;

function registerImage(path: string, blob: Blob): void {
  unregisterImage(path);
  const url = URL.createObjectURL(blob);
  urlByPath.set(path, url);
  pathByUrl.set(url, path);
}

function unregisterImage(path: string): void {
  const old = urlByPath.get(path);
  if (!old) return;
  URL.revokeObjectURL(old);
  urlByPath.delete(path);
  pathByUrl.delete(old);
}

function ensureImageCache(db: IDBDatabase): Promise<void> {
  if (!imageCachePromise) {
    imageCachePromise = dbGetAll<ImageRecord>(db, 'images').then((recs) => {
      for (const r of recs) if (r.blob) registerImage(r.path, r.blob);
    });
  }
  return imageCachePromise;
}

async function storeImage(db: IDBDatabase, path: string, blob: Blob, sha?: string): Promise<void> {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const typed = blob.type.startsWith('image/') ? blob : new Blob([blob], { type: MIME_BY_EXT[ext] ?? 'application/octet-stream' });
  const rec: ImageRecord = { path, blob: typed, sha: sha ?? (await gitBlobSha(new Uint8Array(await typed.arrayBuffer()))) };
  // Not dbPut: plain() would destroy the Blob.
  const tx = db.transaction('images', 'readwrite');
  tx.objectStore('images').put(rec);
  await txDone(tx);
  registerImage(path, typed);
}

// ── Git / GitHub helpers ──────────────────────────────────────────────────────

// SHA git uses for a blob: SHA1("blob <byteLen>\0<content>").
async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const textSha = (s: string) => gitBlobSha(new TextEncoder().encode(s));

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

interface Gh { owner: string; repo: string; token: string; }

function ghFromSettings(settings: Settings): Gh | null {
  const m = settings.repo_url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/);
  if (!m || !settings.git_token) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), token: settings.git_token };
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// Every GitHub read bypasses the HTTP cache: the API marks responses cacheable
// for 60 s, and a stale tree makes a fresh remote change look like a conflict.
function ghFetch(gh: Gh, apiPath: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
  const { accept, ...rest } = init;
  return fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/${apiPath}`, {
    cache: 'no-store',
    ...rest,
    headers: {
      Authorization: `token ${gh.token}`,
      Accept: accept ?? 'application/vnd.github+json',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

async function ghCheck(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`GitHub ${what}: ${res.status} ${await res.text()}`);
  return res;
}

function isTextPath(path: string): boolean {
  return path.endsWith('.md') || ['todos.json', 'projects.json', 'whiteboards.json', 'tags.json', 'journal.json'].includes(path);
}

// path → blob sha for every synced file on the default branch.
async function ghTree(gh: Gh): Promise<Map<string, string>> {
  const res = await ghFetch(gh, 'git/trees/HEAD?recursive=1');
  // 404 = repo not found / no access; 409 = repo exists but has no commits yet.
  if (res.status === 409) return new Map();
  await ghCheck(res, 'tree');
  const data = await res.json();
  if (data.truncated) throw new Error('GitHub tree is too large to sync.');
  const map = new Map<string, string>();
  for (const item of data.tree) {
    if (item.type === 'blob' && (isTextPath(item.path) || IMAGE_EXT_RE.test(item.path))) {
      map.set(item.path, item.sha);
    }
  }
  return map;
}

// Raw blob by sha — no base64, no 1 MB contents-API limit.
async function ghBlob(gh: Gh, sha: string): Promise<Blob> {
  const res = await ghCheck(await ghFetch(gh, `git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json' }), `blob ${sha}`);
  return res.blob();
}

const ghText = async (gh: Gh, sha: string) => (await ghBlob(gh, sha)).text();

async function ghCurrentSha(gh: Gh, path: string): Promise<string | undefined> {
  const res = await ghFetch(gh, `contents/${encodePath(path)}`);
  if (res.status === 404) return undefined;
  return (await (await ghCheck(res, `stat ${path}`)).json()).sha;
}

// Creates/updates a file and returns its new blob sha. On a sha mismatch the
// remote moved since we listed the tree; retry against its current sha (the
// same resolution the Rust backend used).
async function ghPut(gh: Gh, path: string, base64: string, sha: string | undefined): Promise<string> {
  let current = sha;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body: Record<string, string> = { message: 'todoto sync', content: base64 };
    if (current) body.sha = current;
    const res = await ghFetch(gh, `contents/${encodePath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      current = await ghCurrentSha(gh, path);
      continue;
    }
    await ghCheck(res, `put ${path}`);
    return (await res.json()).content.sha;
  }
  throw new Error(`GitHub PUT failed after 3 attempts (persistent conflict on ${path}).`);
}

async function ghDelete(gh: Gh, path: string, sha: string): Promise<void> {
  const res = await ghFetch(gh, `contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: 'todoto sync', sha }),
  });
  if (res.status === 404) return;
  await ghCheck(res, `delete ${path}`);
}

async function ghFileAtRef(gh: Gh, path: string, ref: string): Promise<string> {
  const res = await ghFetch(gh, `contents/${encodePath(path)}?ref=${ref}`, { accept: 'application/vnd.github.raw+json' });
  return (await ghCheck(res, `read ${path}@${ref}`)).text();
}

// ── Sync ──────────────────────────────────────────────────────────────────────
//
// Three-way sync against a manifest (path → blob sha as of the last successful
// sync), the same model the Rust backend used:
//   local == remote            → nothing to do
//   only local changed         → upload        (local deleted → delete remote)
//   only remote changed        → download      (remote deleted → delete local)
//   both changed               → merge / conflict resolution per file type

interface Manifest {
  repo: string;
  files: Record<string, string>;
  // Item ids present in todos.json / whiteboards.json / journal.json after the last sync — lets
  // a merge tell "deleted on one side" apart from "created on the other".
  baseIds: Record<string, string[]>;
}

async function loadManifest(db: IDBDatabase, repoUrl: string): Promise<Manifest> {
  const m = await metaGet<Manifest>(db, 'manifest');
  // A different repo means none of the recorded state applies.
  if (!m || m.repo !== repoUrl) return { repo: repoUrl, files: {}, baseIds: {} };
  return { repo: m.repo, files: m.files ?? {}, baseIds: m.baseIds ?? {} };
}

interface LocalState {
  notes: Note[];
  todos: Todo[];
  text: Map<string, string>;
  images: Map<string, string>; // path → sha
}

async function readLocalState(db: IDBDatabase, manifest: Manifest): Promise<LocalState> {
  const [notes, todos, projects, tags, boards, journal, images] = await Promise.all([
    dbGetAll<Note>(db, 'notes'),
    dbGetAll<Todo>(db, 'todos'),
    loadProjectsFile(db),
    loadTagsFile(db),
    loadWhiteboardsFile(db),
    loadJournalFile(db),
    dbGetAll<ImageRecord>(db, 'images'),
  ]);
  const had = (p: string) => p in manifest.files;
  const text = new Map<string, string>();
  // A JSON file exists locally once it has content or was synced before; an
  // untouched empty one must not overwrite (or be mistaken for) the remote file.
  if (todos.length || had('todos.json')) text.set('todos.json', serializeTodos(todos));
  if (projects.projects.length || projects.updated_at || had('projects.json')) text.set('projects.json', serializeProjectsFile(projects));
  if (tags.tags.length || tags.updated_at || had('tags.json')) text.set('tags.json', serializeTagsFile(tags));
  if (boards.whiteboards.length || had('whiteboards.json')) text.set('whiteboards.json', serializeWhiteboardsFile(boards));
  if (journal.days.length || had('journal.json')) text.set('journal.json', serializeJournalFile(journal));
  for (const t of todos) {
    if (t.notes && t.notes.trim() !== '') text.set(taskNotePath(t.id), t.notes);
  }
  for (const n of notes) text.set(noteFilePath(n), serializeNote(n));
  return { notes, todos, text, images: new Map(images.filter((r) => r.blob).map((r) => [r.path, r.sha])) };
}

function mergeById<T extends { id: string; updated_at: string }>(local: T[], remote: T[], base: string[] | undefined): T[] {
  const baseSet = new Set(base ?? []);
  const l = new Map(local.map((x) => [x.id, x]));
  const r = new Map(remote.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const id of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(id);
    const b = r.get(id);
    if (a && b) out.push(time(a.updated_at) >= time(b.updated_at) ? a : b);
    // Present on one side only: if it existed at the last sync, the other side
    // deleted it; otherwise this side created it.
    else if (!baseSet.has(id)) out.push((a ?? b)!);
  }
  return out;
}

const CONFLICT_DATE = () => new Date().toISOString().slice(0, 10);

type Change = { content: string | null }; // null = delete locally

interface SyncStats { up: number; down: number; del: number; }

async function runSync(db: IDBDatabase, settings: Settings): Promise<SyncStats> {
  const gh = ghFromSettings(settings);
  if (!gh) throw new Error('GitHub repo URL or token not configured.');

  const manifest = await loadManifest(db, settings.repo_url);
  const base = manifest.files;
  const local = await readLocalState(db, manifest);
  const remote = await ghTree(gh);

  const stats: SyncStats = { up: 0, down: 0, del: 0 };
  const newFiles: Record<string, string> = {};
  const newBaseIds = { ...manifest.baseIds };
  const changes = new Map<string, Change>();   // text files to apply locally
  const conflictCopies: Note[] = [];
  const uploads: Array<{ path: string; content: string; sha?: string }> = [];
  const remoteDeletes: Array<{ path: string; sha: string }> = [];

  // ── Plan text files ────────────────────────────────────────────────────────
  const textPaths = new Set([
    ...local.text.keys(),
    ...[...remote.keys()].filter(isTextPath),
    ...Object.keys(base).filter(isTextPath),
  ]);

  for (const path of textPaths) {
    const L = local.text.get(path);
    const Ls = L != null ? await textSha(L) : undefined;
    const R = remote.get(path);
    const B = base[path];

    if (Ls === R) {
      if (R) newFiles[path] = R;
      continue;
    }
    if (L == null) {
      // Deleted here (and remote untouched) → delete there; otherwise the remote
      // edit wins over the local delete.
      if (B === R) {
        remoteDeletes.push({ path, sha: R! });
      } else {
        changes.set(path, { content: await ghText(gh, R!) });
        newFiles[path] = R!;
      }
      continue;
    }
    if (R == null) {
      if (B === Ls) changes.set(path, { content: null });
      else uploads.push({ path, content: L });
      continue;
    }
    const localChanged = B !== Ls;
    const remoteChanged = B !== R;
    if (!localChanged) {
      changes.set(path, { content: await ghText(gh, R) });
      newFiles[path] = R;
      continue;
    }
    if (!remoteChanged) {
      uploads.push({ path, content: L, sha: R });
      continue;
    }

    // Both sides changed.
    const Rc = await ghText(gh, R);
    const resolved = resolveConflict(path, L, Rc, B !== undefined, manifest, conflictCopies);
    if (resolved === Rc) {
      changes.set(path, { content: Rc });
      newFiles[path] = R;
    } else {
      if (resolved !== L) changes.set(path, { content: resolved });
      uploads.push({ path, content: resolved, sha: R });
    }
  }

  // ── Plan images ────────────────────────────────────────────────────────────
  const imageDownloads: Array<{ path: string; sha: string }> = [];
  const imageUploads: string[] = [];
  const imageLocalDeletes: string[] = [];
  const imagePaths = new Set([
    ...local.images.keys(),
    ...[...remote.keys()].filter((p) => IMAGE_EXT_RE.test(p)),
    ...Object.keys(base).filter((p) => IMAGE_EXT_RE.test(p)),
  ]);
  for (const path of imagePaths) {
    const Ls = local.images.get(path);
    const R = remote.get(path);
    const B = base[path];
    if (Ls === R) { if (R) newFiles[path] = R; continue; }
    if (Ls == null) {
      if (B === R) remoteDeletes.push({ path, sha: R! });
      else imageDownloads.push({ path, sha: R! });
    } else if (R == null) {
      if (B === Ls) imageLocalDeletes.push(path);
      else imageUploads.push(path);
    } else if (B === Ls) {
      imageDownloads.push({ path, sha: R });
    } else {
      imageUploads.push(path);
    }
  }

  // Guard against a wiped or half-initialised local store propagating as a
  // mass delete on GitHub.
  if (remoteDeletes.length > 5 && remoteDeletes.length > remote.size * 0.3) {
    throw new Error(
      `Sync stopped: it would delete ${remoteDeletes.length} of ${remote.size} files on GitHub. ` +
      'If that is really intended, delete them on GitHub directly.'
    );
  }

  // ── Execute remote writes (sequential: parallel commits race with 409s) ────
  for (const { path, sha } of remoteDeletes) {
    await ghDelete(gh, path, sha);
    stats.del++;
  }
  for (const u of uploads) {
    newFiles[u.path] = await ghPut(gh, u.path, bytesToBase64(new TextEncoder().encode(u.content)), u.sha ?? remote.get(u.path));
    stats.up++;
  }
  for (const path of imageUploads) {
    const rec = await reqPromise<ImageRecord>(db.transaction('images', 'readonly').objectStore('images').get(path));
    newFiles[path] = await ghPut(gh, path, bytesToBase64(new Uint8Array(await rec.blob.arrayBuffer())), remote.get(path));
    stats.up++;
  }

  // ── Apply locally ──────────────────────────────────────────────────────────
  for (const { path, sha } of imageDownloads) {
    await storeImage(db, path, await ghBlob(gh, sha), sha);
    newFiles[path] = sha;
    stats.down++;
  }
  for (const path of imageLocalDeletes) {
    await dbDelete(db, 'images', path);
    unregisterImage(path);
    stats.del++;
  }

  // The user may have edited something while we were talking to GitHub. Any
  // file whose local content moved since the snapshot is left alone. Where
  // that skips adopting remote content (a download, or a merge we uploaded),
  // the manifest entry is rolled back so the next sync sees both sides changed
  // and merges again instead of overwriting either edit. A plain upload keeps
  // its new sha: the next run then just uploads the newer local edit.
  const now = await readLocalState(db, manifest);
  const rollback = (path: string) => {
    if (base[path] === undefined) delete newFiles[path];
    else newFiles[path] = base[path];
  };
  for (const path of [...changes.keys()]) {
    if (now.text.get(path) !== local.text.get(path)) {
      changes.delete(path);
      rollback(path);
    }
  }

  await applyTextChanges(db, now, changes);
  for (const copy of conflictCopies) await dbPut(db, 'notes', copy);
  for (const c of changes.values()) if (c.content === null) stats.del++; else stats.down++;

  // Record merge bases for the id-merged files.
  const finalTodos = changes.get('todos.json')?.content ?? now.text.get('todos.json');
  if (finalTodos != null && newFiles['todos.json'] === (await textSha(finalTodos))) {
    newBaseIds['todos.json'] = (JSON.parse(finalTodos) as TodoData).todos.map((t) => t.id);
  }
  const finalBoards = changes.get('whiteboards.json')?.content ?? now.text.get('whiteboards.json');
  if (finalBoards != null && newFiles['whiteboards.json'] === (await textSha(finalBoards))) {
    newBaseIds['whiteboards.json'] = (JSON.parse(finalBoards) as WhiteboardsFile).whiteboards.map((b) => b.id);
  }
  const finalJournal = changes.get('journal.json')?.content ?? now.text.get('journal.json');
  if (finalJournal != null && newFiles['journal.json'] === (await textSha(finalJournal))) {
    newBaseIds['journal.json'] = (JSON.parse(finalJournal) as JournalFile).days.map((d) => d.id);
  }

  await metaSet(db, 'manifest', { repo: settings.repo_url, files: newFiles, baseIds: newBaseIds } satisfies Manifest);
  return stats;
}

// Returns the content both sides should end up with. Returning the remote
// content means "adopt remote", anything else is uploaded.
function resolveConflict(
  path: string,
  L: string,
  Rc: string,
  hadBase: boolean,
  manifest: Manifest,
  conflictCopies: Note[]
): string {
  if (L === Rc) return Rc;

  if (path === 'todos.json') {
    const l = (JSON.parse(L) as TodoData).todos ?? [];
    const r = (JSON.parse(Rc) as TodoData).todos ?? [];
    return JSON.stringify({ todos: mergeById(l, r, manifest.baseIds[path]), version: 1 }, null, 2);
  }
  if (path === 'whiteboards.json') {
    const l = (JSON.parse(L) as WhiteboardsFile).whiteboards ?? [];
    const r = (JSON.parse(Rc) as WhiteboardsFile).whiteboards ?? [];
    return serializeWhiteboardsFile({ whiteboards: mergeById(l, r, manifest.baseIds[path]), version: 1 });
  }
  if (path === 'journal.json') {
    const l = (JSON.parse(L) as JournalFile).days ?? [];
    const r = (JSON.parse(Rc) as JournalFile).days ?? [];
    return serializeJournalFile({ days: mergeById(l, r, manifest.baseIds[path]), version: 1 });
  }
  if (path === 'projects.json' || path === 'tags.json') {
    // Whole-file last-write-wins.
    const l = JSON.parse(L) as { updated_at?: string };
    const r = JSON.parse(Rc) as { updated_at?: string };
    return time(r.updated_at) > time(l.updated_at) ? Rc : L;
  }
  if (TASK_NOTE_RE.test(path)) {
    // No reliable timestamp per task note; keep both texts rather than lose one.
    if (L.trim() === Rc.trim()) return Rc;
    return `${L.trimEnd()}\n\n---\n\n**Sync conflict — version from another device:**\n\n${Rc.trimStart()}`;
  }

  // Docs note: newer updated_at wins; on a genuine concurrent edit the losing
  // text is kept as a separate "(conflict …)" note.
  const ln = parseNoteFile(L, path);
  const rn = parseNoteFile(Rc, path);
  const remoteWins = time(rn.updated_at) > time(ln.updated_at);
  const loser = remoteWins ? ln : rn;
  const winner = remoteWins ? rn : ln;
  if (hadBase && loser.content.trim() !== winner.content.trim()) {
    const now = new Date().toISOString();
    const title = `${loser.title} (conflict ${CONFLICT_DATE()})`;
    conflictCopies.push({
      ...loser,
      id: uuid(),
      title,
      created_at: now,
      updated_at: now,
      file_path: derivedNotePath({ title, folder: loser.folder }),
    });
  }
  return remoteWins ? Rc : L;
}

async function applyTextChanges(
  db: IDBDatabase,
  cur: LocalState,
  changes: Map<string, Change>
): Promise<void> {
  if (changes.size === 0) return;

  // Docs notes
  const notesByPath = new Map(cur.notes.map((n) => [noteFilePath(n), n]));
  for (const [path, { content }] of changes) {
    if (!path.endsWith('.md') || TASK_NOTE_RE.test(path)) continue;
    const existing = notesByPath.get(path);
    if (content === null) {
      if (existing) await dbDelete(db, 'notes', existing.id);
      continue;
    }
    const note = parseNoteFile(content, path);
    if (existing && existing.id !== note.id) await dbDelete(db, 'notes', existing.id);
    await dbPut(db, 'notes', note);
  }

  // Todos (+ their inline task notes)
  const todosChange = changes.get('todos.json');
  const taskNoteChanges = [...changes].filter(([p]) => TASK_NOTE_RE.test(p));
  if (todosChange || taskNoteChanges.length) {
    const notesById = new Map<string, string | null>(cur.todos.map((t) => [t.id, t.notes ?? null]));
    for (const [p, { content }] of taskNoteChanges) notesById.set(p.match(TASK_NOTE_RE)![1], content);
    const list: Todo[] = todosChange?.content != null
      ? (JSON.parse(todosChange.content) as TodoData).todos ?? []
      : cur.todos;
    const tx = db.transaction('todos', 'readwrite');
    const store = tx.objectStore('todos');
    store.clear();
    for (const t of list) store.put(plain({ ...t, notes: notesById.get(t.id) ?? null }));
    await txDone(tx);
  }

  const json = (p: string) => {
    const c = changes.get(p)?.content;
    return c == null ? null : JSON.parse(c);
  };
  const projects = json('projects.json');
  if (projects) await metaSet(db, 'projects', { projects: projects.projects ?? [], version: 1, updated_at: projects.updated_at ?? '' });
  const tags = json('tags.json');
  if (tags) await metaSet(db, 'tags', { tags: tags.tags ?? [], version: 1, updated_at: tags.updated_at ?? '' });
  const boards = json('whiteboards.json');
  if (boards) await metaSet(db, 'whiteboards', { whiteboards: boards.whiteboards ?? [], version: 1 });
  const journal = json('journal.json');
  if (journal) await metaSet(db, 'journal', { days: journal.days ?? [], version: 1 });
}

// ── Sync entry point (serialised) ─────────────────────────────────────────────

let syncing: Promise<SyncResult> | null = null;

function syncNow(): Promise<SyncResult> {
  if (syncing) return Promise.resolve({ success: false, message: 'Sync already in progress.', timestamp: new Date().toISOString() });
  syncing = (async () => {
    const timestamp = new Date().toISOString();
    try {
      const db = await openDb();
      await ensureImageCache(db);
      const { up, down, del } = await runSync(db, loadSettings());
      localStorage.setItem(LAST_SYNC_KEY, timestamp);
      const message = up + down + del === 0 ? 'Already up to date.' : `Synced. ↑${up} ↓${down} ✕${del}`;
      return { success: true, message, timestamp };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err), timestamp };
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// First visit on a new device: pull everything before showing an empty app.
let initialPull: Promise<void> | null = null;

function ensureInitialPull(db: IDBDatabase): Promise<void> {
  if (!initialPull) {
    initialPull = (async () => {
      const settings = loadSettings();
      if (!ghFromSettings(settings)) return;
      const manifest = await metaGet<Manifest>(db, 'manifest');
      if (manifest && manifest.repo === settings.repo_url) return;
      await syncNow();
    })();
  }
  return initialPull;
}

async function ready(): Promise<IDBDatabase> {
  const db = await openDb();
  await ensureImageCache(db);
  await ensureInitialPull(db);
  return db;
}

// ── Backend implementation ────────────────────────────────────────────────────

export const idbBackend: ApiBackend = {
  getNotes: async () => {
    const db = await ready();
    const notes = await dbGetAll<Note>(db, 'notes');
    return notes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || time(b.updated_at) - time(a.updated_at));
  },

  getFolders: async () => {
    const db = await ready();
    const notes = await dbGetAll<Note>(db, 'notes');
    const folders = new Set<string>();
    for (const n of notes) {
      // Include ancestors so nested folders show up even when only leaves hold notes.
      const parts = (n.folder ?? '').split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    return [...folders].sort();
  },

  saveNote: async (partial) => {
    const db = await openDb();
    const now = new Date().toISOString();
    const note: Note = { id: '', folder: '', pinned: false, tags: [], created_at: now, updated_at: now, ...partial };
    if (!note.id) {
      note.id = uuid();
      note.created_at = now;
    }
    note.updated_at = now;
    // The file path follows title and folder, so renames and moves become a
    // delete + create on the next sync. Never take over another note's file.
    const others = (await dbGetAll<Note>(db, 'notes')).filter((n) => n.id !== note.id);
    const taken = new Set(others.map(noteFilePath));
    let path = derivedNotePath(note);
    if (taken.has(path)) path = derivedNotePath(note, `_${note.id.slice(0, 8)}`);
    note.file_path = path;
    await dbPut(db, 'notes', note);
    return note;
  },

  deleteNote: async (id) => {
    const db = await openDb();
    await dbDelete(db, 'notes', id);
  },

  getTodos: async () => {
    const db = await ready();
    return dbGetAll<Todo>(db, 'todos');
  },

  saveTodo: async (partial) => {
    const db = await openDb();
    const now = new Date().toISOString();
    const todo: Todo = {
      id: '',
      done: false,
      priority: 'none',
      due_date: null,
      tags: [],
      started_at: null,
      finished_at: null,
      work_sessions: [],
      notes: null,
      parent_id: null,
      created_at: now,
      updated_at: now,
      ...partial,
    };
    if (!todo.id) {
      todo.id = uuid();
      todo.created_at = now;
    }
    todo.updated_at = now;
    todo.note_path = todo.notes && todo.notes.trim() !== '' ? taskNotePath(todo.id) : null;
    await dbPut(db, 'todos', todo);
    return todo;
  },

  deleteTodo: async (id) => {
    const db = await openDb();
    // Subtasks go with their parent.
    const todos = await dbGetAll<Todo>(db, 'todos');
    const tx = db.transaction('todos', 'readwrite');
    for (const t of todos) if (t.id === id || t.parent_id === id) tx.objectStore('todos').delete(t.id);
    await txDone(tx);
  },

  getSettings: async () => loadSettings(),

  saveSettings: async (settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },

  getProjects: async () => (await loadProjectsFile(await ready())).projects,

  saveProjects: async (projects) => {
    await metaSet(await openDb(), 'projects', { projects, version: 1, updated_at: new Date().toISOString() });
  },

  getWhiteboards: async () => (await loadWhiteboardsFile(await ready())).whiteboards,

  saveWhiteboards: async (whiteboards) => {
    await metaSet(await openDb(), 'whiteboards', { whiteboards, version: 1 });
  },

  getJournal: async () => (await loadJournalFile(await ready())).days,

  saveJournal: async (days) => {
    await metaSet(await openDb(), 'journal', { days, version: 1 });
  },

  getTags: async () => (await loadTagsFile(await ready())).tags,

  saveTags: async (tags) => {
    await metaSet(await openDb(), 'tags', { tags, version: 1, updated_at: new Date().toISOString() });
  },

  syncNow,

  getLastSync: async () => localStorage.getItem(LAST_SYNC_KEY),

  getNoteHistory: async (path) => {
    const gh = ghFromSettings(loadSettings());
    if (!gh) return [];
    const res = await ghCheck(await ghFetch(gh, `commits?path=${encodeURIComponent(path)}&per_page=50`), 'history');
    const commits: CommitInfo[] = (await res.json()).map((c: { sha: string; commit: { author: { date: string }; message: string } }) => ({
      sha: c.sha,
      date: c.commit.author.date,
      message: c.commit.message,
    }));
    if (commits.length <= 1) return commits;
    // Every save rewrites updated_at in the frontmatter, so collapse commits
    // whose note body didn't actually change.
    const bodies = await Promise.all(
      commits.map((c) => ghFileAtRef(gh, path, c.sha).then((t) => stripFrontmatter(t).trim()).catch(() => null))
    );
    const result: CommitInfo[] = [];
    let prev: string | null = null;
    commits.forEach((c, i) => {
      const body = bodies[i];
      if (body != null && body !== prev) {
        prev = body;
        result.push(c);
      }
    });
    return result;
  },

  getNoteAtCommit: async (path, sha) => {
    const gh = ghFromSettings(loadSettings());
    if (!gh) return '';
    return ghFileAtRef(gh, path, sha);
  },

  saveImage: async (dir, blob) => {
    const db = await openDb();
    const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const safeExt = IMAGE_EXT_RE.test(`.${ext}`) ? ext : 'png';
    const path = `${dir}/image-${Date.now()}.${safeExt}`;
    await storeImage(db, path, blob);
    return path;
  },

  resolveImageUrl: (path) => urlByPath.get(path.replace(/^\/+/, '')) ?? path,

  unresolveImageUrl: (url) => pathByUrl.get(url) ?? url,

  readClipboardImage: async () => {
    // Webviews can't read clipboard images reliably on Wayland; the shell can.
    if (isTauri()) {
      const b64 = await invoke<string | null>('read_clipboard_image').catch(() => null);
      if (b64) return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType) return item.getType(imageType);
      }
    } catch {}
    return null;
  },
};
