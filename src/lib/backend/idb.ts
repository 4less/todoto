import { v4 as uuid } from 'uuid';
import type { Note, Todo, Settings, SyncResult, CommitInfo, Project } from '../types';
import type { ApiBackend } from './interface';

// ── IndexedDB ─────────────────────────────────────────────────────────────────

const DB_NAME = 'todoto';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('todos')) db.createObjectStore('todos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'path' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function dbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbPutMany(db: IDBDatabase, store: string, items: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    for (const item of items) s.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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

// ── Projects (synced via projects.json, whole-file last-write-wins) ───────────

const PROJECTS_KEY = 'todoto-idb-projects';

interface ProjectsFile { projects: Project[]; version: number; updated_at: string; }

function loadProjectsFile(): ProjectsFile {
  try {
    const s = localStorage.getItem(PROJECTS_KEY);
    if (s) {
      const parsed = JSON.parse(s);
      return { projects: parsed.projects ?? [], version: 1, updated_at: parsed.updated_at ?? '' };
    }
  } catch {}
  return { projects: [], version: 1, updated_at: '' };
}

function writeProjectsFile(file: ProjectsFile): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(file));
}

function serializeProjectsFile(file: ProjectsFile): string {
  return JSON.stringify({ projects: file.projects, version: 1, updated_at: file.updated_at }, null, 2);
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

function toBase64(str: string): string {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
}

function fromBase64(b64: string): string {
  return decodeURIComponent(
    Array.from(atob(b64.replace(/\n/g, '')))
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
  );
}

function encodePathSegments(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)).join('/');
}

// Computes the same SHA git uses for a blob: SHA1("blob <byteLen>\0<content>").
// Used to skip pushing files whose content hasn't changed.
async function blobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ghGet(
  owner: string,
  repo: string,
  token: string,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodePathSegments(path)}`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { content: fromBase64(data.content), sha: data.sha };
}

async function ghPutWithRetry(
  owner: string,
  repo: string,
  token: string,
  path: string,
  content: string,
  sha?: string,
  retries = 3
): Promise<void> {
  let currentSha = sha;
  for (let attempt = 0; attempt < retries; attempt++) {
    const body: Record<string, string> = { message: 'todoto sync', content: toBase64(content) };
    if (currentSha) body.sha = currentSha;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodePathSegments(path)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (res.status === 409) {
      const fresh = await ghGet(owner, repo, token, path);
      currentSha = fresh?.sha;
      continue;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
    return;
  }
  throw new Error(`GitHub PUT failed after ${retries} attempts (persistent SHA conflict on ${path}).`);
}

// Returns path → sha for all tracked files (.md + todos.json).
async function ghListTree(
  owner: string,
  repo: string,
  token: string
): Promise<Map<string, string>> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  // 404 = repo not found; 409 = repo exists but empty (no commits yet)
  if (res.status === 404 || res.status === 409) return new Map();
  if (!res.ok) throw new Error(`GitHub tree: ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const map = new Map<string, string>();
  for (const item of data.tree) {
    if (item.type === 'blob' && (item.path.endsWith('.md') || item.path === 'todos.json' || item.path === 'projects.json')) {
      map.set(item.path, item.sha);
    }
  }
  return map;
}

// ── Note file format (matches Rust backend exactly) ──────────────────────────

