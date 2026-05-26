export interface Note {
  id: string;
  title: string;
  content: string;
  folder: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  tags: string[];
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface Settings {
  repo_path: string;
  repo_url: string;
  git_username: string;
  git_email: string;
  git_token: string;
  auto_sync: boolean;
  sync_interval_seconds: number;
}

export interface SyncResult {
  success: boolean;
  message: string;
  timestamp: string;
}

export type View = 'home' | 'tasks' | 'docs' | 'search';
