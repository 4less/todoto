export interface Note {
  id: string;
  title: string;
  content: string;
  folder: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  tags: string[];
  file_path?: string;
}

export interface WorkSession {
  start: string; // ISO datetime
  end: string;   // ISO datetime
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
  started_at: string | null;
  finished_at: string | null;
  work_sessions: WorkSession[];
  notes?: string | null;
  note_path?: string | null;
  parent_id?: string | null;
}

// A user-defined tag-based shortcut shown in the sidebar/drawer.
// Clicking one jumps to the Tasks view filtered to its tag(s).
export interface Project {
  id: string;
  name: string;
  tags: string[];
  icon: string;  // key into PROJECT_ICONS
  color: string; // hex colour
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

export interface CommitInfo {
  sha: string;
  date: string;    // ISO 8601
  message: string;
}

export type View = 'home' | 'tasks' | 'docs' | 'search';
