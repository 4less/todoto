<script lang="ts">
  import { settings, showSettings, syncState, theme, taskShowDividers } from '$lib/stores';
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
      syncState.update((s) => ({ ...s, lastResult: result, lastSync: result.success ? result.timestamp : s.lastSync }));
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
    <!-- Appearance section -->
    <section class="settings-section">
      <h3>Appearance</h3>
      <div class="field">
        <label>Theme</label>
        <div class="theme-grid">
          {#each [
            ['system',   'Auto',     'system'],
            ['light',    'Light',    'light'],
            ['dark',     'Dark',     'dark'],
            ['midnight', 'Midnight', 'midnight'],
            ['forest',   'Forest',   'forest'],
          ] as [val, label, icon]}
            <button
              class="theme-btn {$theme === val ? 'active' : ''}"
              onclick={() => theme.set(val as 'system' | 'light' | 'dark' | 'midnight' | 'forest')}
              type="button"
            >
              {#if icon === 'system'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
              {:else if icon === 'light'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              {:else if icon === 'dark'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              {:else if icon === 'midnight'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              {:else if icon === 'forest'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8C8 10 5.9 16.17 3.82 19.5c.5.7 1.18.5 1.68 0L12 13l6.18 6.5c.5.5 1.18.7 1.68 0C17.32 16.17 16 10 17 8z"/><path d="M12 13V22"/></svg>
              {/if}
              {label}
            </button>
          {/each}
        </div>
      </div>
      <div class="toggle-row">
        <label class="toggle-label" for="s-task-dividers">
          <input id="s-task-dividers" type="checkbox" bind:checked={$taskShowDividers} class="checkbox" />
          <span>Show dividers between tasks</span>
        </label>
      </div>
    </section>

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
    background: var(--surface); border-left: 1px solid var(--border);
    z-index: 201; display: flex; flex-direction: column;
    animation: slide-in 0.2s ease;
  }
  @keyframes slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  h2 { font-size: 1.1rem; font-weight: 600; color: var(--text-1); }
  .close-btn {
    width: 32px; height: 32px; border-radius: 8px; border: none;
    background: transparent; color: var(--text-5); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .close-btn:hover { background: var(--border); color: var(--text-2); }

  .panel-body { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 24px; }

  .settings-section { display: flex; flex-direction: column; gap: 14px; }
  h3 { font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-6); }
  .section-desc { font-size: 0.82rem; color: var(--text-7); line-height: 1.5; }

  .field { display: flex; flex-direction: column; gap: 5px; }
  label { font-size: 0.82rem; color: var(--text-3); font-weight: 500; }
  .field-hint { font-size: 0.75rem; color: var(--text-7); }
  .field-hint a { color: var(--accent-lt); text-decoration: none; }
  .field-hint a:hover { text-decoration: underline; }

  .input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 9px 12px; font-size: 0.875rem; outline: none;
    transition: border-color 0.12s;
  }
  .input:focus { border-color: var(--accent); }
  .input.narrow { max-width: 120px; }

  .token-row { display: flex; gap: 8px; }
  .token-row .input { flex: 1; }
  .toggle-btn {
    padding: 0 12px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.8rem; cursor: pointer;
    white-space: nowrap;
  }
  .toggle-btn:hover { border-color: var(--text-8); color: var(--text-2); }

  .theme-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .theme-btn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.82rem; cursor: pointer;
    transition: all 0.12s;
  }
  .theme-btn:hover { border-color: var(--accent); color: var(--text-2); }
  .theme-btn.active { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  .toggle-row { display: flex; align-items: center; }
  .toggle-label { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 0.875rem; color: var(--text-2); }
  .checkbox { accent-color: var(--accent); width: 16px; height: 16px; cursor: pointer; }

  .test-result {
    padding: 10px 14px; border-radius: 8px; font-size: 0.82rem;
  }
  .test-result.success { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
  .test-result.error { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border-2); }

  .panel-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px; border-top: 1px solid var(--border); flex-shrink: 0;
  }
  .footer-right { display: flex; gap: 8px; }

  .btn-primary {
    padding: 9px 18px; border-radius: 8px; border: none;
    background: var(--accent); color: #fff; font-size: 0.875rem; cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-dk); }
  .btn-primary:disabled { opacity: 0.6; cursor: default; }

  .btn-ghost {
    padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.875rem; cursor: pointer;
    transition: all 0.12s;
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--text-8); color: var(--text-2); }
  .btn-ghost:disabled { opacity: 0.6; cursor: default; }
</style>
