<script lang="ts">
  import { onDestroy } from 'svelte';
  import { todos, activeTimers, taskFilterStatus, taskFilterPriority, taskFilterTag, taskFilterDuePeriod, taskFilterGroupByTags, taskFilterSearch, settings } from '$lib/stores';
  import { api, saveTaskNoteImage } from '$lib/api';
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import type { Todo, WorkSession } from '$lib/types';
  import { serializeAnnotations } from '$lib/taskAnnotations';
  import DatePicker from '$lib/components/DatePicker.svelte';
  import { Crepe, CrepeFeature } from '@milkdown/crepe';
  import { replaceAll } from '@milkdown/utils';
  import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
  import { setBlockTypeCommand, codeBlockSchema, inlineCodeSchema } from '@milkdown/kit/preset/commonmark';
  import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
  import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

  // ── Filter state (persisted in global stores) ─────────────────────────────
  let showFilters = $state(false);
  let searchInputEl: HTMLInputElement | null = $state(null);

  // ── New-task form ─────────────────────────────────────────────────────────
  let showForm = $state(false);
  let newTitle = $state('');
  let newPriority: 'high' | 'medium' | 'low' = $state('medium');
  let newDue = $state('');
  let newTagInput = $state('');

  // ── Edit state ────────────────────────────────────────────────────────────
  let editId: string | null = $state(null);
  let editTitle = $state('');
  let editPriority: 'high' | 'medium' | 'low' = $state('medium');
  let editDue = $state('');
  let editTagInput = $state('');

  // ── Selection state ───────────────────────────────────────────────────────
  let selectedIds: Set<string> = $state(new Set());
  let confirmDelete = $state(false);

  // ── Timer state ───────────────────────────────────────────────────────────
  let expandedSessions: string | null = $state(null);
  let tick = $state(0);
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  // ── Focus mode ────────────────────────────────────────────────────────────
  let focusMode = $state(false);
  let focusTodoId = $derived([...$activeTimers.keys()][0] ?? null);
  let focusTodo = $derived(focusTodoId ? ($todos.find((t) => t.id === focusTodoId) ?? null) : null);

  $effect(() => {
    if ($activeTimers.size === 0) focusMode = false;
  });
  $effect(() => {
    if (focusMode && focusTodo && notesOpenId !== focusTodo.id) openNotes(focusTodo);
  });

  // ── Notes state ───────────────────────────────────────────────────────────
  let notesOpenId: string | null = $state(null);
  let notesContent: string = $state('');
  let notesRawMode = $state(false);
  let notesSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let notesEditorInstance: Crepe | null = null;

  $effect(() => {
    if ($activeTimers.size > 0) {
      if (!tickInterval) tickInterval = setInterval(() => { tick++; }, 1000);
    } else {
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  let allTags = $derived([...new Set($todos.flatMap((t) => t.tags))].sort());

  let filtered = $derived(
    $todos
      .filter((t) => {
        if ($taskFilterStatus === 'pending' && t.done) return false;
        if ($taskFilterStatus === 'done' && !t.done) return false;
        if ($taskFilterPriority && t.priority !== $taskFilterPriority) return false;
        if ($taskFilterTag && !t.tags.includes($taskFilterTag)) return false;
        if ($taskFilterDuePeriod) {
          const due = t.due_date ? new Date(t.due_date) : null;
          const today = new Date(); today.setHours(0, 0, 0, 0);
          if ($taskFilterDuePeriod === 'overdue') {
            if (!due || due >= today) return false;
          } else if ($taskFilterDuePeriod === 'today') {
            const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
            if (!due || due < today || due >= tomorrow) return false;
          } else if ($taskFilterDuePeriod === 'week') {
            const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
            if (!due || due < today || due >= weekEnd) return false;
          } else if ($taskFilterDuePeriod === 'month') {
            const monthEnd = new Date(today); monthEnd.setDate(today.getDate() + 30);
            if (!due || due < today || due >= monthEnd) return false;
          }
        }
        if ($taskFilterSearch && !t.title.toLowerCase().includes($taskFilterSearch.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      })
  );

  let pendingTodos = $derived(filtered.filter((t) => !t.done));
  let doneTodos = $derived(filtered.filter((t) => t.done));

  let ungroupedPending = $derived(
    $taskFilterGroupByTags.length > 0
      ? pendingTodos.filter((t) => !$taskFilterGroupByTags.some((gt) => t.tags.includes(gt)))
      : []
  );

  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };

  let sortedGroups = $derived(
    $taskFilterGroupByTags
      .map((tag) => ({ tag, todos: pendingTodos.filter((t) => t.tags.includes(tag)) }))
      .filter((g) => g.todos.length > 0)
      .sort((a, b) => {
        const earliest = (ts: typeof pendingTodos) =>
          ts.reduce((min, t) => t.due_date ? Math.min(min, new Date(t.due_date).getTime()) : min, Infinity);
        const bestPrio = (ts: typeof pendingTodos) =>
          ts.reduce((best, t) => Math.min(best, priorityRank[t.priority] ?? 1), 2);
        const timeDiff = earliest(a.todos) - earliest(b.todos);
        return timeDiff !== 0 ? timeDiff : bestPrio(a.todos) - bestPrio(b.todos);
      })
  );

  let selTodo = $derived(
    selectedIds.size === 1 ? $todos.find((t) => selectedIds.has(t.id)) ?? null : null
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  async function toggleDone(todo: Todo) {
    const now = new Date().toISOString();
    const markingDone = !todo.done;

    if ($activeTimers.has(todo.id)) {
      const startMs = $activeTimers.get(todo.id)!;
      activeTimers.update((m) => { m.delete(todo.id); return m; });
      const session: WorkSession = { start: new Date(startMs).toISOString(), end: now };
      todo = { ...todo, work_sessions: [...(todo.work_sessions ?? []), session] };
    }

    const updated = await api.saveTodo({
      ...todo,
      done: markingDone,
      finished_at: markingDone ? now : null,
      started_at: !markingDone ? now : (todo.started_at ?? null),
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function startTimer(todo: Todo) {
    const now = new Date().toISOString();
    activeTimers.update((m) => { m.set(todo.id, Date.now()); return m; });
    if (!todo.started_at) {
      const updated = await api.saveTodo({ ...todo, started_at: now });
      todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    }
  }

  async function stopTimer(todo: Todo) {
    const startMs = $activeTimers.get(todo.id);
    if (!startMs) return;
    activeTimers.update((m) => { m.delete(todo.id); return m; });

    const session: WorkSession = {
      start: new Date(startMs).toISOString(),
      end: new Date().toISOString(),
    };
    const updated = await api.saveTodo({
      ...todo,
      work_sessions: [...(todo.work_sessions ?? []), session],
      started_at: todo.started_at ?? session.start,
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function createTodo() {
    if (!newTitle.trim()) return;
    const tags = newTagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    const created = await api.saveTodo({
      id: '', title: newTitle.trim(), done: false, priority: newPriority,
      due_date: newDue || null, tags,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    todos.update((ts) => [created, ...ts]);
    newTitle = ''; newPriority = 'medium'; newDue = ''; newTagInput = '';
    showForm = false;
  }

  function startEdit(todo: Todo) {
    editId = todo.id;
    editTitle = todo.title;
    editPriority = todo.priority;
    editDue = todo.due_date ?? '';
    editTagInput = todo.tags.join(', ');
    selectedIds = new Set();
  }

  async function saveEdit(todo: Todo) {
    const tags = editTagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    const updated = await api.saveTodo({
      ...todo, title: editTitle.trim(), priority: editPriority,
      due_date: editDue || null, tags,
    });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
    editId = null;
  }

  async function deleteTodo(id: string) {
    activeTimers.update((m) => { m.delete(id); return m; });
    await api.deleteTodo(id);
    todos.update((ts) => ts.filter((t) => t.id !== id));
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    confirmDelete = false;
  }

  async function deleteSelected() {
    for (const id of selectedIds) {
      await deleteTodo(id);
    }
    selectedIds = new Set();
    confirmDelete = false;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  // notesContent stores asset:// URLs so the live editor always works.
  // The note .md file on disk stores repo-relative paths (portable, syncs to GitHub).
  // Conversion happens once at load (relative→asset://) and once at save (asset://→relative).

  const ASSET_RE = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)(\/.*)/;

  function splitUrlTitle(raw: string): [string, string] {
    const i = raw.search(/\s+["']/);
    return i >= 0 ? [raw.slice(0, i), raw.slice(i)] : [raw.trim(), ''];
  }

  // Convert repo-relative image paths → asset:// URLs (used when loading into editor).
  function makeImagesLoadable(content: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, raw) => {
      const [src, title] = splitUrlTitle(raw);
      if (src.startsWith('http') || src.startsWith('data:') || ASSET_RE.test(src)) return match;
      const abs = src.startsWith('/') ? src : `${repoPath}/${src}`;
      return `![${alt}](${convertFileSrc(abs)}${title})`;
    });
  }

  // Convert asset:// URLs → repo-relative paths (used when saving to file).
  function stripAssetUrls(content: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    const prefix = repoPath + '/';
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, raw) => {
      const [src, title] = splitUrlTitle(raw);
      const m = src.match(ASSET_RE);
      if (!m) return match;
      let abs = decodeURIComponent(m[1]);
      if (abs.startsWith('//')) abs = abs.slice(1);
      const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
      return `![${alt}](${rel}${title})`;
    });
  }

  async function persistNotes(todo: Todo) {
    // Save relative paths to the note file so it's portable and syncs cleanly.
    const updated = await api.saveTodo({ ...todo, notes: stripAssetUrls(notesContent) || null });
    todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  function scheduleNotesSave() {
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
      const todo = $todos.find((t) => t.id === notesOpenId);
      if (todo) void persistNotes(todo);
    }, 800);
  }

  const COPY_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  function makeCopyBtn(getText: () => string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.title = 'Copy';
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(getText()).then(() => {
        btn.innerHTML = CHECK_SVG;
        setTimeout(() => { btn.innerHTML = COPY_SVG; }, 1200);
      });
    });
    return btn;
  }

  function patchToolbarCodeButton(editorInstance: Crepe, el: HTMLElement) {
    const toolbar = el.querySelector('.toolbar');
    if (!toolbar) return;
    toolbar.addEventListener('pointerdown', (e) => {
      const btn = (e.target as Element).closest('.toolbar-item');
      if (!btn || !btn.innerHTML.includes('9.4 16.6')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      editorInstance.editor.action((ctx) => {
        const commands = ctx.get(commandsCtx);
        commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) });
      });
    }, true);
  }

  const noInlineCodeKey = new PluginKey('no-inline-code');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function installCodeBlockPlugin(milkCtx: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = milkCtx.get(editorViewCtx);
    const inlineCodeType = inlineCodeSchema.type(milkCtx);
    const codeBlockType = codeBlockSchema.type(milkCtx);

    const plugin = new Plugin({
      key: noInlineCodeKey,
      appendTransaction(_trs, _old, newState) {
        // Find paragraphs that contain inline code marks
        const paraRanges: Array<{ start: number; end: number; node: typeof newState.doc }> = [];
        newState.doc.descendants((node, pos) => {
          if (node.type.name !== 'paragraph') return;
          let hasInlineCode = false;
          node.content.forEach((child) => {
            if (child.isText && child.marks.some((m) => m.type === inlineCodeType)) hasInlineCode = true;
          });
          if (hasInlineCode) paraRanges.push({ start: pos, end: pos + node.nodeSize, node } as any);
        });
        if (paraRanges.length === 0) return null;

        let tr = newState.tr;
        // Process end-to-start so positions stay valid
        for (let i = paraRanges.length - 1; i >= 0; i--) {
          const { start, end, node } = paraRanges[i] as any;
          const replacement: any[] = [];
          let pendingText = '';

          (node as any).content.forEach((child: any) => {
            if (!child.isText) return;
            const isCode = child.marks.some((m: any) => m.type === inlineCodeType);
            if (isCode) {
              if (pendingText.trim()) {
                replacement.push(newState.schema.nodes.paragraph.create({}, newState.schema.text(pendingText)));
                pendingText = '';
              }
              if (child.text) replacement.push(codeBlockType.create({}, newState.schema.text(child.text)));
            } else {
              pendingText += child.text ?? '';
            }
          });
          if (pendingText.trim()) replacement.push(newState.schema.nodes.paragraph.create({}, newState.schema.text(pendingText)));

          if (replacement.length) tr = tr.replaceWith(start, end, replacement);
        }
        return tr;
      },
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type === codeBlockType && !node.textContent.includes('\n')) {
              decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'single-line' }));
            }
          });
          return DecorationSet.create(state.doc, decos);
        }
      }
    });

    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));
  }

  function attachCodeCopyButtons(pm: HTMLElement) {
    // One shared floating button for both block and inline code
    const floatBtn = makeCopyBtn(() => currentTarget?.textContent ?? '');
    floatBtn.classList.add('float');
    document.body.appendChild(floatBtn);

    let currentTarget: HTMLElement | null = null;

    function show(target: HTMLElement, refEl: HTMLElement) {
      currentTarget = target;
      const rect = refEl.getBoundingClientRect();
      floatBtn.style.top = `${rect.top + 8}px`;
      floatBtn.style.left = `${rect.right - 34}px`;
      floatBtn.classList.add('visible');
    }
    function hide(e: MouseEvent) {
      if ((e.relatedTarget as HTMLElement) === floatBtn) return;
      floatBtn.classList.remove('visible');
      currentTarget = null;
    }

    pm.addEventListener('mouseover', (e) => {
      const pre = (e.target as HTMLElement).closest('pre');
      if (pre instanceof HTMLElement) { show(pre.querySelector('code') ?? pre, pre); return; }
      const code = (e.target as HTMLElement).closest('code');
      if (code instanceof HTMLElement) {
        const r = code.getBoundingClientRect();
        currentTarget = code;
        floatBtn.style.top = `${r.top + r.height / 2}px`;
        floatBtn.style.left = `${r.right + 6}px`;
        floatBtn.classList.add('visible');
      }
    });
    pm.addEventListener('mouseout', hide);
    floatBtn.addEventListener('mouseleave', hide);
  }

  function initNotesEditor(el: HTMLElement) {
    if (!document.getElementById('mk-h-fix')) {
      const s = document.createElement('style');
      s.id = 'mk-h-fix';
      s.textContent = '.milkdown .ProseMirror h1,.milkdown .ProseMirror h2,.milkdown .ProseMirror h3,.milkdown .ProseMirror h4,.milkdown .ProseMirror h5,.milkdown .ProseMirror h6{margin-top:0!important;padding-top:0!important}';
      document.head.appendChild(s);
    }
    let instance: Crepe | null = null;
    let destroyed = false;
    const uploadImage = async (file: File) => {
      if (!notesOpenId) throw new Error('No todo open');
      const relPath = await saveTaskNoteImage(notesOpenId, file);
      const repoPath = $settings.repo_path;
      return repoPath ? convertFileSrc(`${repoPath}/${relPath}`) : relPath;
    };
    const c = new Crepe({
      root: el,
      defaultValue: notesContent, // already has asset:// URLs (set in openNotes)
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.TopBar]: false,
        [CrepeFeature.Latex]: false,
        [CrepeFeature.Table]: false,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.CodeMirror]: false,
        [CrepeFeature.LinkTooltip]: false,
      },
      featureConfigs: {
        [CrepeFeature.ImageBlock]: {
          onUpload: uploadImage,
          blockOnUpload: uploadImage,
        },
      },
    });
    c.on((api) => {
      api.markdownUpdated((_, markdown) => {
        // Keep asset:// URLs in notesContent so the editor always renders correctly.
        // stripAssetUrls is only called at save time (persistNotes).
        notesContent = markdown;
        scheduleNotesSave();
      });
    });
    el.addEventListener('keydown', handleNotesHeadingShortcut);

    async function insertImageFromClipboard() {
      if (!notesOpenId) return false;
      // Read the clipboard image directly from Rust — bypasses unreliable JS clipboard API
      const b64 = await invoke<string | null>('read_clipboard_image');
      if (!b64) return false;
      const relPath = await invoke<string>('save_task_note_image', {
        id: notesOpenId, dataB64: b64, ext: 'png',
      });
      const repoPath = $settings.repo_path;
      const assetUrl = repoPath ? convertFileSrc(`${repoPath}/${relPath}`) : relPath;
      c.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodeType = view.state.schema.nodes['image-block'];
        if (nodeType) {
          const node = nodeType.create({ src: assetUrl, caption: '', ratio: 1 });
          view.dispatch(view.state.tr.replaceSelectionWith(node));
        }
      });
      return true;
    }

    // Intercept Ctrl+V at keydown so we can check the clipboard via Rust before
    // the paste event fires. If there's an image we handle it; otherwise we let
    // the native paste event proceed normally for text.
    async function handleNotesCtrlV(e: KeyboardEvent) {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v')) return;
      if (!notesOpenId) return;
      try {
        const handled = await insertImageFromClipboard();
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      } catch (err) {
        console.error('Clipboard image read failed:', err);
      }
    }

    void c.create().then(() => {
      if (!destroyed) {
        instance = c;
        notesEditorInstance = c;
        const pm = el.querySelector('.ProseMirror');
        if (pm instanceof HTMLElement) {
          pm.style.paddingTop = '0';
          attachCodeCopyButtons(pm);
        }
        patchToolbarCodeButton(c, el);
        c.editor.action((ctx) => { installCodeBlockPlugin(ctx); });
        el.addEventListener('keydown', handleNotesCtrlV, true);
      } else void c.destroy();
    });
    return {
      destroy() {
        destroyed = true;
        el.removeEventListener('keydown', handleNotesHeadingShortcut);
        el.removeEventListener('keydown', handleNotesCtrlV, true);
        if (notesEditorInstance === instance) notesEditorInstance = null;
        void instance?.destroy();
        instance = null;
      },
    };
  }

  function toggleNotesRaw() {
    if (!notesRawMode) {
      notesRawMode = true;
    } else {
      notesRawMode = false;
      // makeImagesLoadable is a no-op for asset:// URLs but handles the case
      // where the user typed relative paths in raw mode.
      const loadable = makeImagesLoadable(notesContent);
      notesContent = loadable;
      notesEditorInstance?.editor.action(replaceAll(loadable));
    }
  }

  function handleNotesHeadingShortcut(e: KeyboardEvent) {
    if (!e.ctrlKey || notesRawMode || !notesEditorInstance) return;
    const promote = e.key === '=' || e.key === '+';
    const demote = e.key === '-';
    if (!promote && !demote) return;
    e.preventDefault();
    notesEditorInstance.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;
      const { schema } = state;
      const parent = state.selection.$from.parent;
      let level = 0;
      if (parent.type === schema.nodes.heading) level = parent.attrs.level as number;
      else if (parent.type !== schema.nodes.paragraph) return;
      let tr;
      if (promote) {
        if (level === 1) return;
        tr = state.tr.setBlockType(from, to, schema.nodes.heading, { level: level === 0 ? 6 : level - 1 });
      } else {
        if (level === 0) return;
        tr = level === 6
          ? state.tr.setBlockType(from, to, schema.nodes.paragraph)
          : state.tr.setBlockType(from, to, schema.nodes.heading, { level: level + 1 });
      }
      view.dispatch(tr);
    });
  }

  function openNotes(todo: Todo) {
    notesRawMode = false;
    if (notesOpenId && notesOpenId !== todo.id) {
      if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
      const prev = $todos.find((t) => t.id === notesOpenId);
      if (prev) void persistNotes(prev);
    }
    notesOpenId = todo.id;
    // Convert relative image paths to asset:// URLs so the editor can display them.
    notesContent = makeImagesLoadable(todo.notes ?? '');
  }

  function closeNotes() {
    if (notesSaveTimer) { clearTimeout(notesSaveTimer); notesSaveTimer = null; }
    const todo = $todos.find((t) => t.id === notesOpenId);
    if (todo) void persistNotes(todo);
    notesOpenId = null;
  }

  function clearNotesContent() {
    notesContent = '';
    notesEditorInstance?.editor.action(replaceAll(''));
    scheduleNotesSave();
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function priorityColor(p: string) {
    return p === 'high' ? 'var(--red)' : p === 'medium' ? 'var(--yellow)' : 'var(--text-5)';
  }

  function isOverdue(due: string | null): boolean {
    if (!due) return false;
    return new Date(due) < new Date(new Date().toDateString());
  }

  function fmtRelativeDue(due: string | null): string {
    if (!due) return '';
    const today = new Date(new Date().toDateString());
    const target = new Date(due);
    const days = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days < 0) return `${Math.abs(days)}d ago`;
    if (days < 7) return `in ${days}d`;
    const weeks = Math.floor(days / 7);
    if (days < 28) return `in ${weeks}w`;
    const months = Math.floor(days / 30);
    return `in ${months}mo`;
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function fmtDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatElapsed(startMs: number): string {
    void tick;
    const secs = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function totalSessionMs(sessions: WorkSession[]): number {
    return (sessions ?? []).reduce(
      (acc, s) => acc + (new Date(s.end).getTime() - new Date(s.start).getTime()), 0
    );
  }

  function formatDuration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  function copyMarkdown(todo: Todo) {
    navigator.clipboard?.writeText(serializeAnnotations(todo));
  }

  function focusSearchSoon() { setTimeout(() => searchInputEl?.focus(), 0); }

  function toggleFilters() {
    showFilters = !showFilters;
    if (showFilters) focusSearchSoon();
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!showFilters) showFilters = true;
      focusSearchSoon();
    }
    if (e.key === 'Escape' && selectedIds.size > 0) {
      selectedIds = new Set();
      confirmDelete = false;
    }
  }

