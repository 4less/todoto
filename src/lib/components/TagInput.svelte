<script lang="ts">
  import { tags as registry, todos, notes, whiteboards } from '$lib/stores';
  import type { Tag } from '$lib/types';
  import {
    tagKey, cleanTag, canonicalize, findTag, allTags, similarTags, splitTagInput, tagUsage,
  } from '$lib/tags';

  let {
    value = $bindable<string[]>([]),
    placeholder = 'Add tags…',
    autofocus = false,
    locked = [],
    onchange,
  }: {
    /** Canonical tag spellings currently on the item. */
    value?: string[];
    placeholder?: string;
    autofocus?: boolean;
    /** Tags shown but not removable — e.g. inherited from the active project. */
    locked?: string[];
    /** Fired after every add/remove, for callers that persist immediately. */
    onchange?: (tags: string[]) => void;
  } = $props();

  let text = $state('');
  let open = $state(false);
  let highlighted = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);

  // Every tag the app knows: curated entries plus spellings only found on items,
  // so an existing-but-uncurated tag still autocompletes instead of looking new.
  let known = $derived(allTags($registry, $todos, $notes, $whiteboards));
  let usage = $derived(tagUsage($todos, $notes, $whiteboards));

  let currentKeys = $derived(new Set([...value, ...locked].map(tagKey)));

  /** Existing tags matching what's typed, best match first, already-added excluded. */
  let matches = $derived.by(() => {
    const q = tagKey(text);
    const pool = known.filter((t) => !currentKeys.has(tagKey(t.canonical)));
    if (!q) {
      return [...pool]
        .sort((a, b) => (usage.counts.get(tagKey(b.canonical)) ?? 0) - (usage.counts.get(tagKey(a.canonical)) ?? 0))
        .slice(0, 8);
    }
    const scored = pool
      .map((t) => {
        // Match against the canonical spelling and every alias.
        const keys = [tagKey(t.canonical), ...t.aliases.map(tagKey)];
        const best = keys.reduce((acc, k) => {
          if (k === q) return Math.min(acc, 0);
          if (k.startsWith(q)) return Math.min(acc, 1);
          if (k.includes(q)) return Math.min(acc, 2);
          return acc;
        }, 99);
        return { tag: t, rank: best };
      })
      .filter((s) => s.rank < 99);
    return scored
      .sort((a, b) =>
        a.rank - b.rank ||
        (usage.counts.get(tagKey(b.tag.canonical)) ?? 0) - (usage.counts.get(tagKey(a.tag.canonical)) ?? 0))
      .slice(0, 8)
      .map((s) => s.tag);
  });

  // The crux of "is this new?": an exact key match against a known tag or one of
  // its aliases means we're reusing it, anything else creates a tag.
  let exact = $derived(text.trim() ? findTag(text, known) : null);
  let wouldCreate = $derived(!!text.trim() && !exact && !currentKeys.has(tagKey(text)));
  // Near-misses, so an accidental near-duplicate gets noticed before it exists.
  let nearMisses = $derived(wouldCreate ? similarTags(text, known) : []);

  let alreadyAdded = $derived(!!text.trim() && currentKeys.has(tagKey(text)));

  // Rows are the matches plus, when applicable, the trailing "create" row.
  let rowCount = $derived(matches.length + (wouldCreate ? 1 : 0));

  $effect(() => {
    // Keep the highlight inside the list as it shrinks while typing.
    text;
    if (highlighted >= rowCount) highlighted = Math.max(0, rowCount - 1);
  });

  function countFor(tag: Tag) {
    return usage.counts.get(tagKey(tag.canonical)) ?? 0;
  }

  function add(raw: string) {
    const tag = canonicalize(raw, known);
    if (!tagKey(tag)) return;
    if (!currentKeys.has(tagKey(tag))) {
      value = [...value, tag];
      onchange?.(value);
    }
    text = '';
    highlighted = 0;
    open = true;
    inputEl?.focus();
  }

  function remove(tag: string) {
    value = value.filter((t) => tagKey(t) !== tagKey(tag));
    onchange?.(value);
    inputEl?.focus();
  }

  function commitHighlighted() {
    if (highlighted < matches.length) add(matches[highlighted].canonical);
    else if (wouldCreate) add(text);
    else if (text.trim()) add(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      highlighted = rowCount === 0 ? 0 : (highlighted + 1) % rowCount;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      open = true;
      highlighted = rowCount === 0 ? 0 : (highlighted - 1 + rowCount) % rowCount;
    } else if (e.key === 'Enter') {
      // Enter belongs to the tag list while there's something to commit;
      // an empty input lets the surrounding form submit as usual.
      if (text.trim()) {
        e.preventDefault();
        e.stopPropagation();
        commitHighlighted();
      }
    } else if (e.key === ',' || (e.key === ' ' && text.trim())) {
      e.preventDefault();
      for (const part of splitTagInput(text)) add(part);
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      e.preventDefault();
      value = value.slice(0, -1);
      onchange?.(value);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      open = false;
    }
  }

  function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!/[\s,]/.test(pasted)) return;
    e.preventDefault();
    for (const part of splitTagInput(pasted)) add(part);
  }

  function onBlur() {
    // Commit whatever is half-typed so a tag isn't silently lost on blur.
    if (text.trim()) for (const part of splitTagInput(text)) add(part);
    text = '';
    open = false;
  }
