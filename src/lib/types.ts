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
  priority: 'none' | 'low' | 'medium' | 'high';
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
  order?: number | null;
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

// ── Whiteboard ───────────────────────────────────────────────────────────────
// A free-form canvas of sticky notes and rectangles, optionally linked by arrows.
// Coordinates are in board space (unzoomed); the view applies pan/zoom on top.

export type BoardNodeKind = 'sticky' | 'rect';

export interface BoardNode {
  id: string;
  kind: BoardNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string; // key into BOARD_COLORS
}

export interface BoardEdge {
  id: string;
  from: string; // BoardNode id
  to: string;   // BoardNode id
}

export interface Whiteboard {
  id: string;
  name: string;
  tags: string[];
  nodes: BoardNode[];
  edges: BoardEdge[];
  created_at: string;
  updated_at: string;
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

export type View = 'home' | 'tasks' | 'today' | 'docs' | 'search';
