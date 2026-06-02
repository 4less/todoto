import { writable, derived } from 'svelte/store';
import type { Note, Todo, Settings, SyncResult, View } from './types';

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
export const taskFilterPriority = localStore<'' | 'high' | 'medium' | 'low'>('todoto-filter-priority', '');
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
