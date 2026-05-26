<script lang="ts">
  import { todos } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Todo } from '$lib/types';
  import { serializeAnnotations } from '$lib/taskAnnotations';

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

  // ── Derived ───────────────────────────────────────────────────────────────
  let allTags = $derived(
    [...new Set($todos.flatMap((t) => t.tags))].sort()
  );

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

  // ── Actions ───────────────────────────────────────────────────────────────
  async function toggleDone(todo: Todo) {
    const updated = await api.saveTodo({ ...todo, done: !todo.done });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function createTodo() {
    if (!newTitle.trim()) return;
    const tags = newTagInput
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    const created = await api.saveTodo({
      id: '',
      title: newTitle.trim(),
      done: false,
      priority: newPriority,
      due_date: newDue || null,
      tags,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
  }

  async function saveEdit(todo: Todo) {
    const tags = editTagInput
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
    const updated = await api.saveTodo({
      ...todo,
      title: editTitle.trim(),
      priority: editPriority,
      due_date: editDue || null,
      tags,
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    editId = null;
  }

  async function deleteTodo(id: string) {
    await api.deleteTodo(id);
    todos.update((ts) => ts.filter((t) => t.id !== id));
  }

  function priorityColor(p: string) {
    return p === 'high' ? '#f87171' : p === 'medium' ? '#fbbf24' : '#6b7280';
  }

  function isOverdue(due: string | null): boolean {
    if (!due) return false;
    return new Date(due) < new Date(new Date().toDateString());
  }

  function copyMarkdown(todo: Todo) {
    navigator.clipboard?.writeText(serializeAnnotations(todo));
  }

  function focusSearchSoon() {
    setTimeout(() => searchInputEl?.focus(), 0);
  }

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
        <input class="input" type="text" placeholder="YYYY-MM-DD" bind:value={newDue} title="Due date" />
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
        <button
          class="chip {filterStatus === s ? 'active' : ''}"
          onclick={() => (filterStatus = s as typeof filterStatus)}
        >{s}</button>
      {/each}
    </div>

    <div class="filter-chips">
      <span class="filter-label">Priority:</span>
      <button class="chip {filterPriority === '' ? 'active' : ''}" onclick={() => (filterPriority = '')}>all</button>
      {#each ['high', 'medium', 'low'] as p}
        <button
          class="chip prio-chip {filterPriority === p ? 'active' : ''}"
          style="--pc: {priorityColor(p)}"
          onclick={() => (filterPriority = filterPriority === p ? '' : p as typeof filterPriority)}
        >{p}</button>
      {/each}
    </div>

    {#if allTags.length > 0}
      <div class="filter-chips">
        <span class="filter-label">Tag:</span>
        <button class="chip {filterTag === '' ? 'active' : ''}" onclick={() => (filterTag = '')}>all</button>
        {#each allTags as tag}
          <button
            class="chip tag-chip {filterTag === tag ? 'active' : ''}"
            onclick={() => (filterTag = filterTag === tag ? '' : tag)}
          >#{tag}</button>
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
        <div class="task-card {todo.done ? 'done' : ''}">
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
                <input class="input" type="text" placeholder="YYYY-MM-DD" bind:value={editDue} />
                <input class="input" placeholder="#tags" bind:value={editTagInput} />
              </div>
              <div class="form-actions">
                <button class="btn-primary" onclick={() => saveEdit(todo)}>Save</button>
                <button class="btn-ghost" onclick={() => (editId = null)}>Cancel</button>
              </div>
            </div>
          {:else}
            <button
              class="check-btn"
              onclick={() => toggleDone(todo)}
              title="{todo.done ? 'Mark pending' : 'Mark done'}"
            >
              {#if todo.done}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              {:else}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              {/if}
            </button>

            <div class="task-body">
              <div class="task-title-row">
                <span class="priority-bar" style="background:{priorityColor(todo.priority)}" title="{todo.priority} priority"></span>
                <span class="task-title">{todo.title}</span>
              </div>
              <div class="task-meta">
                {#if todo.due_date}
                  <span class="due-chip {isOverdue(todo.due_date) && !todo.done ? 'overdue' : ''}">
                    {todo.due_date}
                  </span>
                {/if}
                {#each todo.tags as tag}
                  <button
                    class="tag-chip"
                    onclick={() => (filterTag = tag)}
                    title="Filter by #{tag}"
                  >#{tag}</button>
                {/each}
              </div>
            </div>

            <div class="task-actions">
              <button class="action-btn" onclick={() => startEdit(todo)} title="Edit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="action-btn" onclick={() => copyMarkdown(todo)} title="Copy markdown">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              <button class="action-btn danger" onclick={() => deleteTodo(todo.id)} title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
              </button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tasks { height: 100%; overflow-y: auto; padding: 28px 32px; display: flex; flex-direction: column; gap: 16px; }

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

  /* New task form */
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
    background-repeat: no-repeat;
    background-position: right 10px center;
  }
  .select:focus { border-color: #6366f1; }
  .btn-primary {
    padding: 8px 16px; border-radius: 8px; border: none;
    background: #6366f1; color: #fff; font-size: 0.875rem; cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover { background: #4f46e5; }
  .btn-ghost {
    padding: 8px 16px; border-radius: 8px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; font-size: 0.875rem; cursor: pointer;
  }
  .btn-ghost:hover { border-color: #4b5563; color: #e2e8f0; }

  /* Filter bar */
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
    background: transparent; color: #9ca3af; font-size: 0.75rem; cursor: pointer;
    transition: all 0.12s;
  }
  .chip:hover { border-color: #6366f1; color: #a5b4fc; }
  .chip.active { background: #1e1e3a; border-color: #6366f1; color: #818cf8; }
  .prio-chip.active { border-color: var(--pc); color: var(--pc); background: color-mix(in srgb, var(--pc) 15%, transparent); }
  .tag-chip { color: #818cf8; border-color: #1e1e3a; }
  .tag-chip.active { background: #1e1e3a; border-color: #6366f1; }

  /* Annotation hint */
  .annotation-hint {
    font-size: 0.75rem; color: #475569; padding: 6px 2px;
  }
  .annotation-hint code {
    background: #1e1e2e; border-radius: 4px; padding: 1px 5px; color: #a78bfa;
  }

  /* Task list */
  .task-list { display: flex; flex-direction: column; gap: 6px; }
  .empty { color: #475569; font-size: 0.875rem; padding: 20px 0; text-align: center; }

  .task-card {
    background: #13131a; border: 1px solid #1e1e2e; border-radius: 10px;
    padding: 12px 14px; display: flex; align-items: center; gap: 12px;
    transition: border-color 0.12s;
  }
  .task-card:hover { border-color: #2d2d3d; }
  .task-card.done { opacity: 0.55; }

  .check-btn { background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0; display: flex; }

  .task-body { flex: 1; min-width: 0; }
  .task-title-row { display: flex; align-items: center; gap: 8px; }
  .priority-bar { width: 3px; height: 16px; border-radius: 2px; flex-shrink: 0; }
  .task-title { font-size: 0.9rem; color: #e2e8f0; }
  .task-card.done .task-title { text-decoration: line-through; color: #64748b; }

  .task-meta { display: flex; gap: 6px; align-items: center; margin-top: 5px; flex-wrap: wrap; }
  .due-chip {
    font-size: 0.7rem; color: #fbbf24; background: #2a1f00;
    padding: 2px 7px; border-radius: 4px;
  }
  .due-chip.overdue { color: #f87171; background: #2a0e0e; }
  .tag-chip {
    font-size: 0.7rem; color: #818cf8; background: transparent;
    border: none; padding: 0; cursor: pointer;
  }
  .tag-chip:hover { color: #a78bfa; text-decoration: underline; }

  .task-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.12s; }
  .task-card:hover .task-actions { opacity: 1; }
  .action-btn {
    width: 28px; height: 28px; border-radius: 6px; border: none;
    background: transparent; color: #6b7280; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .action-btn:hover { background: #1e1e2e; color: #e2e8f0; }
  .action-btn.danger:hover { background: #2a0e0e; color: #f87171; }

  @media (max-width: 600px) {
    .tasks { padding: 16px; }
    .form-row { flex-direction: column; }
  }
</style>
