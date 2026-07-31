<script lang="ts">
  import { todos, notes, whiteboards } from '$lib/stores';
  import {
    allTargets, searchTargets, contentExcerpt, linkToken,
    SEARCH_FIELDS, type SearchField, type LinkKind, type LinkTarget,
  } from '$lib/links';

  let { initialQuery = '', onconfirm, oncancel }: {
    initialQuery?: string;
    onconfirm: (tokens: string[]) => void;
    oncancel: () => void;
  } = $props();

  let query = $state(initialQuery);
  let searchEl: HTMLInputElement | null = $state(null);

  // Focused via an effect rather than the autofocus attribute: the picker mounts
  // while the source field (or the ProseMirror view) still holds focus, and in
  // that race autofocus is not reliably honoured — leaving Enter doing nothing.
  $effect(() => {
    searchEl?.focus();
    searchEl?.select();
  });
  // Every field is searched by default; the dropdown narrows it.
  let fields = $state<SearchField[]>([...SEARCH_FIELDS]);
  let kinds = $state<LinkKind[]>(['todo', 'note', 'board']);
  let fieldsOpen = $state(false);
  let highlighted = $state(0);
  // Selection is ordered so the inserted tokens follow the order they were picked.
  let selected = $state<LinkTarget[]>([]);

  let targets = $derived(allTargets($todos, $notes, $whiteboards));
  let results = $derived(searchTargets(query, targets, { fields, kinds }));

  let selectedIds = $derived(new Set(selected.map((s) => s.kind + s.id)));

  $effect(() => {
    query; fields; kinds;
    highlighted = 0;
  });

  function toggle(t: LinkTarget) {
    const key = t.kind + t.id;
    selected = selectedIds.has(key)
      ? selected.filter((s) => s.kind + s.id !== key)
      : [...selected, t];
  }

  function toggleField(f: SearchField) {
    // Never leave every field off — that would match nothing at all.
    const next = fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f];
    if (next.length > 0) fields = next;
  }

  function toggleKind(k: LinkKind) {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    if (next.length > 0) kinds = next;
  }

  function confirm() {
    // Enter with nothing ticked links whatever is highlighted — the fast path.
    const picks = selected.length > 0 ? selected : results[highlighted] ? [results[highlighted]] : [];
    if (picks.length === 0) return;
    onconfirm(picks.map((p) => linkToken(p.kind, p.id)));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = results.length ? (highlighted + 1) % results.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = results.length ? (highlighted - 1 + results.length) % results.length : 0;
    } else if (e.key === 'Tab' || (e.key === ' ' && e.ctrlKey)) {
      // Tab ticks the highlighted row without leaving the search box.
      e.preventDefault();
      if (results[highlighted]) toggle(results[highlighted]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      oncancel();
    }
  }

  const KIND_LABEL: Record<LinkKind, string> = { todo: 'Todo', note: 'Note', board: 'Board' };
  const FIELD_LABEL: Record<SearchField, string> = { title: 'Title', content: 'Content', tag: 'Tag' };
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') oncancel(); }} />

<div class="backdrop" onclick={oncancel} aria-hidden="true"></div>

