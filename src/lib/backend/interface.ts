import type { Note, Todo, Settings, SyncResult, CommitInfo, Project, Whiteboard, Tag, DayEntry } from '../types';

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

  getJournal(): Promise<DayEntry[]>;
  saveJournal(entries: DayEntry[]): Promise<void>;

  getTags(): Promise<Tag[]>;
  saveTags(tags: Tag[]): Promise<void>;

  syncNow(): Promise<SyncResult>;
  getLastSync(): Promise<string | null>;

  getNoteHistory(path: string): Promise<CommitInfo[]>;
  getNoteAtCommit(path: string, sha: string): Promise<string>;

  /** Stores an image under `dir` (repo-relative) and returns its repo-relative path. */
  saveImage(dir: string, blob: Blob): Promise<string>;
  /** Repo-relative image path → URL the webview can display (unknown paths pass through). */
  resolveImageUrl(path: string): string;
  /** Inverse of resolveImageUrl, for turning displayed markdown back into stored markdown. */
  unresolveImageUrl(url: string): string;
  /** Reads an image from the native/system clipboard; null if unavailable. */
  readClipboardImage(): Promise<Blob | null>;
}
