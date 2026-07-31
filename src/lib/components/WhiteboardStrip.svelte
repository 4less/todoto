<script lang="ts">
  import { whiteboards, openWhiteboardId, activeProject, activeProjectTags } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Whiteboard } from '$lib/types';

  // Boards belong to a project the same way tasks do: by sharing at least one of
  // the project's tags. A new board inherits the project's tags on creation.
  let boards = $derived(
    $whiteboards
      .filter((b) => $activeProjectTags.some((t) => b.tags.includes(t)))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  let confirmDeleteId = $state<string | null>(null);

  async function persist(next: Whiteboard[]) {
    whiteboards.set(next);
    await api.saveWhiteboards(next);
  }

  async function createBoard() {
    const now = new Date().toISOString();
    const board: Whiteboard = {
      id: crypto.randomUUID(),
      name: `${$activeProject?.name ?? 'New'} board`,
      tags: [...$activeProjectTags],
      nodes: [],
      edges: [],
      created_at: now,
      updated_at: now,
    };
    await persist([...$whiteboards, board]);
    openWhiteboardId.set(board.id);
  }

  async function removeBoard(id: string) {
    confirmDeleteId = null;
    await persist($whiteboards.filter((b) => b.id !== id));
  }
</script>

<div class="wb-strip">
  <span class="wb-label">Whiteboards</span>

  {#each boards as b (b.id)}
    <div class="wb-card" class:confirming={confirmDeleteId === b.id}>
      <button class="wb-open" onclick={() => openWhiteboardId.set(b.id)} title="Open “{b.name}”">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
        <span class="wb-name">{b.name}</span>
        <span class="wb-count">{b.nodes.length}</span>
      </button>
      {#if confirmDeleteId === b.id}
        <button class="wb-confirm" onclick={() => removeBoard(b.id)} title="Confirm delete">Delete?</button>
        <button class="wb-x" onclick={() => (confirmDeleteId = null)} aria-label="Cancel delete">✕</button>
      {:else}
        <button class="wb-x" onclick={() => (confirmDeleteId = b.id)} aria-label="Delete whiteboard" title="Delete whiteboard">✕</button>
      {/if}
    </div>
  {/each}

  <button class="wb-new" onclick={createBoard} title="Create a whiteboard for this project">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New whiteboard
  </button>
</div>

<style>
  .wb-strip {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 0 var(--pad-x, 24px);
  }

  .wb-label {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-6); margin-right: 2px;
  }

  .wb-card {
    display: flex; align-items: center;
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface); overflow: hidden;
  }
  .wb-card:hover { border-color: var(--border-2); }
  .wb-card.confirming { border-color: var(--red); }

  .wb-open {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 4px 6px 10px; border: none; background: transparent;
    color: var(--text-3); font-size: 0.8rem; font-family: inherit; cursor: pointer;
    max-width: 220px;
  }
  .wb-open:hover { color: var(--accent); }
  .wb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wb-count {
    font-size: 0.68rem; color: var(--text-6);
    background: var(--bg); border-radius: 6px; padding: 1px 5px;
    font-variant-numeric: tabular-nums;
  }

  .wb-x {
    border: none; background: transparent; cursor: pointer;
    color: var(--text-7); font-size: 0.7rem; padding: 6px 8px;
  }
  .wb-x:hover { color: var(--red); }

  .wb-confirm {
    border: none; background: var(--red-bg); color: var(--red);
    font-size: 0.72rem; font-family: inherit; padding: 6px 8px; cursor: pointer;
  }

  .wb-new {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 8px;
    border: 1px dashed var(--border-2); background: transparent;
    color: var(--text-5); font-size: 0.8rem; font-family: inherit; cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .wb-new:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
</style>
