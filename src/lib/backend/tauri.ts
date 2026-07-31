import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { Note, Todo, Settings, SyncResult, CommitInfo, Project, Whiteboard } from '../types';
import type { ApiBackend } from './interface';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const tauriBackend: ApiBackend = {
  getNotes: () => invoke<Note[]>('get_notes'),
  getFolders: () => invoke<string[]>('get_folders'),
  saveNote: (note) =>
    invoke<Note>('save_note', { note: { id: '', pinned: false, tags: [], folder: '', ...note } }),
  deleteNote: (id) => invoke<void>('delete_note', { id }),

  getTodos: () => invoke<Todo[]>('get_todos'),
  saveTodo: (todo) =>
    invoke<Todo>('save_todo', {
      todo: {
        id: '', done: false, priority: 'none', due_date: null, tags: [],
        started_at: null, finished_at: null, work_sessions: [], notes: null,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...todo,
      },
    }),
  deleteTodo: (id) => invoke<void>('delete_todo', { id }),

  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings) => invoke<void>('save_settings', { settings }),

  getProjects: () => invoke<Project[]>('get_projects'),
  saveProjects: (projects) => invoke<void>('save_projects', { projects }),

  getWhiteboards: () => invoke<Whiteboard[]>('get_whiteboards'),
  saveWhiteboards: (whiteboards) => invoke<void>('save_whiteboards', { whiteboards }),

  syncNow: () => invoke<SyncResult>('sync_now'),
  getLastSync: () => invoke<string | null>('get_last_sync'),

  getNoteHistory: (path) => invoke<CommitInfo[]>('get_note_history', { path }),
  getNoteAtCommit: (path, sha) => invoke<string>('get_note_at_commit', { path, sha }),

  saveTaskNoteImage: async (id, blob) => {
    const dataUrl = await blobToDataUrl(blob);
    const dataB64 = dataUrl.split(',')[1];
    const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    return invoke<string>('save_task_note_image', { id, dataB64, ext });
  },

  resolveImageUrl: (path, repoPath) => {
    if (!repoPath || path.startsWith('data:') || path.startsWith('http')) return path;
    const absPath = path.startsWith('/') ? path : `${repoPath}/${path}`;
    return convertFileSrc(absPath);
  },

  readClipboardImage: async () => {
    const b64 = await invoke<string | null>('read_clipboard_image');
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  },
};
