import { writable, derived } from 'svelte/store';
import type { Note, Todo, Settings, SyncResult, View } from './types';

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
export const theme = writable<'system' | 'light' | 'dark'>('system');
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

export const pendingTodos = derived(todos, ($todos) => $todos.filter((t) => !t.done));
export const doneTodos = derived(todos, ($todos) => $todos.filter((t) => t.done));
export const pinnedNotes = derived(notes, ($notes) => $notes.filter((n) => n.pinned));
export const recentNotes = derived(notes, ($notes) =>
  [...$notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
);