<div class="picker" role="dialog" aria-label="Link a resource">
  <div class="search-row">
    <span class="at">@</span>
    <input
      class="search"
      bind:this={searchEl}
      bind:value={query}
      placeholder="Search todos, notes and boards…"
      onkeydown={onKeydown}
      autocomplete="off"
    />

    <div class="dropdown">
      <button class="drop-btn" onclick={() => (fieldsOpen = !fieldsOpen)}>
        Search in: {fields.length === SEARCH_FIELDS.length ? 'all' : fields.map((f) => FIELD_LABEL[f]).join(', ')}
        <span class="caret">▾</span>
      </button>
      {#if fieldsOpen}
        <div class="drop-menu">
          {#each SEARCH_FIELDS as f}
            <button class="drop-item" onclick={() => toggleField(f)}>
              <span class="tick">{fields.includes(f) ? '✓' : ''}</span>{FIELD_LABEL[f]}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="kinds">
    {#each ['todo', 'note', 'board'] as const as k}
      <button class="kind-chip {kinds.includes(k) ? 'on' : ''}" onclick={() => toggleKind(k)}>
        {KIND_LABEL[k]}s
      </button>
    {/each}
    <span class="hint">↑↓ move · Tab select · ↵ link{selected.length ? ` ${selected.length}` : ''} · Esc cancel</span>
  </div>

  {#if selected.length > 0}
    <div class="tray">
      {#each selected as s (s.kind + s.id)}
        <button class="tray-chip {s.kind}" onclick={() => toggle(s)}>
          {s.title}<span class="tray-x">✕</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="results">
    {#if results.length === 0}
      <p class="empty">Nothing matches.</p>
    {/if}
    {#each results as t, i (t.kind + t.id)}
      {@const excerpt = fields.includes('content') ? contentExcerpt(t, query) : ''}
      <button
        class="result {i === highlighted ? 'active' : ''} {selectedIds.has(t.kind + t.id) ? 'picked' : ''}"
        onmouseenter={() => (highlighted = i)}
        onclick={() => toggle(t)}
        ondblclick={() => onconfirm([linkToken(t.kind, t.id)])}
      >
        <span class="check">{selectedIds.has(t.kind + t.id) ? '✓' : ''}</span>
        <span class="badge {t.kind}">{KIND_LABEL[t.kind]}</span>
        <span class="body">
          <span class="title">{t.title}</span>
          {#if excerpt}<span class="excerpt">{excerpt}</span>{/if}
        </span>
        <span class="meta">
          {#each t.tags.slice(0, 3) as tag}<span class="tag">#{tag}</span>{/each}
          {#if t.subtitle}<span class="sub">{t.subtitle}</span>{/if}
        </span>
      </button>
    {/each}
  </div>

  <div class="foot">
    <button class="btn ghost" onclick={oncancel}>Cancel</button>
    <button class="btn primary" onclick={confirm} disabled={selected.length === 0 && results.length === 0}>
      Link {selected.length > 0 ? selected.length : ''}
    </button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 400; }

  .picker {
    position: fixed; top: 12vh; left: 50%; transform: translateX(-50%);
    width: min(720px, 94vw); max-height: 74vh; z-index: 401;
    display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.55);
    overflow: hidden;
  }

  .search-row {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .at { color: var(--accent); font-size: 1.1rem; font-weight: 700; }
  .search {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--text-1); font-size: 0.95rem; font-family: inherit;
  }
  .search::placeholder { color: var(--text-7); }

  .dropdown { position: relative; flex-shrink: 0; }
  .drop-btn {
    display: flex; align-items: center; gap: 6px;
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-4); font-size: 0.72rem; font-family: inherit;
    padding: 5px 9px; cursor: pointer; white-space: nowrap;
  }
  .drop-btn:hover { color: var(--text-2); }
  .caret { font-size: 0.6rem; }
  .drop-menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 5;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4); padding: 4px; min-width: 130px;
  }
  .drop-item {
    display: flex; align-items: center; gap: 6px; width: 100%;
    background: transparent; border: none; border-radius: 6px;
    color: var(--text-3); font-size: 0.76rem; font-family: inherit;
    padding: 6px 8px; cursor: pointer; text-align: left;
  }
  .drop-item:hover { background: var(--border); color: var(--text-1); }
  .tick { width: 10px; color: var(--accent); }

  .kinds {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-bottom: 1px solid var(--border);
  }
  .kind-chip {
    background: transparent; border: 1px solid var(--border-2); border-radius: 999px;
    color: var(--text-6); font-size: 0.7rem; font-family: inherit;
    padding: 3px 10px; cursor: pointer;
  }
  .kind-chip.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }
  .hint { margin-left: auto; color: var(--text-7); font-size: 0.66rem; }

  .tray {
    display: flex; flex-wrap: wrap; gap: 5px;
    padding: 8px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface-alt);
  }
  .tray-chip {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--accent-bg); border: 1px solid var(--accent); border-radius: 6px;
    color: var(--accent-lt); font-size: 0.72rem; font-family: inherit;
    padding: 2px 7px; cursor: pointer; max-width: 220px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tray-x { opacity: 0.6; font-size: 0.62rem; }

  .results { flex: 1; overflow-y: auto; min-height: 0; padding: 6px; }
  .empty { color: var(--text-6); font-size: 0.82rem; text-align: center; padding: 28px 0; }

  .result {
    display: flex; align-items: center; gap: 9px; width: 100%;
    background: transparent; border: none; border-radius: 8px;
    padding: 7px 9px; cursor: pointer; text-align: left;
    color: var(--text-3); font-family: inherit;
  }
  .result.active { background: var(--accent-bg); }
  .result.picked { background: var(--surface-alt); }
  .result.picked.active { background: var(--accent-bg); }

  .check { width: 12px; flex-shrink: 0; color: var(--accent); font-size: 0.78rem; }

  .badge {
    flex-shrink: 0; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 5px; text-transform: uppercase;
  }
  .badge.todo  { background: var(--accent-bg-2); color: var(--accent-ltr); }
  .badge.note  { background: var(--green-bg); color: var(--green); }
  .badge.board { background: var(--yellow-bg); color: var(--yellow); }

  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .title { color: var(--text-2); font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .excerpt { color: var(--text-6); font-size: 0.68rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .meta { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .tag { color: var(--accent-lt); font-size: 0.65rem; background: var(--accent-bg); border-radius: 4px; padding: 1px 5px; }
  .sub { color: var(--text-7); font-size: 0.65rem; }

  .foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid var(--border);
  }
  .btn {
    border-radius: 8px; padding: 6px 14px; font-size: 0.78rem;
    font-family: inherit; cursor: pointer; border: 1px solid var(--border-2);
    background: var(--bg); color: var(--text-3);
  }
  .btn.ghost:hover { color: var(--text-1); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:disabled { opacity: 0.4; cursor: default; }
</style>
