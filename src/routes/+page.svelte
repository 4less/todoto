<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { notes, todos, settings, activeView, showSettings, syncState } from '$lib/stores';
  import HomeView from '$lib/components/HomeView.svelte';
  import TasksView from '$lib/components/TasksView.svelte';
  import DocsView from '$lib/components/DocsView.svelte';
  import SearchView from '$lib/components/SearchView.svelte';
  import SettingsPanel from '$lib/components/SettingsPanel.svelte';
  import SyncIndicator from '$lib/components/SyncIndicator.svelte';

  let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  async function loadAll() {
    const [n, t, s] = await Promise.all([api.getNotes(), api.getTodos(), api.getSettings()]);
    notes.set(n);
    todos.set(t);
    settings.set(s);
    const lastSync = await api.getLastSync();
    syncState.update((st) => ({ ...st, lastSync }));
    scheduleAutoSync(s.auto_sync, s.sync_interval_seconds);
  }

  function scheduleAutoSync(enabled: boolean, intervalSecs: number) {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    if (!enabled || intervalSecs <= 0) return;
    autoSyncTimer = setInterval(triggerSync, intervalSecs * 1000);
  }

  async function triggerSync() {
    syncState.update((s) => ({ ...s, syncing: true }));
    try {
      const result = await api.syncNow();
      const [n, t] = await Promise.all([api.getNotes(), api.getTodos()]);
      notes.set(n);
      todos.set(t);
      syncState.set({ syncing: false, lastResult: result, lastSync: result.timestamp });
    } catch {
      syncState.update((s) => ({ ...s, syncing: false }));
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      triggerSync();
    }
  }

  onMount(() => {
    loadAll();
    window.addEventListener('keydown', handleKeydown);
    return () => {
      if (autoSyncTimer) clearInterval(autoSyncTimer);
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  const navItems = [
    { id: 'home'   as const, label: 'Home',   svg: svgHome   },
    { id: 'tasks'  as const, label: 'Tasks',  svg: svgTasks  },
    { id: 'docs'   as const, label: 'Docs',   svg: svgDocs   },
    { id: 'search' as const, label: 'Search', svg: svgSearch },
  ];

  function svgHome(a: boolean) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${a?'#6366f1':'#9ca3af'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }
  function svgTasks(a: boolean) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${a?'#6366f1':'#9ca3af'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
  }
  function svgDocs(a: boolean) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${a?'#6366f1':'#9ca3af'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  }
  function svgSearch(a: boolean) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${a?'#6366f1':'#9ca3af'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  }
</script>

<div class="app">
  <!-- Desktop sidebar -->
  <nav class="sidebar">
    <div class="sidebar-logo">
      <img src="/logo.png" alt="todoto" class="logo-img" />
      <span class="logo-text">todoto</span>
    </div>

    <div class="sidebar-nav">
      {#each navItems as item}
        <button
          class="nav-item {$activeView === item.id ? 'active' : ''}"
          onclick={() => activeView.set(item.id)}
        >
          {@html item.svg($activeView === item.id)}
          <span>{item.label}</span>
        </button>
      {/each}
    </div>

    <div class="sidebar-footer">
      <SyncIndicator onSync={triggerSync} />
      <button class="settings-btn" onclick={() => showSettings.set(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Settings
      </button>
    </div>
  </nav>

  <!-- Main content -->
  <main class="main">
    {#if $activeView === 'home'}
      <HomeView onSync={triggerSync} />
    {:else if $activeView === 'tasks'}
      <TasksView />
    {:else if $activeView === 'docs'}
      <DocsView onTodosChanged={loadAll} />
    {:else if $activeView === 'search'}
      <SearchView />
    {/if}
  </main>

  <!-- Mobile bottom nav -->
  <nav class="bottom-nav">
    {#each navItems as item}
      <button
        class="bottom-nav-item {$activeView === item.id ? 'active' : ''}"
        onclick={() => activeView.set(item.id)}
      >
        {@html item.svg($activeView === item.id)}
        <span>{item.label}</span>
      </button>
    {/each}
    <button class="bottom-nav-item" onclick={() => showSettings.set(true)}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>Settings</span>
    </button>
  </nav>

  {#if $showSettings}
    <SettingsPanel onSaved={loadAll} />
  {/if}
</div>

<style>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
  }

  :global(*), :global(*::before), :global(*::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: #0f0f14;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    height: 100dvh;
    overflow: hidden;
  }
  :global(::-webkit-scrollbar) { width: 4px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: #2d2d3d; border-radius: 2px; }

  .app { display: flex; height: 100dvh; overflow: hidden; background: #0f0f14; padding-top: env(safe-area-inset-top); }

  .sidebar {
    width: 200px;
    min-width: 200px;
    background: #13131a;
    border-right: 1px solid #1e1e2e;
    display: flex;
    flex-direction: column;
    padding: 20px 12px;
    gap: 4px;
  }

  .sidebar-logo { padding: 4px 8px 16px; border-bottom: 1px solid #1e1e2e; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .logo-img { width: 24px; height: 24px; object-fit: contain; }
  .logo-text {
    font-size: 1.3rem; font-weight: 700;
    background: linear-gradient(135deg, #6366f1, #a78bfa);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    letter-spacing: -0.5px;
  }

  .sidebar-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; }

  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 10px; border: none;
    background: transparent; color: #9ca3af;
    font-size: 0.875rem; font-weight: 500;
    cursor: pointer; transition: background 0.15s, color 0.15s;
    text-align: left; width: 100%;
  }
  .nav-item:hover { background: #1e1e2e; color: #e2e8f0; }
  .nav-item.active { background: #1e1e3a; color: #6366f1; }

  .sidebar-footer {
    display: flex; flex-direction: column; gap: 4px;
    padding-top: 12px; border-top: 1px solid #1e1e2e;
  }

  .settings-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 8px; border: none;
    background: transparent; color: #6b7280;
    font-size: 0.8rem; cursor: pointer;
    transition: background 0.15s, color 0.15s; width: 100%; text-align: left;
  }
  .settings-btn:hover { background: #1e1e2e; color: #e2e8f0; }

  .main { flex: 1; overflow: hidden; display: flex; flex-direction: column; background: #0f0f14; }

  .bottom-nav {
    display: none; position: fixed; bottom: 0; left: 0; right: 0;
    background: #13131a; border-top: 1px solid #1e1e2e;
    padding: 6px 0 max(8px, env(safe-area-inset-bottom)); z-index: 100;
  }
  .bottom-nav-item {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 4px; border: none; background: transparent;
    color: #6b7280; font-size: 0.68rem; cursor: pointer; transition: color 0.15s;
  }
  .bottom-nav-item.active { color: #6366f1; }
  .bottom-nav-item span { font-weight: 500; }

  @media (max-width: 600px) {
    .sidebar { display: none; }
    .bottom-nav { display: flex; }
    .main { padding-bottom: 68px; }
  }
</style>
