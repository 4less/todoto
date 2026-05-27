import { invoke } from '@tauri-apps/api/core';
import type { Note, Todo, Settings, SyncResult } from './types';

export const api = {
  getNotes: () => invoke<Note[]>('get_notes'),
  getFolders: () => invoke<string[]>('get_folders'),
  saveNote: (note: Partial<Note> & { title: string; content: string }) =>
    invoke<Note>('save_note', { note: { id: '', pinned: false, tags: [], folder: '', ...note } }),
  deleteNote: (id: string) => invoke<void>('delete_note', { id }),

  getTodos: () => invoke<Todo[]>('get_todos'),
  saveTodo: (todo: Partial<Todo> & { title: string }) =>
    invoke<Todo>('save_todo', {
      todo: {
        id: '', done: false, priority: 'medium', due_date: null, tags: [],
        started_at: null, finished_at: null, work_sessions: [], notes: null,
        ...todo,
      },
    }),
  deleteTodo: (id: string) => invoke<void>('delete_todo', { id }),

  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),

  syncNow: () => invoke<SyncResult>('sync_now'),
  getLastSync: () => invoke<string | null>('get_last_sync'),
};
