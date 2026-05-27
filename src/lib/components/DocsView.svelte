<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { notes, todos, selectedNoteId } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Note } from '$lib/types';
  import { extractTasksFromMarkdown } from '$lib/taskAnnotations';
  import { Crepe, CrepeFeature } from '@milkdown/crepe';
  import '@milkdown/crepe/theme/common/style.css';
  import '@milkdown/crepe/theme/nord-dark.css';
  import { replaceAll } from '@milkdown/utils';
  import { editorViewCtx } from '@milkdown/core';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores';

  let { onTodosChanged }: { onTodosChanged: () => void } = $props();

  let editorEl: HTMLElement;
  let crepe: Crepe | null = null;
  let currentMarkdown = $state('');

  let saving = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Prevents scheduling autosave during the synchronous replaceAll() call in loadNote.
  let loadingNote = false;

  // Inline creation (VS Code-style)
  let inlineCreate: { type: 'note' | 'folder'; parentPath: string } | null = $state(null);
  let inlineCreateValue = $state('');
  // Folders that have been named but have no notes yet — kept so the tree shows them
  let pendingFolders = $state<string[]>([]);

  // Header "+" dropdown
  let showHeaderMenu = $state(false);

  // Right-click context menu
  let contextMenu: { x: number; y: number; folderPath: string } | null = $state(null);

  // Folder management
  let selectedFolder: string | null = $state(null);
  let expandedFolders = $state(new Set<string>(['']));

  // Current note
  let currentNote: Note | null = $state(null);
  let lastLoadedId = '';
  let rawMode = $state(false);

  // Rename state
  let renamingNoteId: string | null = $state(null);
  let renameNoteValue = $state('');
  let renamingFolder: string | null = $state(null);
  let renameFolderValue = $state('');

  // Folder delete confirm
  let confirmDeleteFolder: string | null = $state(null);

  // Drag-and-drop
  let draggedNoteId: string | null = $state(null);
  let dragTarget: string | null = $state(null); // folder being hovered; '' = root

  interface FolderTreeNode { name: string; fullPath: string; children: FolderTreeNode[]; }

  function buildFolderTree(paths: string[]): FolderTreeNode[] {
    const root: FolderTreeNode[] = [];
    for (const path of paths.filter(Boolean).sort()) {
      const parts = path.split('/');
      let level = root;
      let built = '';
      for (const part of parts) {
        built = built ? `${built}/${part}` : part;
        let node = level.find(n => n.name === part);
        if (!node) { node = { name: part, fullPath: built, children: [] }; level.push(node); }
        level = node.children;
      }
    }
    return root;
  }

  function subtreeNoteCount(path: string): number {
    return $notes.filter(n => { const f = n.folder ?? ''; return f === path || f.startsWith(path + '/'); }).length;
  }

  // Derived
  let allFolders = $derived(
    [...new Set([...$notes.map((n) => n.folder ?? ''), ...pendingFolders])].filter(Boolean).sort()
  );
  let folderTree = $derived(buildFolderTree(allFolders));
  let visibleNotes = $derived(
    selectedFolder === null
      ? $notes
      : $notes.filter(n => { const f = n.folder ?? ''; return f === selectedFolder || f.startsWith(selectedFolder + '/'); })
  );

  $effect(() => {
    const id = $selectedNoteId;
    if (id && id !== lastLoadedId) {
      const note = $notes.find((n) => n.id === id);
      if (note) {
        loadNote(note);
        // Ensure all ancestor folders are expanded so the note is visible in the tree
        if (note.folder) expandPath(note.folder);
      }
    }
  });

  // Matches asset:// and http(s)://asset.localhost URLs produced by convertFileSrc
  const ASSET_RE = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)(\/.*)/;

  // Convert relative image paths to asset:// URLs so Tauri's WebView can load
  // them directly from the filesystem (assetProtocol is enabled in tauri.conf.json).
  // Splits "url" or `url "title"` or `url 'title'` into [url, title].
  function splitUrlTitle(raw: string): [string, string] {
    const m = raw.match(/^(\S+)(?:\s+(["'(].*["')]\s*))?$/);
    return m ? [m[1], m[2] ?? ''] : [raw, ''];
  }

  // Images are always resolved from the repo root (global img/ directory).
  // A reference like `img/diagram.png` always means `{repoPath}/img/diagram.png`,
  // regardless of which folder the note lives in — so moving/renaming notes never
  // breaks image links.
  function makeImagesLoadable(content: string, _folder: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, raw) => {
      const [src, title] = splitUrlTitle(raw);
      if (src.startsWith('http') || src.startsWith('data:') || ASSET_RE.test(src)) return match;
      const absPath = src.startsWith('/') ? src : `${repoPath}/${src}`;
      const assetUrl = convertFileSrc(absPath);
      return title ? `![${alt}](${assetUrl} ${title})` : `![${alt}](${assetUrl})`;
    });
  }

  // Strip asset:// URLs back to repo-root-relative paths for saving.
  function stripAssetUrls(content: string, _folder: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    const prefix = repoPath + '/';
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, raw) => {
      const [src, title] = splitUrlTitle(raw);
      const m = src.match(ASSET_RE);
      if (!m) return match;
      // decodeURIComponent may give "//home/..." when convertFileSrc encoded the leading slash
      let absPath = decodeURIComponent(m[1]);
      if (absPath.startsWith('//')) absPath = absPath.slice(1);
      if (absPath.startsWith(prefix)) {
        const rel = absPath.slice(prefix.length);
        return title ? `![${alt}](${rel} ${title})` : `![${alt}](${rel})`;
      }
      return match;
    });
  }

  function loadNote(note: Note) {
    if (saveTimer && currentNote && currentNote.id !== note.id) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void saveCurrentNote();
    }
    currentNote = note;
    lastLoadedId = note.id;
    currentMarkdown = note.content;
    const display = makeImagesLoadable(note.content, note.folder ?? '');
    loadingNote = true;
    crepe?.editor.action(replaceAll(display));
    loadingNote = false;
    // Ensure ancestor folders are expanded so the note is visible in the sidebar
    if (note.folder) expandPath(note.folder);
  }

  function toggleRaw() {
    if (!rawMode) {
      rawMode = true;
    } else {
      rawMode = false;
      if (crepe && currentNote) {
        crepe.editor.action(replaceAll(makeImagesLoadable(currentMarkdown, currentNote.folder ?? '')));
      }
    }
  }

  // Ctrl+= promotes heading (paragraph→h6→h5→…→h1)
  // Ctrl+-  demotes heading  (h1→h2→…→h6→paragraph)
  function handleHeadingShortcut(e: KeyboardEvent) {
    if (!e.ctrlKey || rawMode || !crepe) return;
    const promote = e.key === '=' || e.key === '+';
    const demote  = e.key === '-';
    if (!promote && !demote) return;
    e.preventDefault();

    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;
      const selFrom = state.selection.$from;
      const { schema } = state;

      const parent = selFrom.parent;
      let level = 0; // 0 = paragraph
      if (parent.type === schema.nodes.heading) {
        level = parent.attrs.level as number;
      } else if (parent.type !== schema.nodes.paragraph) {
        return; // inside a list item, code block, etc. — ignore
      }

      let tr;
      if (promote) {
        if (level === 1) return; // already h1, can't go further
        const next = level === 0 ? 6 : level - 1;
        tr = state.tr.setBlockType(from, to, schema.nodes.heading, { level: next });
      } else {
        if (level === 0) return; // already paragraph, can't go further
        if (level === 6) {
          tr = state.tr.setBlockType(from, to, schema.nodes.paragraph);
        } else {
          tr = state.tr.setBlockType(from, to, schema.nodes.heading, { level: level + 1 });
        }
      }
      view.dispatch(tr);
    });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentNote, 1200);
  }

  async function saveCurrentNote() {
    if (!currentNote) return;
    // Capture both synchronously before any await — currentNote/currentMarkdown
    // can change while the async save is in flight if the user switches notes.
    const noteToSave = currentNote;
    const content = currentMarkdown;
    const title = noteToSave.title || extractTitle(content);

    saving = true;
    try {
      const saved = await api.saveNote({ ...noteToSave, content, title });
      // Only update the displayed note if the user hasn't switched away
      if (currentNote?.id === noteToSave.id) {
        currentNote = saved;
        lastLoadedId = saved.id;
      }
      notes.update((ns) => ns.map((n) => (n.id === saved.id ? saved : n)));
      await syncTasksFromDoc(content);
    } finally {
      saving = false;
    }
  }

  function extractTitle(content: string): string {
    const m = content.match(/^#+ (.+)/m);
    return m ? m[1].trim() : 'Untitled';
  }

  async function syncTasksFromDoc(md: string) {
    const parsed = extractTasksFromMarkdown(md);
    if (!parsed.length) return;
    const existing = $todos;
    for (const p of parsed) {
      const match = existing.find((t) => t.title === p.cleanTitle);
      if (match) {
        if (match.done !== p.done || match.priority !== p.priority) {
          const updated = await api.saveTodo({
            ...match, done: p.done, priority: p.priority,
            due_date: p.due_date ?? match.due_date,
            tags: p.tags.length ? p.tags : match.tags,
          });
          todos.update((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
        }
      } else {
        const created = await api.saveTodo({
          id: '', title: p.cleanTitle, done: p.done, priority: p.priority,
          due_date: p.due_date, tags: p.tags,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        todos.update((ts) => [created, ...ts]);
      }
    }
    onTodosChanged();
  }

  // Action to auto-focus an input when it mounts
  function focusOnMount(el: HTMLElement) { el.focus(); }

  function expandPath(path: string) {
    if (!path) return;
    const parts = path.split('/');
    expandedFolders = new Set([...expandedFolders, ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]);
  }

  function startInlineCreate(type: 'note' | 'folder', parentPath: string) {
    inlineCreate = { type, parentPath };
    inlineCreateValue = '';
    contextMenu = null;
    showHeaderMenu = false;
    // Auto-expand the parent so the inline input is visible
    expandPath(parentPath);
  }

  function cancelInlineCreate() {
    inlineCreate = null;
  }

  async function commitInlineCreate() {
    if (!inlineCreate) return;
    const { type, parentPath } = inlineCreate;
    const name = inlineCreateValue.trim();
    inlineCreate = null;
    inlineCreateValue = '';
    if (!name) return;

    if (type === 'note') {
      const note = await api.saveNote({
        id: '', title: name, content: `# ${name}\n\n`,
        folder: parentPath, pinned: false, tags: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      notes.update(ns => [note, ...ns]);
      // Remove from pending folders now that a real note exists there
      if (parentPath) pendingFolders = pendingFolders.filter(f => f !== parentPath);
      selectedNoteId.set(note.id);
      loadNote(note);
      selectedFolder = parentPath || null;
    } else {
      // Named a new folder — add as pending so it appears in the tree without requiring a note right away
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      pendingFolders = [...pendingFolders, folderPath];
      expandPath(folderPath);
    }
  }

  async function deleteNote(id: string) {
    await api.deleteNote(id);
    notes.update((ns) => ns.filter((n) => n.id !== id));
    if ($selectedNoteId === id) {
      const remaining = $notes.filter((n) => n.id !== id);
      const next = remaining[0] ?? null;
      selectedNoteId.set(next?.id ?? null);
      currentNote = next;
      if (next) loadNote(next);
    }
  }

  async function togglePin(note: Note) {
    const updated = await api.saveNote({ ...note, pinned: !note.pinned });
    notes.update((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
    if (currentNote?.id === updated.id) currentNote = updated;
  }

  async function moveToFolder(note: Note, folder: string) {
    const updated = await api.saveNote({ ...note, folder });
    notes.update((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
    if (currentNote?.id === updated.id) currentNote = updated;
  }

  function toggleFolder(folder: string) {
    const next = new Set(expandedFolders);
    if (next.has(folder)) next.delete(folder); else next.add(folder);
    expandedFolders = next;
  }

  // ── Rename note ────────────────────────────────────────────────────────────

  function startRenameNote(note: Note) {
    renamingNoteId = note.id;
    renameNoteValue = note.title;
  }

  async function commitRenameNote(note: Note) {
    const newTitle = renameNoteValue.trim();
    renamingNoteId = null;
    if (!newTitle || newTitle === note.title) return;
    const updated = await api.saveNote({ ...note, title: newTitle });
    notes.update((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
    if (currentNote?.id === updated.id) { currentNote = updated; lastLoadedId = updated.id; }
  }

  // ── Rename folder ──────────────────────────────────────────────────────────

  function startRenameFolder(folder: string) {
    renamingFolder = folder;
    renameFolderValue = folder;
    confirmDeleteFolder = null;
  }

  async function commitRenameFolder(oldFolder: string) {
    const newFolder = renameFolderValue.trim();
    renamingFolder = null;
    if (newFolder === oldFolder) return;
    const toRename = $notes.filter(n => { const f = n.folder ?? ''; return f === oldFolder || f.startsWith(oldFolder + '/'); });
    for (const note of toRename) {
      const oldF = note.folder ?? '';
      const newF = oldF === oldFolder ? newFolder : newFolder + oldF.slice(oldFolder.length);
      const updated = await api.saveNote({ ...note, folder: newF });
      notes.update(ns => ns.map(n => n.id === updated.id ? updated : n));
      if (currentNote?.id === updated.id) currentNote = { ...currentNote, folder: newF };
    }
    expandedFolders = new Set([...expandedFolders].map(f => {
      if (f === oldFolder) return newFolder;
      if (f.startsWith(oldFolder + '/')) return newFolder + f.slice(oldFolder.length);
      return f;
    }));
    if (selectedFolder === oldFolder) selectedFolder = newFolder;
    else if (selectedFolder?.startsWith(oldFolder + '/')) selectedFolder = newFolder + selectedFolder.slice(oldFolder.length);
  }

  // ── Delete folder ──────────────────────────────────────────────────────────

  async function deleteFolderNotes(folder: string) {
    confirmDeleteFolder = null;
    const toDelete = $notes.filter(n => { const f = n.folder ?? ''; return f === folder || f.startsWith(folder + '/'); });
    for (const note of toDelete) await api.deleteNote(note.id);
    notes.update(ns => ns.filter(n => { const f = n.folder ?? ''; return f !== folder && !f.startsWith(folder + '/'); }));
    if (toDelete.find(n => n.id === $selectedNoteId)) { selectedNoteId.set(null); currentNote = null; }
    if (selectedFolder === folder || selectedFolder?.startsWith(folder + '/')) selectedFolder = null;
    // Remove any pending sub-paths too
    pendingFolders = pendingFolders.filter(f => f !== folder && !f.startsWith(folder + '/'));
  }

  async function moveFolderToRoot(folder: string) {
    confirmDeleteFolder = null;
    const toMove = $notes.filter(n => { const f = n.folder ?? ''; return f === folder || f.startsWith(folder + '/'); });
    for (const note of toMove) {
      const updated = await api.saveNote({ ...note, folder: '' });
      notes.update(ns => ns.map(n => n.id === updated.id ? updated : n));
      if (currentNote?.id === updated.id) currentNote = { ...currentNote, folder: '' };
    }
    if (selectedFolder === folder || selectedFolder?.startsWith(folder + '/')) selectedFolder = null;
    pendingFolders = pendingFolders.filter(f => f !== folder && !f.startsWith(folder + '/'));
  }

  // ── Drag and drop ──────────────────────────────────────────────────────────

  function onDragStart(e: DragEvent, noteId: string) {
    e.dataTransfer!.setData('text/plain', noteId);
    e.dataTransfer!.effectAllowed = 'move';
    draggedNoteId = noteId;
  }

  function onDragOver(e: DragEvent, folder: string) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    dragTarget = folder;
  }

  function onDragLeave(e: DragEvent, folder: string) {
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      if (dragTarget === folder) dragTarget = null;
    }
  }

  async function onDrop(e: DragEvent, targetFolder: string) {
    e.preventDefault();
    dragTarget = null;
    draggedNoteId = null;
    const noteId = e.dataTransfer!.getData('text/plain');
    if (!noteId) return;
    const note = $notes.find((n) => n.id === noteId);
    if (!note || (note.folder ?? '') === targetFolder) return;
    await moveToFolder(note, targetFolder);
    expandedFolders = new Set([...expandedFolders, targetFolder]);
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  onMount(() => {
    // Inject heading-gap fix once — CSS rules can't be set via :global() for this pattern
    if (!document.getElementById('mk-h-fix')) {
      const s = document.createElement('style');
      s.id = 'mk-h-fix';
      s.textContent = '.milkdown .ProseMirror h1,.milkdown .ProseMirror h2,.milkdown .ProseMirror h3,.milkdown .ProseMirror h4,.milkdown .ProseMirror h5,.milkdown .ProseMirror h6{margin-top:0!important;padding-top:0!important}';
      document.head.appendChild(s);
    }
    const c = new Crepe({
      root: editorEl,
      defaultValue: '',
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.TopBar]: false,
        [CrepeFeature.Latex]: false,
      },
    });
    c.on((api) => {
      api.markdownUpdated((_, markdown) => {
        currentMarkdown = stripAssetUrls(markdown, currentNote?.folder ?? '');
        // Skip autosave when the update was triggered by loadNote's replaceAll call.
        if (currentNote && !loadingNote) scheduleSave();
      });
    });
    const closeMenus = () => { contextMenu = null; showHeaderMenu = false; };
    document.addEventListener('click', closeMenus);

    void c.create().then(() => {
      crepe = c;
      editorEl.addEventListener('keydown', handleHeadingShortcut);
      const pm = editorEl.querySelector('.ProseMirror');
      if (pm instanceof HTMLElement) pm.style.paddingTop = '0';
      if (currentNote && currentMarkdown) {
        crepe.editor.action(replaceAll(makeImagesLoadable(currentMarkdown, currentNote.folder ?? '')));
      } else if ($notes.length > 0) {
        const first = $notes[0];
        selectedNoteId.set(first.id);
        loadNote(first);
      }
    });
  });

  onDestroy(() => {
    document.removeEventListener('click', () => { contextMenu = null; showHeaderMenu = false; });
    editorEl?.removeEventListener('keydown', handleHeadingShortcut);
    if (saveTimer) { clearTimeout(saveTimer); void saveCurrentNote(); }
    void crepe?.destroy();
  });
</script>

<div class="docs">
  <!-- ── Folder + note sidebar ─────────────────────────────────────────── -->
  <aside class="note-list">
    <div class="note-list-header">
      <span class="section-title">Documents</span>
      <div class="header-menu-wrap">
        <button class="icon-btn" onclick={(e) => { e.stopPropagation(); showHeaderMenu = !showHeaderMenu; }} title="New…">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        {#if showHeaderMenu}
          <div class="ctx-menu" onclick={(e) => e.stopPropagation()}>
            <button class="ctx-item" onclick={() => startInlineCreate('note', '')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              New document
            </button>
            <button class="ctx-item" onclick={() => startInlineCreate('folder', '')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              New folder
            </button>
          </div>
        {/if}
      </div>
    </div>

    <!-- "All" shortcut — also a drop target for root; right-click for root-level creation -->
    <button
      class="folder-all {selectedFolder === null ? 'active' : ''} {dragTarget === '' ? 'drag-over' : ''}"
      onclick={() => (selectedFolder = null)}
      oncontextmenu={(e) => { e.preventDefault(); contextMenu = { x: e.clientX, y: e.clientY, folderPath: '' }; }}
      ondragover={(e) => onDragOver(e, '')}
      ondragleave={(e) => onDragLeave(e, '')}
      ondrop={(e) => onDrop(e, '')}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      All documents
      <span class="count">{$notes.length}</span>
    </button>

    <!-- Folder tree -->
    <div class="folder-tree">

      {#snippet noteItem(note: import('$lib/types').Note)}
        <li
          class="note-item {$selectedNoteId === note.id ? 'active' : ''} {draggedNoteId === note.id ? 'dragging' : ''}"
          draggable="true"
          ondragstart={(e) => onDragStart(e, note.id)}
          ondragend={() => { draggedNoteId = null; }}
        >
          {#if renamingNoteId === note.id}
            <input class="note-input rename-inline" bind:value={renameNoteValue}
              onkeydown={(e) => { if (e.key === 'Enter') commitRenameNote(note); if (e.key === 'Escape') renamingNoteId = null; }}
              onblur={() => commitRenameNote(note)} />
          {:else}
            <button class="note-item-select" onclick={() => { selectedNoteId.set(note.id); loadNote(note); }}>
              <div class="note-item-title">{#if note.pinned}<span class="pin">📌</span>{/if}{note.title || 'Untitled'}</div>
              <div class="note-item-meta">{fmtDate(note.updated_at)}</div>
            </button>
            <div class="note-item-actions">
              <button class="micro-btn" onclick={() => startRenameNote(note)} title="Rename">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="micro-btn" onclick={() => togglePin(note)} title="{note.pinned ? 'Unpin' : 'Pin'}">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="{note.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/></svg>
              </button>
              <button class="micro-btn danger" onclick={() => deleteNote(note.id)} title="Delete">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </button>
            </div>
          {/if}
        </li>
      {/snippet}

      {#snippet folderNode(node: FolderTreeNode, depth: number)}
        {@const directNotes = $notes.filter(n => (n.folder ?? '') === node.fullPath)}
        {@const isExpanded = expandedFolders.has(node.fullPath)}
        {@const isSelected = selectedFolder === node.fullPath}

        <div
          class="folder-row {dragTarget === node.fullPath ? 'drag-over' : ''}"
          role="listitem"
          style="padding-left: {depth * 14}px"
          oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); contextMenu = { x: e.clientX, y: e.clientY, folderPath: node.fullPath }; }}
          ondragover={(e) => onDragOver(e, node.fullPath)}
          ondragleave={(e) => onDragLeave(e, node.fullPath)}
          ondrop={(e) => onDrop(e, node.fullPath)}
        >
          {#if renamingFolder === node.fullPath}
            <input use:focusOnMount class="note-input rename-inline" bind:value={renameFolderValue}
              onkeydown={(e) => { if (e.key === 'Enter') commitRenameFolder(node.fullPath); if (e.key === 'Escape') renamingFolder = null; }}
              onblur={() => commitRenameFolder(node.fullPath)} />
          {:else}
            <button class="folder-btn {isSelected ? 'active' : ''}"
              onclick={() => { selectedFolder = node.fullPath; toggleFolder(node.fullPath); confirmDeleteFolder = null; }}>
              <span class="folder-chevron">{isExpanded ? '▾' : '▸'}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="{isSelected ? '#6366f1' : 'none'}" stroke="{isSelected ? '#6366f1' : '#9ca3af'}" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="folder-name">{node.name}</span>
              <span class="count">{subtreeNoteCount(node.fullPath)}</span>
            </button>
            <div class="folder-actions">
              <button class="micro-btn" title="New document" onclick={() => startInlineCreate('note', node.fullPath)}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
              </button>
              <button class="micro-btn" title="New subfolder" onclick={() => startInlineCreate('folder', node.fullPath)}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
              </button>
              <button class="micro-btn" onclick={() => startRenameFolder(node.fullPath)} title="Rename">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              {#if confirmDeleteFolder === node.fullPath}
                <button class="micro-btn warning" onclick={() => moveFolderToRoot(node.fullPath)} title="Move to root">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                </button>
                <button class="micro-btn danger" onclick={() => deleteFolderNotes(node.fullPath)} title="Delete all">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
                <button class="micro-btn" onclick={() => (confirmDeleteFolder = null)}>✕</button>
              {:else}
                <button class="micro-btn danger" onclick={() => (confirmDeleteFolder = node.fullPath)} title="Delete">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

        {#if confirmDeleteFolder === node.fullPath}
          <div class="folder-delete-hint" style="padding-left: {depth * 14 + 22}px">Move to root or delete all?</div>
        {/if}

        {#if isExpanded}
          <!-- Inline subfolder creation (appears below parent, indented as child) -->
          {#if inlineCreate?.type === 'folder' && inlineCreate.parentPath === node.fullPath}
            <div class="folder-row inline-create" style="padding-left: {(depth + 1) * 14}px">
              <span class="folder-chevron">▸</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <input use:focusOnMount class="inline-name-input" bind:value={inlineCreateValue}
                placeholder="folder name"
                onkeydown={(e) => { if (e.key === 'Enter') commitInlineCreate(); if (e.key === 'Escape') cancelInlineCreate(); }}
                onblur={() => { if (inlineCreate?.type === 'folder' && inlineCreate.parentPath === node.fullPath) cancelInlineCreate(); }} />
            </div>
          {/if}

          <!-- Inline note creation in this folder -->
          {#if inlineCreate?.type === 'note' && inlineCreate.parentPath === node.fullPath}
            <ul class="note-items" style="padding-left: {(depth + 1) * 14}px">
              <li class="note-item inline-create">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" style="flex-shrink:0;margin-left:6px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <input use:focusOnMount class="inline-name-input" bind:value={inlineCreateValue}
                  placeholder="document name"
                  onkeydown={(e) => { if (e.key === 'Enter') commitInlineCreate(); if (e.key === 'Escape') cancelInlineCreate(); }}
                  onblur={() => { if (inlineCreate?.type === 'note' && inlineCreate.parentPath === node.fullPath) cancelInlineCreate(); }} />
              </li>
            </ul>
          {/if}

          {#if directNotes.length}
            <ul class="note-items" style="padding-left: {(depth + 1) * 14}px">
              {#each directNotes as note (note.id)}{@render noteItem(note)}{/each}
            </ul>
          {/if}
          {#each node.children as child}{@render folderNode(child, depth + 1)}{/each}
        {/if}
      {/snippet}

      {#each folderTree as node}{@render folderNode(node, 0)}{/each}

      <!-- Root-level inline folder creation (from header "+" → New folder) -->
      {#if inlineCreate?.type === 'folder' && inlineCreate.parentPath === ''}
        <div class="folder-row inline-create">
          <span class="folder-chevron">▸</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <input use:focusOnMount class="inline-name-input" bind:value={inlineCreateValue}
            placeholder="folder name"
            onkeydown={(e) => { if (e.key === 'Enter') commitInlineCreate(); if (e.key === 'Escape') cancelInlineCreate(); }}
            onblur={() => { if (inlineCreate?.type === 'folder' && inlineCreate.parentPath === '') cancelInlineCreate(); }} />
        </div>
      {/if}

      <!-- Root-level inline note creation (from header "+" → New document) -->
      {#if inlineCreate?.type === 'note' && inlineCreate.parentPath === ''}
        <ul class="note-items" style="padding-left: 14px">
          <li class="note-item inline-create">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" style="flex-shrink:0;margin-left:6px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <input use:focusOnMount class="inline-name-input" bind:value={inlineCreateValue}
              placeholder="document name"
              onkeydown={(e) => { if (e.key === 'Enter') commitInlineCreate(); if (e.key === 'Escape') cancelInlineCreate(); }}
              onblur={() => { if (inlineCreate?.type === 'note' && inlineCreate.parentPath === '') cancelInlineCreate(); }} />
          </li>
        </ul>
      {/if}

      <!-- Uncategorized (root) notes -->
      {#if $notes.some(n => !(n.folder ?? ''))}
        {@const rootNotes = $notes.filter(n => !(n.folder ?? ''))}
        {@const isExpanded = expandedFolders.has('')}
        {@const isSelected = selectedFolder === ''}
        <div class="folder-row {dragTarget === '' ? 'drag-over' : ''}" role="listitem"
          ondragover={(e) => onDragOver(e, '')} ondragleave={(e) => onDragLeave(e, '')} ondrop={(e) => onDrop(e, '')}>
          {#if renamingFolder === ''}
            <input class="note-input rename-inline" bind:value={renameFolderValue}
              onkeydown={(e) => { if (e.key === 'Enter') commitRenameFolder(''); if (e.key === 'Escape') renamingFolder = null; }}
              onblur={() => commitRenameFolder('')} />
          {:else}
            <button class="folder-btn {isSelected ? 'active' : ''}"
              onclick={() => { selectedFolder = ''; toggleFolder(''); confirmDeleteFolder = null; }}>
              <span class="folder-chevron">{isExpanded ? '▾' : '▸'}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="folder-name">Uncategorized</span>
              <span class="count">{rootNotes.length}</span>
            </button>
            <div class="folder-actions">
              <button class="micro-btn" onclick={() => startRenameFolder('')} title="Rename">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              {#if confirmDeleteFolder === ''}
                <button class="micro-btn danger" onclick={() => deleteFolderNotes('')} title="Delete all">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
                <button class="micro-btn" onclick={() => (confirmDeleteFolder = null)} title="Cancel">✕</button>
              {:else}
                <button class="micro-btn danger" onclick={() => (confirmDeleteFolder = '')} title="Delete">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>
        {#if confirmDeleteFolder === ''}<div class="folder-delete-hint">Delete all uncategorized notes?</div>{/if}
        {#if isExpanded}
          <ul class="note-items indented">
            {#each rootNotes as note (note.id)}{@render noteItem(note)}{/each}
          </ul>
        {/if}
      {/if}

    </div>

    {#if $notes.length === 0}
      <div class="empty-note">No documents yet.</div>
    {/if}
  </aside>

  <!-- ── Editor area ──────────────────────────────────────────────────── -->
  <div class="editor-area">

    {#if currentNote}
      <div class="editor-toolbar">
        <div class="toolbar-left">
          <input
            class="title-input"
            value={currentNote.title}
            oninput={(e) => {
              if (currentNote) {
                currentNote = { ...currentNote, title: (e.target as HTMLInputElement).value };
                scheduleSave();
              }
            }}
            placeholder="Untitled"
          />
        </div>
        <div class="toolbar-right">
          {#if saving}<span class="saving-indicator">saving…</span>{/if}
          <button
            class="icon-btn {rawMode ? 'active' : ''}"
            onclick={toggleRaw}
            title={rawMode ? 'Switch to WYSIWYG' : 'Switch to Raw'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          </button>
        </div>
      </div>
    {/if}

    <div class="milkdown-wrapper" class:hidden={!currentNote || rawMode} bind:this={editorEl}></div>

    <textarea
      class="raw-editor"
      class:hidden={!currentNote || !rawMode}
      bind:value={currentMarkdown}
      oninput={() => { if (currentNote) scheduleSave(); }}
      spellcheck={false}
    ></textarea>

    {#if !currentNote}
      <div class="no-doc">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2d2d3d" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>Select a document or create a new one</p>
        <button class="btn-primary" onclick={() => startInlineCreate('note', '')}>New document</button>
      </div>
    {/if}

    {#if currentNote}
      <div class="editor-hint">
        Task syntax: <code>- [ ] Title #tag @YYYY-MM-DD !high</code> — auto-syncs to Tasks.
      </div>
    {/if}
  </div>

  <!-- Right-click context menu -->
  {#if contextMenu}
    <div
      class="ctx-menu"
      style="position:fixed;left:{contextMenu.x}px;top:{contextMenu.y}px;z-index:200"
      onclick={(e) => e.stopPropagation()}
    >
      <button class="ctx-item" onclick={() => startInlineCreate('note', contextMenu!.folderPath)}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        New document
      </button>
      <button class="ctx-item" onclick={() => startInlineCreate('folder', contextMenu!.folderPath)}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        {contextMenu!.folderPath ? 'New subfolder' : 'New folder'}
      </button>
      {#if contextMenu!.folderPath}
        <div class="ctx-sep"></div>
        <button class="ctx-item" onclick={() => { startRenameFolder(contextMenu!.folderPath); contextMenu = null; }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Rename
        </button>
        <button class="ctx-item danger" onclick={() => { confirmDeleteFolder = contextMenu!.folderPath; contextMenu = null; }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          Delete
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .docs { height: 100%; display: flex; overflow: hidden; }

  /* ── Sidebar ── */
  .note-list {
    width: 230px; min-width: 230px; background: #13131a;
    border-right: 1px solid #1e1e2e; display: flex; flex-direction: column; overflow: hidden;
  }
  .note-list-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 12px 8px; flex-shrink: 0;
  }
  .section-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
  .icon-btn {
    width: 24px; height: 24px; border-radius: 6px; border: none;
    background: #1e1e2e; color: #9ca3af; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s;
  }
  .icon-btn:hover { background: #6366f1; color: #fff; }

  .new-note-form { padding: 0 8px 10px; display: flex; flex-direction: column; gap: 5px; }
  .note-input {
    background: #0f0f14; border: 1px solid #6366f1; border-radius: 7px;
    color: #e2e8f0; padding: 6px 10px; font-size: 0.8rem; outline: none; width: 100%;
  }
  .rename-inline { border-color: #818cf8; margin: 2px 4px; width: calc(100% - 8px); }
  .form-row { display: flex; gap: 5px; }
  .btn-create {
    flex: 1; padding: 6px; border-radius: 7px; border: none;
    background: #6366f1; color: #fff; font-size: 0.8rem; cursor: pointer;
  }
  .btn-create:hover { background: #4f46e5; }
  .btn-cancel {
    padding: 6px 10px; border-radius: 7px; border: 1px solid #2d2d3d;
    background: transparent; color: #6b7280; cursor: pointer; font-size: 0.8rem;
  }

  .folder-all {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 12px; margin: 0 4px 2px; border-radius: 8px;
    border: none; background: transparent; color: #9ca3af;
    font-size: 0.82rem; cursor: pointer; text-align: left; width: calc(100% - 8px);
    transition: background 0.12s, color 0.12s;
  }
  .folder-all:hover { background: #1a1a28; color: #e2e8f0; }
  .folder-all.active { background: #1e1e3a; color: #6366f1; }
  .folder-all.drag-over { background: #1e2a1e; border: 1px dashed #34d399; color: #34d399; }

  .folder-tree { flex: 1; overflow-y: auto; padding: 0 4px 12px; }

  .folder-row {
    display: flex; align-items: center; border-radius: 8px;
    transition: background 0.1s;
  }
  .folder-row.drag-over { background: #1e2a1e; outline: 1px dashed #34d399; }
  .folder-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: 8px; border: none;
    background: transparent; color: #9ca3af;
    font-size: 0.82rem; cursor: pointer; flex: 1; text-align: left;
    transition: background 0.12s, color 0.12s;
  }
  .folder-btn:hover { background: #1a1a28; color: #e2e8f0; }
  .folder-btn.active { color: #6366f1; }
  .folder-chevron { font-size: 0.6rem; width: 10px; }
  .folder-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .folder-actions {
    display: none; gap: 1px; padding-right: 3px; flex-shrink: 0;
  }
  .folder-row:hover .folder-actions { display: flex; }

  .folder-delete-hint {
    font-size: 0.68rem; color: #f87171; padding: 2px 8px 4px 22px;
  }

  .count {
    font-size: 0.68rem; color: #4b5563; background: #1e1e2e;
    padding: 1px 5px; border-radius: 8px; flex-shrink: 0;
  }

  .note-items { list-style: none; padding: 0; }
  .note-items.indented { padding-left: 14px; }
  .note-item {
    display: flex; align-items: center; border-radius: 7px;
    transition: background 0.12s; margin-bottom: 1px;
    cursor: grab;
  }
  .note-item:hover { background: #1a1a28; }
  .note-item.active { background: #1e1e3a; }
  .note-item.dragging { opacity: 0.4; }
  .note-item-select {
    flex: 1; min-width: 0; padding: 7px 6px; border-radius: 7px;
    background: transparent; border: none; text-align: left; cursor: pointer;
  }
  .note-item-title {
    font-size: 0.8rem; color: #e2e8f0; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .note-item-meta { font-size: 0.68rem; color: #475569; margin-top: 1px; }
  .pin { font-size: 0.65em; margin-right: 2px; }
  .note-item-actions {
    display: none; gap: 1px; padding-right: 3px; flex-shrink: 0;
  }
  .note-item:hover .note-item-actions { display: flex; }
  .micro-btn {
    width: 20px; height: 20px; border-radius: 4px; border: none;
    background: #2d2d3d; color: #9ca3af; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: all 0.12s;
    font-size: 0.65rem;
  }
  .micro-btn:hover { background: #3d3d50; color: #e2e8f0; }
  .micro-btn.danger:hover { background: #2a0e0e; color: #f87171; }
  .micro-btn.warning:hover { background: #1a2a1a; color: #34d399; }
  .empty-note { color: #475569; font-size: 0.8rem; padding: 12px; }

  /* ── Editor ── */
  .editor-area {
    flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
    background: #0f0f14;
  }

  .editor-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid #1e1e2e; flex-shrink: 0; gap: 8px;
  }
  .toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .title-input {
    flex: 1; min-width: 0; background: transparent; border: none; outline: none;
    color: #f1f5f9; font-size: 1.05rem; font-weight: 600;
  }
  .title-input::placeholder { color: #475569; }

  .saving-indicator { font-size: 0.72rem; color: #64748b; }
  .icon-btn.active { background: #3730a3; color: #a5b4fc; }

  /* ── Milkdown wrapper ── */
  .milkdown-wrapper { flex: 1; overflow-y: auto; min-height: 0; }
  .milkdown-wrapper.hidden { display: none; }

  /* Override Crepe nord-dark variables to match the app's indigo palette */
  :global(.milkdown) {
    --crepe-color-background: #0f0f14;
    --crepe-color-surface: #13131a;
    --crepe-color-surface-low: #0f0f14;
    --crepe-color-on-background: #e2e8f0;
    --crepe-color-on-surface: #cbd5e1;
    --crepe-color-on-surface-variant: #94a3b8;
    --crepe-color-outline: #2d2d3d;
    --crepe-color-primary: #6366f1;
    --crepe-color-secondary: #1e1e3a;
    --crepe-color-on-secondary: #a5b4fc;
    --crepe-color-inline-code: #a78bfa;
    --crepe-color-inline-area: #1e1e2e;
    --crepe-color-hover: #1e1e3a;
    --crepe-color-selected: rgba(99, 102, 241, 0.45);
    --crepe-color-error: #f87171;
    --crepe-shadow-1: none;
    --crepe-shadow-2: none;
  }

  /* Make editor fill the wrapper and use good prose sizing */
  :global(.milkdown-wrapper .milkdown) { min-height: 100%; }
  :global(.milkdown-wrapper .ProseMirror) {
    padding: 4px 32px 24px !important;
    max-width: 820px;
    font-size: 0.925rem;
    line-height: 1.75;
    color: #e2e8f0;
    caret-color: #818cf8;
  }
  /* Ensure block-edit handle positions relative to the wrapper, not viewport */
  :global(.milkdown-wrapper .milkdown) { position: relative; }

  .no-doc {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 14px; color: #475569;
  }
  .no-doc p { font-size: 0.875rem; }
  .btn-primary {
    padding: 10px 20px; border-radius: 8px; border: none;
    background: #6366f1; color: #fff; font-size: 0.875rem; cursor: pointer;
  }
  .btn-primary:hover { background: #4f46e5; }

  .editor-hint {
    padding: 5px 20px; font-size: 0.7rem; color: #374151;
    border-top: 1px solid #1a1a28; flex-shrink: 0;
  }
  .editor-hint code { background: #1e1e2e; padding: 1px 4px; border-radius: 3px; color: #6366f1; }

  /* ── Raw editor ── */
  .raw-editor {
    flex: 1; min-height: 0; padding: 16px 32px; margin: 0; border: none; outline: none; resize: none;
    background: #0a0a10; color: #cbd5e1;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
    font-size: 0.875rem; line-height: 1.7; tab-size: 2;
  }
  .raw-editor.hidden { display: none; }

  /* ── Header menu wrap ── */
  .header-menu-wrap { position: relative; }

  /* ── Context / dropdown menus ── */
  .ctx-menu {
    background: #1a1a28; border: 1px solid #2d2d3d; border-radius: 8px;
    padding: 4px; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; gap: 1px;
  }
  /* The header dropdown is relative, the right-click menu is fixed (set inline) */
  .header-menu-wrap .ctx-menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 100;
  }
  .ctx-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 5px; border: none;
    background: transparent; color: #cbd5e1;
    font-size: 0.8rem; cursor: pointer; text-align: left; width: 100%;
    transition: background 0.1s, color 0.1s;
  }
  .ctx-item:hover { background: #2d2d3d; color: #f1f5f9; }
  .ctx-item.danger { color: #f87171; }
  .ctx-item.danger:hover { background: #2a0e0e; }
  .ctx-sep { height: 1px; background: #2d2d3d; margin: 3px 0; }

  /* ── Inline creation inputs ── */
  .inline-name-input {
    flex: 1; background: #0f0f14; border: 1px solid #6366f1; border-radius: 5px;
    color: #e2e8f0; padding: 3px 7px; font-size: 0.8rem; outline: none;
    min-width: 0;
  }
  .note-item.inline-create { cursor: default; padding: 4px 6px; gap: 6px; }
  .folder-row.inline-create { padding-top: 3px; padding-bottom: 3px; gap: 6px; }

  @media (max-width: 600px) {
    .note-list { width: 100%; min-width: unset; max-height: 180px; border-right: none; border-bottom: 1px solid #1e1e2e; }
    .docs { flex-direction: column; }
  }
</style>