</script>

<div class="tag-input" class:open>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="chips" onpointerdown={() => inputEl?.focus()}>
    {#each locked as t (t)}
      <span class="chip locked" title="Inherited from the current project">#{t}</span>
    {/each}
    {#each value as t (t)}
      <span class="chip">
        #{t}
        <button type="button" class="chip-x" onclick={() => remove(t)} aria-label="Remove {t}">✕</button>
      </span>
    {/each}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={inputEl}
      bind:value={text}
      {autofocus}
      class="entry"
      placeholder={value.length || locked.length ? '' : placeholder}
      onkeydown={onKeydown}
      onpaste={onPaste}
      onfocus={() => (open = true)}
      onblur={onBlur}
      autocomplete="off"
      spellcheck="false"
    />
  </div>

  {#if open && (rowCount > 0 || alreadyAdded)}
    <div class="menu">
      {#if alreadyAdded}
        <div class="row muted">Already added</div>
      {/if}

      {#each matches as t, i (t.id)}
        <button
          type="button"
          class="row {i === highlighted ? 'active' : ''}"
          onmousedown={(e) => { e.preventDefault(); add(t.canonical); }}
          onmouseenter={() => (highlighted = i)}
        >
          <span class="row-tag">#{t.canonical}</span>
          {#if t.aliases.length > 0}
            <span class="row-alias">= {t.aliases.map((a) => '#' + a).join(' ')}</span>
          {/if}
          <span class="row-count">{countFor(t)}</span>
        </button>
      {/each}

      {#if wouldCreate}
        <button
          type="button"
          class="row create {highlighted === matches.length ? 'active' : ''}"
          onmousedown={(e) => { e.preventDefault(); add(text); }}
          onmouseenter={() => (highlighted = matches.length)}
        >
          <span class="new-badge">NEW</span>
          <span class="row-tag">#{cleanTag(text)}</span>
          <span class="row-hint">will be created</span>
        </button>

        {#if nearMisses.length > 0}
          <div class="near">
            Similar existing {nearMisses.length === 1 ? 'tag' : 'tags'}:
            {#each nearMisses as n (n.id)}
              <button type="button" class="near-tag" onmousedown={(e) => { e.preventDefault(); add(n.canonical); }}>
                #{n.canonical}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .tag-input { position: relative; width: 100%; }

  .chips {
    display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
    min-height: 34px; padding: 5px 8px;
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    cursor: text;
  }
  .tag-input.open .chips { border-color: var(--accent); }

  .chip {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 6px; border-radius: 6px;
    background: var(--accent-bg); color: var(--accent-lt);
    font-size: 0.72rem; white-space: nowrap;
  }
  .chip.locked { background: var(--border); color: var(--text-5); }

  .chip-x {
    border: none; background: transparent; cursor: pointer; padding: 0 1px;
    color: inherit; opacity: 0.6; font-size: 0.65rem; line-height: 1;
  }
  .chip-x:hover { opacity: 1; }

  .entry {
    flex: 1; min-width: 90px;
    border: none; background: transparent; outline: none;
    color: var(--text-2); font-size: 0.8rem; font-family: inherit; padding: 2px 0;
  }
  .entry::placeholder { color: var(--text-7); }

  .menu {
    position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 60;
    max-height: 260px; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    padding: 4px;
  }

  .row {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 6px 8px; border: none; border-radius: 6px;
    background: transparent; color: var(--text-3);
    font-size: 0.78rem; font-family: inherit; text-align: left; cursor: pointer;
  }
  .row.active { background: var(--accent-bg); color: var(--accent-lt); }
  .row.muted { color: var(--text-6); cursor: default; font-style: italic; }

  .row-tag { font-weight: 500; }
  .row-alias { color: var(--text-6); font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-count {
    margin-left: auto; flex-shrink: 0;
    color: var(--text-6); font-size: 0.68rem; font-variant-numeric: tabular-nums;
    background: var(--bg); border-radius: 5px; padding: 1px 5px;
  }
  .row-hint { margin-left: auto; color: var(--text-6); font-size: 0.68rem; }

  /* A new tag is visually unmistakable: dashed frame, green NEW badge. */
  .row.create {
    border: 1px dashed var(--green-border, var(--border-2));
    margin-top: 2px;
  }
  .row.create.active { background: var(--green-bg); border-color: var(--green); color: var(--green); }

  .new-badge {
    flex-shrink: 0; padding: 1px 5px; border-radius: 4px;
    background: var(--green); color: var(--bg-deep);
    font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
  }

  .near {
    display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
    padding: 6px 8px 4px; color: var(--yellow); font-size: 0.68rem;
  }
  .near-tag {
    border: 1px solid var(--yellow); background: transparent; color: var(--yellow);
    border-radius: 5px; padding: 1px 5px; font-size: 0.68rem;
    font-family: inherit; cursor: pointer;
  }
  .near-tag:hover { background: var(--yellow-bg); }
</style>
