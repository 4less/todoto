<script lang="ts">
  import { settings, showSettings, syncState } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Settings } from '$lib/types';

  let { onSaved }: { onSaved: () => void } = $props();

  let form: Settings = $state({ ...$settings });
  let saving = $state(false);
  let testResult: string | null = $state(null);
  let showToken = $state(false);

  async function save() {
    saving = true;
    try {
      await api.saveSettings(form);
      settings.set({ ...form });
      testResult = null;
      onSaved();
      showSettings.set(false);
    } finally {
      saving = false;
    }
  }

  async function testSync() {
    saving = true;
    testResult = null;
    try {
      await api.saveSettings(form);
      settings.set({ ...form });
      const result = await api.syncNow();
      testResult = result.success ? `✓ ${result.message}` : `✕ ${result.message}`;
      syncState.update((s) => ({ ...s, lastResult: result, lastSync: result.timestamp }));
      onSaved();
    } finally {
      saving = false;
    }
  }

  function close() { showSettings.set(false); }

  // Reset form when settings store changes externally
  $effect(() => { form = { ...$settings }; });
</script>

<!-- Backdrop -->
<div class="backdrop" onclick={close}></div>

<div class="panel">
  <div class="panel-header">
    <h2>Settings</h2>
    <button class="close-btn" onclick={close}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  <div class="panel-body">
    <!-- GitHub Sync section -->
    <section class="settings-section">
      <h3>GitHub Sync</h3>
      <p class="section-desc">Connect a GitHub repository to sync your notes and todos across devices. Uses the GitHub API — no git binary required.</p>

      <div class="field">
        <label for="s-repo-url">Repository URL</label>
        <input
          id="s-repo-url" class="input" type="url" bind:value={form.repo_url}
          placeholder="https://github.com/username/repo"
        />
        <div class="field-hint">HTTPS URL of your GitHub repository</div>
      </div>

      <div class="field">
        <label for="s-git-token">Personal Access Token (PAT)</label>
        <div class="token-row">
          <input
            id="s-git-token" class="input" type={showToken ? 'text' : 'password'}
            bind:value={form.git_token}
            placeholder="ghp_…"
          />
          <button class="toggle-btn" onclick={() => (showToken = !showToken)}>
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <div class="field-hint">
          GitHub PAT with <strong>repo</strong> scope (Contents read &amp; write).
          <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">Create token →</a>
        </div>
      </div>
    </section>

    <!-- Auto-sync section -->
    <section class="settings-section">
      <h3>Auto Sync</h3>
      <div class="toggle-row">
        <label class="toggle-label" for="s-auto-sync">
          <input id="s-auto-sync" type="checkbox" bind:checked={form.auto_sync} class="checkbox" />
          <span>Enable auto-sync</span>
        </label>
      </div>
      {#if form.auto_sync}
        <div class="field">
          <label for="s-sync-interval">Sync interval (seconds)</label>
          <input
            id="s-sync-interval" class="input narrow" type="number" min="10" max="3600"
            bind:value={form.sync_interval_seconds}
          />
        </div>
      {/if}
    </section>

    {#if testResult}
      <div class="test-result {testResult.startsWith('✓') ? 'success' : 'error'}">
        {testResult}
      </div>
    {/if}
  </div>

  <div class="panel-footer">
    <button class="btn-ghost" onclick={testSync} disabled={saving}>
      {saving ? 'Testing…' : 'Test sync'}
    </button>
    <div class="footer-right">
      <button class="btn-ghost" onclick={close}>Cancel</button>
      <button class="btn-primary" onclick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 200; backdrop-filter: blur(2px);
  }

  .panel {
    position: fixed; right: 0; top: 0; bottom: 0;
    width: min(480px, 100vw);
    background: #13131a; border-left: 1px solid #1e1e2e;
    z-index: 201; display: flex; flex-direction: column;
    animation: slide-in 0.2s ease;
  }
  @keyframes slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; border-bottom: 1px solid #1e1e2e; flex-shrink: 0;
  }
  h2 { font-size: 1.1rem; font-weight: 600; color: #f1f5f9; }
  .close-btn {
    width: 32px; height: 32px; border-radius: 8px; border: none;
    background: transparent; color: #6b7280; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .close-btn:hover { background: #1e1e2e; color: #e2e8f0; }

  .panel-body { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 24px; }

  .settings-section { display: flex; flex-direction: column; gap: 14px; }
  h3 { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: #64748b; }
  .section-desc { font-size: 0.82rem; color: #475569; line-height: 1.5; }

  .field { display: flex; flex-direction: column; gap: 5px; }
  label { font-size: 0.82rem; color: #94a3b8; font-weight: 500; }
  .field-hint { font-size: 0.75rem; color: #475569; }
  .field-hint a { color: #818cf8; text-decoration: none; }
  .field-hint a:hover { text-decoration: underline; }

  .input {
    background: #0f0f14; border: 1px solid #2d2d3d; border-radius: 8px;
    color: #e2e8f0; padding: 9px 12px; font-size: 0.875rem; outline: none;
    transition: border-color 0.12s;
  }
  .input:focus { border-color: #6366f1; }
  .input.narrow { max-width: 120px; }

  .token-row { display: flex; gap: 8px; }
  .token-row .input { flex: 1; }
  .toggle-btn {
    padding: 0 12px; border-radius: 8px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; font-size: 0.8rem; cursor: pointer;
    white-space: nowrap;
  }
  .toggle-btn:hover { border-color: #4b5563; color: #e2e8f0; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  .toggle-row { display: flex; align-items: center; }
  .toggle-label { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 0.875rem; color: #e2e8f0; }
  .checkbox { accent-color: #6366f1; width: 16px; height: 16px; cursor: pointer; }

  .test-result {
    padding: 10px 14px; border-radius: 8px; font-size: 0.82rem;
  }
  .test-result.success { background: #0e2a1a; color: #34d399; border: 1px solid #1a4a2a; }
  .test-result.error { background: #2a0e0e; color: #f87171; border: 1px solid #4a1a1a; }

  .panel-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px; border-top: 1px solid #1e1e2e; flex-shrink: 0;
  }
  .footer-right { display: flex; gap: 8px; }

  .btn-primary {
    padding: 9px 18px; border-radius: 8px; border: none;
    background: #6366f1; color: #fff; font-size: 0.875rem; cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: #4f46e5; }
  .btn-primary:disabled { opacity: 0.6; cursor: default; }

  .btn-ghost {
    padding: 9px 16px; border-radius: 8px; border: 1px solid #2d2d3d;
    background: transparent; color: #9ca3af; font-size: 0.875rem; cursor: pointer;
    transition: all 0.12s;
  }
  .btn-ghost:hover:not(:disabled) { border-color: #4b5563; color: #e2e8f0; }
  .btn-ghost:disabled { opacity: 0.6; cursor: default; }
</style>
