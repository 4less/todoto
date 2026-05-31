import { invoke } from '@tauri-apps/api/core';
import type { Note, Todo, Settings, SyncResult, CommitInfo } from './types';

export async function saveTaskNoteImage(id: string, blob: Blob): Promise<string> {
  // FileReader is the only reliable way to get base64 from large blobs without
  // O(n²) string concat or call-stack overflow from spread operators.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const dataB64 = dataUrl.split(',')[1];
  // Derive extension from MIME type (e.g. "image/png" → "png").
  const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  return invoke<string>('save_task_note_image', { id, dataB64, ext });
}

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
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...todo,
      },
    }),
  deleteTodo: (id: string) => invoke<void>('delete_todo', { id }),

  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),

  syncNow: () => invoke<SyncResult>('sync_now'),
  getLastSync: () => invoke<string | null>('get_last_sync'),

  getNoteHistory: (path: string) => invoke<CommitInfo[]>('get_note_history', { path }),
  getNoteAtCommit: (path: string, sha: string) => invoke<string>('get_note_at_commit', { path, sha }),
};
