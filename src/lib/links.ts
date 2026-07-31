import type { Todo, Note, Whiteboard } from './types';
import { activeView, focusRequest, selectedNoteId, openWhiteboardId } from './stores';

// Cross-references between the fundamental items.
//
// Each linked resource is its own `@kind:id` token, so a text can carry any
// number of them and each resolves independently. The id is the resource's own
// uuid — links survive renames, and nothing has to be rewritten when a title
// changes.
//
// The `kind:` prefix keeps the token clear of the existing `@YYYY-MM-DD` due
// date annotation (see taskAnnotations.ts), which would otherwise share the
// sigil.

export type LinkKind = 'todo' | 'note' | 'board';

const PREFIX: Record<LinkKind, string> = { todo: 't', note: 'n', board: 'b' };
const KIND_OF: Record<string, LinkKind> = { t: 'todo', n: 'note', b: 'board' };

/**
 * Matches a stored link token. The id charset is deliberately broad rather than
 * uuid-shaped — ids come from several places, and a link that silently stops
 * rendering because an id isn't hex would be near-impossible to spot.
 */
export const LINK_RE = /@([tnb]):([A-Za-z0-9][A-Za-z0-9_-]{1,63})/g;

export function linkToken(kind: LinkKind, id: string): string {
  return `@${PREFIX[kind]}:${id}`;
}

export interface ParsedLink {
  kind: LinkKind;
  id: string;
  token: string;
  start: number;
  end: number;
}

/** Every link token in a string, in order. */
export function parseLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  if (!text) return out;
  const re = new RegExp(LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      kind: KIND_OF[m[1]],
      id: m[2],
      token: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export interface LinkTarget {
  kind: LinkKind;
  id: string;
  title: string;
  /** Extra context for the picker: folder, tags, done state… */
  subtitle: string;
  tags: string[];
  /** Searchable body text. */
  content: string;
  /** True when the target no longer exists. */
  missing?: boolean;
}

export function todoTarget(t: Todo): LinkTarget {
  return {
    kind: 'todo',
    id: t.id,
    title: t.title,
    subtitle: t.done ? 'done' : (t.due_date ? `due ${t.due_date}` : t.priority !== 'none' ? t.priority : ''),
    tags: t.tags,
    content: t.notes ?? '',
  };
}

export function noteTarget(n: Note): LinkTarget {
  return {
    kind: 'note',
    id: n.id,
    title: n.title || 'Untitled',
    subtitle: n.folder || '',
    tags: n.tags,
    content: n.content ?? '',
  };
}

export function boardTarget(b: Whiteboard): LinkTarget {
  return {
    kind: 'board',
    id: b.id,
    title: b.name,
    subtitle: `${b.nodes.length} item${b.nodes.length === 1 ? '' : 's'}`,
    tags: b.tags,
    // A board's "content" is the text written on its shapes.
    content: b.nodes.map((n) => n.text).filter(Boolean).join(' \n'),
  };
}

/** Every linkable resource, as a flat list. */
export function allTargets(todos: Todo[], notes: Note[], boards: Whiteboard[]): LinkTarget[] {
  return [...todos.map(todoTarget), ...notes.map(noteTarget), ...boards.map(boardTarget)];
}

/** Looks up one link's target, or a placeholder when it's been deleted. */
export function resolveLink(
  link: { kind: LinkKind; id: string },
  todos: Todo[],
  notes: Note[],
  boards: Whiteboard[]
): LinkTarget {
  if (link.kind === 'todo') {
    const t = todos.find((x) => x.id === link.id);
    if (t) return todoTarget(t);
  } else if (link.kind === 'note') {
    const n = notes.find((x) => x.id === link.id);
    if (n) return noteTarget(n);
  } else {
    const b = boards.find((x) => x.id === link.id);
    if (b) return boardTarget(b);
  }
  return { kind: link.kind, id: link.id, title: 'Missing', subtitle: '', tags: [], content: '', missing: true };
}

/** Navigates to a linked resource. Shared by every surface that renders links. */
export function openLinkTarget(kind: LinkKind, id: string) {
  if (kind === 'todo') {
    openWhiteboardId.set(null);
    activeView.set('tasks');
    focusRequest.set(id);
  } else if (kind === 'note') {
    openWhiteboardId.set(null);
    selectedNoteId.set(id);
    activeView.set('docs');
  } else {
    openWhiteboardId.set(id);
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

export type SearchField = 'title' | 'content' | 'tag';
export const SEARCH_FIELDS: SearchField[] = ['title', 'content', 'tag'];

export interface SearchOptions {
  fields: SearchField[];
  kinds: LinkKind[];
}

/**
 * Ranked search across the selected fields. A title hit always outranks a tag
 * hit, which outranks a body hit, so the obvious match sits at the top.
 */
export function searchTargets(query: string, targets: LinkTarget[], opts: SearchOptions): LinkTarget[] {
  const pool = targets.filter((t) => opts.kinds.includes(t.kind));
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, 60);

  const terms = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ t: LinkTarget; score: number }> = [];

  for (const t of pool) {
    const title = t.title.toLowerCase();
    const tags = t.tags.join(' ').toLowerCase();
    const content = t.content.toLowerCase();

    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      let best = 0;
      if (opts.fields.includes('title')) {
        if (title === term) best = Math.max(best, 100);
        else if (title.startsWith(term)) best = Math.max(best, 70);
        else if (title.includes(term)) best = Math.max(best, 50);
      }
      if (opts.fields.includes('tag') && tags.includes(term)) best = Math.max(best, 30);
      if (opts.fields.includes('content') && content.includes(term)) best = Math.max(best, 10);
      if (best === 0) { matchedAll = false; break; }
      score += best;
    }

    if (matchedAll) scored.push({ t, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
    .slice(0, 60)
    .map((s) => s.t);
}

/** A short excerpt around the first body match, for the picker's result rows. */
export function contentExcerpt(target: LinkTarget, query: string): string {
  const body = target.content.replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const q = query.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const at = q ? body.toLowerCase().indexOf(q) : -1;
  if (at < 0) return body.slice(0, 90);
  const from = Math.max(0, at - 30);
  return (from > 0 ? '…' : '') + body.slice(from, from + 90);
}