</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="tasks" class:focus-mode={focusMode}>
  <header class="page-header">
    <div>
      <h1>Tasks</h1>
      <p class="subtitle">{filtered.length} of {$todos.length} tasks</p>
    </div>
    <div class="header-actions">
      {#if $activeTimers.size > 0}
        <button
          class="focus-toggle {focusMode ? 'active' : ''}"
          onclick={() => (focusMode = !focusMode)}
          title="Focus mode"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 9V5a2 2 0 0 1 2-2h4M3 15v4a2 2 0 0 0 2 2h4M21 9V5a2 2 0 0 0-2-2h-4M21 15v4a2 2 0 0 1-2 2h-4"/></svg>
          Focus
          <span class="focus-pip"></span>
        </button>
      {/if}
      <button
        class="filter-toggle {showFilters ? 'active' : ''}"
        onclick={toggleFilters}
        title="Toggle filters (Ctrl/Cmd+F)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      </button>
      <button class="fab" onclick={() => (showForm = !showForm)} title="New task">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  </header>

  <!-- New task form -->
  {#if showForm}
    <div class="new-task-form">
      <input
        class="input" placeholder="Task title…" bind:value={newTitle}
        onkeydown={(e) => e.key === 'Enter' && createTodo()}
        autofocus
      />
      <div class="form-row">
        <select class="select" bind:value={newPriority}>
          <option value="high">High priority</option>
          <option value="medium">Medium priority</option>
          <option value="low">Low priority</option>
        </select>
        <DatePicker bind:value={newDue} placeholder="Due date" />
        <input class="input" placeholder="#tags (space/comma separated)" bind:value={newTagInput} />
      </div>
      <div class="form-actions">
        <button class="btn-primary" onclick={createTodo}>Add task</button>
        <button class="btn-ghost" onclick={() => (showForm = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Filter bar -->
  {#if showFilters}
    <div class="filter-bar">
      <input class="search-input" placeholder="Search tasks…" bind:value={$taskFilterSearch} bind:this={searchInputEl} />
      <div class="filter-chips">
        <span class="filter-label">Status:</span>
        {#each ['all', 'pending', 'done'] as s}
          <button class="chip {$taskFilterStatus === s ? 'active' : ''}" onclick={() => ($taskFilterStatus = s as typeof $taskFilterStatus)}>{s}</button>
        {/each}
      </div>
      <div class="filter-chips">
        <span class="filter-label">Priority:</span>
        <button class="chip {$taskFilterPriority === '' ? 'active' : ''}" onclick={() => ($taskFilterPriority = '')}>all</button>
        {#each ['high', 'medium', 'low'] as p}
          <button class="chip prio-chip {$taskFilterPriority === p ? 'active' : ''}" style="--pc: {priorityColor(p)}"
            onclick={() => ($taskFilterPriority = $taskFilterPriority === p ? '' : p as typeof $taskFilterPriority)}>{p}</button>
        {/each}
      </div>
      {#if allTags.length > 0}
        <div class="filter-chips">
          <span class="filter-label">Tag:</span>
          <button class="chip {$taskFilterTag === '' ? 'active' : ''}" onclick={() => ($taskFilterTag = '')}>all</button>
          {#each allTags as tag}
            <button class="chip tag-chip {$taskFilterTag === tag ? 'active' : ''}"
              onclick={() => ($taskFilterTag = $taskFilterTag === tag ? '' : tag)}>#{tag}</button>
          {/each}
        </div>
      {/if}
      <div class="filter-chips">
        <span class="filter-label">Due:</span>
        <button class="chip {$taskFilterDuePeriod === '' ? 'active' : ''}" onclick={() => ($taskFilterDuePeriod = '')}>all</button>
        {#each [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month']] as [val, label]}
          <button class="chip due-period-chip {$taskFilterDuePeriod === val ? 'active' : ''}"
            onclick={() => ($taskFilterDuePeriod = $taskFilterDuePeriod === val ? '' : val as typeof $taskFilterDuePeriod)}
          >{label}</button>
        {/each}
      </div>
      {#if allTags.length > 0}
        <div class="filter-chips">
          <span class="filter-label">Group:</span>
          {#if $taskFilterGroupByTags.length > 0}
            <button class="chip group-clear-chip" onclick={() => ($taskFilterGroupByTags = [])}>clear</button>
          {/if}
          {#each allTags as tag}
            <button
              class="chip group-tag-chip {$taskFilterGroupByTags.includes(tag) ? 'active' : ''}"
              onclick={() => {
                if ($taskFilterGroupByTags.includes(tag)) {
                  $taskFilterGroupByTags = $taskFilterGroupByTags.filter((t) => t !== tag);
                } else {
                  $taskFilterGroupByTags = [...$taskFilterGroupByTags, tag];
                }
              }}
            >#{tag}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#snippet taskCard(todo: import('$lib/types').Todo)}
        {@const isTimerActive = $activeTimers.has(todo.id)}
        {@const timerStartMs = $activeTimers.get(todo.id)}
        {@const sessions = todo.work_sessions ?? []}
        {@const totalMs = totalSessionMs(sessions)}
        {@const isSelected = selectedIds.has(todo.id)}

        <div class="task-card {todo.done ? 'done' : ''} {isTimerActive ? 'timer-active' : ''} {isSelected ? 'selected' : ''} {notesOpenId === todo.id ? 'notes-open' : ''}">
          {#if editId === todo.id}
            <div class="edit-form">
              <input class="input" bind:value={editTitle} onkeydown={(e) => e.key === 'Enter' && saveEdit(todo)} />
              <div class="form-row">
                <select class="select" bind:value={editPriority}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <DatePicker bind:value={editDue} placeholder="Due date" />
                <input class="input" placeholder="#tags" bind:value={editTagInput} />
              </div>
              <div class="form-actions">
                <button class="btn-primary" onclick={() => saveEdit(todo)}>Save</button>
                <button class="btn-ghost" onclick={() => (editId = null)}>Cancel</button>
              </div>
            </div>
          {:else}
            <button class="check-btn" onclick={() => toggleDone(todo)} title="{todo.done ? 'Mark pending' : 'Mark done'}">
              {#if todo.done}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              {:else}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              {/if}
            </button>

            <div class="task-body" onclick={() => toggleSelect(todo.id)} ondblclick={() => { selectedIds = new Set([todo.id]); openNotes(todo); }}>
              <div class="task-title-row">
                <span class="priority-bar" style="background:{priorityColor(todo.priority)}" title="{todo.priority} priority"></span>
                <span class="task-title">{todo.title}</span>
                {#if todo.notes}
                  <span class="notes-indicator" title="Has notes">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </span>
                {/if}
                {#if isTimerActive && timerStartMs !== undefined}
                  <span class="timer-running">{formatElapsed(timerStartMs)}</span>
                {/if}
              </div>

              <div class="task-meta">
                {#if todo.due_date}
                  <span class="due-chip {isOverdue(todo.due_date) && !todo.done ? 'overdue' : ''}" title={todo.due_date}>
                    {fmtRelativeDue(todo.due_date)}
                  </span>
                {/if}
                {#if todo.started_at}
                  <span class="time-chip started" title="Started {fmtDateTime(todo.started_at)}">▶ {fmtDate(todo.started_at)}</span>
                {/if}
                {#if todo.finished_at}
                  <span class="time-chip finished" title="Finished {fmtDateTime(todo.finished_at)}">✓ {fmtDate(todo.finished_at)}</span>
                {/if}
                {#if totalMs > 0}
                  <button
                    class="time-chip logged {expandedSessions === todo.id ? 'active' : ''}"
                    onclick={(e) => { e.stopPropagation(); expandedSessions = expandedSessions === todo.id ? null : todo.id; }}
                    title="View work sessions"
                  >⏱ {formatDuration(totalMs)}</button>
                {/if}
                {#each todo.tags as tag}
                  <button class="tag-chip" onclick={(e) => { e.stopPropagation(); $taskFilterTag = tag; }} title="Filter by #{tag}">#{tag}</button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        {#if expandedSessions === todo.id && sessions.length > 0}
          <div class="sessions-panel">
            <div class="sessions-title">Work sessions</div>
            {#each sessions as s, i}
              <div class="session-row">
                <span class="session-num">{i + 1}</span>
                <span class="session-range">{fmtDateTime(s.start)} → {fmtDateTime(s.end)}</span>
                <span class="session-dur">{formatDuration(new Date(s.end).getTime() - new Date(s.start).getTime())}</span>
              </div>
            {/each}
            <div class="sessions-total">Total: {formatDuration(totalMs)}</div>
          </div>
        {/if}

        {#if notesOpenId === todo.id}
          <div class="notes-panel">
            <div class="notes-panel-header">
              <span class="notes-panel-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                Notes
              </span>
              <div style="display:flex;gap:4px;align-items:center;">
                <button class="notes-close-btn" onclick={clearNotesContent} title="Clear notes">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
                <button class="notes-close-btn {notesRawMode ? 'raw-active' : ''}" onclick={toggleNotesRaw} title="{notesRawMode ? 'Switch to WYSIWYG' : 'Switch to raw markdown'}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                </button>
                <button class="notes-close-btn" onclick={closeNotes} title="Close notes">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            <div class="notes-editor-wrap" style:display={notesRawMode ? 'none' : ''} use:initNotesEditor></div>
            {#if notesRawMode}
              <textarea
                class="notes-raw-editor"
                bind:value={notesContent}
                oninput={scheduleNotesSave}
                spellcheck={false}
              ></textarea>
            {/if}
          </div>
        {/if}
  {/snippet}

  {#if !focusMode}
  <div class="annotation-hint">
    Markdown syntax: <code>- [ ] Title #tag @YYYY-MM-DD !high</code> — write tasks in Docs and they sync here.
  </div>
  {/if}

  {#if focusMode && focusTodo}
    <div class="focus-view">
      {@render taskCard(focusTodo)}
    </div>
  {:else}
  <div class="task-list">
    {#if filtered.length === 0}
      <div class="empty">No tasks match the current filters.</div>
    {:else if $taskFilterGroupByTags.length > 0}
      <!-- Grouped view — sorted by earliest due date, then best priority -->
      {#each sortedGroups as { tag: groupTag, todos: groupTodos }}
        <div class="group-divider">
          <span>#{groupTag} · {groupTodos.length}</span>
        </div>
        {#each groupTodos as todo (todo.id + '::' + groupTag)}
          {@render taskCard(todo)}
        {/each}
      {/each}
      {#if ungroupedPending.length > 0}
        <div class="group-divider">
          <span>Other · {ungroupedPending.length}</span>
        </div>
        {#each ungroupedPending as todo (todo.id + '::other')}
          {@render taskCard(todo)}
        {/each}
      {/if}
      {#if doneTodos.length > 0}
        <div class="section-divider">
          <span>Completed · {doneTodos.length}</span>
        </div>
        {#each doneTodos as todo (todo.id)}
          {@render taskCard(todo)}
        {/each}
      {/if}
    {:else}
      <!-- Flat view -->
      {#if pendingTodos.length === 0}
        <div class="empty">All tasks completed.</div>
      {/if}
      {#each pendingTodos as todo (todo.id)}
        {@render taskCard(todo)}
      {/each}

      {#if doneTodos.length > 0}
        <div class="section-divider">
          <span>Completed · {doneTodos.length}</span>
        </div>
        {#each doneTodos as todo (todo.id)}
          {@render taskCard(todo)}
        {/each}
      {/if}
    {/if}
  </div>
  {/if}

  <!-- Selection action bar -->
  {#if selectedIds.size > 0}
    <div class="selection-bar">
      {#if confirmDelete}
        <span class="sel-count">Delete {selectedIds.size} task{selectedIds.size > 1 ? 's' : ''}?</span>
        <div class="sel-spacer"></div>
        <button class="sel-btn danger" onclick={deleteSelected}>Confirm</button>
        <button class="sel-btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
      {:else}
        <div class="sel-top-row">
          <span class="sel-count">{selectedIds.size} selected</span>
          <button class="sel-btn ghost icon-only" onclick={() => { selectedIds = new Set(); }} title="Clear selection">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div class="sel-spacer"></div>
          {#if selTodo}
            <button class="sel-btn" onclick={() => startEdit(selTodo!)} title="Edit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="sel-btn" onclick={() => copyMarkdown(selTodo!)} title="Copy markdown">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
            <button
              class="sel-btn {notesOpenId === selTodo.id ? 'notes-active' : ''}"
              onclick={() => notesOpenId === selTodo!.id ? closeNotes() : openNotes(selTodo!)}
              title="{notesOpenId === selTodo.id ? 'Close notes' : (selTodo.notes ? 'Edit notes' : 'Add notes')}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Notes
            </button>
          {/if}
          <button class="sel-btn danger" onclick={() => (confirmDelete = true)} title="Delete selected">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            Delete
          </button>
        </div>
        {#if selTodo}
          {#if $activeTimers.has(selTodo.id)}
            <button class="play-btn stop" onclick={() => stopTimer(selTodo!)} title="Stop timer">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>
              <span class="play-btn-time">{formatElapsed($activeTimers.get(selTodo.id)!)}</span>
            </button>
          {:else}
            <button class="play-btn" onclick={() => startTimer(selTodo!)} title="Start timer">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Start timer
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  @import '@milkdown/crepe/theme/common/style.css';
  @import '@milkdown/crepe/theme/nord-dark.css';

  .tasks { height: 100%; overflow-y: auto; padding: 28px 32px 16px; display: flex; flex-direction: column; gap: 16px; }

  .page-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  h1 { font-size: 1.6rem; font-weight: 700; color: var(--text-1); }
  .subtitle { color: var(--text-6); font-size: 0.875rem; margin-top: 2px; }

  .filter-toggle {
    width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
  }
  .filter-toggle:hover { border-color: var(--accent); color: var(--accent-ltr); }
  .filter-toggle.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }

  .fab {
    width: 40px; height: 40px; border-radius: 12px; border: none;
    background: var(--accent); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s; flex-shrink: 0;
  }
  .fab:hover { background: var(--accent-dk); }

  .new-task-form {
    background: var(--surface); border: 1px solid var(--accent); border-radius: 12px;
    padding: 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .edit-form { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .form-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .form-actions { display: flex; gap: 8px; }

  .input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem; outline: none;
    flex: 1; min-width: 0;
  }
  .input:focus { border-color: var(--accent); }
  .select {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 32px 8px 12px; font-size: 0.875rem; outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
  }
  .select:focus { border-color: var(--accent); }
  .btn-primary {
    padding: 8px 16px; border-radius: 8px; border: none;
    background: var(--accent); color: #fff; font-size: 0.875rem; cursor: pointer; transition: background 0.15s;
  }
  .btn-primary:hover { background: var(--accent-dk); }
  .btn-ghost {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.875rem; cursor: pointer;
  }
  .btn-ghost:hover { border-color: var(--text-8); color: var(--text-2); }

  .filter-bar {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
  }
  .search-input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem; outline: none; width: 100%;
  }
  .search-input:focus { border-color: var(--accent); }
  .filter-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .filter-label { font-size: 0.75rem; color: var(--text-6); min-width: 52px; }
  .chip {
    padding: 3px 10px; border-radius: 20px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.75rem; cursor: pointer; transition: all 0.12s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent-ltr); }
  .chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }
  .prio-chip.active { border-color: var(--pc); color: var(--pc); background: color-mix(in srgb, var(--pc) 15%, transparent); }
  .tag-chip { color: var(--accent-lt); border-color: var(--accent-bg); }
  .tag-chip.active { background: var(--accent-bg); border-color: var(--accent); }

  .annotation-hint { font-size: 0.75rem; color: var(--text-7); padding: 6px 2px; }
  .annotation-hint code { background: var(--border); border-radius: 4px; padding: 1px 5px; color: var(--accent-purple); }

  .task-list { display: flex; flex-direction: column; gap: 4px; }
  .empty { color: var(--text-7); font-size: 0.875rem; padding: 20px 0; text-align: center; }

  .section-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 12px 0 4px; color: var(--text-7); font-size: 0.72rem;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  }
  .section-divider::before, .section-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }

  .group-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 20px 0 6px; color: var(--accent-lt); font-size: 0.82rem;
    font-weight: 700; letter-spacing: 0.03em;
  }
  .group-divider:first-child { margin-top: 4px; }
  .group-divider::before, .group-divider::after {
    content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .due-period-chip.active { background: var(--yellow-bg); border-color: var(--yellow); color: var(--yellow); }
  .group-tag-chip { color: var(--accent-purple); border-color: color-mix(in srgb, var(--accent-purple) 30%, transparent); }
  .group-tag-chip.active { background: color-mix(in srgb, var(--accent-purple) 15%, transparent); border-color: var(--accent-purple); color: var(--accent-purple); }
  .group-clear-chip { color: var(--text-5); border-color: var(--border-2); }

  .task-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px;
    transition: border-color 0.12s, background 0.12s;
  }
  .task-card:hover { border-color: var(--border-2); }
  .task-card.done { opacity: 0.55; }
  .task-card.timer-active { border-color: var(--accent); background: var(--surface); }
  .task-card.selected { border-color: var(--accent); background: var(--accent-bg); }

  .check-btn { background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0; display: flex; margin-top: 2px; }

  .task-body { flex: 1; min-width: 0; cursor: pointer; }
  .task-title-row { display: flex; align-items: flex-start; gap: 8px; }
  .priority-bar { width: 3px; height: 16px; border-radius: 2px; flex-shrink: 0; margin-top: 3px; }
  .task-title { font-size: 0.9rem; color: var(--text-2); flex: 1; min-width: 0; word-break: break-word; }
  .task-card.done .task-title { text-decoration: line-through; color: var(--text-6); }

  .timer-running {
    font-size: 0.78rem; color: var(--accent-lt); font-variant-numeric: tabular-nums;
    background: var(--accent-bg); padding: 1px 7px; border-radius: 4px;
    font-family: monospace; letter-spacing: 0.03em;
  }

  .task-meta { display: flex; gap: 5px; align-items: center; margin-top: 5px; flex-wrap: wrap; }

  .due-chip {
    font-size: 0.7rem; color: var(--yellow); background: var(--yellow-bg);
    padding: 2px 7px; border-radius: 4px;
  }
  .due-chip.overdue { color: var(--red); background: var(--red-bg); }

  .time-chip {
    font-size: 0.68rem; padding: 2px 6px; border-radius: 4px;
  }
  .time-chip.started { color: var(--text-3); background: var(--border); }
  .time-chip.finished { color: var(--green); background: var(--green-bg); }
  .time-chip.logged {
    color: var(--accent-purple); background: var(--accent-bg); border: none; cursor: pointer;
    transition: background 0.12s;
  }
  .time-chip.logged:hover, .time-chip.logged.active { background: var(--accent-bg-2); }

  .tag-chip {
    font-size: 0.7rem; color: var(--accent-lt); background: transparent;
    border: none; padding: 0; cursor: pointer;
  }
  .tag-chip:hover { color: var(--accent-purple); text-decoration: underline; }

  /* Work sessions panel */
  .sessions-panel {
    background: var(--bg); border: 1px solid var(--border); border-top: none;
    border-radius: 0 0 10px 10px; padding: 10px 14px 12px;
    margin-top: -4px; display: flex; flex-direction: column; gap: 5px;
  }
  .sessions-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-7); margin-bottom: 4px; }
  .session-row { display: flex; align-items: center; gap: 10px; font-size: 0.75rem; }
  .session-num { color: var(--text-7); min-width: 16px; text-align: right; }
  .session-range { color: var(--text-3); flex: 1; }
  .session-dur { color: var(--accent-purple); white-space: nowrap; }
  .sessions-total { font-size: 0.75rem; color: var(--text-6); padding-top: 4px; border-top: 1px solid var(--border); margin-top: 2px; }

  /* Focus mode toggle */
  .focus-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.78rem; font-weight: 500;
    cursor: pointer; transition: all 0.15s; position: relative;
  }
  .focus-toggle:hover { border-color: var(--accent); color: var(--accent-ltr); background: var(--border); }
  .focus-toggle.active { border-color: var(--accent); color: var(--accent-lt); background: var(--accent-bg); }
  .focus-pip {
    width: 6px; height: 6px; border-radius: 50%; background: var(--red);
    animation: pip-pulse 1.5s ease-in-out infinite;
  }
  .focus-toggle.active .focus-pip { background: var(--green); }
  @keyframes pip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Focus view */
  .focus-view {
    flex: 1; display: flex; flex-direction: column; gap: 0;
    padding: 0; overflow-y: auto;
  }

  /* Focus mode: notes panel fills all remaining space, full bleed */
  .focus-mode {
    padding-left: 0;
    padding-right: 0;
    padding-bottom: 0;
    overflow: hidden;
  }
  .focus-mode .focus-view {
    overflow: hidden;
    min-height: 0;
  }
  .focus-mode .notes-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-left: none;
    border-right: none;
    border-bottom: none;
    border-radius: 0;
  }
  .focus-mode .notes-editor-wrap {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  :global(.focus-mode .notes-editor-wrap .ProseMirror) {
    padding-bottom: 40px !important;
  }
  .focus-mode .notes-raw-editor {
    flex: 1;
    min-height: 0;
    resize: none;
    overflow-y: auto;
  }

  /* Selection bar */
  .selection-bar {
    position: sticky; bottom: 0;
    background: var(--surface-alt); border: 1px solid var(--accent); border-radius: 14px;
    padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;
    box-shadow: 0 -4px 24px rgba(99, 102, 241, 0.15);
    margin-top: auto;
  }
  .sel-top-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sel-count { font-size: 0.85rem; color: var(--accent-ltr); font-weight: 600; white-space: nowrap; }
  .sel-spacer { flex: 1; }
  .sel-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-2); font-size: 0.8rem; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }
  .sel-btn:hover { background: var(--accent-bg); border-color: var(--accent); color: var(--text-2); }
  .sel-btn.ghost { color: var(--text-4); }
  .sel-btn.ghost:hover { color: var(--text-2); }
  .sel-btn.icon-only { padding: 6px 8px; }
  .sel-btn.danger { color: var(--red); border-color: var(--red-border); }
  .sel-btn.danger:hover { background: var(--red-bg); border-color: var(--red); }

  /* Big play / stop button */
  .play-btn {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 14px 20px; border-radius: 10px; border: none;
    background: var(--accent); color: #fff;
    font-size: 1rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    letter-spacing: 0.01em;
  }
  .play-btn:hover { background: var(--accent-dk); }
  .play-btn:active { transform: scale(0.98); }
  .play-btn.stop { background: var(--red-border); color: var(--red); border: 1px solid var(--red-deep); }
  .play-btn.stop:hover { background: var(--red-border-2); }
  .play-btn-time { font-family: monospace; font-size: 1.1rem; letter-spacing: 0.05em; font-variant-numeric: tabular-nums; }

  @media (max-width: 600px) {
    .tasks { padding: 16px 16px 12px; }
    .form-row { flex-direction: column; }
    .selection-bar { border-radius: 10px; }
    .sel-btn { padding: 6px 10px; font-size: 0.78rem; flex-shrink: 0; }
  }

  /* Notes indicator on task card */
  .notes-indicator {
    display: flex; align-items: center;
    color: var(--accent); opacity: 0.75; flex-shrink: 0;
  }

  /* Task card with notes open — square bottom corners to connect to panel */
  .task-card.notes-open {
    border-color: var(--accent);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  /* Notes panel */
  .notes-panel {
    background: var(--bg-deep);
    border: 1px solid var(--accent);
    border-top: none;
    border-radius: 0 0 10px 10px;
  }

  .notes-panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-deep);
  }

  .notes-panel-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.68rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--accent);
  }

  .notes-close-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 5px;
    border: 1px solid transparent; background: transparent;
    color: var(--text-6); cursor: pointer; transition: all 0.12s; margin-left: 2px;
  }
  .notes-close-btn:hover { border-color: var(--red-border); color: var(--red); background: var(--red-bg); }
  .notes-clear-btn:hover { border-color: var(--red-border); color: var(--red); background: var(--red-bg); }
  .notes-close-btn.raw-active { border-color: var(--accent); color: var(--accent-lt); background: var(--accent-bg); }
  .notes-close-btn.raw-active:hover { border-color: var(--accent-lt); color: var(--accent-ltr); background: var(--accent-bg-2); }

  /* Notes raw markdown textarea */
  .notes-raw-editor {
    display: block;
    width: 100%;
    min-height: 180px;
    background: transparent;
    border: none;
    color: var(--text-2);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    line-height: 1.7;
    padding: 12px 16px;
    resize: vertical;
    outline: none;
    caret-color: var(--text-2) !important;
    box-sizing: border-box;
  }

  /* Notes Milkdown editor */
  .notes-editor-wrap { min-height: 140px; }
  :global(.notes-editor-wrap .ProseMirror) {
    padding: 4px 16px 12px !important;
    font-size: 0.85rem;
    line-height: 1.65;
    min-height: 120px;
    outline: none;
    overflow-wrap: break-word;
    word-break: break-word;
    caret-color: var(--text-2) !important;
  }
  :global(.notes-editor-wrap .milkdown) { position: relative; }

  /* Block code */
  :global(.notes-editor-wrap .ProseMirror pre) {
    position: relative;
    background: var(--bg-deep);
    border: 1px solid var(--border-2);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 8px 14px;
    margin: 3px 0;
    overflow-x: auto;
  }
  /* Consecutive code blocks — close the gap so they feel like one region */
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block + .milkdown-code-block) {
    margin-top: 1px;
  }
  /* Single-line code blocks — decoration class lands on div.milkdown-code-block */
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block.single-line pre) {
    padding: 4px 10px;
  }
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block.single-line) {
    margin: 2px 0;
  }
  /* List item with a code block: bullet stays on the same line */
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block)) {
    display: flex;
    align-items: center;
    list-style: none;
    gap: 6px;
  }
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block)::before) {
    content: '•';
    flex-shrink: 0;
    font-size: 1.1em;
    line-height: 1;
    color: var(--text-6);
  }
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block) > .milkdown-code-block) {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  :global(.notes-editor-wrap .ProseMirror pre code) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    line-height: 1.7;
    color: var(--text-2);
    background: none;
    border: none;
    padding: 0;
  }

  :global(.code-copy-btn) {
    position: fixed;
    display: none;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 6px;
    border: 1px solid var(--border-2);
    background: var(--surface-alt);
    color: var(--text-5);
    cursor: pointer;
    z-index: 9999;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  :global(.code-copy-btn.visible) { display: flex; }
  :global(.code-copy-btn:hover) { background: var(--accent-bg-2); border-color: var(--accent); color: var(--text-2); }

  /* Notes button active state in selection bar */
  .sel-btn.notes-active { color: var(--accent-lt); border-color: var(--accent); background: var(--accent-bg); }
  .sel-btn.notes-active:hover { background: var(--accent-bg-2); }
</style>