function sanitizeFilename(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function noteFilePath(note: Note): string {
  // Use the stored file_path if we pulled this note from GitHub,
  // otherwise derive from folder + title (same logic as the Rust backend).
  if (note.file_path) return note.file_path;
  const name = `${sanitizeFilename(note.title)}.md`;
  return note.folder ? `${note.folder}/${name}` : name;
}

function serializeNote(note: Note): string {
  const tags = note.tags.join(', ');
  return `---\nid: ${note.id}\ntitle: ${note.title}\npinned: ${note.pinned}\ntags: ${tags}\ncreated_at: ${note.created_at}\nupdated_at: ${note.updated_at}\n---\n${note.content}`;
}

function parseNoteFile(content: string, filePath: string): Note | null {
  let fmStr = '';
  let body = content;

  if (content.startsWith('---\n')) {
    const rest = content.slice(4);
    const endIdx = rest.indexOf('\n---\n');
    if (endIdx !== -1) {
      fmStr = rest.slice(0, endIdx);
      body = rest.slice(endIdx + 5);
    }
  }

  let id = '', title = '', pinned = false, tags: string[] = [];
  let created_at = new Date().toISOString();
  let updated_at = new Date().toISOString();

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

// ── Todos format (matches Rust backend: { todos: [...], version: 1 }) ─────────

interface TodoData { todos: Todo[]; version: number; }

function serializeTodos(todos: Todo[]): string {
  // Strip inline notes (they live in task-notes/{id}.md), keep note_path.
  const stripped = todos.map((t) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { notes: _notes, ...rest } = t;
    if (t.notes && !rest.note_path) rest.note_path = `task-notes/${t.id}.md`;
    return rest;
  });
  return JSON.stringify({ todos: stripped, version: 1 }, null, 2);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncToGitHub(settings: Settings, db: IDBDatabase): Promise<void> {
  const parsed = parseRepoUrl(settings.repo_url);
  if (!parsed || !settings.git_token) throw new Error('GitHub repo URL or token not configured.');
  const { owner, repo } = parsed;
  const token = settings.git_token;

  const [notes, todos] = await Promise.all([
    dbGetAll<Note>(db, 'notes'),
    dbGetAll<Todo>(db, 'todos'),
  ]);

  // Fetch the current tree once so we have SHAs for all existing files.
  const tree = await ghListTree(owner, repo, token);

  // Build list of files to push, skipping ones whose content hasn't changed.
  const filesToPush: Array<{ path: string; content: string; sha: string | undefined }> = [];

  const addIfChanged = async (path: string, content: string) => {
    const remoteSha = tree.get(path);
    if (remoteSha) {
      const localSha = await blobSha(content);
      if (localSha === remoteSha) return; // unchanged — skip
    }
    filesToPush.push({ path, content, sha: remoteSha });
  };

  await addIfChanged('todos.json', serializeTodos(todos));
  await addIfChanged('projects.json', serializeProjectsFile(loadProjectsFile()));

  for (const todo of todos) {
    if (todo.notes != null && todo.notes.trim() !== '') {
      await addIfChanged(`task-notes/${todo.id}.md`, todo.notes);
    }
  }

  for (const note of notes) {
    await addIfChanged(noteFilePath(note), serializeNote(note));
  }

  // Push sequentially — concurrent commits to the same repo cause 409 races.
  for (const { path, content, sha } of filesToPush) {
    await ghPutWithRetry(owner, repo, token, path, content, sha);
  }
}

async function pullFromGitHub(settings: Settings, db: IDBDatabase): Promise<boolean> {
  const parsed = parseRepoUrl(settings.repo_url);
  if (!parsed || !settings.git_token) return false;
  const { owner, repo } = parsed;
  const token = settings.git_token;

  const tree = await ghListTree(owner, repo, token);
  if (tree.size === 0) return false;

  // Fetch all tracked files in parallel.
  const notePaths = [...tree.keys()].filter(
    (p) => p.endsWith('.md') && !p.startsWith('task-notes/')
  );
  const taskNotePaths = [...tree.keys()].filter((p) => p.startsWith('task-notes/'));

  const [todosRaw, ...noteResults] = await Promise.all([
    tree.has('todos.json') ? ghGet(owner, repo, token, 'todos.json') : Promise.resolve(null),
    ...notePaths.map((p) => ghGet(owner, repo, token, p)),
  ]);

  const taskNoteMap = new Map<string, string>();
  await Promise.all(
    taskNotePaths.map(async (p) => {
      const r = await ghGet(owner, repo, token, p);
      if (r) {
        // path is task-notes/{id}.md → extract id
        const id = p.slice('task-notes/'.length, -'.md'.length);
        taskNoteMap.set(id, r.content);
      }
    })
  );

  // Parse todos
  let remoteTodos: Todo[] = [];
  if (todosRaw) {
    const data: TodoData = JSON.parse(todosRaw.content);
    remoteTodos = (data.todos ?? []).map((t) => ({
      ...t,
      notes: taskNoteMap.get(t.id) ?? t.notes ?? null,
    }));
  }

  // Parse notes
  const remoteNotes: Note[] = noteResults
    .map((r, i) => (r ? parseNoteFile(r.content, notePaths[i]) : null))
    .filter((n): n is Note => n !== null);

  // Merge with local (newer updated_at wins)
  const [localNotes, localTodos] = await Promise.all([
    dbGetAll<Note>(db, 'notes'),
    dbGetAll<Todo>(db, 'todos'),
  ]);

  await Promise.all([
    dbPutMany(db, 'notes', mergeByUpdated(localNotes, remoteNotes)),
    dbPutMany(db, 'todos', mergeByUpdated(localTodos, remoteTodos)),
  ]);

  // Projects: whole-file last-write-wins. If the remote file is newer, adopt it
  // locally so the subsequent push sees identical content and skips it.
  if (tree.has('projects.json')) {
    const raw = await ghGet(owner, repo, token, 'projects.json');
    if (raw) {
      try {
        const remote = JSON.parse(raw.content) as ProjectsFile;
        const local = loadProjectsFile();
        if ((remote.updated_at ?? '') > (local.updated_at ?? '')) {
          writeProjectsFile({ projects: remote.projects ?? [], version: 1, updated_at: remote.updated_at ?? '' });
        }
      } catch {}
    }
  }

  return true;
}

function mergeByUpdated<T extends { id: string; updated_at: string }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of remote) map.set(item.id, item);
  for (const item of local) {
    const r = map.get(item.id);
    if (!r || item.updated_at > r.updated_at) map.set(item.id, item);
  }
  return [...map.values()];
}

