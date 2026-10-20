import type { Project, ProjectGroup, Todo } from './types';

// Project headings ("groups"). The todo → group link lives on the todo
// (group_id); everything here derives the other direction from it.

export function projectGroupsOf(project: Project | null | undefined): ProjectGroup[] {
  return [...(project?.groups ?? [])].sort((a, b) => a.order - b.order);
}

/** The group a todo is in — a subtask is in its parent's group. */
export function groupOf(todo: Todo, all: Todo[]): string | null {
  if (todo.parent_id) {
    const parent = all.find((t) => t.id === todo.parent_id);
    return parent?.group_id ?? null;
  }
  return todo.group_id ?? null;
}

/** All todos in a group: its top-level todos plus their subtasks. */
export function groupMembers(groupId: string, all: Todo[]): Todo[] {
  const top = all.filter((t) => !t.parent_id && t.group_id === groupId);
  const ids = new Set(top.map((t) => t.id));
  return [...top, ...all.filter((t) => t.parent_id && ids.has(t.parent_id))];
}

/**
 * Group id to show a todo under in `project`, or null for "no heading". A
 * group_id pointing at a deleted heading or at another project's heading (a
 * todo can match several projects' tags) counts as no heading here.
 */
export function visibleGroupId(todo: Todo, project: Project | null | undefined): string | null {
  const id = todo.group_id ?? null;
  return id && project?.groups?.some((g) => g.id === id) ? id : null;
}
