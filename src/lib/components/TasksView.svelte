<script lang="ts">
  import { onDestroy } from 'svelte';
  import { todos, activeTimers, taskFilterStatus, taskFilterPriority, taskFilterTag, taskFilterDuePeriod, taskFilterGroupByTags, taskFilterSearch, taskFilterShowOther, taskFilterHideUngrouped, taskShowTags, taskShowDividers, taskFilterToday, todaySelection, todayKey, draggingTodoId, dragOverToday, pinTodoToToday, settings, activeProject, activeProjectTags, focusRequest, projectApplyTick } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Todo, WorkSession } from '$lib/types';
  import { serializeAnnotations } from '$lib/taskAnnotations';
  import DatePicker from '$lib/components/DatePicker.svelte';
  import NotesEditor from '$lib/components/NotesEditor.svelte';

  // ── Filter state (persisted in global stores) ─────────────────────────────
  let showFilters = $state(false);
  let searchInputEl: HTMLInputElement | null = $state(null);

  // ── New-task form ─────────────────────────────────────────────────────────
  let showForm = $state(false);
  let newTitle = $state('');
  let newPriority: 'none' | 'high' | 'medium' | 'low' = $state('none');
  let newDue = $state('');
  let newTagInput = $state('');

  // ── Edit state ────────────────────────────────────────────────────────────
  let editId: string | null = $state(null);
  let editTitle = $state('');
  let editPriority: 'none' | 'high' | 'medium' | 'low' = $state('none');
  let editDue = $state('');
  let editTagInput = $state('');

  // ── Selection state ───────────────────────────────────────────────────────
  let selectedIds: Set<string> = $state(new Set());
  let confirmDelete = $state(false);
  let activeId: string | null = $state(null);

  // ── Timer state ───────────────────────────────────────────────────────────
  let expandedSessions: string | null = $state(null);
  let editingSession: { todoId: string; index: number; start: string; end: string } | null = $state(null);

  function toDatetimeLocal(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function saveSessionEdit(todo: Todo) {
    if (!editingSession || editingSession.todoId !== todo.id) return;
    const sessions = [...(todo.work_sessions ?? [])];
    sessions[editingSession.index] = {
      start: new Date(editingSession.start).toISOString(),
      end:   new Date(editingSession.end).toISOString(),
    };
    const updated = await api.saveTodo({ ...todo, work_sessions: sessions });
    todos.update((ts) => ts.map((t) => t.id === updated.id ? updated : t));
    editingSession = null;
  }

  async function deleteSession(todo: Todo, index: number) {
    const sessions = (todo.work_sessions ?? []).filter((_, i) => i !== index);
    const updated = await api.saveTodo({ ...todo, work_sessions: sessions });
    todos.update((ts) => ts.map((t) => t.id === updated.id ? updated : t));
  }
  let tick = $state(0);
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  // ── Focus mode ────────────────────────────────────────────────────────────
  let focusMode = $state(false);
  let focusTodoId = $state<string | null>(null);
  let focusTodo = $derived(focusTodoId ? ($todos.find((t) => t.id === focusTodoId) ?? null) : null);
  // The currently-running ("live") task, if any — drives the header focus shortcut.
  let liveTodoId = $derived([...$activeTimers.keys()][0] ?? null);

  // Auto-open the focus task's notes once when entering focus mode (or when the
  // focus task changes) — but don't fight the user if they then close them.
  let lastFocusOpenedId: string | null = null;
  $effect(() => {
    if (focusMode && focusTodo) {
      if (lastFocusOpenedId !== focusTodo.id) {
        lastFocusOpenedId = focusTodo.id;
        openNotes(focusTodo);
      }
    } else {
      lastFocusOpenedId = null;
    }
  });

  // Honour a focus request coming from the sidebar (jump to the running task).
  $effect(() => {
    const reqId = $focusRequest;
    if (reqId && $todos.some((t) => t.id === reqId)) {
      focusTodoId = reqId;
      focusMode = true;
      focusRequest.set(null);
    }
  });

  // Switching projects (the view stays mounted) should leave focus mode so the
  // newly-selected project's list is shown — the sidebar button jumps back in.
  let lastProjectId: string | null | undefined = undefined;
  $effect(() => {
    const pid = $activeProject?.id ?? null;
    if (lastProjectId !== undefined && pid !== lastProjectId) {
      focusMode = false;
      focusTodoId = null;
    }
    lastProjectId = pid;
  });

  // Clicking a project in the sidebar always shows its full task list — leave
  // focus mode even when the already-active project is re-clicked (no id change).
  let lastApplyTick: number | undefined = undefined;
  $effect(() => {
    const tick = $projectApplyTick;
    if (lastApplyTick !== undefined && tick !== lastApplyTick) {
      focusMode = false;
      focusTodoId = null;
    }
    lastApplyTick = tick;
  });

  // ── Notes state ───────────────────────────────────────────────────────────
  let notesOpenId: string | null = $state(null);

  // ── Subtask state ─────────────────────────────────────────────────────────
  let addingChildFor: string | null = $state(null);
  let expandedChildren: Set<string> = $state(new Set());
  let newChildTitle = $state('');

  // ── Pointer-based drag (HTML5 drag-and-drop is unreliable in Linux WebKitGTK) ─
  // Drop targets are found via elementFromPoint on mouseup, so nothing depends on
  // native dragover/drop events firing.
  let dropTargetId: string | null = $state(null);          // task-wrap highlighted under cursor
  let pdrag = $state<{ id: string; title: string; x: number; y: number } | null>(null);
  let pdown: { id: string; x: number; y: number } | null = null;
  let justDragged = false;                                  // suppress the click after a drag

  function subOrder(t: Todo): number { return t.order ?? new Date(t.created_at).getTime(); }
  function hasKids(id: string): boolean { return $todos.some((t) => t.parent_id === id); }

  async function reparentTo(todo: Todo, parentId: string | null, order?: number) {
    const updated = await api.saveTodo({ ...todo, parent_id: parentId, order: order ?? null });
    // Keep the fields we set even if an older backend build drops `order` on the round-trip,
    // so reordering is reflected immediately in the UI.
    const merged = { ...updated, parent_id: parentId, order: order ?? null };
    todos.update((ts) => ts.map((t) => t.id === merged.id ? merged : t));
    if (parentId) expandedChildren = new Set(expandedChildren).add(parentId);
  }

  function rowMouseDown(e: MouseEvent, todo: Todo) {
    if (e.button !== 0 || editId === todo.id) return;
    // Don't start a drag from interactive controls or the notes/edit/session areas.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, .task-actions, .edit-form, .notes-panel, .sessions-panel')) return;
    e.preventDefault(); // prevent text selection / native image-drag before a drag begins
    pdown = { id: todo.id, x: e.clientX, y: e.clientY };
  }
  function windowMouseMove(e: MouseEvent) {
    if (pdrag) {
      pdrag = { ...pdrag, x: e.clientX, y: e.clientY };
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      dragOverToday.set(!!el?.closest('[data-drop-today]'));
      const tid = (el?.closest('.task-wrap[data-todo-id]') as HTMLElement | null)?.getAttribute('data-todo-id') ?? null;
      dropTargetId = (tid && tid !== pdrag.id && !hasKids(pdrag.id)) ? tid : null;
      return;
    }
    if (pdown) {
      const dx = e.clientX - pdown.x, dy = e.clientY - pdown.y;
      if (dx * dx + dy * dy > 25) { // ~5px threshold before it counts as a drag
        const todo = $todos.find((t) => t.id === pdown!.id);
        if (todo) {
          pdrag = { id: todo.id, title: todo.title, x: e.clientX, y: e.clientY };
          draggingTodoId.set(todo.id);
          document.body.style.userSelect = 'none';
        }
      }
    }
  }
  async function windowMouseUp(e: MouseEvent) {
    pdown = null;
    if (!pdrag) return;
    const draggedId = pdrag.id;
    const { clientX: x, clientY: y } = e;
    endPDrag();
    const dragged = $todos.find((t) => t.id === draggedId);
    if (!dragged) return;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (el?.closest('[data-drop-today]')) { pinTodoToToday(draggedId); return; }
    const targetId = (el?.closest('.task-wrap[data-todo-id]') as HTMLElement | null)?.getAttribute('data-todo-id');
    const target = targetId ? $todos.find((t) => t.id === targetId) : null;
    if (target) { await dropOnTask(dragged, target); return; }
    // Released over empty space → promote a subtask to top-level.
    if (dragged.parent_id) await reparentTo(dragged, null);
  }
  function endPDrag() {
    pdrag = null; dropTargetId = null; draggingTodoId.set(null); dragOverToday.set(false);
    document.body.style.userSelect = '';
    justDragged = true; setTimeout(() => { justDragged = false; }, 0);
  }
  async function dropOnTask(dragged: Todo, target: Todo) {
    if (dragged.id === target.id || hasKids(dragged.id)) return; // a parent can't be nested (one level)
    if (target.parent_id) {
      // Onto a subtask → insert before it under the same parent (reorder / reparent-into).
      const parentId = target.parent_id;
      if (parentId === dragged.id) return;
      const sibs = $todos.filter((t) => t.parent_id === parentId && t.id !== dragged.id)
        .sort((a, b) => subOrder(a) - subOrder(b));
      const idx = sibs.findIndex((s) => s.id === target.id);
      const tOrd = subOrder(target);
      const prev = sibs[idx - 1];
      await reparentTo(dragged, parentId, prev ? (subOrder(prev) + tOrd) / 2 : tOrd - 1);
    } else {
      // Onto a top-level task → nest as its child at the end.
      if (dragged.parent_id === target.id) return;
      const kids = $todos.filter((t) => t.parent_id === target.id);
      await reparentTo(dragged, target.id, kids.reduce((m, k) => Math.max(m, subOrder(k)), 0) + 1);
    }
  }

  $effect(() => {
    if ($activeTimers.size > 0) {
      if (!tickInterval) tickInterval = setInterval(() => { tick++; }, 1000);
    } else {
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  // Tags available to the page filter exclude the active project's prefilter tags:
  // those are already implied, so you can only filter/group by the remaining tags.
  let allTags = $derived(
    [...new Set($todos.flatMap((t) => t.tags))]
      .sort()
      .filter((tag) => tag !== 'other' && !$activeProjectTags.includes(tag))
  );

  // Project tags that have leaked into the persisted group filter are ignored so the
  // prefilter tags never appear as group sections.
  let groupTags = $derived($taskFilterGroupByTags.filter((t) => !$activeProjectTags.includes(t)));

  let filtered = $derived(
    $todos
      .filter((t) => {
        if ($taskFilterToday) {
          // "Today": show the hand-picked ids (a subtask can be pinned too). A pinned
          // subtask whose parent is also pinned is shown nested under it, so skip its
          // standalone row to avoid duplication.
          const ids = $todaySelection.date === todayKey() ? $todaySelection.ids : [];
          if (!ids.includes(t.id)) return false;
          if (t.parent_id && ids.includes(t.parent_id)) return false;
        } else if (t.parent_id) {
          return false; // children always appear under their parent
        }
        // Project prefilter: only tasks carrying at least one project tag are in scope.
        if ($activeProjectTags.length > 0 && !$activeProjectTags.some((pt) => t.tags.includes(pt))) return false;
        if ($taskFilterStatus === 'pending' && t.done) return false;
        if ($taskFilterStatus === 'done' && !t.done) return false;
        if ($taskFilterPriority && t.priority !== $taskFilterPriority) return false;
        if ($taskFilterTag && !t.tags.includes($taskFilterTag)) return false;
        if (!$taskFilterShowOther && t.tags.includes('other')) return false;
        if ($taskFilterDuePeriod) {
          const due = t.due_date ? new Date(t.due_date) : null;
          const today = new Date(); today.setHours(0, 0, 0, 0);
          if ($taskFilterDuePeriod === 'overdue') {
            if (!due || due >= today) return false;
          } else if ($taskFilterDuePeriod === 'today') {
            const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
            if (!due || due >= tomorrow) return false;
          } else if ($taskFilterDuePeriod === 'week') {
            const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
            if (!due || due >= weekEnd) return false;
          } else if ($taskFilterDuePeriod === 'month') {
            const monthEnd = new Date(today); monthEnd.setDate(today.getDate() + 30);
            if (!due || due >= monthEnd) return false;
          }
        }
        if ($taskFilterSearch && !t.title.toLowerCase().includes($taskFilterSearch.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      })
  );

  let pendingTodos = $derived(filtered.filter((t) => !t.done));
  let doneTodos = $derived(filtered.filter((t) => t.done));
  let rootTodoCount = $derived(
    $todos.filter((t) =>
      !t.parent_id &&
      ($activeProjectTags.length === 0 || $activeProjectTags.some((pt) => t.tags.includes(pt)))
    ).length
  );

  let ungroupedPending = $derived(
    groupTags.length > 0
      ? pendingTodos.filter((t) => {
          if (groupTags.some((gt) => t.tags.includes(gt))) return false;
          // Always show tagless tasks; respect the toggle only for tasks that have tags not in the group.
          return t.tags.length === 0 || !$taskFilterHideUngrouped;
        })
      : []
  );

  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };

  let sortedGroups = $derived(
    groupTags
      .map((tag) => ({ tag, todos: pendingTodos.filter((t) => t.tags.includes(tag)) }))
      .filter((g) => g.todos.length > 0)
      .sort((a, b) => {
        const earliest = (ts: typeof pendingTodos) =>
          ts.reduce((min, t) => t.due_date ? Math.min(min, new Date(t.due_date).getTime()) : min, Infinity);
        const bestPrio = (ts: typeof pendingTodos) =>
          ts.reduce((best, t) => Math.min(best, priorityRank[t.priority] ?? 1), 2);
        const timeDiff = earliest(a.todos) - earliest(b.todos);
        return timeDiff !== 0 ? timeDiff : bestPrio(a.todos) - bestPrio(b.todos);
      })
  );

  let selTodo = $derived(
    selectedIds.size === 1 ? $todos.find((t) => selectedIds.has(t.id)) ?? null : null
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  async function toggleDone(todo: Todo) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const markingDone = !todo.done;

    if ($activeTimers.has(todo.id)) {
      const startMs = $activeTimers.get(todo.id)!;
      activeTimers.update((m) => { m.delete(todo.id); return m; });
      const session: WorkSession = { start: new Date(startMs).toISOString(), end: now };
      todo = { ...todo, work_sessions: [...(todo.work_sessions ?? []), session] };
    } else if (markingDone) {
      // Completing a task with no running timer still logs effort: a 1-minute
      // session ending at the moment it's marked done.
      const session: WorkSession = { start: new Date(nowMs - 60_000).toISOString(), end: now };
      todo = { ...todo, work_sessions: [...(todo.work_sessions ?? []), session] };
    }

    const updated = await api.saveTodo({
      ...todo,
      done: markingDone,
      finished_at: markingDone ? now : null,
      started_at: !markingDone ? now : (todo.started_at ?? null),
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function startTimer(todo: Todo) {
    const now = new Date().toISOString();
    activeTimers.update((m) => { m.set(todo.id, Date.now()); return m; });
    if (!todo.started_at) {
      const updated = await api.saveTodo({ ...todo, started_at: now });
      todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    }
  }

  async function stopTimer(todo: Todo) {
    const startMs = $activeTimers.get(todo.id);
    if (!startMs) return;
    activeTimers.update((m) => { m.delete(todo.id); return m; });

    const session: WorkSession = {
      start: new Date(startMs).toISOString(),
      end: new Date().toISOString(),
    };
    const updated = await api.saveTodo({
      ...todo,
      work_sessions: [...(todo.work_sessions ?? []), session],
      started_at: todo.started_at ?? session.start,
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function createTodo() {
    if (!newTitle.trim()) return;
    const typedTags = newTagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    // Tasks created inside a project automatically carry its tags, so they stay in scope.
    const tags = [...new Set([...$activeProjectTags, ...typedTags])];
    const created = await api.saveTodo({
      id: '', title: newTitle.trim(), done: false, priority: newPriority,
      due_date: newDue || null, tags,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    todos.update((ts) => [created, ...ts]);
    newTitle = ''; newPriority = 'none'; newDue = ''; newTagInput = '';
    showForm = false;
  }

  async function addChildTodo(parent: Todo) {
    if (!newChildTitle.trim()) return;
    const created = await api.saveTodo({
      title: newChildTitle.trim(),
      priority: parent.priority,
      tags: [...parent.tags],
      parent_id: parent.id,
    });
    todos.update((ts) => [...ts, created]);
    // Make sure the parent's subtask zone is expanded so the new child shows.
    expandedChildren = new Set(expandedChildren).add(parent.id);
    newChildTitle = '';
    addingChildFor = null;
  }

  function startEdit(todo: Todo) {
    editId = todo.id;
    editTitle = todo.title;
    editPriority = todo.priority;
    editDue = todo.due_date ?? '';
    editTagInput = todo.tags.join(', ');
    selectedIds = new Set();
  }

  async function saveEdit(todo: Todo) {
    const tags = editTagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    const updated = await api.saveTodo({
      ...todo, title: editTitle.trim(), priority: editPriority,
      due_date: editDue || null, tags,
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    editId = null;
  }

  async function deleteTodo(id: string) {
    activeTimers.update((m) => { m.delete(id); return m; });
    await api.deleteTodo(id);
    todos.update((ts) => ts.filter((t) => t.id !== id));
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    activeId = null;
    confirmDelete = false;
  }

  async function deleteSelected() {
    for (const id of selectedIds) {
      await deleteTodo(id);
    }
    selectedIds = new Set();
    confirmDelete = false;
  }

  // ── Today's selection ─────────────────────────────────────────────────────
  function removeFromToday(id: string) {
    const key = todayKey();
    todaySelection.update((sel) => ({ date: key, ids: (sel.date === key ? sel.ids : []).filter((x) => x !== id) }));
  }

  function openNotes(todo: Todo) {
    notesOpenId = todo.id;
  }

  function closeNotes() {
    notesOpenId = null;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function priorityColor(p: string) {
    return p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--yellow)' : p === 'low' ? 'var(--text-5)' : 'transparent';
  }

  function isOverdue(due: string | null): boolean {
    if (!due) return false;
    return new Date(due) < new Date(new Date().toDateString());
  }

  function fmtDueLabel(due: string | null): string {
    if (!due) return '';
    const today = new Date(new Date().toDateString());
    const target = new Date(due);
    const days = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return fmtDate(due);
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function fmtDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatElapsed(startMs: number): string {
    void tick;
    const secs = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function totalSessionMs(sessions: WorkSession[]): number {
    return (sessions ?? []).reduce(
      (acc, s) => acc + (new Date(s.end).getTime() - new Date(s.start).getTime()), 0
    );
  }

  function childrenMs(todoId: string): number {
    return $todos
      .filter((t) => t.parent_id === todoId)
      .reduce((sum, c) => sum + totalSessionMs(c.work_sessions ?? []), 0);
  }

  function formatDuration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  let copiedId: string | null = $state(null);
  function copyMarkdown(todo: Todo) {
    let text = serializeAnnotations(todo);
    if (todo.notes && todo.notes.trim()) text += '\n\n' + todo.notes.trim();
    navigator.clipboard?.writeText(text);
    copiedId = todo.id;
    setTimeout(() => { if (copiedId === todo.id) copiedId = null; }, 1200);
  }

  // ── Active-filter chips ─────────────────────────────────────────────────────
  const DUE_LABELS: Record<string, string> = { overdue: 'Overdue', today: 'Today', week: 'This week', month: 'This month' };
  let hasActiveFilters = $derived(
    !!$taskFilterSearch || $taskFilterStatus !== 'all' || $taskFilterPriority !== '' ||
    $taskFilterTag !== '' || $taskFilterDuePeriod !== '' || $taskFilterGroupByTags.length > 0 ||
    $taskFilterToday
  );
  function clearAllFilters() {
    $taskFilterSearch = ''; $taskFilterStatus = 'all'; $taskFilterPriority = '';
    $taskFilterTag = ''; $taskFilterDuePeriod = ''; $taskFilterGroupByTags = [];
    $taskFilterHideUngrouped = false; $taskFilterToday = false;
  }

  function focusSearchSoon() { setTimeout(() => searchInputEl?.focus(), 0); }

  function toggleFilters() {
    showFilters = !showFilters;
    if (showFilters) focusSearchSoon();
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!showFilters) showFilters = true;
      focusSearchSoon();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      showForm = true;
    }
    // Ctrl/Cmd+M — add a subtask to the active (or focused) root task.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      const target = activeId ?? focusTodoId;
      if (target && !$todos.find((t) => t.id === target)?.parent_id) {
        e.preventDefault();
        addingChildFor = target;
        newChildTitle = '';
        expandedChildren = new Set(expandedChildren).add(target);
      }
    }
    if (e.key === 'Escape') {
      activeId = null;
      selectedIds = new Set();
      confirmDelete = false;
    }
  }

  // Clicking anywhere on the page that isn't a todo (or the page chrome) acts as a
  // reset area: collapse the active card, close its notes, and hide subtasks.
  const RESET_CHROME = '.task-wrap, .page-header, .new-task-form, .filter-bar, .selection-bar';

  // Track where the press began so a text selection that starts inside a card and
  // ends in the background doesn't fire a reset. Reset only when BOTH the mousedown
  // and the mouseup happen in the reset area (a genuine background click).
  let pressInResetArea = false;
  function handleBackgroundMousedown(e: MouseEvent) {
    pressInResetArea = !(e.target as HTMLElement).closest(RESET_CHROME);
  }

  function handleBackgroundClick(e: MouseEvent) {
    if (!pressInResetArea) return;
    if ((e.target as HTMLElement).closest(RESET_CHROME)) return;
    activeId = null;
    notesOpenId = null;
    expandedChildren = new Set();
  }

</script>

<svelte:window onkeydown={handleGlobalKeydown} onmousemove={windowMouseMove} onmouseup={windowMouseUp} />

<div class="tasks" class:focus-mode={focusMode} onmousedown={handleBackgroundMousedown} onclick={handleBackgroundClick}>
  {#if pdrag}
    <div class="drag-ghost" style="left:{pdrag.x}px; top:{pdrag.y}px;">{pdrag.title}</div>
  {/if}
  <header class="page-header">
    <div>
      <h1>{$taskFilterToday ? 'Today' : ($activeProject ? $activeProject.name : 'Tasks')}</h1>
      <p class="subtitle">
        {filtered.length} of {rootTodoCount} tasks
        {#if $activeProject}<span class="scope-tags">· {$activeProjectTags.map((t) => '#' + t).join(' ')}</span>{/if}
      </p>
    </div>
    <div class="header-actions">
      {#if $activeTimers.size > 0}
        <button
          class="focus-toggle {focusMode ? 'active' : ''}"
          onclick={() => {
            if (focusMode) { focusMode = false; focusTodoId = null; }
            else if (liveTodoId) { focusTodoId = liveTodoId; focusMode = true; }
          }}
          title="Focus the running task"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 9V5a2 2 0 0 1 2-2h4M3 15v4a2 2 0 0 0 2 2h4M21 9V5a2 2 0 0 0-2-2h-4M21 15v4a2 2 0 0 1-2 2h-4"/></svg>
          Focus
          <span class="focus-pip"></span>
        </button>
      {/if}
      {#if !focusMode}
        <button
          class="filter-toggle {$taskShowTags ? 'active' : ''}"
          onclick={() => ($taskShowTags = !$taskShowTags)}
          title="{$taskShowTags ? 'Hide tags on tasks' : 'Show tags on tasks'}"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        </button>
        <button
          class="filter-toggle {showFilters ? 'active' : ''}"
          onclick={toggleFilters}
          title="Toggle filters (Ctrl/Cmd+F)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        </button>
      {/if}
      <button class="fab" onclick={() => (showForm = !showForm)} title="New task">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  </header>

  <!-- Active filters — each chip removes that filter on click -->
  {#if hasActiveFilters}
    <div class="active-filters">
      {#if $taskFilterToday}
        <button class="afilter" onclick={() => ($taskFilterToday = false)}>Today<span class="afilter-x">✕</span></button>
      {/if}
      {#if $taskFilterSearch}
        <button class="afilter" onclick={() => ($taskFilterSearch = '')} title="Clear search">“{$taskFilterSearch}”<span class="afilter-x">✕</span></button>
      {/if}
      {#if $taskFilterStatus !== 'all'}
        <button class="afilter" onclick={() => ($taskFilterStatus = 'all')}>Status: {$taskFilterStatus}<span class="afilter-x">✕</span></button>
      {/if}
      {#if $taskFilterPriority !== ''}
        <button class="afilter" onclick={() => ($taskFilterPriority = '')}>Priority: {$taskFilterPriority}<span class="afilter-x">✕</span></button>
      {/if}
      {#if $taskFilterTag !== ''}
        <button class="afilter" onclick={() => ($taskFilterTag = '')}>#{$taskFilterTag}<span class="afilter-x">✕</span></button>
      {/if}
      {#if $taskFilterDuePeriod !== ''}
        <button class="afilter" onclick={() => ($taskFilterDuePeriod = '')}>Due: {DUE_LABELS[$taskFilterDuePeriod] ?? $taskFilterDuePeriod}<span class="afilter-x">✕</span></button>
      {/if}
      {#each $taskFilterGroupByTags as gt}
        <button class="afilter afilter-group" onclick={() => ($taskFilterGroupByTags = $taskFilterGroupByTags.filter((t) => t !== gt))}>Group: #{gt}<span class="afilter-x">✕</span></button>
      {/each}
      {#if $taskFilterGroupByTags.length > 0 && $taskFilterHideUngrouped}
        <button class="afilter" onclick={() => ($taskFilterHideUngrouped = false)}>Other hidden<span class="afilter-x">✕</span></button>
      {/if}
      <button class="afilter afilter-clear" onclick={clearAllFilters}>Clear all</button>
    </div>
  {/if}

  <!-- New task form -->
  {#if showForm}
    <div class="new-task-form">
      <input
        class="input" placeholder="Task title…" bind:value={newTitle}
        onkeydown={(e) => e.key === 'Enter' && createTodo()}
        autofocus
      />
      <div class="form-row">
        <select class="select" bind:value={newPriority}>
          <option value="none">No priority</option>
          <option value="high">High priority</option>
          <option value="medium">Medium priority</option>
          <option value="low">Low priority</option>
        </select>
        <DatePicker bind:value={newDue} placeholder="Due date" />
        <input class="input" placeholder="#tags (space/comma separated)" bind:value={newTagInput} />
      </div>
      <div class="form-actions">
        <button class="btn-primary" onclick={createTodo}>Add task</button>
        <button class="btn-ghost" onclick={() => (showForm = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Filter bar -->
  {#if showFilters && !focusMode}
    <div class="filter-bar">
      <input class="search-input" placeholder="Search tasks…" bind:value={$taskFilterSearch} bind:this={searchInputEl} />
      <div class="filter-chips">
        <span class="filter-label">Status:</span>
        {#each ['all', 'pending', 'done'] as s}
          <button class="chip {$taskFilterStatus === s ? 'active' : ''}" onclick={() => ($taskFilterStatus = s as typeof $taskFilterStatus)}>{s}</button>
        {/each}
      </div>
      <div class="filter-chips">
        <span class="filter-label">Priority:</span>
        <button class="chip {$taskFilterPriority === '' ? 'active' : ''}" onclick={() => ($taskFilterPriority = '')}>all</button>
        {#each ['high', 'medium', 'low', 'none'] as p}
          <button class="chip prio-chip {$taskFilterPriority === p ? 'active' : ''}" style="--pc: {p === 'none' ? 'var(--text-5)' : priorityColor(p)}"
            onclick={() => ($taskFilterPriority = $taskFilterPriority === p ? '' : p as typeof $taskFilterPriority)}>{p}</button>
        {/each}
      </div>
      <div class="filter-chips">
        <span class="filter-label">Tag:</span>
        <button class="chip {$taskFilterTag === '' ? 'active' : ''}" onclick={() => ($taskFilterTag = '')}>all</button>
        {#each allTags as tag}
          <button class="chip tag-chip {$taskFilterTag === tag ? 'active' : ''}"
            onclick={() => ($taskFilterTag = $taskFilterTag === tag ? '' : tag)}>#{tag}</button>
        {/each}
      </div>
      <div class="filter-chips">
        <span class="filter-label">Due:</span>
        <button class="chip {$taskFilterDuePeriod === '' ? 'active' : ''}" onclick={() => ($taskFilterDuePeriod = '')}>all</button>
        {#each [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month']] as [val, label]}
          <button class="chip due-period-chip {$taskFilterDuePeriod === val ? 'active' : ''}"
            onclick={() => ($taskFilterDuePeriod = $taskFilterDuePeriod === val ? '' : val as typeof $taskFilterDuePeriod)}
          >{label}</button>
        {/each}
      </div>
      {#if allTags.length > 0}
        <div class="filter-chips">
          <span class="filter-label">Group:</span>
          {#if groupTags.length > 0}
            <button class="chip group-clear-chip" onclick={() => ($taskFilterGroupByTags = [])}>clear</button>
          {/if}
          {#each allTags as tag}
            <button
              class="chip group-tag-chip {$taskFilterGroupByTags.includes(tag) ? 'active' : ''}"
              onclick={() => {
                if ($taskFilterGroupByTags.includes(tag)) {
                  $taskFilterGroupByTags = $taskFilterGroupByTags.filter((t) => t !== tag);
                } else {
                  $taskFilterGroupByTags = [...$taskFilterGroupByTags, tag];
                }
              }}
            >#{tag}</button>
          {/each}
          {#if groupTags.length > 0}
            <button class="chip other-chip {$taskFilterHideUngrouped ? 'active' : ''}"
              onclick={() => ($taskFilterHideUngrouped = !$taskFilterHideUngrouped)}
              title="Toggle visibility of ungrouped todos">
              {$taskFilterHideUngrouped ? 'Other hidden' : 'Other visible'}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#snippet taskCard(todo: import('$lib/types').Todo, isChild: boolean)}
        {@const isTimerActive = $activeTimers.has(todo.id)}
        {@const timerStartMs = $activeTimers.get(todo.id)}
        {@const sessions = todo.work_sessions ?? []}
        {@const ownMs = totalSessionMs(sessions)}
        {@const totalMs = isChild ? ownMs : ownMs + childrenMs(todo.id)}
        {@const isSelected = selectedIds.has(todo.id)}
        {@const isActive = activeId === todo.id}
        {@const hasChildren = !todo.parent_id && $todos.some((t) => t.parent_id === todo.id)}
        {@const childTimerHidden = hasChildren && !expandedChildren.has(todo.id) && $todos.some((t) => t.parent_id === todo.id && $activeTimers.has(t.id))}

        {@const hasNotes = notesOpenId === todo.id}
        <div class="task-wrap {isChild ? 'child-wrap' : ''} {$taskShowDividers ? '' : 'no-divider'} {todo.done ? 'done' : ''} {isTimerActive || childTimerHidden ? 'wrap-timer' : ''} {isSelected ? 'wrap-selected' : ''} {isActive ? 'wrap-active' : ''} {hasNotes ? 'with-notes' : ''} {dropTargetId === todo.id ? 'drag-target' : ''} {pdrag?.id === todo.id ? 'dragging' : ''}"
        data-todo-id={todo.id}>
        <div class="task-card" onmousedown={(e) => rowMouseDown(e, todo)}>
          {#if !isChild && todo.priority !== 'none'}
            <span class="prio-edge" style="background:{priorityColor(todo.priority)}" title="{todo.priority} priority"></span>
          {/if}
          {#if editId === todo.id}
            <div class="edit-form">
              <input class="input" bind:value={editTitle} onkeydown={(e) => e.key === 'Enter' && saveEdit(todo)} />
              <div class="form-row">
                <select class="select" bind:value={editPriority}>
                  <option value="none">No priority</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <DatePicker bind:value={editDue} placeholder="Due date" />
                <input class="input" placeholder="#tags" bind:value={editTagInput} />
              </div>
              <div class="form-actions">
                <button class="btn-primary" onclick={() => saveEdit(todo)}>Save</button>
                <button class="btn-ghost" onclick={() => (editId = null)}>Cancel</button>
              </div>
            </div>
          {:else}
            <button class="check-btn" onclick={() => toggleDone(todo)} title="{todo.done ? 'Mark pending' : 'Mark done'}">
              {#if todo.done}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="var(--accent)"/><polyline points="7.5 12.5 10.5 15.5 16.5 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {:else}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              {/if}
            </button>

            <div class="task-body"
              onclick={(e) => {
                if (e.detail > 1 || justDragged) return;
                if (e.ctrlKey || e.metaKey) {
                  toggleSelect(todo.id);
                } else {
                  if (activeId === todo.id) {
                    activeId = null;
                    // Collapsing the card also retracts its subtasks.
                    if (hasChildren) { const s = new Set(expandedChildren); s.delete(todo.id); expandedChildren = s; }
                  } else {
                    activeId = todo.id;
                    if (hasChildren) { const s = new Set(expandedChildren); s.add(todo.id); expandedChildren = s; }
                  }
                }
              }}
              ondblclick={() => notesOpenId === todo.id ? closeNotes() : openNotes(todo)}>
              <div class="task-title-row">
                <span class="task-title" ondblclick={(e) => { e.stopPropagation(); startEdit(todo); }} title="Double-click to edit">{todo.title}</span>
                {#if isTimerActive && timerStartMs !== undefined && !isActive && !isSelected}
                  <span class="timer-running">{formatElapsed(timerStartMs)}</span>
                {/if}
              </div>

              <div class="task-meta">
                {#if todo.done}
                  {#if todo.finished_at}
                    <span class="completed-note">Completed {fmtDate(todo.finished_at)}</span>
                  {/if}
                {:else}
                  {#if $taskShowTags || isActive || isSelected}
                    {#each todo.tags as tag}
                      <button class="tag-pill" onclick={(e) => { e.stopPropagation(); $taskFilterTag = tag; }} title="Filter by #{tag}">#{tag}</button>
                    {/each}
                  {/if}
                  {#if totalMs > 0}
                    <button
                      class="time-chip logged {expandedSessions === todo.id ? 'active' : ''}"
                      onclick={(e) => { e.stopPropagation(); expandedSessions = expandedSessions === todo.id ? null : todo.id; }}
                      title="View work sessions"
                    ><svg class="meta-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>{formatDuration(totalMs)}</button>
                  {/if}
                  {#if todo.started_at}
                    <span class="time-chip started" title="Started {fmtDateTime(todo.started_at)}">▶ {fmtDate(todo.started_at)}</span>
                  {/if}
                {/if}
              </div>
            </div>
            {#if !isActive && !isSelected}
              <div class="task-right">
                {#if todo.due_date && !todo.done}
                  <span class="due-right {isOverdue(todo.due_date) ? 'overdue' : ''}" title={todo.due_date}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    {fmtDueLabel(todo.due_date)}
                  </span>
                {/if}
                {#if todo.notes}
                  <span class="notes-indicator" title="Has notes">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </span>
                {/if}
              </div>
            {/if}
            {#if isActive || isSelected}
              <div class="card-actions">
              {#if isTimerActive && timerStartMs !== undefined}
                <span class="timer-running">{formatElapsed(timerStartMs)}</span>
              {/if}
              <button class="task-action-btn {focusMode && focusTodoId === todo.id ? 'active' : ''}" title="{focusMode && focusTodoId === todo.id ? 'Exit focus' : 'Focus'}"
                onclick={() => { if (focusMode && focusTodoId === todo.id) { focusMode = false; focusTodoId = null; } else { focusTodoId = todo.id; focusMode = true; } }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <ellipse cx="12" cy="12" rx="10" ry="6"/><circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button class="card-play-btn {isTimerActive ? 'stop' : ''}" title={isTimerActive ? 'Stop timer' : 'Start timer'}
                onclick={() => isTimerActive ? stopTimer(todo) : startTimer(todo)}>
                {#if isTimerActive}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                {:else}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                {/if}
              </button>
              <div class="task-actions" onclick={(e) => e.stopPropagation()}>
                {#if $taskFilterToday}
                  <button class="task-action-btn active" title="Remove from Today" onclick={() => removeFromToday(todo.id)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="7.05"/></svg>
                  </button>
                {/if}
                {#if !todo.parent_id}
                  <button class="task-action-btn" title="Add subtask"
                    onclick={() => { addingChildFor = addingChildFor === todo.id ? null : todo.id; newChildTitle = ''; }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </button>
                {/if}
                {#if hasChildren}
                  <button class="task-action-btn" title={expandedChildren.has(todo.id) ? 'Collapse subtasks' : 'Expand subtasks'}
                    onclick={() => { const s = new Set(expandedChildren); s.has(todo.id) ? s.delete(todo.id) : s.add(todo.id); expandedChildren = s; }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                      style="transition: transform 0.2s; transform: rotate({expandedChildren.has(todo.id) ? '0' : '-90'}deg)">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                {/if}
                <button class="task-action-btn {notesOpenId === todo.id ? 'active' : ''}" title="{notesOpenId === todo.id ? 'Close notes' : 'Open notes'}"
                  onclick={() => notesOpenId === todo.id ? closeNotes() : openNotes(todo)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </button>
                <button class="task-action-btn" title="{copiedId === todo.id ? 'Copied!' : 'Copy as markdown'}" onclick={() => copyMarkdown(todo)}>
                  {#if copiedId === todo.id}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  {/if}
                </button>
                <div class="task-actions-divider"></div>
                <button class="task-action-btn" title="Edit" onclick={() => startEdit(todo)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="task-action-btn delete-action" title="Delete"
                  onclick={() => { selectedIds = new Set([todo.id]); confirmDelete = true; }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
              </div>
              </div>
            {/if}
          {/if}
        </div>

        {#if expandedSessions === todo.id && sessions.length > 0}
          <div class="sessions-panel" style="border-top: 1px solid var(--border); border-radius: 0;">
            <div class="sessions-title">Work sessions</div>
            {#each sessions as s, i}
              {@const isEditingThis = editingSession?.todoId === todo.id && editingSession.index === i}
              <div class="session-row {isEditingThis ? 'editing' : ''}">
                <span class="session-num">{i + 1}</span>
                {#if isEditingThis}
                  <input class="session-dt-input session-date-input" type="date" value={editingSession!.start.split('T')[0]}
                    oninput={(e) => editingSession = { ...editingSession!, start: (e.target as HTMLInputElement).value + 'T' + editingSession!.start.split('T')[1] }} />
                  <input class="session-dt-input session-time-input" type="time" value={editingSession!.start.split('T')[1]}
                    oninput={(e) => editingSession = { ...editingSession!, start: editingSession!.start.split('T')[0] + 'T' + (e.target as HTMLInputElement).value }} />
                  <span class="session-sep">→</span>
                  <input class="session-dt-input session-date-input" type="date" value={editingSession!.end.split('T')[0]}
                    oninput={(e) => editingSession = { ...editingSession!, end: (e.target as HTMLInputElement).value + 'T' + editingSession!.end.split('T')[1] }} />
                  <input class="session-dt-input session-time-input" type="time" value={editingSession!.end.split('T')[1]}
                    oninput={(e) => editingSession = { ...editingSession!, end: editingSession!.end.split('T')[0] + 'T' + (e.target as HTMLInputElement).value }} />
                  <button class="session-action-btn save" onclick={() => saveSessionEdit(todo)} title="Save">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  <button class="session-action-btn" onclick={() => editingSession = null} title="Cancel">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                {:else}
                  <span class="session-range">{fmtDateTime(s.start)} → {fmtDateTime(s.end)}</span>
                  <button class="session-action-btn edit-btn" onclick={() => editingSession = { todoId: todo.id, index: i, start: toDatetimeLocal(s.start), end: toDatetimeLocal(s.end) }} title="Edit">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button class="session-action-btn delete-btn" onclick={() => deleteSession(todo, i)} title="Delete">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  </button>
                  <span class="session-dur">{formatDuration(new Date(s.end).getTime() - new Date(s.start).getTime())}</span>
                {/if}
              </div>
            {/each}
            <div class="sessions-footer">
              <span class="sessions-total">Total: {formatDuration(totalMs)}</span>
              <button class="sessions-collapse-btn" onclick={() => expandedSessions = null} title="Collapse">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
              </button>
            </div>
          </div>
        {/if}

        {#if !todo.parent_id}
          {@const children = $todos
            .filter((t) => t.parent_id === todo.id)
            .sort((a, b) => (Number(a.done) - Number(b.done)) || (subOrder(a) - subOrder(b)))}
          {#if children.length > 0 || addingChildFor === todo.id}
            <div class="children-zone" class:collapsed={!expandedChildren.has(todo.id)}>
              {#if !todo.done}
                {@const doneKids = children.filter((k) => k.done).length}
                <span class="subprogress" title="{doneKids}/{children.length} subtasks done">
                  <span class="subprogress-fill" style="width:{Math.round((doneKids / children.length) * 100)}%"></span>
                </span>
              {/if}
              {#each children as child (child.id)}
                <div class="child-task-wrap {notesOpenId === child.id ? 'child-expanded' : ''}">
                  {@render taskCard(child, true)}
                </div>
              {/each}
              {#if addingChildFor === todo.id}
                <div class="child-add-form">
                  <input
                    class="input child-add-input"
                    placeholder="Subtask title…"
                    bind:value={newChildTitle}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') void addChildTodo(todo);
                      if (e.key === 'Escape') { addingChildFor = null; newChildTitle = ''; }
                    }}
                    autofocus
                  />
                  <button class="btn-primary" onclick={() => void addChildTodo(todo)}>Add</button>
                  <button class="btn-ghost" onclick={() => { addingChildFor = null; newChildTitle = ''; }}>Cancel</button>
                </div>
              {:else if children.length > 0}
                <button class="add-child-bottom-btn"
                  onclick={() => { addingChildFor = todo.id; newChildTitle = ''; }}>
                  + Add subtask
                </button>
              {/if}
            </div>
          {/if}
        {/if}

        {#if hasNotes}
          <NotesEditor
            {todo}
            repoPath={$settings.repo_path}
            {hasChildren}
            {focusMode}
            onClose={closeNotes}
            onTodoUpdated={(updated) => todos.update((ts) => ts.map((t) => t.id === updated.id ? updated : t))}
          />
        {/if}
        </div><!-- end task-wrap -->
  {/snippet}

  {#if focusMode && focusTodo}
    <div class="focus-view">
      {@render taskCard(focusTodo, !!focusTodo.parent_id)}
    </div>
  {:else}
  <div class="task-list">
    {#if filtered.length === 0}
      <div class="empty">No tasks match the current filters.</div>
    {:else if groupTags.length > 0}
      <!-- Grouped view — sorted by earliest due date, then best priority -->
      {#each sortedGroups as { tag: groupTag, todos: groupTodos }}
        <div class="group-divider">
          <span>#{groupTag} · {groupTodos.length}</span>
        </div>
        {#each groupTodos as todo (todo.id + '::' + groupTag)}
          {@render taskCard(todo, false)}
        {/each}
      {/each}
      {#if ungroupedPending.length > 0}
        <div class="group-divider">
          <span>Other · {ungroupedPending.length}</span>
        </div>
        {#each ungroupedPending as todo (todo.id + '::other')}
          {@render taskCard(todo, false)}
        {/each}
      {/if}
      {#if doneTodos.length > 0}
        <div class="section-divider">
          <span>Completed ({doneTodos.length})</span>
        </div>
        {#each doneTodos as todo (todo.id)}
          {@render taskCard(todo, false)}
        {/each}
      {/if}
    {:else}
      <!-- Flat view -->
      {#if pendingTodos.length === 0}
        <div class="empty">All tasks completed.</div>
      {/if}
      {#each pendingTodos as todo (todo.id)}
        {@render taskCard(todo, false)}
      {/each}

      {#if doneTodos.length > 0}
        <div class="section-divider">
          <span>Completed ({doneTodos.length})</span>
        </div>
        {#each doneTodos as todo (todo.id)}
          {@render taskCard(todo, false)}
        {/each}
      {/if}
    {/if}
  </div>
  {/if}

  <!-- Selection action bar -->
  {#if confirmDelete || selectedIds.size > 1}
    <div class="selection-bar">
      {#if confirmDelete}
        {@const delChildCount = [...selectedIds].reduce((n, id) => n + $todos.filter((t) => t.parent_id === id).length, 0)}
        <span class="sel-count">Delete {selectedIds.size} task{selectedIds.size > 1 ? 's' : ''}{delChildCount > 0 ? ` and ${delChildCount} subtask${delChildCount > 1 ? 's' : ''}` : ''}?</span>
        <div class="sel-spacer"></div>
        <button class="sel-btn danger" onclick={deleteSelected}>Confirm</button>
        <button class="sel-btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
      {:else}
        <div class="sel-top-row">
          {#if selectedIds.size > 1}
            <span class="sel-count">{selectedIds.size} selected</span>
          {/if}
          <button class="sel-btn ghost icon-only" onclick={() => { selectedIds = new Set(); }} title="Clear selection">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          {#if selectedIds.size > 1}
            <button class="sel-btn danger" onclick={() => (confirmDelete = true)} title="Delete selected">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
              Delete {selectedIds.size}
            </button>
          {/if}
          <div class="sel-spacer"></div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>

  /* --pad-x insets the chrome (header/filters) while task rows stay full-bleed. */
  .tasks { --pad-x: 24px; --row-h: 56px; height: 100%; overflow-y: auto; padding: 24px 0 14px; display: flex; flex-direction: column; gap: 12px; background: var(--surface); }

  .page-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 0 var(--pad-x); }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  h1 { font-size: 1.6rem; font-weight: 700; color: var(--text-1); }
  .subtitle { color: var(--text-6); font-size: 0.875rem; margin-top: 2px; }
  .scope-tags { color: var(--accent-lt); }

  .filter-toggle {
    width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .filter-toggle:hover { border-color: var(--accent); color: var(--accent-ltr); }
  .filter-toggle.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }

  .fab {
    width: 40px; height: 40px; border-radius: 12px; border: none;
    background: var(--accent); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s; flex-shrink: 0;
  }
  .fab:hover { background: var(--accent-dk); }

  .new-task-form {
    background: var(--surface); border: 1px solid var(--accent); border-radius: 12px;
    padding: 16px; display: flex; flex-direction: column; gap: 10px;
    margin: 0 var(--pad-x);
  }
  .edit-form { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
  .form-row { display: flex; gap: 8px; flex-wrap: wrap; }
  /* Give each control a min basis so they wrap onto new lines in narrow
     (e.g. subtask) cards instead of being squeezed until their text clips. */
  .form-row > :global(*) { flex: 1 1 140px; min-width: 0; }
  .form-actions { display: flex; gap: 8px; }

  .input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem; outline: none;
    flex: 1; min-width: 0;
  }
  .input:focus { border-color: var(--accent); }
  .select {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 32px 8px 12px; font-size: 0.875rem; outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
  }
  .select:focus { border-color: var(--accent); }
  .btn-primary {
    padding: 8px 16px; border-radius: 8px; border: none;
    background: var(--accent); color: #fff; font-size: 0.875rem; cursor: pointer; transition: background 0.15s;
  }
  .btn-primary:hover { background: var(--accent-dk); }
  .btn-ghost {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.875rem; cursor: pointer;
  }
  .btn-ghost:hover { border-color: var(--text-8); color: var(--text-2); }

  .filter-bar {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    margin: 0 var(--pad-x);
  }
  .search-input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem; outline: none; width: 100%;
  }
  .search-input:focus { border-color: var(--accent); }
  .filter-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .filter-label { font-size: 0.75rem; color: var(--text-6); min-width: 52px; }
  .chip {
    padding: 3px 10px; border-radius: 20px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.75rem; cursor: pointer; transition: all 0.12s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent-ltr); }
  .chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }
  .prio-chip.active { border-color: var(--pc); color: var(--pc); background: color-mix(in srgb, var(--pc) 15%, transparent); }
  .tag-chip { color: var(--accent-lt); border-color: var(--accent-bg); }
  .tag-chip.active { background: var(--accent-bg); border-color: var(--accent); }
  .other-chip { color: var(--text-6); border-style: dashed; }
  .other-chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); border-style: solid; }

  /* ── Active filter chips ── */
  .active-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 var(--pad-x); }
  .afilter {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid var(--accent); background: var(--accent-bg);
    color: var(--accent-lt); font-size: 0.75rem; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .afilter:hover { background: var(--accent); color: #fff; }
  .afilter-x { font-size: 0.8rem; line-height: 1; opacity: 0.8; }
  .afilter:hover .afilter-x { opacity: 1; }
  .afilter-group { border-color: var(--accent-purple); color: var(--accent-purple); background: color-mix(in srgb, var(--accent-purple) 14%, transparent); }
  .afilter-group:hover { background: var(--accent-purple); color: #fff; }
  .afilter-clear { border-style: dashed; border-color: var(--border-2); background: transparent; color: var(--text-5); }
  .afilter-clear:hover { background: var(--border); color: var(--text-2); border-style: solid; }

  .task-list { display: flex; flex-direction: column; gap: 0; }
  .empty { color: var(--text-7); font-size: 0.875rem; padding: 20px var(--pad-x); text-align: center; }

  .section-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 16px 0 4px; padding: 6px var(--pad-x); border-radius: 0;
    background: var(--surface-alt); color: var(--text-6); font-size: 0.72rem;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  }

  .group-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 20px 0 6px; padding: 0 var(--pad-x); color: var(--accent-lt); font-size: 0.82rem;
    font-weight: 700; letter-spacing: 0.03em;
  }
  .group-divider:first-child { margin-top: 4px; }
  .group-divider::before, .group-divider::after {
    content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .due-period-chip.active { background: var(--yellow-bg); border-color: var(--yellow); color: var(--yellow); }
  .group-tag-chip { color: var(--accent-purple); border-color: color-mix(in srgb, var(--accent-purple) 30%, transparent); }
  .group-tag-chip.active { background: color-mix(in srgb, var(--accent-purple) 15%, transparent); border-color: var(--accent-purple); color: var(--accent-purple); }
  .group-clear-chip { color: var(--text-5); border-color: var(--border-2); }

  /* ── Task row (flat list, hairline dividers between rows) ── */
  .task-wrap {
    position: relative;
    border: none; border-bottom: 1px solid var(--border-2); border-radius: 0;
    background: transparent; overflow: hidden;
    transition: background 0.15s;
  }
  .task-wrap:hover { background: var(--surface-alt); }
  .task-wrap.done { opacity: 0.55; }
  /* Live (timer running) — green vertical bar down the left edge. */
  .task-wrap.wrap-timer::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--green); z-index: 1;
  }
  /* Active (clicked) just reveals the action bar — a subtle row tint. */
  .task-wrap.wrap-active { background: var(--surface-alt); }
  .task-wrap.wrap-selected {
    background: var(--accent-bg);
    border-bottom-color: color-mix(in srgb, var(--accent) 40%, transparent);
    box-shadow: none;
  }
  /* Subtask rows sit inside their parent — no divider or surface of their own. */
  .task-wrap.child-wrap { border-bottom: none; border-radius: 0; background: transparent; }
  /* Dividers off (Settings → Appearance): keep the 1px so row heights don't shift. */
  .task-wrap.no-divider { border-bottom-color: transparent; }
  /* While editing, let the row overflow so the date-picker calendar isn't clipped
     by the row's bounds (which are short when subtasks are collapsed). */
  .task-wrap:has(.edit-form) { overflow: visible; }
  /* Drag & drop feedback */
  .task-wrap.dragging { opacity: 0.4; }
  .task-wrap.drag-target { background: var(--accent-bg); box-shadow: inset 0 0 0 2px var(--accent); }
  /* Cursor-following label shown while dragging (pointer-based DnD). */
  .drag-ghost {
    position: fixed; z-index: 9999; pointer-events: none;
    transform: translate(14px, 10px);
    background: var(--surface); border: 1px solid var(--accent); border-radius: 8px;
    padding: 6px 12px; font-size: 0.85rem; color: var(--text-1);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .task-card > .task-action-btn { align-self: center; }
  .card-play-btn {
    width: 40px; height: 40px; border-radius: 50%; border: none; flex-shrink: 0;
    background: var(--green); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    align-self: center;
    transition: background 0.12s, transform 0.1s;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--green) 35%, transparent);
  }
  .card-play-btn:hover { background: #16a34a; transform: scale(1.05); }
  .card-play-btn:active { transform: scale(0.93); }
  .card-play-btn.stop { background: transparent; color: var(--red); border: 2px solid var(--red); box-shadow: none; }
  .card-play-btn.stop:hover { background: var(--red-bg); }

  /* Every row is exactly --row-h tall, whatever it carries (tags, due date, the
     action bar when clicked/selected). Content is clipped rather than allowed to
     grow the row, so the list keeps a steady rhythm. */
  .task-card {
    position: relative;
    background: transparent; border: none; border-radius: 0;
    box-sizing: border-box; height: var(--row-h, 56px); overflow: hidden;
    padding: 0 var(--pad-x); display: flex; align-items: center; gap: 12px; flex-wrap: nowrap;
  }
  /* The edit form is the one thing taller than a row — let it size itself. */
  .task-card:has(.edit-form) { height: auto; overflow: visible; padding: 13px var(--pad-x); }
  /* Priority shown as a colour half-circle anchored to the row's left edge. */
  .prio-edge {
    position: absolute; left: 0; top: 50%; transform: translateY(-50%);
    width: 8px; height: 16px; border-radius: 0 999px 999px 0; z-index: 0;
  }
  /* Subtask rows are inset from their parent but keep the same row height. */
  .children-zone .task-card { padding: 0 10px; }

  /* Action controls (focus / play / edit etc.) grouped so they can flow onto
     their own row when there isn't room for a substantial slice of the title. */
  .card-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
  .task-card.done { opacity: 1; } /* opacity handled by task-wrap */

  .check-btn { background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0; display: flex; }
  /* Subtasks are shorter than the 40px play button, so clicking one (which
     reveals the action bar) would grow the row. Reserve that height on the
     always-present check button so the card size stays constant. */
  .child-wrap .check-btn { min-height: 40px; align-items: center; }

  /* Shrinks (rather than wrapping the actions onto a second line) so the row
     height stays fixed; the title truncates when space runs out. */
  .task-body { flex: 1; min-width: 0; cursor: pointer; align-self: stretch; overflow: hidden; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
  .task-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .task-title {
    font-size: 0.95rem; font-weight: 400; color: var(--text-1); flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .task-wrap.done .task-title { text-decoration: line-through; color: var(--text-6); }

  .timer-running {
    font-size: 0.85rem; color: var(--accent-lt); font-variant-numeric: tabular-nums;
    background: var(--accent-bg); padding: 2px 8px; border-radius: 20px;
    font-family: monospace; letter-spacing: 0.03em; white-space: nowrap;
  }

  /* One line only — the row can't grow, so surplus meta is clipped. */
  .task-meta { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; overflow: hidden; min-width: 0; }
  .task-meta > * { flex-shrink: 0; }
  .task-meta:empty { display: none; }

  .time-chip {
    font-size: 0.75rem; padding: 0; background: transparent; border-radius: 0;
  }
  .time-chip.started { color: var(--text-4); }
  .time-chip.logged {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--text-5); background: transparent; border: none; cursor: pointer; padding: 0;
    transition: color 0.12s;
  }
  .time-chip.logged:hover, .time-chip.logged.active { color: var(--accent-purple); }
  .meta-ico { flex-shrink: 0; }

  .tag-chip {
    font-size: 0.78rem; font-weight: 500; color: var(--accent-lt); background: transparent;
    border: none; padding: 0; cursor: pointer;
  }
  .tag-chip:hover { color: var(--accent-purple); text-decoration: underline; }

  /* Tag pills shown under the task title */
  .tag-pill {
    font-size: 0.72rem; font-weight: 500;
    color: var(--accent-lt); background: var(--accent-bg);
    border: none; padding: 2px 9px; border-radius: 20px; cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .tag-pill:hover { background: var(--accent-bg-2); color: var(--accent-ltr); }

  .completed-note { font-size: 0.78rem; color: var(--text-6); }

  /* Right-side cluster: subtask progress, due date, notes indicator */
  .task-right {
    display: flex; align-items: center; gap: 12px;
    margin-left: auto; padding-left: 8px; flex-shrink: 0; align-self: center;
  }
  .due-right {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 0.78rem; color: var(--text-5); white-space: nowrap;
  }
  .due-right.overdue { color: var(--red); }
  /* Sits on the todo's bottom border, flush with its right edge — a thin, muted
     segment, not a floating bar. */
  .subprogress {
    position: absolute; right: 12px; bottom: 0; z-index: 1;
    width: 160px; max-width: calc(100% - 20px); height: 3px;
    border-radius: 2px 2px 0 0; background: var(--border-2); overflow: hidden;
  }
  .subprogress-fill {
    display: block; height: 100%;
    background: color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 2px 2px 0 0; transition: width 0.2s;
  }

  /* Work sessions panel */
  .sessions-panel {
    background: var(--surface-alt); padding: 10px 18px 12px;
    display: flex; flex-direction: column; gap: 5px;
  }
  .sessions-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-7); margin-bottom: 4px; }
  .session-row { display: flex; align-items: center; gap: 10px; font-size: 0.75rem; min-height: 24px; }
  .session-num { color: var(--text-7); min-width: 16px; text-align: right; }
  .session-range { color: var(--text-3); flex: 1; }
  .session-dur { color: var(--accent-purple); white-space: nowrap; margin-left: auto; }
  .sessions-footer { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; border-top: 1px solid var(--border); margin-top: 2px; }
  .sessions-total { font-size: 0.75rem; color: var(--text-6); }
  .sessions-collapse-btn {
    background: none; border: none; cursor: pointer; padding: 2px 4px; border-radius: 4px;
    color: var(--text-6); display: flex; align-items: center; transition: background 0.1s, color 0.1s;
  }
  .sessions-collapse-btn:hover { background: var(--border); color: var(--text-2); }
  .session-row .session-action-btn { display: none; }
  .session-row:hover .session-action-btn { display: flex; }
  .session-row.editing .session-action-btn { display: flex; }
  .session-action-btn {
    width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent;
    color: var(--text-6); cursor: pointer; align-items: center; justify-content: center;
    flex-shrink: 0; transition: background 0.1s, color 0.1s;
  }
  .session-action-btn:hover { background: var(--border); color: var(--text-2); }
  .session-action-btn.edit-btn:hover { color: var(--accent-lt); background: var(--accent-bg); }
  .session-action-btn.delete-btn:hover { color: #f87171; background: rgba(248,113,113,0.12); }
  .session-action-btn.save:hover { color: #4ade80; background: rgba(74,222,128,0.1); }
  .session-sep { color: var(--text-6); }
  .session-dt-input {
    background: var(--surface-alt); border: 1px solid var(--border-2); border-radius: 5px;
    color: var(--text-2); font-size: 0.72rem; padding: 2px 6px;
    color-scheme: dark;
  }
  .session-date-input { width: 7.5rem; }
  .session-time-input { width: 5.5rem; }

  /* Focus mode toggle */
  .focus-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.78rem; font-weight: 500;
    cursor: pointer; transition: all 0.15s; position: relative;
  }
  .focus-toggle:hover { border-color: var(--accent); color: var(--accent-ltr); background: var(--border); }
  .focus-toggle.active { border-color: var(--accent); color: var(--accent-lt); background: var(--accent-bg); }
  .focus-pip {
    width: 6px; height: 6px; border-radius: 50%; background: var(--red);
    animation: pip-pulse 1.5s ease-in-out infinite;
  }
  .focus-toggle.active .focus-pip { background: var(--green); }
  @keyframes pip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Focus view */
  .focus-view {
    flex: 1; display: flex; flex-direction: column; gap: 0;
    padding: 0; overflow-y: auto;
  }

  /* Focus mode: todo + notes fill the whole area as one flush, borderless surface */
  .focus-mode {
    padding-bottom: 0;
  }
  .focus-mode .task-card { border-color: transparent; }
  .focus-mode .focus-view {
    min-height: 0;
    border-top: 1px solid var(--border);
  }
  .focus-mode .focus-view .task-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: none;
    border-radius: 0;
    background: transparent;
  }
  /* The full-height left bar would span the whole focus surface — confine the
     running-timer indicator to the todo header instead. */
  .focus-mode .focus-view .task-wrap.wrap-timer::before { display: none; }
  .focus-mode .focus-view .task-wrap.wrap-timer .task-card { position: relative; }
  .focus-mode .focus-view .task-wrap.wrap-timer .task-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
    background: var(--green); z-index: 1;
  }
  @media (max-width: 600px) {
    .focus-mode .focus-view { margin: 0; }
  }
  /* Selection bar */
  .selection-bar {
    position: sticky; bottom: 0;
    background: var(--surface-alt); border: 1px solid var(--accent); border-radius: 14px;
    padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;
    box-shadow: 0 -4px 24px rgba(99, 102, 241, 0.15);
    margin: auto var(--pad-x) 0;
  }
  .sel-top-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sel-count { font-size: 0.85rem; color: var(--accent-ltr); font-weight: 600; white-space: nowrap; }
  .sel-spacer { flex: 1; }
  .sel-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-2); font-size: 0.8rem; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }
  .sel-btn:hover { background: var(--accent-bg); border-color: var(--accent); color: var(--text-2); }
  .sel-btn.ghost { color: var(--text-4); }
  .sel-btn.ghost:hover { color: var(--text-2); }
  .sel-btn.icon-only { padding: 6px 8px; }
  .sel-btn.danger { color: var(--red); border-color: var(--red-border); }
  .sel-btn.danger:hover { background: var(--red-bg); border-color: var(--red); }


  @media (max-width: 600px) {
    .tasks { --pad-x: 16px; padding: 16px 0 12px; }
    .form-row { flex-direction: column; }
    .selection-bar { border-radius: 10px; }
    .sel-btn { padding: 6px 10px; font-size: 0.78rem; flex-shrink: 0; }
  }

  /* Notes indicator on task card */
  .notes-indicator {
    display: flex; align-items: center;
    color: var(--accent); opacity: 0.75; flex-shrink: 0;
  }

  /* Task card with notes open — square bottom corners to connect to panel */
  .task-card.notes-open {
    border-color: var(--accent);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }


  /* ── Subtasks ──────────────────────────────────────────────────────────── */

  /* Child task cards */
  .task-card.child-card {
    padding: 7px 12px;
    background: var(--bg-deep);
    border-color: var(--border);
  }
  .task-card.child-card:hover { border-color: var(--border-2); }
  .task-card.child-card.selected { border-color: var(--accent); background: var(--accent-bg); }
  .task-card.child-card .task-title { font-size: 0.85rem; }

  /* Break a child card/panel out of the children-zone indent when notes are open.
     left offset 34px = margin-left(22) + border-left(2) + padding-left(10);
     extra 12px on width re-covers the zone's padding-right. */
  .children-zone .child-task-wrap { display: contents; }
  .children-zone .child-task-wrap.child-expanded {
    display: block;
    box-sizing: border-box;
    margin-left: -34px;
    width: calc(100% + 46px);
  }
  /* Broken-out (notes-open) subtask: use a top-level row's padding so its checkbox
     and content align with the other tasks instead of the narrow subtask inset. */
  .children-zone .child-task-wrap.child-expanded .task-card { padding: 0 var(--pad-x); }
  .children-zone .child-task-wrap.child-expanded .check-btn { min-height: 0; }

  /* The indented zone that wraps child cards */
  .children-zone {
    position: relative;
    margin-left: 22px;
    padding-left: 10px;
    /* right padding keeps subtask borders clear of the parent card's edge */
    padding-right: 12px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 3px;
    padding-bottom: 4px;
  }

  /* "Add subtask" text button at bottom of filled children-zone */
  .add-child-bottom-btn {
    background: none; border: none; cursor: pointer;
    font-size: 0.7rem; color: var(--text-7);
    padding: 3px 0 1px; text-align: left;
    transition: color 0.12s;
  }
  .add-child-bottom-btn:hover { color: var(--accent-lt); }

  /* Inline new-child form */
  .child-add-form {
    display: flex; gap: 6px; align-items: center;
    padding: 3px 0;
  }
  .child-add-input {
    font-size: 0.82rem !important;
    padding: 4px 10px !important;
    min-width: 0;
  }

  /* action group pill */
  .task-actions {
    display: flex; align-items: center; gap: 1px;
    flex-shrink: 0; align-self: center;
    background: var(--surface); border: 1px solid var(--border-2);
    border-radius: 10px; padding: 3px 4px;
  }
  .task-action-btn {
    width: 26px; height: 26px; border-radius: 6px;
    border: none; background: transparent;
    color: var(--text-6); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.1s, color 0.1s;
  }
  .task-action-btn:hover { background: var(--surface-alt); color: var(--text-2); }
  .task-action-btn.active { background: var(--accent-bg); color: var(--accent-lt); }
  .task-action-btn.delete-action:hover { color: #f87171; background: rgba(248,113,113,0.10); }
  .task-actions-divider { width: 1px; height: 14px; background: var(--border-2); margin: 0 3px; flex-shrink: 0; }

  /* seamlessly connect notes panel inside task-wrap */
  :global(.task-wrap .notes-panel) {
    border: none !important;
    border-top: 1px solid var(--border) !important;
    border-radius: 0 !important;
    margin-top: 0 !important;
  }
  :global(.task-wrap .notes-panel-detached) {
    border-top: 1px solid var(--border) !important;
  }

  .children-zone.collapsed > :not(.child-add-form):not(.subprogress) { display: none; }


</style>
