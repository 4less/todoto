<script lang="ts">
  import { syncState } from '$lib/stores';

  let { onSync }: { onSync: () => void } = $props();

  function fmtTime(iso: string | null): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<button class="sync-btn" onclick={onSync} title="Sync now">
  <svg
    class="sync-icon {$syncState.syncing ? 'spinning' : ''}"
    width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
  >
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
  {#if $syncState.syncing}
    Syncing…
  {:else if $syncState.lastSync}
    Synced {fmtTime($syncState.lastSync)}
  {:else}
    Sync now
  {/if}
</button>

{#if $syncState.lastResult && !$syncState.lastResult.success}
  <div class="sync-error">
    <span class="sync-error-label">Sync failed:</span>
    {$syncState.lastResult.message}
  </div>
{/if}

<style>
  .sync-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 12px; border-radius: 8px; border: none;
    background: transparent; color: var(--text-5);
    font-size: 0.78rem; cursor: pointer;
    transition: background 0.15s, color 0.15s; width: 100%; text-align: left;
  }
  .sync-btn:hover { background: var(--border); color: var(--text-2); }

  .sync-icon { transition: transform 0.3s; }
  .sync-icon.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .sync-error {
    font-size: 0.72rem; color: var(--red);
    padding: 2px 12px 6px;
    line-height: 1.5;
    word-break: break-word;
  }
  .sync-error-label { font-weight: 600; margin-right: 4px; }
</style>
