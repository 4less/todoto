<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { base } from '$app/paths';
  import { api } from '$lib/api';
  import { notes, todos, settings, activeView, showSettings, syncState, diskFolders, theme,
    projects, activeProjectId, taskFilterTag, taskFilterGroupByTags, taskFilterHideUngrouped,
    taskFilterToday, draggingTodoId, dragOverToday, activeTimers, focusRequest, projectApplyTick,
    whiteboards, openWhiteboardId, tags, showTagManager } from '$lib/stores';
  import type { Project } from '$lib/types';
  import HomeView from '$lib/components/HomeView.svelte';
  import TasksView from '$lib/components/TasksView.svelte';
  import DocsView from '$lib/components/DocsView.svelte';
  import SearchView from '$lib/components/SearchView.svelte';
  import SettingsPanel from '$lib/components/SettingsPanel.svelte';
  import SyncIndicator from '$lib/components/SyncIndicator.svelte';
  import ProjectsNav from '$lib/components/ProjectsNav.svelte';
  import WhiteboardView from '$lib/components/WhiteboardView.svelte';
  import TagManager from '$lib/components/TagManager.svelte';
  import MentionHost from '$lib/components/MentionHost.svelte';

  let autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  let loading = $state(true);
  let sidebarCollapsed = $state(localStorage.getItem('todoto-sidebar-collapsed') === 'true');
  let drawerOpen = $state(false);

  function closeDrawer() { drawerOpen = false; }
  // Switching to a top-level view clears any applied project filter highlight.
  function navMain(id: typeof $activeView) {
    openWhiteboardId.set(null);
    activeProjectId.set(null);
    // "Today" is a filtered Tasks view rather than its own page.
    if (id === 'today') { taskFilterToday.set(true); activeView.set('tasks'); return; }
    taskFilterToday.set(false);
    activeView.set(id);
  }
  function isNavActive(id: typeof $activeView) {
    if (id === 'today') return $activeView === 'tasks' && $taskFilterToday;
    return $activeView === id && !$activeProjectId && !$taskFilterToday;
  }

  // Dragging a task onto the sidebar "Today" item pins it to today's workload.
  // The drop is handled by the pointer-drag logic in TasksView (which finds this
  // element via `data-drop-today`); here we only flag it as a valid target.
  function navTo(id: typeof $activeView) { navMain(id); closeDrawer(); }

  // Tasks with a running timer — one sidebar entry is shown per task so several
  // concurrently-logged tasks can each be jumped to.
  let liveTasks = $derived($todos.filter((t) => $activeTimers.has(t.id)));

  // Jump straight to a running ("live") task in focus mode, from anywhere in the app.
  function jumpToTaskFocus(id: string) {
    openWhiteboardId.set(null);
    activeView.set('tasks');
    focusRequest.set(id);
    closeDrawer();
  }

  // Apply a project shortcut: jump to Tasks, prefiltered to the project's tags.
  // The project tags become a hard constraint (handled in TasksView), so we start
  // from a clean per-page filter — the user can then filter/group within the project.
  function applyProject(p: Project) {
    openWhiteboardId.set(null);
    taskFilterTag.set('');
    taskFilterGroupByTags.set([]);
    taskFilterHideUngrouped.set(false);
    taskFilterToday.set(false);
    activeProjectId.set(p.id);
    activeView.set('tasks');
    projectApplyTick.update((n) => n + 1);
    closeDrawer();
  }

  $effect(() => {
    localStorage.setItem('todoto-sidebar-collapsed', String(sidebarCollapsed));
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  function applyTheme(t: 'system' | 'light' | 'dark' | 'midnight' | 'forest') {
    const resolved = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  // Initialize from localStorage before first render
  const savedTheme = localStorage.getItem('todoto-theme') as 'system' | 'light' | 'dark' | 'midnight' | 'forest' | null;
  if (savedTheme) theme.set(savedTheme);
  applyTheme(savedTheme ?? 'system');

  $effect(() => {
    localStorage.setItem('todoto-theme', $theme);
    applyTheme($theme);
  });

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadAll() {
    const [n, t, s, f, p, w, g] = await Promise.all([api.getNotes(), api.getTodos(), api.getSettings(), api.getFolders(), api.getProjects(), api.getWhiteboards(), api.getTags()]);
    notes.set(n);
    todos.set(t);
    settings.set(s);
    diskFolders.set(f);
    projects.set(p);
    whiteboards.set(w);
    tags.set(g);
    const lastSync = await api.getLastSync();
    syncState.update((st) => ({ ...st, lastSync }));
    scheduleAutoSync(s.auto_sync, s.sync_interval_seconds);
  }

  async function refreshNotesFromDisk() {
    const [fresh, folders] = await Promise.all([api.getNotes(), api.getFolders()]);
    diskFolders.set(folders);
    notes.update((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      for (const n of fresh) {
        const existing = byId.get(n.id);
        if (!existing || n.updated_at > existing.updated_at) byId.set(n.id, n);
      }
      return [...byId.values()].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)
      );
    });
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
      const [n, t, f, p, w, g] = await Promise.all([api.getNotes(), api.getTodos(), api.getFolders(), api.getProjects(), api.getWhiteboards(), api.getTags()]);
      notes.set(n); todos.set(t); diskFolders.set(f); projects.set(p); tags.set(g);
      // An open board is being edited right now — adopting the just-synced copy
      // would clobber unsaved local moves, so leave the store alone until it closes.
      if (!get(openWhiteboardId)) whiteboards.set(w);
      // Only advance lastSync on success — a failed attempt must not be shown as
      // the last sync time.
      syncState.update((s) => ({ syncing: false, lastResult: result, lastSync: result.success ? result.timestamp : s.lastSync }));
    } catch {
      syncState.update((s) => ({ ...s, syncing: false }));
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); triggerSync(); }
  }

  onMount(() => {
    loadAll().finally(() => { loading = false; });
    const onFocus = () => void refreshNotesFromDisk();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => { if (get(theme) === 'system') applyTheme('system'); };
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('focus', onFocus);
    mq.addEventListener('change', onSystemChange);
    return () => {
      if (autoSyncTimer) clearInterval(autoSyncTimer);
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('focus', onFocus);
      mq.removeEventListener('change', onSystemChange);
    };
  });

  // ── Nav ───────────────────────────────────────────────────────────────────
  const navItems = [
    { id: 'home'   as const, label: 'Home',   svg: svgHome   },
    { id: 'tasks'  as const, label: 'Tasks',  svg: svgTasks  },
    { id: 'today'  as const, label: 'Today',  svg: svgToday  },
    { id: 'docs'   as const, label: 'Docs',   svg: svgDocs   },
    { id: 'search' as const, label: 'Search', svg: svgSearch },
  ];

  // All nav SVGs use currentColor so CSS drives active/inactive tinting
  function svgHome() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }
  function svgTasks() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
  }
  function svgToday() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="7.05"/></svg>`;
  }
  function svgDocs() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  }
  function svgSearch() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  }
</script>

<div class="app">
  <!-- Desktop sidebar -->
  <nav class="sidebar {sidebarCollapsed ? 'collapsed' : ''}">
    <div class="sidebar-header">
      {#if !sidebarCollapsed}
        <div class="sidebar-logo">
          <img src="{base}/logo.png" alt="todoto" class="logo-img" />
          <span class="logo-text">todoto</span>
        </div>
      {/if}
      <button class="collapse-btn" onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <!-- Panel-left icon — same as Claude's sidebar toggle -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M9 3v18"/>
        </svg>
      </button>
    </div>

    <div class="sidebar-nav">
      {#each navItems as item}
        <button
          class="nav-item {isNavActive(item.id) ? 'active' : ''}"
          class:today-droppable={item.id === 'today' && $draggingTodoId}
          class:today-dropover={item.id === 'today' && $dragOverToday}
          data-drop-today={item.id === 'today' ? '' : undefined}
          onclick={() => navMain(item.id)}
          title={sidebarCollapsed ? item.label : ''}
        >
          {@html item.svg()}
          {#if !sidebarCollapsed}<span>{item.label}</span>{/if}
        </button>
      {/each}

      {#each liveTasks as t (t.id)}
        <button class="nav-item live-focus" onclick={() => jumpToTaskFocus(t.id)}
          title={sidebarCollapsed ? t.title : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="10" ry="6"/><circle cx="12" cy="12" r="3"/></svg>
          {#if !sidebarCollapsed}<span class="live-task-name">{t.title}</span>{/if}
          <span class="live-pip"></span>
        </button>
      {/each}

      <ProjectsNav collapsed={sidebarCollapsed} onApply={applyProject} />
    </div>

    <div class="sidebar-footer">
      <SyncIndicator onSync={triggerSync} collapsed={sidebarCollapsed} />
      <button class="settings-btn" onclick={() => showTagManager.set(true)}
        title={sidebarCollapsed ? 'Tags' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        {#if !sidebarCollapsed}Tags{/if}
      </button>
      <button class="settings-btn" onclick={() => showSettings.set(true)}
        title={sidebarCollapsed ? 'Settings' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        {#if !sidebarCollapsed}Settings{/if}
      </button>
    </div>
  </nav>

  <!-- Main content -->
  <main class="main">
    {#if $openWhiteboardId}
      <!-- An open board takes over the whole content area; only the menubar stays. -->
      <WhiteboardView boardId={$openWhiteboardId} />
    {:else if $activeView === 'home'}
      <HomeView onSync={triggerSync} />
    {:else if $activeView === 'tasks'}
      <TasksView />
    {:else if $activeView === 'docs'}
      <DocsView onTodosChanged={loadAll} />
    {:else if $activeView === 'search'}
      <SearchView />
    {/if}
  </main>

  <!-- Mobile top bar (hamburger) -->
  <header class="mobile-header">
    <button class="hamburger" onclick={() => (drawerOpen = true)} aria-label="Open menu">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6"  x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <span class="mobile-title">{navItems.find(n => n.id === $activeView)?.label ?? 'todoto'}</span>
    <SyncIndicator onSync={triggerSync} collapsed={true} />
  </header>

  <!-- Mobile drawer backdrop -->
  {#if drawerOpen}
    <div class="drawer-backdrop" onclick={closeDrawer} aria-hidden="true"></div>
  {/if}

  <!-- Mobile drawer -->
  <nav class="drawer {drawerOpen ? 'open' : ''}">
    <div class="drawer-header">
      <img src="{base}/logo.png" alt="todoto" class="logo-img" />
      <span class="logo-text">todoto</span>
      <button class="drawer-close" onclick={closeDrawer} aria-label="Close menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="drawer-nav">
      {#each navItems as item}
        <button class="drawer-item {isNavActive(item.id) ? 'active' : ''}" onclick={() => navTo(item.id)}>
          {@html item.svg()}
          <span>{item.label}</span>
        </button>
      {/each}

      {#each liveTasks as t (t.id)}
        <button class="drawer-item live-focus" onclick={() => jumpToTaskFocus(t.id)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="10" ry="6"/><circle cx="12" cy="12" r="3"/></svg>
          <span class="live-task-name">{t.title}</span>
          <span class="live-pip"></span>
        </button>
      {/each}

      <ProjectsNav collapsed={false} onApply={applyProject} />
    </div>
    <div class="drawer-footer">
      <button class="drawer-item" onclick={() => { showTagManager.set(true); closeDrawer(); }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        <span>Tags</span>
      </button>
      <button class="drawer-item" onclick={() => { showSettings.set(true); closeDrawer(); }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Settings</span>
      </button>
    </div>
  </nav>

  {#if $showSettings}
    <SettingsPanel onSaved={loadAll} />
  {/if}

  {#if $showTagManager}
    <TagManager />
  {/if}

  <!-- Renders the "@" suggestion and link picker for every field that opts in. -->
  <MentionHost />

  <div class="splash {loading ? '' : 'done'}">
    <div class="splash-content">
      <img src="{base}/logo.png" alt="" class="splash-logo" />
      <span class="splash-wordmark">todoto</span>
      <div class="splash-dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  </div>
</div>

<style>
  :global(html), :global(body) { margin: 0; padding: 0; width: 100%; height: 100%; }
  :global(*), :global(*::before), :global(*::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: var(--bg);
    color: var(--text-2);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    height: 100dvh;
    overflow: hidden;
  }
  :global(::-webkit-scrollbar) { width: 4px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: var(--border-2); border-radius: 2px; }

  .app { display: flex; height: 100dvh; overflow: hidden; background: var(--bg); padding-top: env(safe-area-inset-top); }

  .sidebar {
    width: 200px; min-width: 200px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 12px; gap: 4px;
    transition: width 0.2s ease, min-width 0.2s ease, padding 0.2s ease;
    overflow: hidden;
  }
  .sidebar.collapsed { width: 64px; min-width: 64px; padding: 20px 8px; }

  .sidebar-header {
    display: flex; align-items: center;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 8px;
    min-height: 40px;
  }
  .sidebar.collapsed .sidebar-header { justify-content: center; }

  .sidebar-logo { display: flex; align-items: center; gap: 8px; flex: 1; overflow: hidden; }
  .logo-img { width: 24px; height: 24px; object-fit: contain; flex-shrink: 0; }
  .logo-text {
    font-size: 1.3rem; font-weight: 700;
    background: linear-gradient(135deg, var(--accent), var(--accent-purple));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    letter-spacing: -0.5px; white-space: nowrap;
  }

  .collapse-btn {
    flex-shrink: 0; margin-left: auto;
    width: 28px; height: 28px; border-radius: 6px; border: none;
    background: transparent; color: var(--text-6); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .collapse-btn:hover { background: var(--border); color: var(--text-2); }
  .sidebar.collapsed .collapse-btn { margin-left: 0; }

  .sidebar-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }

  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 10px; border: none;
    background: transparent; color: var(--text-4);
    font-size: 0.875rem; font-weight: 500;
    cursor: pointer; transition: background 0.15s, color 0.15s;
    text-align: left; width: 100%;
  }
  .nav-item:hover { background: var(--border); color: var(--text-2); }
  .nav-item.active { background: var(--accent-bg); color: var(--accent); }
  .nav-item.today-droppable { outline: 1px dashed var(--accent); outline-offset: -2px; }
  .nav-item.today-dropover { background: var(--accent); color: #fff; outline-color: transparent; }
  .sidebar.collapsed .nav-item { justify-content: center; padding: 10px; gap: 0; }

  /* Quick-jump to the running task — green to match the live timer bar. */
  .live-focus { color: var(--green); position: relative; }
  .live-focus:hover { background: color-mix(in srgb, var(--green) 14%, transparent); color: var(--green); }
  .live-focus svg { flex-shrink: 0; }
  /* The task name fills the row and truncates so long titles don't overflow. */
  .live-task-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-pip {
    width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0;
    margin-left: auto; animation: live-pip-pulse 1.5s ease-in-out infinite;
  }
  .sidebar.collapsed .live-focus { gap: 0; }
  .sidebar.collapsed .live-focus .live-pip {
    position: absolute; top: 6px; right: 6px; margin-left: 0;
  }
  @keyframes live-pip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  .sidebar-footer {
    display: flex; flex-direction: column; gap: 4px;
    padding-top: 12px; border-top: 1px solid var(--border);
  }

  .settings-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 8px; border: none;
    background: transparent; color: var(--text-5);
    font-size: 0.8rem; cursor: pointer;
    transition: background 0.15s, color 0.15s; width: 100%; text-align: left;
  }
  .settings-btn:hover { background: var(--border); color: var(--text-2); }
  .sidebar.collapsed .settings-btn { justify-content: center; padding: 8px; gap: 0; }

  .main { flex: 1; overflow: hidden; display: flex; flex-direction: column; background: var(--bg); }

  /* ── Mobile top bar ──────────────────────────────────────────────────────── */
  .mobile-header {
    display: none; align-items: center; gap: 12px;
    padding: 0 16px; height: 52px; flex-shrink: 0;
    background: var(--surface); border-bottom: 1px solid var(--border);
    position: relative; z-index: 10;
  }
  .hamburger {
    width: 36px; height: 36px; border-radius: 8px; border: none;
    background: transparent; color: var(--text-3); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s;
  }
  .hamburger:hover { background: var(--border); }
  .mobile-title {
    flex: 1; font-size: 1rem; font-weight: 600; color: var(--text-2);
  }

  /* ── Drawer backdrop ─────────────────────────────────────────────────────── */
  .drawer-backdrop {
    display: none; position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.45);
    animation: fade-in 0.2s ease;
  }

  /* ── Slide-in drawer ─────────────────────────────────────────────────────── */
  .drawer {
    display: none; position: fixed; top: 0; left: 0; bottom: 0;
    width: 260px; z-index: 201;
    background: var(--surface); border-right: 1px solid var(--border);
    flex-direction: column; padding: 20px 12px;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }
  .drawer.open { transform: translateX(0); }

  .drawer-header {
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 16px; border-bottom: 1px solid var(--border); margin-bottom: 8px;
  }
  .drawer-close {
    margin-left: auto; width: 28px; height: 28px; border-radius: 6px; border: none;
    background: transparent; color: var(--text-5); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .drawer-close:hover { background: var(--border); color: var(--text-2); }

  .drawer-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }
  .drawer-footer { padding-top: 12px; border-top: 1px solid var(--border); }

  .drawer-item {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 12px; border-radius: 10px; border: none;
    background: transparent; color: var(--text-4);
    font-size: 0.9rem; font-weight: 500; cursor: pointer;
    transition: background 0.15s, color 0.15s; width: 100%; text-align: left;
  }
  .drawer-item:hover { background: var(--border); color: var(--text-2); }
  .drawer-item.active { background: var(--accent-bg); color: var(--accent); }

  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  @media (max-width: 600px) {
    .app { flex-direction: column; }
    .sidebar { display: none; }
    .mobile-header { display: flex; order: -1; }
    .drawer-backdrop { display: block; }
    .drawer { display: flex; }
    .main { padding-top: 0; }
  }

  .splash {
    position: fixed; inset: 0; z-index: 1000;
    background: var(--bg);
    display: flex; align-items: center; justify-content: center;
    transition: opacity 0.4s ease, visibility 0.4s ease;
  }
  .splash.done { opacity: 0; visibility: hidden; pointer-events: none; }
  .splash-content {
    display: flex; flex-direction: column; align-items: center; gap: 16px;
    animation: splash-rise 0.5s ease both;
  }
  .splash-logo { width: 56px; height: 56px; object-fit: contain; animation: splash-pulse 2s ease-in-out infinite; }
  .splash-wordmark {
    font-size: 1.8rem; font-weight: 700; letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--accent), var(--accent-purple));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .splash-dots { display: flex; gap: 6px; margin-top: 4px; }
  .splash-dots span {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent); opacity: 0.3;
    animation: splash-dot 1.2s ease-in-out infinite;
  }
  .splash-dots span:nth-child(2) { animation-delay: 0.2s; }
  .splash-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes splash-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes splash-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.06); opacity: 0.85; } }
  @keyframes splash-dot { 0%, 80%, 100% { opacity: 0.3; transform: scale(1); } 40% { opacity: 1; transform: scale(1.4); } }
</style>
