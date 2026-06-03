import { v4 as uuid } from 'uuid';
import type { Note, Todo, Settings, SyncResult, CommitInfo } from '../types';
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

// ── GitHub API helpers ────────────────────────────────────────────────────────

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

function toBase64(str: string): string {
  // Encode UTF-8 string to base64 safely.
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

async function ghGet(
  owner: string,
  repo: string,
  token: string,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
  });
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
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      // SHA mismatch — another writer beat us. Fetch the latest SHA and retry.
      const fresh = await ghGet(owner, repo, token, path);
      currentSha = fresh?.sha;
      continue;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
    return;
  }
  throw new Error(`GitHub PUT failed after ${retries} attempts (persistent SHA conflict on ${path}).`);
}

async function syncToGitHub(settings: Settings, db: IDBDatabase): Promise<void> {
  const parsed = parseRepoUrl(settings.repo_url);
  if (!parsed || !settings.git_token) throw new Error('GitHub repo URL or token not configured.');
  const { owner, repo } = parsed;
  const token = settings.git_token;

  const [notes, todos] = await Promise.all([
    dbGetAll<Note>(db, 'notes'),
    dbGetAll<Todo>(db, 'todos'),
  ]);

  await Promise.all([
    (async () => {
      const existing = await ghGet(owner, repo, token, 'data/notes.json');
      await ghPutWithRetry(owner, repo, token, 'data/notes.json', JSON.stringify(notes, null, 2), existing?.sha);
    })(),
    (async () => {
      const existing = await ghGet(owner, repo, token, 'data/todos.json');
      await ghPutWithRetry(owner, repo, token, 'data/todos.json', JSON.stringify(todos, null, 2), existing?.sha);
    })(),
  ]);
}

async function pullFromGitHub(settings: Settings, db: IDBDatabase): Promise<boolean> {
  const parsed = parseRepoUrl(settings.repo_url);
  if (!parsed || !settings.git_token) return false;
  const { owner, repo } = parsed;
  const token = settings.git_token;

  const [notesFile, todosFile] = await Promise.all([
    ghGet(owner, repo, token, 'data/notes.json'),
    ghGet(owner, repo, token, 'data/todos.json'),
  ]);

  const remoteNotes: Note[] = notesFile ? JSON.parse(notesFile.content) : [];
  const remoteTodos: Todo[] = todosFile ? JSON.parse(todosFile.content) : [];

  // Merge: remote wins for items not in local, local wins for items modified more recently.
  const localNotes = await dbGetAll<Note>(db, 'notes');
  const localTodos = await dbGetAll<Todo>(db, 'todos');

  const mergedNotes = mergeByUpdated(localNotes, remoteNotes);
  const mergedTodos = mergeByUpdated(localTodos, remoteTodos);

  await Promise.all([
    dbPutMany(db, 'notes', mergedNotes),
    dbPutMany(db, 'todos', mergedTodos),
  ]);
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

  syncNow: async (): Promise<SyncResult> => {
    if (syncLock) return { success: false, message: 'Sync already in progress.', timestamp: new Date().toISOString() };
    syncLock = true;
    const settings = loadSettings();
    const timestamp = new Date().toISOString();
    try {
      const db = await openDb();
      await syncToGitHub(settings, db);
      await pullFromGitHub(settings, db);
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
