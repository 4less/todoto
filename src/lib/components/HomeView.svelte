<script lang="ts">
  import { notes, todos, pendingTodos, recentNotes, syncState, activeView, selectedNoteId } from '$lib/stores';

  let { onSync }: { onSync: () => void } = $props();

  // ── Activity calendar ─────────────────────────────────────────────────────
  type CalMode = 'minutes' | 'tasks';
  let calMode: CalMode = $state('minutes');

  const CELL = 11;        // px — cell size
  const GAP  = 3;         // px — gap between cells
  const COL  = CELL + GAP; // 14px per column

  function localDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Build YYYY-MM-DD → value map
  const calMap = $derived.by(() => {
    const map = new Map<string, number>();
    for (const todo of $todos) {
      if (calMode === 'minutes') {
        for (const s of todo.work_sessions ?? []) {
          if (!s.start || !s.end) continue;
          const ms = new Date(s.end).getTime() - new Date(s.start).getTime();
          if (ms <= 0) continue;
          const key = localDateStr(new Date(s.start));
          map.set(key, (map.get(key) ?? 0) + ms / 60000);
        }
      } else {
        if (todo.done && todo.finished_at) {
          const key = localDateStr(new Date(todo.finished_at));
          map.set(key, (map.get(key) ?? 0) + 1);
        }
      }
    }
    return map;
  });

  const calPeak = $derived(Math.max(1, ...calMap.values()));

  function toLevel(value: number): 0 | 1 | 2 | 3 | 4 {
    if (value === 0) return 0;
    const r = value / calPeak;
    if (r <= 0.15) return 1;
    if (r <= 0.40) return 2;
    if (r <= 0.70) return 3;
    return 4;
  }

  // Color per level per mode
  function cellBg(lvl: number, empty: boolean): string {
    if (empty) return 'var(--border)';
    if (calMode === 'minutes') {
      return (['var(--surface-alt)', '#1c1c40', '#2d2d80', '#4f46e5', '#818cf8'] as const)[lvl] ?? 'var(--surface-alt)';
    } else {
      return (['var(--surface-alt)', '#0d2018', '#145228', '#238636', '#3fb950'] as const)[lvl] ?? 'var(--surface-alt)';
    }
  }

  // 53-week grid — all dates computed as direct offsets from today to avoid
  // any DST / timezone / while-loop-termination issues.
  const calGrid = $derived.by(() => {
    const now = new Date();
    const todayStr = localDateStr(now);
    const todayDow = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
    // Column 0 starts at the Monday that is 52 full weeks before this Monday.
    const startOffset = -(todayDow + 52 * 7); // day offset relative to today

    type Cell = { date: string | null; value: number; lvl: 0|1|2|3|4 };
    const weeks: Cell[][] = [];
    const months: { idx: number; text: string }[] = [];
    let lastMonth = -1;
    let total = 0;

    for (let w = 0; w < 53; w++) {
      const week: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(now);
        date.setDate(now.getDate() + startOffset + w * 7 + d);
        const key = localDateStr(date);
        if (key > todayStr) {
          week.push({ date: null, value: 0, lvl: 0 });
        } else {
          const val = calMap.get(key) ?? 0;
          total += val;
          week.push({ date: key, value: val, lvl: toLevel(val) });
        }
      }

      const firstReal = week.find(c => c.date);
      if (firstReal?.date) {
        const m = new Date(firstReal.date + 'T12:00').getMonth();
        if (m !== lastMonth) {
          months.push({ idx: w, text: new Date(firstReal.date + 'T12:00').toLocaleDateString([], { month: 'short' }) });
          lastMonth = m;
        }
      }

      weeks.push(week);
    }

    return { weeks, months, total, todayStr };
  });

  function fmtSummary(total: number): string {
    if (calMode === 'minutes') {
      const h = Math.floor(total / 60), m = Math.round(total % 60);
      const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
      return `${dur} worked in the past year`;
    }
    return `${total} task${total === 1 ? '' : 's'} completed in the past year`;
  }

  function fmtTooltip(cell: { date: string | null; value: number }): string {
    if (!cell.date) return '';
    const d = new Date(cell.date + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    if (cell.value === 0) return `No activity · ${d}`;
    if (calMode === 'minutes') {
      const h = Math.floor(cell.value / 60), m = Math.round(cell.value % 60);
      return `${h > 0 ? `${h}h ` : ''}${m}m worked · ${d}`;
    }
    return `${cell.value} task${cell.value === 1 ? '' : 's'} completed · ${d}`;
  }

  // ── Other helpers ─────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function fmtSync(iso: string | null): string {
    if (!iso) return 'Never synced';
    const d = new Date(iso), diff = Date.now() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function openNote(id: string) { selectedNoteId.set(id); activeView.set('docs'); }
  function priorityColor(p: string) {
    return p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--yellow)' : 'var(--text-5)';
  }
