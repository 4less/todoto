<script lang="ts">
  import { notes, todos, pendingTodos, recentNotes, syncState, activeView, selectedNoteId } from '$lib/stores';
  import { api } from '$lib/api';

  let { onSync }: { onSync: () => void } = $props();

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function fmtSync(iso: string | null): string {
    if (!iso) return 'Never synced';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function openNote(id: string) {
    selectedNoteId.set(id);
    activeView.set('docs');
  }

  function priorityColor(p: string) {
    return p === 'high' ? '#f87171' : p === 'medium' ? '#fbbf24' : '#6b7280';
  }
</script>

<div class="home">
  <header class="page-header">
    <div>
      <h1>Home</h1>
      <p class="subtitle">Your workspace at a glance</p>
    </div>
    <button class="sync-fab" onclick={onSync} title="Sync">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="{$syncState.syncing ? 'spinning' : ''}"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>
  </header>

  <!-- Stats row -->
  <div class="stats">
    <div class="stat-card">
      <span class="stat-value">{$pendingTodos.length}</span>
      <span class="stat-label">Pending tasks</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{$notes.length}</span>
      <span class="stat-label">Documents</span>
    </div>
    <div class="stat-card">
      <span class="stat-value sync-status {$syncState.syncing ? 'syncing' : $syncState.lastResult?.success === false ? 'error' : 'ok'}">
        {$syncState.syncing ? '↻' : $syncState.lastResult?.success === false ? '✕' : '✓'}
      </span>
      <span class="stat-label">{fmtSync($syncState.lastSync)}</span>
    </div>
  </div>

  <div class="sections">
    <!-- Upcoming tasks -->
    <section class="section">
      <div class="section-header">
        <h2>Upcoming tasks</h2>
        <button class="link-btn" onclick={() => activeView.set('tasks')}>View all →</button>
      </div>
      {#if $pendingTodos.length === 0}
        <div class="empty-msg">No pending tasks — you're all caught up!</div>
      {:else}
        <ul class="task-list">
          {#each $pendingTodos.slice(0, 5) as todo}
            <li class="task-item" onclick={() => activeView.set('tasks')}>
              <span class="priority-dot" style="background:{priorityColor(todo.priority)}"></span>
              <span class="task-title">{todo.title}</span>
              {#if todo.due_date}
                <span class="due-chip">{todo.due_date}</span>
              {/if}
              {#each todo.tags as tag}
                <span class="tag-chip">#{tag}</span>
              {/each}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Recent docs -->
    <section class="section">
      <div class="section-header">
        <h2>Recent docs</h2>
        <button class="link-btn" onclick={() => activeView.set('docs')}>View all →</button>
      </div>
      {#if $recentNotes.length === 0}
        <div class="empty-msg">No documents yet. Create your first note!</div>
      {:else}
        <ul class="doc-list">
          {#each $recentNotes as note}
            <li class="doc-item" onclick={() => openNote(note.id)}>
              <div class="doc-title">{note.title || 'Untitled'}</div>
              <div class="doc-meta">
                {fmtDate(note.updated_at)}
                {#each note.tags as tag}
                  <span class="tag-chip">#{tag}</span>
                {/each}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .home {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding: 28px 32px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #f1f5f9; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-top: 2px; }

  .sync-fab {
    width: 40px; height: 40px; border-radius: 12px; border: none;
    background: #1e1e2e; color: #6366f1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s;
  }
  .sync-fab:hover { background: #2a2a40; }
  :global(.spinning) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .stat-card {
    background: #13131a; border: 1px solid #1e1e2e; border-radius: 12px;
    padding: 16px 20px; display: flex; flex-direction: column; gap: 4px;
  }
  .stat-value { font-size: 1.6rem; font-weight: 700; color: #f1f5f9; }
  .stat-label { font-size: 0.8rem; color: #64748b; }
  .sync-status.syncing { color: #fbbf24; }
  .sync-status.error { color: #f87171; }
  .sync-status.ok { color: #34d399; }

  .sections {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    flex: 1;
    min-height: 0;
  }

  .section {
    background: #13131a;
    border: 1px solid #1e1e2e;
    border-radius: 14px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  h2 { font-size: 0.95rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .link-btn { background: none; border: none; color: #6366f1; font-size: 0.8rem; cursor: pointer; }
  .link-btn:hover { color: #a78bfa; }

  .empty-msg { color: #475569; font-size: 0.85rem; padding: 12px 0; }

  .task-list, .doc-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    overflow-y: auto;
  }

  .task-item {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-radius: 8px; cursor: pointer; transition: background 0.12s;
    font-size: 0.875rem;
  }
  .task-item:hover { background: #1a1a28; }
  .priority-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .task-title { flex: 1; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .doc-item {
    padding: 10px 10px; border-radius: 8px; cursor: pointer;
    transition: background 0.12s;
  }
  .doc-item:hover { background: #1a1a28; }
  .doc-title { font-size: 0.875rem; color: #e2e8f0; font-weight: 500; }
  .doc-meta { font-size: 0.75rem; color: #64748b; margin-top: 3px; display: flex; gap: 6px; align-items: center; }

  .tag-chip {
    font-size: 0.7rem; color: #818cf8; background: #1e1e3a;
    padding: 1px 6px; border-radius: 4px;
  }
  .due-chip {
    font-size: 0.7rem; color: #fbbf24; background: #2a1f00;
    padding: 1px 6px; border-radius: 4px; white-space: nowrap;
  }

  @media (max-width: 700px) {
    .home { padding: 16px; }
    .stats { grid-template-columns: 1fr 1fr; }
    .sections { grid-template-columns: 1fr; }
  }
</style>
