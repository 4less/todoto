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
// Which project filter is currently applied — drives the nav highlight. Not
// persisted: the view always returns to Home on startup, so a remembered project
// id would highlight a project while Home is actually shown.
export const activeProjectId = writable<string | null>(null);

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

// Bumped every time a project is applied from the sidebar. The Tasks view watches
// it to leave focus mode and show the full list — even when the same project that
// is already active is re-clicked (which wouldn't change activeProjectId).
export const projectApplyTick = writable(0);

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
// Whether tags/labels are shown on todo rows in their unselected/inactive state.
// A clicked or selected task always shows its tags regardless of this setting.
export const taskShowTags = localStore<boolean>('todoto-show-tags', true);
// Hairline dividers between todo rows. Off gives a cleaner, borderless list.
export const taskShowDividers = localStore<boolean>('todoto-show-dividers', true);

// Today's hand-picked workload: a date + the ids of todos selected for that day.
// Todos are referenced by id only — they don't know they're picked. A stored date
// other than today means the selection is stale and treated as empty.
export const todaySelection = localStore<{ date: string; ids: string[] }>('todoto-today', { date: '', ids: [] });

// When true, the Tasks view is filtered to today's hand-picked workload. A view
// filter (not a separate page) so the task cards/behaviour are identical.
export const taskFilterToday = writable(false);

/** Local calendar day as YYYY-MM-DD — the key that scopes the daily selection. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Id of the todo currently being dragged (null when not dragging). Shared so the
// sidebar "Today" nav item can act as a drop target for pinning to today.
export const draggingTodoId = writable<string | null>(null);
// True while a drag is hovering the sidebar "Today" item (drives its highlight,
// since :hover isn't reliable during a mouse-button-held drag in some webviews).
export const dragOverToday = writable(false);

/** Add a todo id to today's selection (scoped to the current day). */
export function pinTodoToToday(id: string) {
  const key = todayKey();
  todaySelection.update((sel) => {
    const ids = sel.date === key ? [...sel.ids] : [];
    if (!ids.includes(id)) ids.push(id);
    return { date: key, ids };
  });
}

export const pendingTodos = derived(todos, ($todos) => $todos.filter((t) => !t.done));
export const doneTodos = derived(todos, ($todos) => $todos.filter((t) => t.done));
export const pinnedNotes = derived(notes, ($notes) => $notes.filter((n) => n.pinned));
export const recentNotes = derived(notes, ($notes) =>
  [...$notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
);