</script>

<div class="home">
  <header class="page-header">
    <div>
      <h1>Home</h1>
      <p class="subtitle">Your workspace at a glance</p>
    </div>
    <button class="sync-fab" onclick={onSync} title="Sync">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="{$syncState.syncing ? 'spinning' : ''}"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>
  </header>

  <!-- Activity calendar -->
  <div class="cal-card">
    <div class="cal-top">
      <span class="cal-summary">{fmtSummary(calGrid.total)}</span>
      <div class="cal-mode">
        <button class="mode-btn {calMode === 'minutes' ? 'active' : ''}" onclick={() => calMode = 'minutes'}>Minutes</button>
        <button class="mode-btn {calMode === 'tasks' ? 'active' : ''}" onclick={() => calMode = 'tasks'}>Tasks</button>
      </div>
    </div>

    <div class="cal-scroll">
      <!-- Month labels -->
      <div class="cal-months-row">
        <div class="day-lbl-spacer"></div>
        <div class="cal-months-inner">
          {#each calGrid.months as ml}
            <span class="cal-month-lbl" style="left: {ml.idx * COL}px">{ml.text}</span>
          {/each}
        </div>
      </div>

      <!-- Day labels + grid -->
      <div class="cal-body-row">
        <div class="cal-day-lbls">
          {#each ['', 'Mon', '', 'Wed', '', 'Fri', ''] as d}
            <span>{d}</span>
          {/each}
        </div>
        <div class="cal-grid" style="gap: {GAP}px">
          {#each calGrid.weeks as week}
            <div class="cal-col" style="gap: {GAP}px">
              {#each week as cell}
                <div
                  class="cal-cell {cell.date === calGrid.todayStr ? 'cal-today' : ''}"
                  style="background:{cellBg(cell.lvl, cell.date === null)}; width:{CELL}px; height:{CELL}px"
                  title={fmtTooltip(cell)}
                ></div>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <!-- Legend -->
      <div class="cal-legend">
        <span class="leg-text">Less</span>
        {#each [0, 1, 2, 3, 4] as l}
          <div class="cal-cell" style="background:{cellBg(l, false)}; width:{CELL}px; height:{CELL}px"></div>
        {/each}
        <span class="leg-text">More</span>
      </div>
    </div>
  </div>

  <!-- Stats row -->
  <div class="stats">
    <div class="stat-card">
      <span class="stat-value">{$pendingTodos.length}</span>
      <span class="stat-label">Pending tasks</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">{$notes.length}</span>
      <span class="stat-label">Documents</span>
    </div>
    <div class="stat-card">
      <span class="stat-value sync-status {$syncState.syncing ? 'syncing' : $syncState.lastResult?.success === false ? 'error' : 'ok'}">
        {$syncState.syncing ? '↻' : $syncState.lastResult?.success === false ? '✕' : '✓'}
      </span>
      <span class="stat-label">{fmtSync($syncState.lastSync)}</span>
    </div>
  </div>

  <div class="sections">
    <!-- Upcoming tasks -->
    <section class="section">
      <div class="section-header">
        <h2>Upcoming tasks</h2>
        <button class="link-btn" onclick={() => activeView.set('tasks')}>View all →</button>
      </div>
      {#if $pendingTodos.length === 0}
        <div class="empty-msg">No pending tasks — you're all caught up!</div>
      {:else}
        <ul class="task-list">
          {#each $pendingTodos.slice(0, 5) as todo}
            <li class="task-item" onclick={() => activeView.set('tasks')}>
              <div class="task-top">
                <span class="priority-dot" style="background:{priorityColor(todo.priority)}"></span>
                <span class="task-title">{todo.title}</span>
              </div>
              {#if todo.due_date || todo.tags.length > 0}
                <div class="task-meta">
                  {#if todo.due_date}<span class="due-chip">{todo.due_date}</span>{/if}
                  {#each todo.tags as tag}<span class="tag-chip">#{tag}</span>{/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Recent docs -->
    <section class="section">
      <div class="section-header">
        <h2>Recent docs</h2>
        <button class="link-btn" onclick={() => activeView.set('docs')}>View all →</button>
      </div>
      {#if $recentNotes.length === 0}
        <div class="empty-msg">No documents yet. Create your first note!</div>
      {:else}
        <ul class="doc-list">
          {#each $recentNotes as note}
            <li class="doc-item" onclick={() => openNote(note.id)}>
              <div class="doc-title">{note.title || 'Untitled'}</div>
              <div class="doc-meta">
                {fmtDate(note.updated_at)}
                {#each note.tags as tag}<span class="tag-chip">#{tag}</span>{/each}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .home {
    height: 100%;
    overflow-y: auto;
    padding: 28px 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; }
  h1 { font-size: 1.6rem; font-weight: 700; color: var(--text-1); }
  .subtitle { color: var(--text-6); font-size: 0.875rem; margin-top: 2px; }

  .sync-fab {
    width: 40px; height: 40px; border-radius: 12px; border: none;
    background: var(--border); color: var(--accent); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s;
  }
  .sync-fab:hover { background: var(--accent-bg-2); }
  :global(.spinning) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Calendar card ── */
  .cal-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 20px 14px;
  }

  .cal-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .cal-summary {
    font-size: 0.82rem;
    color: var(--text-4);
  }

  .cal-mode {
    display: flex;
    gap: 0;
    border: 1px solid var(--border-2);
    border-radius: 7px;
    overflow: hidden;
  }
  .mode-btn {
    padding: 3px 10px;
    font-size: 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-5);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .mode-btn:first-child { border-right: 1px solid var(--border-2); }
  .mode-btn.active { background: var(--accent-bg); color: var(--accent-ltr); }
  .mode-btn:hover:not(.active) { background: var(--surface-alt); color: var(--text-3); }

  .cal-scroll { overflow-x: auto; padding-bottom: 2px; }

  /* Month label row */
  .cal-months-row {
    display: flex;
    align-items: flex-end;
    margin-bottom: 4px;
  }
  .day-lbl-spacer { width: 28px; flex-shrink: 0; }
  .cal-months-inner {
    position: relative;
    height: 16px;
    flex: 1;
  }
  .cal-month-lbl {
    position: absolute;
    font-size: 0.7rem;
    color: var(--text-5);
    white-space: nowrap;
    top: 0;
  }

  /* Grid row */
  .cal-body-row { display: flex; align-items: flex-start; }

  .cal-day-lbls {
    width: 28px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 1px;
  }
  .cal-day-lbls span {
    height: 11px;
    line-height: 11px;
    font-size: 0.65rem;
    color: var(--text-6);
    text-align: right;
    padding-right: 4px;
  }

  .cal-grid { display: flex; }
  .cal-col { display: flex; flex-direction: column; }
  .cal-cell { border-radius: 2px; flex-shrink: 0; transition: filter 0.1s; }
  .cal-cell:hover { filter: brightness(1.4); }
  .cal-today { outline: 2px solid var(--accent-lt); outline-offset: -1px; }

  /* Legend */
  .cal-legend {
    display: flex;
    align-items: center;
    gap: 3px;
    justify-content: flex-end;
    margin-top: 8px;
  }
  .leg-text {
    font-size: 0.68rem;
    color: var(--text-6);
    margin: 0 3px;
  }

  /* ── Stats ── */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 20px; display: flex; flex-direction: column; gap: 4px;
  }
  .stat-value { font-size: 1.6rem; font-weight: 700; color: var(--text-1); }
  .stat-label { font-size: 0.8rem; color: var(--text-6); }
  .sync-status.syncing { color: var(--yellow); }
  .sync-status.error { color: var(--red); }
  .sync-status.ok { color: var(--green); }

  /* ── Sections ── */
  .sections {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .section {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 20px; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  h2 { font-size: 0.95rem; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; }
  .link-btn { background: none; border: none; color: var(--accent); font-size: 0.8rem; cursor: pointer; }
  .link-btn:hover { color: var(--accent-purple); }
  .empty-msg { color: var(--text-7); font-size: 0.85rem; padding: 12px 0; }

  .task-list, .doc-list { list-style: none; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
  .task-item {
    display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
    border-radius: 8px; cursor: pointer; transition: background 0.12s; font-size: 0.875rem;
  }
  .task-item:hover { background: var(--surface-alt); }
  .task-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .priority-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .task-title { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .task-meta { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 15px; }
  .doc-item { padding: 10px; border-radius: 8px; cursor: pointer; transition: background 0.12s; }
  .doc-item:hover { background: var(--surface-alt); }
  .doc-title { font-size: 0.875rem; color: var(--text-2); font-weight: 500; }
  .doc-meta { font-size: 0.75rem; color: var(--text-6); margin-top: 3px; display: flex; gap: 6px; align-items: center; }

  .tag-chip { font-size: 0.7rem; color: var(--accent-lt); background: var(--accent-bg); padding: 1px 6px; border-radius: 4px; }
  .due-chip { font-size: 0.7rem; color: var(--yellow); background: var(--yellow-bg); padding: 1px 6px; border-radius: 4px; white-space: nowrap; }

  @media (max-width: 700px) {
    .home { padding: 16px; }
    .stats { grid-template-columns: 1fr 1fr; }
    .sections { grid-template-columns: 1fr; }
  }
</style>
