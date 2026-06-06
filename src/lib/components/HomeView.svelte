<script lang="ts">
  import { notes, todos, pendingTodos, recentNotes, syncState, activeView, selectedNoteId } from '$lib/stores';

  let { onSync }: { onSync: () => void } = $props();

  // ── Activity calendar ─────────────────────────────────────────────────────
  type CalMode = 'minutes' | 'tasks';
  let calMode: CalMode = $state('minutes');

  const GAP  = 4;
  const DAY_LBL_W = 28;
  const MAX_WEEKS = 53;       // one trailing year
  const MIN_CELL = 10;        // never shrink cells below this…
  const MAX_CELL = 16;        // …nor grow them beyond this
  let calContainerWidth = $state(0);

  // Width available for the week columns (excludes the day-label gutter).
  const innerW = $derived(Math.max(0, calContainerWidth - DAY_LBL_W));
  // How many recent weeks fit at the minimum cell size — capped at a year.
  // Before the container is measured, assume the full year (clipped if needed).
  const weeksToShow = $derived(
    calContainerWidth > 0
      ? Math.max(1, Math.min(MAX_WEEKS, Math.floor((innerW + GAP) / (MIN_CELL + GAP))))
      : MAX_WEEKS
  );
  // Size cells to fill the available width for the weeks we're showing.
  const CELL = $derived(
    Math.min(MAX_CELL, Math.max(MIN_CELL, Math.floor((innerW - (weeksToShow - 1) * GAP) / weeksToShow)))
  );
  const COL  = $derived(CELL + GAP);

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

  // Full trailing-year total — kept independent of how many weeks are drawn so
  // the "past year" headline stays accurate even when the grid is narrowed.
  const yearTotal = $derived.by(() => {
    const now = new Date();
    const todayStr = localDateStr(now);
    const todayDow = (now.getDay() + 6) % 7;
    const startOffset = -(todayDow + (MAX_WEEKS - 1) * 7);
    let total = 0;
    for (let i = 0; i < MAX_WEEKS * 7; i++) {
      const date = new Date(now);
      date.setDate(now.getDate() + startOffset + i);
      const key = localDateStr(date);
      if (key > todayStr) continue;
      total += calMap.get(key) ?? 0;
    }
    return total;
  });

  // Heatmap grid — renders only the most recent `weeksToShow` weeks so it fits
  // the window. Dates are direct offsets from today to avoid DST/timezone issues.
  const calGrid = $derived.by(() => {
    const wks = weeksToShow;
    const now = new Date();
    const todayStr = localDateStr(now);
    const todayDow = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
    // Column 0 starts at the Monday of the oldest week we're showing.
    const startOffset = -(todayDow + (wks - 1) * 7);

    type Cell = { date: string | null; value: number; lvl: 0|1|2|3|4 };
    const weeks: Cell[][] = [];
    const months: { idx: number; text: string }[] = [];
    let lastMonth = -1;

    for (let w = 0; w < wks; w++) {
      const week: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(now);
        date.setDate(now.getDate() + startOffset + w * 7 + d);
        const key = localDateStr(date);
        if (key > todayStr) {
          week.push({ date: null, value: 0, lvl: 0 });
        } else {
          const val = calMap.get(key) ?? 0;
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

    return { weeks, months, todayStr };
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

  // ── 24h Timeline ─────────────────────────────────────────────────────────
  const TL_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#ec4899','#8b5cf6','#f97316'];

  let tlColorTags: string[] = $state([]);
  let tlDropdownOpen = $state(false);
  let tlTick = $state(0);

  $effect(() => {
    const id = setInterval(() => { tlTick++; }, 30000);
    return () => clearInterval(id);
  });

  let allTags = $derived([...new Set($todos.flatMap(t => t.tags))].sort().filter(t => t !== 'other'));

  const tlNowFrac = $derived.by(() => {
    void tlTick;
    const n = new Date();
    return (n.getHours() * 60 + n.getMinutes()) / 1440;
  });

  const tlNowLabel = $derived.by(() => {
    void tlTick;
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const tlTodayLabel = $derived(
    new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  );

  function tlTagColor(tags: string[]): string {
    for (const tag of tags) {
      const idx = tlColorTags.indexOf(tag);
      if (idx >= 0) return TL_COLORS[idx % TL_COLORS.length];
    }
    return 'var(--border-2)';
  }

  function tlToggleTag(tag: string) {
    if (tlColorTags.includes(tag)) tlColorTags = tlColorTags.filter(t => t !== tag);
    else tlColorTags = [...tlColorTags, tag];
  }

  const tlSessions = $derived.by(() => {
    void tlTick;
    const todayStr = localDateStr(new Date());
    const out: { startFrac: number; widthFrac: number; color: string; tooltip: string }[] = [];
    for (const todo of $todos) {
      for (const s of todo.work_sessions ?? []) {
        if (!s.start || !s.end) continue;
        const startD = new Date(s.start);
        if (localDateStr(startD) !== todayStr) continue;
        const endD = new Date(s.end);
        const startMin = startD.getHours() * 60 + startD.getMinutes();
        const endMin   = endD.getHours()   * 60 + endD.getMinutes();
        const durMin   = Math.max(1, endMin - startMin);
        const h = Math.floor(durMin / 60), m = durMin % 60;
        out.push({
          startFrac: startMin / 1440,
          widthFrac: durMin / 1440,
          color: tlTagColor(todo.tags),
          tooltip: `${todo.title} · ${h > 0 ? `${h}h ` : ''}${m}m`,
        });
      }
    }
    return out;
  });

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
    return p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--yellow)' : p === 'low' ? 'var(--text-5)' : 'transparent';
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
      <span class="cal-summary">{fmtSummary(yearTotal)}</span>
      <div class="cal-mode">
        <button class="mode-btn {calMode === 'minutes' ? 'active' : ''}" onclick={() => calMode = 'minutes'}>Minutes</button>
        <button class="mode-btn {calMode === 'tasks' ? 'active' : ''}" onclick={() => calMode = 'tasks'}>Tasks</button>
      </div>
    </div>

    <div class="cal-scroll" bind:clientWidth={calContainerWidth}>
      <!-- Month labels -->
      <div class="cal-months-row">
        <div class="day-lbl-spacer"></div>
        <div class="cal-months-inner" style="width: {weeksToShow * COL}px">
          {#each calGrid.months as ml}
            <span class="cal-month-lbl" style="left: {ml.idx * COL}px">{ml.text}</span>
          {/each}
        </div>
      </div>

      <!-- Day labels + grid -->
      <div class="cal-body-row">
        <div class="cal-day-lbls" style="gap: {GAP}px">
          {#each ['Mon', '', 'Wed', '', 'Fri', '', ''] as d}
            <span style="height: {CELL}px; line-height: {CELL}px">{d}</span>
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

  <!-- 24h Timeline -->
  <div class="tl-card" onclick={() => { if (tlDropdownOpen) tlDropdownOpen = false; }}>
    <div class="tl-header">
      <div class="tl-title-group">
        <span class="tl-title">Today</span>
        <span class="tl-date">{tlTodayLabel}</span>
      </div>
      <div class="tl-dropdown-wrap" onclick={(e) => e.stopPropagation()}>
        <button class="tl-dropdown-btn {tlColorTags.length > 0 ? 'active' : ''}"
          onclick={() => (tlDropdownOpen = !tlDropdownOpen)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          Colour by tag
          {#if tlColorTags.length > 0}<span class="tl-tag-count">{tlColorTags.length}</span>{/if}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.15s; transform: rotate({tlDropdownOpen ? '180' : '0'}deg)"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        {#if tlDropdownOpen}
          <div class="tl-dropdown">
            {#if allTags.length === 0}
              <span class="tl-dropdown-empty">No tags yet</span>
            {:else}
              {#each allTags as tag}
                {@const selected = tlColorTags.includes(tag)}
                {@const colorIdx = tlColorTags.indexOf(tag)}
                <label class="tl-tag-row">
                  <input type="checkbox" checked={selected} onchange={() => tlToggleTag(tag)} />
                  <span class="tl-tag-swatch" style="background:{selected ? TL_COLORS[colorIdx % TL_COLORS.length] : 'var(--border-2)'}"></span>
                  #{tag}
                </label>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Track -->
    <div class="tl-track-wrap">
      <div class="tl-now-label-row" style="--now:{tlNowFrac * 100}%">
        <span class="tl-now-time">{tlNowLabel}</span>
      </div>
      <div class="tl-track">
        {#each [6, 12, 18] as h}
          <div class="tl-grid-line" style="left:{h/24*100}%"></div>
        {/each}
        {#each tlSessions as s}
          <div class="tl-bar" style="left:{s.startFrac*100}%; width:max(3px,{s.widthFrac*100}%); background:{s.color}" title={s.tooltip}></div>
        {/each}
        <div class="tl-now-line" style="left:{tlNowFrac*100}%"></div>
      </div>
      <div class="tl-hours">
        {#each [0, 3, 6, 9, 12, 15, 18, 21, 24] as h}
          <span class="tl-hour-lbl" style="left:{h/24*100}%">{h === 0 ? '0h' : `${h}h`}</span>
        {/each}
      </div>
    </div>

    {#if tlColorTags.length > 0}
      <div class="tl-legend">
        {#each tlColorTags as tag, i}
          <span class="tl-legend-item">
            <span class="tl-legend-dot" style="background:{TL_COLORS[i % TL_COLORS.length]}"></span>
            #{tag}
          </span>
        {/each}
        <span class="tl-legend-item tl-legend-other">
          <span class="tl-legend-dot" style="background:var(--border-2)"></span>
          other
        </span>
      </div>
    {/if}
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

  /* overflow:hidden is a safety net — the grid is sized to fit, but this also
     swallows the up-to-1-gap rounding slack and the pre-measurement first frame. */
  .cal-scroll { padding-bottom: 2px; width: 100%; overflow: hidden; }

  /* Month label row */
  .cal-months-row {
    display: flex;
    align-items: flex-end;
    margin-bottom: 4px;
  }
  .day-lbl-spacer { width: 28px; flex-shrink: 0; }
  .cal-day-lbls { flex-shrink: 0; }
  .cal-months-inner {
    position: relative;
    height: 16px;
    flex-shrink: 0;
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
  }
  .cal-day-lbls span {
    font-size: 0.65rem;
    color: var(--text-6);
    text-align: right;
    padding-right: 4px;
    flex-shrink: 0;
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

  /* ── 24h Timeline ── */
  .tl-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 16px 20px 14px;
  }
  .tl-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .tl-title-group { display: flex; flex-direction: column; gap: 1px; }
  .tl-title { font-size: 0.82rem; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; }
  .tl-date { font-size: 0.75rem; color: var(--text-6); }

  .tl-dropdown-wrap { position: relative; }
  .tl-dropdown-btn {
    display: flex; align-items: center; gap: 5px; padding: 4px 10px;
    border-radius: 7px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.75rem; cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .tl-dropdown-btn:hover, .tl-dropdown-btn.active { border-color: var(--accent); color: var(--accent-ltr); }
  .tl-tag-count {
    background: var(--accent-bg); color: var(--accent-lt); border-radius: 10px;
    padding: 0 5px; font-size: 0.7rem; font-weight: 600;
  }
  .tl-dropdown {
    position: absolute; right: 0; top: calc(100% + 4px);
    background: var(--surface-alt); border: 1px solid var(--border-2); border-radius: 10px;
    padding: 6px; min-width: 170px; z-index: 50;
    display: flex; flex-direction: column; gap: 1px;
    max-height: 220px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .tl-dropdown-empty { font-size: 0.78rem; color: var(--text-6); padding: 6px 8px; }
  .tl-tag-row {
    display: flex; align-items: center; gap: 7px; padding: 5px 7px;
    border-radius: 6px; cursor: pointer; font-size: 0.78rem; color: var(--text-3);
  }
  .tl-tag-row:hover { background: var(--border); }
  .tl-tag-row input { accent-color: var(--accent); cursor: pointer; }
  .tl-tag-swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; transition: background 0.12s; }

  .tl-track-wrap { position: relative; }
  .tl-now-label-row {
    position: relative; height: 16px; margin-bottom: 2px;
  }
  .tl-now-time {
    position: absolute; left: var(--now); transform: translateX(-50%);
    font-size: 0.65rem; color: var(--red); font-weight: 600; white-space: nowrap;
  }
  .tl-track {
    position: relative; height: 28px; border-radius: 6px;
    background: var(--surface-alt); border: 1px solid var(--border); overflow: hidden;
  }
  .tl-grid-line {
    position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border-2);
  }
  .tl-bar {
    position: absolute; top: 4px; height: 20px; border-radius: 3px;
    opacity: 0.85; transition: opacity 0.1s; cursor: default;
  }
  .tl-bar:hover { opacity: 1; filter: brightness(1.2); }
  .tl-now-line {
    position: absolute; top: 0; bottom: 0; width: 2px;
    background: var(--red); border-radius: 1px;
  }
  .tl-hours { position: relative; height: 18px; margin-top: 4px; }
  .tl-hour-lbl {
    position: absolute; transform: translateX(-50%);
    font-size: 0.65rem; color: var(--text-6); white-space: nowrap;
  }
  .tl-legend {
    display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px;
    padding-top: 10px; border-top: 1px solid var(--border);
  }
  .tl-legend-item { display: flex; align-items: center; gap: 5px; font-size: 0.75rem; color: var(--text-5); }
  .tl-legend-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .tl-legend-other { color: var(--text-7); }

  @media (max-width: 700px) {
    .home { padding: 16px; }
    .stats { grid-template-columns: 1fr 1fr; }
    .sections { grid-template-columns: 1fr; }
  }
</style>
