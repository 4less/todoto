import type { Note, Todo, Settings, SyncResult, CommitInfo, Project, Whiteboard } from '../types';

export interface ApiBackend {
  getNotes(): Promise<Note[]>;
  getFolders(): Promise<string[]>;
  saveNote(note: Partial<Note> & { title: string; content: string }): Promise<Note>;
  deleteNote(id: string): Promise<void>;

  getTodos(): Promise<Todo[]>;
  saveTodo(todo: Partial<Todo> & { title: string }): Promise<Todo>;
  deleteTodo(id: string): Promise<void>;

  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;

  getProjects(): Promise<Project[]>;
  saveProjects(projects: Project[]): Promise<void>;

  getWhiteboards(): Promise<Whiteboard[]>;
  saveWhiteboards(whiteboards: Whiteboard[]): Promise<void>;

  syncNow(): Promise<SyncResult>;
  getLastSync(): Promise<string | null>;

  getNoteHistory(path: string): Promise<CommitInfo[]>;
  getNoteAtCommit(path: string, sha: string): Promise<string>;

  /** Saves image and returns the URL/path to embed in markdown. */
  saveTaskNoteImage(id: string, blob: Blob): Promise<string>;
  /** Converts a stored markdown image path to a displayable URL. */
  resolveImageUrl(path: string, repoPath: string): string;
  /** Reads an image from the native/system clipboard; null if unavailable. */
  readClipboardImage(): Promise<Blob | null>;
}
