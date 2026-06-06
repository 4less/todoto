import { writable, derived } from 'svelte/store';
import type { Note, Todo, Settings, SyncResult, View, Project } from './types';

function localStore<T>(key: string, initial: T) {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  const store = writable<T>(stored !== null ? JSON.parse(stored) : initial);
  store.subscribe((v) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(v));
  });
  return store;
}

export const notes = writable<Note[]>([]);
export const todos = writable<Todo[]>([]);
export const diskFolders = writable<string[]>([]);
export const settings = writable<Settings>({
  repo_path: '',
  repo_url: '',
  git_username: '',
  git_email: '',
  git_token: '',
  auto_sync: true,
  sync_interval_seconds: 30,
});

// User-defined project shortcuts (synced via projects.json). Loaded from the backend.
export const projects = writable<Project[]>([]);
// Which project filter is currently applied — device-local, drives nav highlight.
export const activeProjectId = localStore<string | null>('todoto-active-project', null);

// The currently-applied project (or null). Its tags act as a hard prefilter on the
// Tasks view: only tasks carrying at least one of these tags are shown, the tags are
// hidden from the page filter/group chips, and new tasks inherit them automatically.
export const activeProject = derived(
  [projects, activeProjectId],
  ([$projects, $id]) => ($id ? $projects.find((p) => p.id === $id) ?? null : null)
);
export const activeProjectTags = derived(activeProject, ($p) => $p?.tags ?? []);

// Set to a todo id to ask the Tasks view to open that task in focus mode. The
// Tasks view consumes and clears it. Lets the sidebar jump back to the running task.
export const focusRequest = writable<string | null>(null);

export const activeView = writable<View>('home');
export const theme = writable<'system' | 'light' | 'dark' | 'midnight' | 'forest'>('system');
export const activeTimers = writable<Map<string, number>>(new Map());
export const selectedNoteId = writable<string | null>(null);
export const showSettings = writable(false);

export interface SyncState {
  syncing: boolean;
  lastResult: SyncResult | null;
  lastSync: string | null;
}
export const syncState = writable<SyncState>({
  syncing: false,
  lastResult: null,
  lastSync: null,
});

export const taskFilterStatus = localStore<'all' | 'pending' | 'done'>('todoto-filter-status', 'all');
export const taskFilterPriority = localStore<'' | 'none' | 'high' | 'medium' | 'low'>('todoto-filter-priority', '');
export const taskFilterTag = localStore<string>('todoto-filter-tag', '');
export const taskFilterDuePeriod = localStore<'' | 'overdue' | 'today' | 'week' | 'month'>('todoto-filter-due', '');
export const taskFilterGroupByTags = localStore<string[]>('todoto-filter-group-tags', []);
export const taskFilterSearch = localStore<string>('todoto-filter-search', '');
export const taskFilterShowOther = localStore<boolean>('todoto-filter-show-other', false);
export const taskFilterHideUngrouped = localStore<boolean>('todoto-filter-hide-ungrouped', false);

export const pendingTodos = derived(todos, ($todos) => $todos.filter((t) => !t.done));
export const doneTodos = derived(todos, ($todos) => $todos.filter((t) => t.done));
export const pinnedNotes = derived(notes, ($notes) => $notes.filter((n) => n.pinned));
export const recentNotes = derived(notes, ($notes) =>
  [...$notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
);
