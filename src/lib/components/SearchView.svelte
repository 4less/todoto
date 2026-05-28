<script lang="ts">
  import { notes, todos, activeView, selectedNoteId } from '$lib/stores';
  import type { Note, Todo } from '$lib/types';

  let query = $state('');

  interface NoteResult { type: 'note'; item: Note; excerpt: string; }
  interface TodoResult { type: 'todo'; item: Todo; }
  type Result = NoteResult | TodoResult;

  let results: Result[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Result[] = [];

    for (const note of $notes) {
      if (
        note.title.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q) ||
        note.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        const idx = note.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 60);
        const end = Math.min(note.content.length, idx + 120);
        const excerpt =
          (start > 0 ? '…' : '') +
          note.content.slice(start, end).replace(/\n/g, ' ') +
          (end < note.content.length ? '…' : '');
        out.push({ type: 'note', item: note, excerpt });
      }
    }

    for (const todo of $todos) {
      if (
        todo.title.toLowerCase().includes(q) ||
        todo.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        out.push({ type: 'todo', item: todo });
      }
    }

    return out;
  });

  function highlight(text: string): string {
    if (!query.trim()) return text;
    const q = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>');
  }

  function openNote(id: string) {
    selectedNoteId.set(id);
    activeView.set('docs');
  }

  function priorityColor(p: string) {
    return p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--yellow)' : 'var(--text-5)';
  }
</script>

<div class="search-view">
  <header class="page-header">
    <h1>Search</h1>
  </header>

  <div class="search-box">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input
      class="search-input"
      placeholder="Search notes, tasks, tags…"
      bind:value={query}
      autofocus
    />
    {#if query}
      <button class="clear-btn" onclick={() => (query = '')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    {/if}
  </div>

  {#if query.length > 0 && query.length < 2}
    <div class="hint">Type at least 2 characters to search.</div>
  {:else if results.length === 0 && query.length >= 2}
    <div class="empty">No results for "<strong>{query}</strong>"</div>
  {:else if results.length > 0}
    <div class="results-header">{results.length} result{results.length !== 1 ? 's' : ''}</div>
    <ul class="results">
      {#each results as result}
        {#if result.type === 'note'}
          <li class="result-card note-result" onclick={() => openNote(result.item.id)}>
            <div class="result-type-badge note-badge">DOC</div>
            <div class="result-body">
              <div class="result-title">{@html highlight(result.item.title || 'Untitled')}</div>
              {#if result.excerpt}
                <div class="result-excerpt">{@html highlight(result.excerpt)}</div>
              {/if}
              {#if result.item.tags.length}
                <div class="result-tags">
                  {#each result.item.tags as tag}
                    <span class="tag-chip">#{tag}</span>
                  {/each}
                </div>
              {/if}
            </div>
            <svg class="result-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-5)" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
          </li>
        {:else}
          <li class="result-card todo-result" onclick={() => activeView.set('tasks')}>
            <div class="result-type-badge todo-badge">TASK</div>
            <div class="result-body">
              <div class="result-title-row">
                <span class="priority-dot" style="background:{priorityColor(result.item.priority)}"></span>
                <span class="result-title {result.item.done ? 'done' : ''}">{@html highlight(result.item.title)}</span>
                {#if result.item.done}<span class="done-chip">done</span>{/if}
              </div>
              {#if result.item.due_date || result.item.tags.length}
                <div class="result-tags">
                  {#if result.item.due_date}<span class="due-chip">{result.item.due_date}</span>{/if}
                  {#each result.item.tags as tag}<span class="tag-chip">#{tag}</span>{/each}
                </div>
              {/if}
            </div>
          </li>
        {/if}
      {/each}
    </ul>
  {:else}
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border-2)" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <p>Search across all your notes and tasks</p>
    </div>
  {/if}
</div>

<style>
  .search-view { height: 100%; overflow-y: auto; padding: 28px 32px; display: flex; flex-direction: column; gap: 20px; }

  .page-header h1 { font-size: 1.6rem; font-weight: 700; color: var(--text-1); }

  .search-box {
    display: flex; align-items: center; gap: 10px;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 12px;
    padding: 12px 16px;
    transition: border-color 0.15s;
  }
  .search-box:focus-within { border-color: var(--accent); }
  .search-input {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--text-2); font-size: 1rem;
  }
  .search-input::placeholder { color: var(--text-7); }
  .clear-btn {
    background: none; border: none; color: var(--text-5); cursor: pointer;
    display: flex; padding: 2px; border-radius: 4px;
    transition: color 0.12s;
  }
  .clear-btn:hover { color: var(--text-2); }

  .hint, .empty { color: var(--text-7); font-size: 0.875rem; }
  .results-header { font-size: 0.78rem; color: var(--text-6); }

  .results { list-style: none; display: flex; flex-direction: column; gap: 8px; }

  .result-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; display: flex; align-items: flex-start; gap: 12px;
    cursor: pointer; transition: border-color 0.12s;
  }
  .result-card:hover { border-color: var(--accent); }

  .result-type-badge {
    font-size: 0.62rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;
    flex-shrink: 0; margin-top: 2px; letter-spacing: 0.05em;
  }
  .note-badge { background: var(--accent-bg); color: var(--accent-lt); }
  .todo-badge { background: var(--green-surface); color: var(--green); }

  .result-body { flex: 1; min-width: 0; }
  .result-title { font-size: 0.9rem; color: var(--text-2); font-weight: 500; }
  .result-title.done { text-decoration: line-through; color: var(--text-6); }
  .result-title-row { display: flex; align-items: center; gap: 8px; }
  .priority-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .result-excerpt {
    font-size: 0.8rem; color: var(--text-6); margin-top: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .result-tags { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
  .tag-chip { font-size: 0.7rem; color: var(--accent-lt); background: var(--accent-bg); padding: 1px 6px; border-radius: 4px; }
  .due-chip { font-size: 0.7rem; color: var(--yellow); background: var(--yellow-bg); padding: 1px 6px; border-radius: 4px; }
  .done-chip { font-size: 0.7rem; color: var(--green); background: var(--green-bg); padding: 1px 6px; border-radius: 4px; }
  .result-arrow { flex-shrink: 0; margin-top: 4px; }

  :global(mark) { background: var(--accent-deep); color: var(--text-2); border-radius: 2px; padding: 0 1px; }

  .empty-state {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 12px; color: var(--text-7);
  }
  .empty-state p { font-size: 0.875rem; }

  @media (max-width: 600px) {
    .search-view { padding: 16px; }
  }
</style>
