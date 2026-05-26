import type { Todo } from './types';

// Annotation syntax embedded in markdown task lines:
//   - [ ] Buy groceries #shopping #errands @2024-12-25 !high
//   - [x] Read book #reading !low
//
// #word      → tag
// @YYYY-MM-DD → due date
// !high|!medium|!low → priority (default: medium)

const TAG_RE = /#([\w-]+)/g;
const DATE_RE = /@(\d{4}-\d{2}-\d{2})/;
const PRIORITY_RE = /!(high|medium|low)/i;
const TASK_LINE_RE = /^- \[( |x)\] (.+)$/im;
const TASKS_GLOBAL_RE = /^- \[( |x)\] (.+)$/gim;

export interface ParsedAnnotation {
  cleanTitle: string;
  tags: string[];
  due_date: string | null;
  priority: 'low' | 'medium' | 'high';
  done: boolean;
}

export function parseAnnotations(raw: string): ParsedAnnotation {
  const doneMatch = raw.match(/^\[( |x)\] /i);
  const done = doneMatch ? doneMatch[1].toLowerCase() === 'x' : false;
  const text = raw.replace(/^\[( |x)\] /i, '');

  const tags: string[] = [];
  let m: RegExpExecArray | null;
  const tagRe = new RegExp(TAG_RE.source, 'g');
  while ((m = tagRe.exec(text)) !== null) tags.push(m[1]);

  const dateMatch = text.match(DATE_RE);
  const due_date = dateMatch ? dateMatch[1] : null;

  const prioMatch = text.match(PRIORITY_RE);
  const priority = prioMatch
    ? (prioMatch[1].toLowerCase() as 'low' | 'medium' | 'high')
    : 'medium';

  const cleanTitle = text
    .replace(TAG_RE, '')
    .replace(DATE_RE, '')
    .replace(PRIORITY_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { cleanTitle, tags, due_date, priority, done };
}

export function serializeAnnotations(todo: Pick<Todo, 'title' | 'tags' | 'due_date' | 'priority' | 'done'>): string {
  const parts: string[] = [todo.title];
  if (todo.tags.length) parts.push(...todo.tags.map((t) => `#${t}`));
  if (todo.due_date) parts.push(`@${todo.due_date}`);
  if (todo.priority !== 'medium') parts.push(`!${todo.priority}`);
  const check = todo.done ? 'x' : ' ';
  return `- [${check}] ${parts.join(' ')}`;
}

/** Extract all task lines from a markdown document */
export function extractTasksFromMarkdown(markdown: string): ParsedAnnotation[] {
  const results: ParsedAnnotation[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TASKS_GLOBAL_RE.source, 'gim');
  while ((match = re.exec(markdown)) !== null) {
    const done = match[1] !== ' ';
    const raw = `[${match[1]}] ${match[2]}`;
    results.push(parseAnnotations(raw));
  }
  return results;
}

/** Hint shown to users in the editor */
export const ANNOTATION_HINT =
  'Task syntax: `- [ ] Title #tag @YYYY-MM-DD !high` — tasks sync to the Tasks view.';