// ── Initial pull (first visit) ────────────────────────────────────────────────

let initialPullDone = false;
let syncLock = false;

async function ensureInitialPull(db: IDBDatabase): Promise<void> {
  if (initialPullDone) return;
  initialPullDone = true;
  const settings = loadSettings();
  if (!settings.repo_url || !settings.git_token) return;
  const localNotes = await dbGetAll<Note>(db, 'notes');
  const localTodos = await dbGetAll<Todo>(db, 'todos');
  if (localNotes.length === 0 && localTodos.length === 0) {
    await pullFromGitHub(settings, db).catch(() => {});
  }
}

// ── Backend implementation ────────────────────────────────────────────────────

export const idbBackend: ApiBackend = {
  getNotes: async () => {
    const db = await openDb();
    await ensureInitialPull(db);
    return dbGetAll<Note>(db, 'notes');
  },

  getFolders: async () => {
    const db = await openDb();
    const notes = await dbGetAll<Note>(db, 'notes');
    const folders = new Set<string>();
    for (const n of notes) if (n.folder) folders.add(n.folder);
    return [...folders].sort();
  },

  saveNote: async (partial) => {
    const db = await openDb();
    const now = new Date().toISOString();
    const note: Note = {
      id: uuid(),
      folder: '',
      pinned: false,
      tags: [],
      created_at: now,
      updated_at: now,
      ...partial,
    };
    if (!note.id) note.id = uuid();
    note.updated_at = now;
    await dbPut(db, 'notes', note);
    return note;
  },

  deleteNote: async (id) => {
    const db = await openDb();
    await dbDelete(db, 'notes', id);
  },

  getTodos: async () => {
    const db = await openDb();
    await ensureInitialPull(db);
    return dbGetAll<Todo>(db, 'todos');
  },

  saveTodo: async (partial) => {
    const db = await openDb();
    const now = new Date().toISOString();
    const todo: Todo = {
      id: uuid(),
      done: false,
      priority: 'medium',
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
    if (!todo.id) todo.id = uuid();
    todo.updated_at = now;
    await dbPut(db, 'todos', todo);
    return todo;
  },

  deleteTodo: async (id) => {
    const db = await openDb();
    await dbDelete(db, 'todos', id);
  },

  getSettings: async () => loadSettings(),

  saveSettings: async (settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },

  getProjects: async () => loadProjectsFile().projects,

  saveProjects: async (projects) => {
    writeProjectsFile({ projects, version: 1, updated_at: new Date().toISOString() });
  },

  syncNow: async (): Promise<SyncResult> => {
    if (syncLock) return { success: false, message: 'Sync already in progress.', timestamp: new Date().toISOString() };
    syncLock = true;
    const settings = loadSettings();
    const timestamp = new Date().toISOString();
    try {
      const db = await openDb();
      await pullFromGitHub(settings, db);
      await syncToGitHub(settings, db);
      localStorage.setItem(LAST_SYNC_KEY, timestamp);
      return { success: true, message: 'Synced with GitHub.', timestamp };
    } catch (err) {
      return { success: false, message: String(err), timestamp };
    } finally {
      syncLock = false;
    }
  },

  getLastSync: async () => localStorage.getItem(LAST_SYNC_KEY),

  getNoteHistory: async () => [] as CommitInfo[],
  getNoteAtCommit: async () => '',

  saveTaskNoteImage: async (id, blob) => {
    const db = await openDb();
    const dataUrl = await blobToDataUrl(blob);
    const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    const path = `notes/images/${id}.${ext}`;
    await dbPut(db, 'images', { path, data: dataUrl });
    // Return the data URL so it embeds directly in markdown.
    return dataUrl;
  },

  // In browser mode saveTaskNoteImage returns a data URL, so no conversion needed.
  resolveImageUrl: (url, _repoPath) => url,

  readClipboardImage: async () => {
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
