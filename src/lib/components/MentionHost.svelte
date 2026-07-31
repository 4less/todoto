<script lang="ts">
  import { mention, pickerOpen, insertTokens, refocus, type MentionState } from '$lib/mentions';
  import LinkPicker from '$lib/components/LinkPicker.svelte';

  // Mounted once for the whole app: fields opt in with the `attachMention`
  // action, and everything else — the suggestion popup, the picker window and
  // writing the tokens back — happens here.

  // Captured when the picker opens, because focusing the picker's search box
  // blurs the source and clears the live mention state.
  let pending = $state<MentionState | null>(null);

  function openPicker() {
    const m = $mention;
    if (!m) return;
    pending = { ...m };
    pickerOpen.set(true);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!$mention || $pickerOpen) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      openPicker();
    } else if (e.key === 'Escape') {
      mention.set(null);
    }
  }

  function confirm(tokens: string[]) {
    if (pending) insertTokens(pending, tokens);
    pickerOpen.set(false);
    pending = null;
    mention.set(null);
  }

  function cancel() {
    const was = pending;
    pickerOpen.set(false);
    pending = null;
    mention.set(null);
    refocus(was);
  }
</script>

<!-- Capture phase: Enter must reach the suggestion before the field's own Enter
     handler, which would otherwise submit the task or commit the edit. -->
<svelte:window onkeydowncapture={onKeydown} />

{#if $mention && !$pickerOpen}
  <div class="suggest" style="left: {$mention.left}px; top: {$mention.top}px;">
    <button class="suggest-btn" onmousedown={(e) => { e.preventDefault(); openPicker(); }}>
      <span class="at">@</span>
      <span class="label">
        Link a todo, note or board{$mention.query ? ` matching “${$mention.query}”` : ''}
      </span>
      <kbd>↵</kbd>
    </button>
  </div>
{/if}

{#if $pickerOpen}
  <LinkPicker initialQuery={pending?.query ?? ''} onconfirm={confirm} oncancel={cancel} />
{/if}

<style>
  .suggest { position: fixed; z-index: 390; }

  .suggest-btn {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface); border: 1px solid var(--accent); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    padding: 7px 10px; cursor: pointer; font-family: inherit;
    color: var(--text-3); font-size: 0.78rem; white-space: nowrap;
    max-width: min(420px, 90vw);
  }
  .suggest-btn:hover { background: var(--accent-bg); }

  .at { color: var(--accent); font-weight: 700; }
  .label { overflow: hidden; text-overflow: ellipsis; }

  kbd {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 4px;
    padding: 1px 5px; font-size: 0.66rem; color: var(--text-5); font-family: inherit;
  }
</style>
