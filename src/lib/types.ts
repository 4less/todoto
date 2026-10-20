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
  // Heading (ProjectGroup) this top-level todo sits under. Subtasks don't use
  // it — they belong to their parent's group (see groupOf in $lib/groups).
  group_id?: string | null;
}

// A user-defined tag-based shortcut shown in the sidebar/drawer.
// Clicking one jumps to the Tasks view filtered to its tag(s).
export interface Project {
  id: string;
  name: string;
  tags: string[];
  icon: string;  // key into PROJECT_ICONS
  color: string; // hex colour
  groups?: ProjectGroup[];
}

// A heading inside a project that groups todos without being a todo itself.
// Membership is stored once, on the todo (Todo.group_id); a group's members
// are derived from that (groupMembers in $lib/groups), so the two can never
// disagree — even when projects.json and todos.json sync from different devices.
export interface ProjectGroup {
  id: string;
  name: string;
  order: number;
}

// ── Tags ─────────────────────────────────────────────────────────────────────
// A curated tag. Items store the canonical spelling; `aliases` are other
// spellings the user has manually declared to mean the same thing. Case and
// separator differences ("ProtalDev" / "protal_dev") collapse automatically via
// tagKey() and never need an alias — aliases are for genuinely different words
// ("k8s" → "kubernetes") and typos, which are always a deliberate merge.
export interface Tag {
  id: string;
  canonical: string;
  aliases: string[];
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

// ── Daily journal ────────────────────────────────────────────────────────────
// One entry per calendar day: the morning plan (which todos, with an optional
// goal each) and the evening review of it. Todos are referenced by id only, so
// a deleted todo just drops out of the review.

export interface DayPlanItem {
  todo_id: string;
  goal: string;     // what the user wanted to achieve (morning)
  progress: string; // what actually happened (evening)
}

export interface DayEntry {
  id: string; // local calendar day, YYYY-MM-DD — doubles as the merge key
  items: DayPlanItem[];
  planned_at: string | null;  // morning dialog last saved
  reviewed_at: string | null; // evening dialog last saved
  focus: number;        // 0 = not rated, 1–5
  productivity: number; // 0 = not rated, 1–5
  what_happened: string;
  prepare_tomorrow: string;
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

export type View = 'home' | 'tasks' | 'today' | 'journal' | 'docs' | 'search';
