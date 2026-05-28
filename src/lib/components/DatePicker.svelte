<script lang="ts">
  let { value = $bindable(''), placeholder = 'Due date' }: { value: string; placeholder?: string } = $props();

  let open = $state(false);
  let viewYear = $state(new Date().getFullYear());
  let viewMonth = $state(new Date().getMonth());

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function buildCalendar(year: number, month: number): (number | null)[] {
    const days = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();
    const cells: (number | null)[] = Array(firstDay).fill(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    return cells;
  }

  let cells = $derived(buildCalendar(viewYear, viewMonth));

  $effect(() => {
    if (value) {
      const d = new Date(value + 'T00:00:00');
      if (!isNaN(d.getTime())) {
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
      }
    }
  });

  function prevMonth() {
    if (viewMonth === 0) { viewMonth = 11; viewYear--; }
    else viewMonth--;
  }
  function nextMonth() {
    if (viewMonth === 11) { viewMonth = 0; viewYear++; }
    else viewMonth++;
  }

  function selectDay(day: number) {
    value = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    open = false;
  }

  function isSelected(day: number) {
    return value === `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function isToday(day: number) {
    const now = new Date();
    return day === now.getDate() && viewMonth === now.getMonth() && viewYear === now.getFullYear();
  }

  function handleWindowClick(e: MouseEvent) {
    if (open && !(e.target as HTMLElement).closest('.dp-root')) {
      open = false;
    }
  }

  function handleWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) open = false;
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKey} />

<div class="dp-root">
  <button class="dp-trigger" onclick={() => (open = !open)} type="button">
    <span class="dp-value {value ? '' : 'placeholder'}">{value || placeholder}</span>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  </button>

  {#if open}
    <div class="dp-dropdown">
      <div class="dp-header">
        <button class="dp-nav" onclick={prevMonth} type="button">‹</button>
        <span class="dp-month-label">{MONTHS[viewMonth]} {viewYear}</span>
        <button class="dp-nav" onclick={nextMonth} type="button">›</button>
      </div>

      <div class="dp-grid">
        {#each DAY_LABELS as label}
          <span class="dp-weekday">{label}</span>
        {/each}
        {#each cells as day}
          {#if day === null}
            <span></span>
          {:else}
            <button
              class="dp-day {isSelected(day) ? 'selected' : ''} {isToday(day) ? 'today' : ''}"
              onclick={() => selectDay(day)}
              type="button"
            >{day}</button>
          {/if}
        {/each}
      </div>

      {#if value}
        <button class="dp-clear" onclick={() => { value = ''; open = false; }} type="button">Clear</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .dp-root { position: relative; flex: 1; min-width: 0; }

  .dp-trigger {
    width: 100%; display: flex; align-items: center; gap: 8px;
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem;
    cursor: pointer; text-align: left; transition: border-color 0.12s;
  }
  .dp-trigger:hover { border-color: var(--accent); }
  .dp-value { flex: 1; }
  .dp-value.placeholder { color: var(--text-8); }
  .dp-trigger svg { color: var(--text-5); flex-shrink: 0; }

  .dp-dropdown {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 200;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 12px;
    padding: 12px; min-width: 236px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  .dp-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .dp-month-label { font-size: 0.875rem; font-weight: 600; color: var(--text-2); }
  .dp-nav {
    background: none; border: none; color: var(--text-4); cursor: pointer;
    font-size: 1.3rem; line-height: 1; padding: 2px 8px; border-radius: 6px;
    transition: color 0.12s, background 0.12s;
  }
  .dp-nav:hover { color: var(--text-2); background: var(--border-2); }

  .dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .dp-weekday { text-align: center; font-size: 0.68rem; color: var(--text-8); padding: 4px 0; font-weight: 600; }

  .dp-day {
    background: none; border: none; cursor: pointer;
    color: var(--text-2); font-size: 0.8rem;
    padding: 5px 2px; border-radius: 6px; text-align: center;
    transition: background 0.1s, color 0.1s;
  }
  .dp-day:hover { background: var(--border-2); color: var(--text-2); }
  .dp-day.today { color: var(--accent-lt); font-weight: 700; }
  .dp-day.selected { background: var(--accent); color: #fff; }
  .dp-day.selected:hover { background: var(--accent-dk); }

  .dp-clear {
    width: 100%; margin-top: 8px; padding: 5px;
    background: none; border: 1px solid var(--border-2); border-radius: 6px;
    color: var(--text-4); font-size: 0.75rem; cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .dp-clear:hover { border-color: var(--red); color: var(--red); }
</style>
