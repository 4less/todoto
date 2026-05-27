<script lang="ts">
  import { onDestroy } from 'svelte';
  import { todos } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Todo, WorkSession } from '$lib/types';
  import { serializeAnnotations } from '$lib/taskAnnotations';
  import DatePicker from '$lib/components/DatePicker.svelte';
  import { marked } from 'marked';

  // ── Filter state ──────────────────────────────────────────────────────────
  let filterStatus: 'all' | 'pending' | 'done' = $state('all');
  let filterPriority: '' | 'high' | 'medium' | 'low' = $state('');
  let filterTag: string = $state('');
  let searchQ: string = $state('');
  let showFilters = $state(false);
  let searchInputEl: HTMLInputElement | null = $state(null);

  // ── New-task form ─────────────────────────────────────────────────────────
  let showForm = $state(false);
  let newTitle = $state('');
  let newPriority: 'high' | 'medium' | 'low' = $state('medium');
  let newDue = $state('');
  let newTagInput = $state('');

  // ── Edit state ────────────────────────────────────────────────────────────
  let editId: string | null = $state(null);
  let editTitle = $state('');
  let editPriority: 'high' | 'medium' | 'low' = $state('medium');
  let editDue = $state('');
  let editTagInput = $state('');

  // ── Selection state ───────────────────────────────────────────────────────
  let selectedIds: Set<string> = $state(new Set());
  let confirmDelete = $state(false);

  // ── Timer state ───────────────────────────────────────────────────────────
  let activeTimers: Map<string, number> = $state(new Map());
  let expandedSessions: string | null = $state(null);
  let tick = $state(0);
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  // ── Notes state ───────────────────────────────────────────────────────────
  let notesOpenId: string | null = $state(null);
  let notesContent: string = $state('');
  let notesPreview: boolean = $state(false);
  let notesHtml: string = $state('');
  let notesSaveTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (activeTimers.size > 0) {
      if (!tickInterval) tickInterval = setInterval(() => { tick++; }, 1000);
    } else {
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  let allTags = $derived([...new Set($todos.flatMap((t) => t.tags))].sort());

  let filtered = $derived(
    $todos.filter((t) => {
      if (filterStatus === 'pending' && t.done) return false;
      if (filterStatus === 'done' && !t.done) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterTag && !t.tags.includes(filterTag)) return false;
      if (searchQ && !t.title.toLowerCase().includes(searchQ.toLowerCase())) return false;
      return true;
    })
  );

  let selTodo = $derived(
    selectedIds.size === 1 ? $todos.find((t) => selectedIds.has(t.id)) ?? null : null
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  async function toggleDone(todo: Todo) {
    const now = new Date().toISOString();
    const markingDone = !todo.done;

    if (activeTimers.has(todo.id)) {
      const startMs = activeTimers.get(todo.id)!;
      const newMap = new Map(activeTimers);
      newMap.delete(todo.id);
      activeTimers = newMap;
      const session: WorkSession = { start: new Date(startMs).toISOString(), end: now };
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
    const newMap = new Map(activeTimers);
    newMap.set(todo.id, Date.now());
    activeTimers = newMap;
    if (!todo.started_at) {
      const updated = await api.saveTodo({ ...todo, started_at: now });
      todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    }
  }

  async function stopTimer(todo: Todo) {
    const startMs = activeTimers.get(todo.id);
    if (!startMs) return;
    const newMap = new Map(activeTimers);
    newMap.delete(todo.id);
    activeTimers = newMap;

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
    const tags = newTagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    const created = await api.saveTodo({
      id: '', title: newTitle.trim(), done: false, priority: newPriority,
      due_date: newDue || null, tags,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    todos.update((ts) => [created, ...ts]);
    newTitle = ''; newPriority = 'medium'; newDue = ''; newTagInput = '';
    showForm = false;
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
    activeTimers.delete(id);
    await api.deleteTodo(id);
    todos.update((ts) => ts.filter((t) => t.id !== id));
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    confirmDelete = false;
  }

  async function deleteSelected() {
    for (const id of selectedIds) {
      await deleteTodo(id);
    }
    selectedIds = new Set();
    confirmDelete = false;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  async function updateNotesHtml() {
    notesHtml = await marked(notesContent) as string;
  }

  async function persistNotes(todo: Todo) {
    const updated = await api.saveTodo({ ...todo, notes: notesContent || null });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  function onNotesInput(todo: Todo) {
    void updateNotesHtml();
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => void persistNotes(todo), 800);
  }

  function openNotes(todo: Todo) {
    if (notesOpenId && notesOpenId !== todo.id) {
      const prev = $todos.find((t) => t.id === notesOpenId);
      if (prev) {
        if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
        void persistNotes(prev);
      }
    }
    notesOpenId = todo.id;
    notesContent = todo.notes ?? '';
    notesPreview = false;
    void updateNotesHtml();
  }

  function closeNotes() {
    if (notesOpenId) {
      const todo = $todos.find((t) => t.id === notesOpenId);
      if (todo) {
        if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
        void persistNotes(todo);
      }
    }
    notesOpenId = null;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function priorityColor(p: string) {
    return p === 'high' ? '#f87171' : p === 'medium' ? '#fbbf24' : '#6b7280';
  }

  function isOverdue(due: string | null): boolean {
    if (!due) return false;
    return new Date(due) < new Date(new Date().toDateString());
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

  function formatDuration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  function copyMarkdown(todo: Todo) {
    navigator.clipboard?.writeText(serializeAnnotations(todo));
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
    if (e.key === 'Escape' && selectedIds.size > 0) {
      selectedIds = new Set();
      confirmDelete = false;
    }
  }

</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="tasks">
  <header class="page-header">
    <div>
      <h1>Tasks</h1>
      <p class="subtitle">{filtered.length} of {$todos.length} tasks</p>
    </div>
    <div class="header-actions">
      <button
        class="filter-toggle {showFilters ? 'active' : ''}"
        onclick={toggleFilters}
        title="Toggle filters (Ctrl/Cmd+F)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      </button>
      <button class="fab" onclick={() => (showForm = !showForm)} title="New task">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  </header>

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
  {#if showFilters}
    <div class="filter-bar">
      <input class="search-input" placeholder="Search tasks…" bind:value={searchQ} bind:this={searchInputEl} />
      <div class="filter-chips">
        <span class="filter-label">Status:</span>
        {#each ['all', 'pending', 'done'] as s}
          <button class="chip {filterStatus === s ? 'active' : ''}" onclick={() => (filterStatus = s as typeof filterStatus)}>{s}</button>
        {/each}
      </div>
      <div class="filter-chips">
        <span class="filter-label">Priority:</span>
        <button class="chip {filterPriority === '' ? 'active' : ''}" onclick={() => (filterPriority = '')}>all</button>
        {#each ['high', 'medium', 'low'] as p}
          <button class="chip prio-chip {filterPriority === p ? 'active' : ''}" style="--pc: {priorityColor(p)}"
            onclick={() => (filterPriority = filterPriority === p ? '' : p as typeof filterPriority)}>{p}</button>
        {/each}
      </div>
      {#if allTags.length > 0}
        <div class="filter-chips">
          <span class="filter-label">Tag:</span>
          <button class="chip {filterTag === '' ? 'active' : ''}" onclick={() => (filterTag = '')}>all</button>
          {#each allTags as tag}
            <button class="chip tag-chip {filterTag === tag ? 'active' : ''}"
              onclick={() => (filterTag = filterTag === tag ? '' : tag)}>#{tag}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Annotation hint -->
  <div class="annotation-hint">
    Markdown syntax: <code>- [ ] Title #tag @YYYY-MM-DD !high</code> — write tasks in Docs and they sync here.
  </div>

  <!-- Task list -->
  <div class="task-list">
    {#if filtered.length === 0}
      <div class="empty">No tasks match the current filters.</div>
    {:else}
      {#each filtered as todo (todo.id)}
        {@const isTimerActive = activeTimers.has(todo.id)}
        {@const timerStartMs = activeTimers.get(todo.id)}
        {@const sessions = todo.work_sessions ?? []}
        {@const totalMs = totalSessionMs(sessions)}
        {@const isSelected = selectedIds.has(todo.id)}

        <div class="task-card {todo.done ? 'done' : ''} {isTimerActive ? 'timer-active' : ''} {isSelected ? 'selected' : ''} {notesOpenId === todo.id ? 'notes-open' : ''}">
          {#if editId === todo.id}
            <!-- Inline edit -->
            <div class="edit-form">
              <input class="input" bind:value={editTitle} onkeydown={(e) => e.key === 'Enter' && saveEdit(todo)} />
              <div class="form-row">
                <select class="select" bind:value={editPriority}>
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
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              {:else}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              {/if}
            </button>

            <div class="task-body" onclick={() => toggleSelect(todo.id)}>
              <div class="task-title-row">
                <span class="priority-bar" style="background:{priorityColor(todo.priority)}" title="{todo.priority} priority"></span>
                <span class="task-title">{todo.title}</span>
                {#if todo.notes}
                  <span class="notes-indicator" title="Has notes">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </span>
                {/if}
                {#if isTimerActive && timerStartMs !== undefined}
                  <span class="timer-running">{formatElapsed(timerStartMs)}</span>
                {/if}
              </div>

              <div class="task-meta">
                {#if todo.due_date}
                  <span class="due-chip {isOverdue(todo.due_date) && !todo.done ? 'overdue' : ''}">{todo.due_date}</span>
                {/if}
                {#if todo.started_at}
                  <span class="time-chip started" title="Started {fmtDateTime(todo.started_at)}">▶ {fmtDate(todo.started_at)}</span>
                {/if}
                {#if todo.finished_at}
                  <span class="time-chip finished" title="Finished {fmtDateTime(todo.finished_at)}">✓ {fmtDate(todo.finished_at)}</span>
                {/if}
                {#if totalMs > 0}
                  <button
                    class="time-chip logged {expandedSessions === todo.id ? 'active' : ''}"
                    onclick={(e) => { e.stopPropagation(); expandedSessions = expandedSessions === todo.id ? null : todo.id; }}
                    title="View work sessions"
                  >⏱ {formatDuration(totalMs)}</button>
                {/if}
                {#each todo.tags as tag}
                  <button class="tag-chip" onclick={(e) => { e.stopPropagation(); filterTag = tag; }} title="Filter by #{tag}">#{tag}</button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <!-- Work sessions expanded view -->
        {#if expandedSessions === todo.id && sessions.length > 0}
          <div class="sessions-panel">
            <div class="sessions-title">Work sessions</div>
            {#each sessions as s, i}
              <div class="session-row">
                <span class="session-num">{i + 1}</span>
                <span class="session-range">{fmtDateTime(s.start)} → {fmtDateTime(s.end)}</span>
                <span class="session-dur">{formatDuration(new Date(s.end).getTime() - new Date(s.start).getTime())}</span>
              </div>
            {/each}
            <div class="sessions-total">Total: {formatDuration(totalMs)}</div>
          </div>
        {/if}

        <!-- Inline notes panel -->
        {#if notesOpenId === todo.id}
          <div class="notes-panel">
            <div class="notes-panel-header">
              <span class="notes-panel-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                Notes
              </span>
              <div class="notes-panel-actions">
                <button class="notes-mode-btn {!notesPreview ? 'active' : ''}" onclick={() => (notesPreview = false)}>Edit</button>
                <button class="notes-mode-btn {notesPreview ? 'active' : ''}" onclick={async () => { notesPreview = true; await updateNotesHtml(); }}>Preview</button>
                <button class="notes-close-btn" onclick={closeNotes} title="Close notes">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            {#if notesPreview}
              <div class="notes-preview">{@html notesHtml}</div>
            {:else}
              <textarea
                class="notes-textarea"
                bind:value={notesContent}
                oninput={() => onNotesInput(todo)}
                placeholder="Write markdown notes… (# heading, **bold**, - list, `code`)"
                spellcheck="false"
              ></textarea>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Selection action bar -->
  {#if selectedIds.size > 0}
    <div class="selection-bar">
      {#if confirmDelete}
        <span class="sel-count">Delete {selectedIds.size} task{selectedIds.size > 1 ? 's' : ''}?</span>
        <div class="sel-spacer"></div>
        <button class="sel-btn danger" onclick={deleteSelected}>Confirm</button>
        <button class="sel-btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
      {:else}
        <span class="sel-count">{selectedIds.size} selected</span>
        <button class="sel-btn ghost icon-only" onclick={() => { selectedIds = new Set(); }} title="Clear selection">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="sel-spacer"></div>
        {#if selTodo}
          {#if activeTimers.has(selTodo.id)}
            <button class="sel-btn timer-stop" onclick={() => stopTimer(selTodo!)} title="Stop timer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              Stop
            </button>
          {:else}
            <button class="sel-btn timer-play" onclick={() => startTimer(selTodo!)} title="Start timer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Play
            </button>
          {/if}
          <button class="sel-btn" onclick={() => startEdit(selTodo!)} title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="sel-btn" onclick={() => copyMarkdown(selTodo!)} title="Copy markdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <button
            class="sel-btn {notesOpenId === selTodo.id ? 'notes-active' : ''}"
            onclick={() => notesOpenId === selTodo!.id ? closeNotes() : openNotes(selTodo!)}
            title="{notesOpenId === selTodo.id ? 'Close notes' : (selTodo.notes ? 'Edit notes' : 'Add notes')}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            {notesOpenId === selTodo.id ? 'Notes ✓' : (selTodo.notes ? 'Notes' : 'Notes')}
          </button>
        {/if}
        <button class="sel-btn danger" onclick={() => (confirmDelete = true)} title="Delete selected">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          Delete
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tasks { height: 100%; overflow-y: auto; padding: 28px 32px 16px; display: flex; flex-direction: column; gap: 16px; }

  .page-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #f1f5f9; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-top: 2px; }

  .filter-toggle {
    width: 36px; height: 36px; border-radius: 10px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .filter-toggle:hover { border-color: #6366f1; color: #a5b4fc; }
  .filter-toggle.active { background: #1e1e3a; border-color: #6366f1; color: #818cf8; }

  .fab {
    width: 40px; height: 40px; border-radius: 12px; border: none;
    background: #6366f1; color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s; flex-shrink: 0;
  }
  .fab:hover { background: #4f46e5; }

  .new-task-form {
    background: #13131a; border: 1px solid #6366f1; border-radius: 12px;
    padding: 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .edit-form { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .form-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .form-actions { display: flex; gap: 8px; }

  .input {
    background: #0f0f14; border: 1px solid #2d2d3d; border-radius: 8px;
    color: #e2e8f0; padding: 8px 12px; font-size: 0.875rem; outline: none;
    flex: 1; min-width: 0;
  }
  .input:focus { border-color: #6366f1; }
  .select {
    background: #0f0f14; border: 1px solid #2d2d3d; border-radius: 8px;
    color: #e2e8f0; padding: 8px 32px 8px 12px; font-size: 0.875rem; outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
  }
  .select:focus { border-color: #6366f1; }
  .btn-primary {
    padding: 8px 16px; border-radius: 8px; border: none;
    background: #6366f1; color: #fff; font-size: 0.875rem; cursor: pointer; transition: background 0.15s;
  }
  .btn-primary:hover { background: #4f46e5; }
  .btn-ghost {
    padding: 8px 16px; border-radius: 8px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; font-size: 0.875rem; cursor: pointer;
  }
  .btn-ghost:hover { border-color: #4b5563; color: #e2e8f0; }

  .filter-bar {
    background: #13131a; border: 1px solid #1e1e2e; border-radius: 12px;
    padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .search-input {
    background: #0f0f14; border: 1px solid #2d2d3d; border-radius: 8px;
    color: #e2e8f0; padding: 8px 12px; font-size: 0.875rem; outline: none; width: 100%;
  }
  .search-input:focus { border-color: #6366f1; }
  .filter-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .filter-label { font-size: 0.75rem; color: #64748b; min-width: 52px; }
  .chip {
    padding: 3px 10px; border-radius: 20px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; font-size: 0.75rem; cursor: pointer; transition: all 0.12s;
  }
  .chip:hover { border-color: #6366f1; color: #a5b4fc; }
  .chip.active { background: #1e1e3a; border-color: #6366f1; color: #818cf8; }
  .prio-chip.active { border-color: var(--pc); color: var(--pc); background: color-mix(in srgb, var(--pc) 15%, transparent); }
  .tag-chip { color: #818cf8; border-color: #1e1e3a; }
  .tag-chip.active { background: #1e1e3a; border-color: #6366f1; }

  .annotation-hint { font-size: 0.75rem; color: #475569; padding: 6px 2px; }
  .annotation-hint code { background: #1e1e2e; border-radius: 4px; padding: 1px 5px; color: #a78bfa; }

  .task-list { display: flex; flex-direction: column; gap: 4px; }
  .empty { color: #475569; font-size: 0.875rem; padding: 20px 0; text-align: center; }

  .task-card {
    background: #13131a; border: 1px solid #1e1e2e; border-radius: 10px;
    padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px;
    transition: border-color 0.12s, background 0.12s;
  }
  .task-card:hover { border-color: #2d2d3d; }
  .task-card.done { opacity: 0.55; }
  .task-card.timer-active { border-color: #6366f1; background: #13131f; }
  .task-card.selected { border-color: #6366f1; background: #16162a; }

  .check-btn { background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0; display: flex; margin-top: 2px; }

  .task-body { flex: 1; min-width: 0; cursor: pointer; }
  .task-title-row { display: flex; align-items: flex-start; gap: 8px; }
  .priority-bar { width: 3px; height: 16px; border-radius: 2px; flex-shrink: 0; margin-top: 3px; }
  .task-title { font-size: 0.9rem; color: #e2e8f0; flex: 1; min-width: 0; word-break: break-word; }
  .task-card.done .task-title { text-decoration: line-through; color: #64748b; }

  .timer-running {
    font-size: 0.78rem; color: #818cf8; font-variant-numeric: tabular-nums;
    background: #1e1e3a; padding: 1px 7px; border-radius: 4px;
    font-family: monospace; letter-spacing: 0.03em;
  }

  .task-meta { display: flex; gap: 5px; align-items: center; margin-top: 5px; flex-wrap: wrap; }

  .due-chip {
    font-size: 0.7rem; color: #fbbf24; background: #2a1f00;
    padding: 2px 7px; border-radius: 4px;
  }
  .due-chip.overdue { color: #f87171; background: #2a0e0e; }

  .time-chip {
    font-size: 0.68rem; padding: 2px 6px; border-radius: 4px;
  }
  .time-chip.started { color: #94a3b8; background: #1e1e2e; }
  .time-chip.finished { color: #34d399; background: #0d2018; }
  .time-chip.logged {
    color: #a78bfa; background: #1e1a2e; border: none; cursor: pointer;
    transition: background 0.12s;
  }
  .time-chip.logged:hover, .time-chip.logged.active { background: #2a2040; }

  .tag-chip {
    font-size: 0.7rem; color: #818cf8; background: transparent;
    border: none; padding: 0; cursor: pointer;
  }
  .tag-chip:hover { color: #a78bfa; text-decoration: underline; }

  /* Work sessions panel */
  .sessions-panel {
    background: #0f0f14; border: 1px solid #1e1e2e; border-top: none;
    border-radius: 0 0 10px 10px; padding: 10px 14px 12px;
    margin-top: -4px; display: flex; flex-direction: column; gap: 5px;
  }
  .sessions-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin-bottom: 4px; }
  .session-row { display: flex; align-items: center; gap: 10px; font-size: 0.75rem; }
  .session-num { color: #475569; min-width: 16px; text-align: right; }
  .session-range { color: #94a3b8; flex: 1; }
  .session-dur { color: #a78bfa; white-space: nowrap; }
  .sessions-total { font-size: 0.75rem; color: #64748b; padding-top: 4px; border-top: 1px solid #1e1e2e; margin-top: 2px; }

  /* Selection bar */
  .selection-bar {
    position: sticky; bottom: 0;
    background: #1a1a2e; border: 1px solid #6366f1; border-radius: 14px;
    padding: 10px 14px; display: flex; align-items: center; gap: 6px;
    box-shadow: 0 -4px 24px rgba(99, 102, 241, 0.15);
    margin-top: auto;
  }
  .sel-count { font-size: 0.85rem; color: #a5b4fc; font-weight: 600; white-space: nowrap; }
  .sel-spacer { flex: 1; }
  .sel-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 6px 12px; border-radius: 8px; border: 1px solid #2d2d3d;
    background: transparent; color: #cbd5e1; font-size: 0.8rem; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }
  .sel-btn:hover { background: #1e1e3a; border-color: #6366f1; color: #e2e8f0; }
  .sel-btn.ghost { color: #9ca3af; }
  .sel-btn.ghost:hover { color: #e2e8f0; }
  .sel-btn.icon-only { padding: 6px 8px; }
  .sel-btn.danger { color: #f87171; border-color: #3a1414; }
  .sel-btn.danger:hover { background: #2a0e0e; border-color: #f87171; }
  .sel-btn.timer-play { color: #818cf8; border-color: #1e1e3a; }
  .sel-btn.timer-play:hover { background: #1e1e3a; border-color: #6366f1; }
  .sel-btn.timer-stop { color: #f87171; border-color: #3a1414; }
  .sel-btn.timer-stop:hover { background: #2a0e0e; border-color: #f87171; }

  @media (max-width: 600px) {
    .tasks { padding: 16px 16px 12px; }
    .form-row { flex-direction: column; }
    .sel-btn { padding: 6px 8px; }
  }

  /* Notes indicator on task card */
  .notes-indicator {
    display: flex; align-items: center;
    color: #6366f1; opacity: 0.75; flex-shrink: 0;
  }

  /* Task card with notes open — square bottom corners to connect to panel */
  .task-card.notes-open {
    border-color: #6366f1;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  /* Notes panel */
  .notes-panel {
    background: #0d0d12;
    border: 1px solid #6366f1;
    border-top: none;
    border-radius: 0 0 10px 10px;
    overflow: hidden;
  }

  .notes-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 14px;
    border-bottom: 1px solid #1e1e2e;
    background: #111118;
  }

  .notes-panel-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.68rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.09em;
    color: #6366f1;
  }

  .notes-panel-actions { display: flex; align-items: center; gap: 4px; }

  .notes-mode-btn {
    padding: 2px 9px; border-radius: 5px;
    border: 1px solid #2d2d3d; background: transparent;
    color: #9ca3af; font-size: 0.72rem; cursor: pointer;
    transition: all 0.12s;
  }
  .notes-mode-btn:hover { border-color: #6366f1; color: #a5b4fc; }
  .notes-mode-btn.active { background: #1e1e3a; border-color: #6366f1; color: #818cf8; }

  .notes-close-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 5px;
    border: 1px solid transparent; background: transparent;
    color: #64748b; cursor: pointer; transition: all 0.12s; margin-left: 2px;
  }
  .notes-close-btn:hover { border-color: #3a1414; color: #f87171; background: #2a0e0e; }

  .notes-textarea {
    display: block; width: 100%; box-sizing: border-box;
    background: transparent; border: none; outline: none;
    color: #e2e8f0;
    font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
    font-size: 0.83rem; line-height: 1.65;
    padding: 14px 16px;
    resize: vertical; min-height: 130px;
  }
  .notes-textarea::placeholder { color: #475569; }

  /* Preview rendered markdown */
  .notes-preview {
    padding: 14px 16px; color: #cbd5e1;
    font-size: 0.875rem; line-height: 1.7;
    min-height: 60px;
  }
  .notes-preview :global(h1),
  .notes-preview :global(h2),
  .notes-preview :global(h3) { color: #f1f5f9; font-weight: 600; margin: 0.9em 0 0.35em; }
  .notes-preview :global(h1) { font-size: 1.05rem; }
  .notes-preview :global(h2) { font-size: 0.95rem; }
  .notes-preview :global(h3) { font-size: 0.875rem; }
  .notes-preview :global(p) { margin: 0.45em 0; }
  .notes-preview :global(ul),
  .notes-preview :global(ol) { padding-left: 1.4em; margin: 0.35em 0; }
  .notes-preview :global(li) { margin: 0.15em 0; }
  .notes-preview :global(code) {
    background: #1e1e2e; border-radius: 4px; padding: 1px 5px;
    font-family: ui-monospace, monospace; color: #a78bfa; font-size: 0.82em;
  }
  .notes-preview :global(pre) {
    background: #1e1e2e; border-radius: 8px; padding: 10px 14px;
    overflow-x: auto; margin: 0.5em 0;
  }
  .notes-preview :global(pre code) { background: transparent; padding: 0; }
  .notes-preview :global(blockquote) {
    border-left: 3px solid #6366f1; padding-left: 12px;
    color: #94a3b8; margin: 0.5em 0;
  }
  .notes-preview :global(a) { color: #818cf8; }
  .notes-preview :global(strong) { color: #f1f5f9; font-weight: 600; }
  .notes-preview :global(hr) { border: none; border-top: 1px solid #1e1e2e; margin: 0.8em 0; }

  /* Notes button active state in selection bar */
  .sel-btn.notes-active { color: #818cf8; border-color: #6366f1; background: #1e1e3a; }
  .sel-btn.notes-active:hover { background: #2a2050; }
</style>
