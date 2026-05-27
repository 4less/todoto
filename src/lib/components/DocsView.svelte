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
  import { invoke, convertFileSrc } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores';

  let { onTodosChanged }: { onTodosChanged: () => void } = $props();

  let editorEl: HTMLElement;
  let crepe: Crepe | null = null;
  let currentMarkdown = '';

  let saving = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // New note / folder form
  let showNewForm = $state(false);
  let newTitle = $state('');
  let newFolder = $state('');

  // Folder management
  let selectedFolder: string | null = $state(null);
  let expandedFolders = $state(new Set<string>(['']));

  // Current note
  let currentNote: Note | null = $state(null);
  let lastLoadedId = '';

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

  // Derived
  let allFolders = $derived([...new Set($notes.map((n) => n.folder ?? ''))].sort());
  let visibleNotes = $derived(
    selectedFolder === null ? $notes : $notes.filter((n) => (n.folder ?? '') === selectedFolder)
  );

  $effect(() => {
    const id = $selectedNoteId;
    if (id && id !== lastLoadedId) {
      const note = $notes.find((n) => n.id === id);
      if (note) loadNote(note);
    }
  });

  // Matches asset:// and http(s)://asset.localhost URLs produced by convertFileSrc
  const ASSET_RE = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)(\/.*)/;

  // Convert relative image paths to asset:// URLs so Tauri's WebView can load
  // them directly from the filesystem (assetProtocol is enabled in tauri.conf.json).
  function makeImagesLoadable(content: string, folder: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    const noteDir = [repoPath, folder].filter(Boolean).join('/');
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      if (src.startsWith('http') || src.startsWith('data:') || ASSET_RE.test(src)) return match;
      const absPath = src.startsWith('/') ? src : `${noteDir}/${src}`;
      return `![${alt}](${convertFileSrc(absPath)})`;
    });
  }

  // Strip asset:// URLs back to paths relative to the note's folder for saving.
  function stripAssetUrls(content: string, folder: string): string {
    const repoPath = $settings.repo_path;
    if (!repoPath) return content;
    const noteDir = [repoPath, folder].filter(Boolean).join('/');
    const prefix = noteDir + '/';
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      const m = src.match(ASSET_RE);
      if (!m) return match;
      // decodeURIComponent may give "//home/..." when convertFileSrc encoded the leading slash
      let absPath = decodeURIComponent(m[1]);
      if (absPath.startsWith('//')) absPath = absPath.slice(1);
      if (absPath.startsWith(prefix)) return `![${alt}](${absPath.slice(prefix.length)})`;
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
    crepe?.editor.action(replaceAll(display));
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentNote, 1200);
  }

  async function saveCurrentNote() {
    if (!currentNote) return;
    let content = currentMarkdown;
    const title = currentNote.title || extractTitle(content);

    saving = true;
    try {
      const saved = await api.saveNote({ ...currentNote, content, title });
      currentNote = saved;
      lastLoadedId = saved.id;
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

  async function createNote() {
    if (!newTitle.trim()) return;
    const folder = newFolder.trim();
    const note = await api.saveNote({
      id: '', title: newTitle.trim(),
      content: `# ${newTitle.trim()}\n\n`,
      folder, pinned: false, tags: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    notes.update((ns) => [note, ...ns]);
    selectedNoteId.set(note.id);
    newTitle = ''; newFolder = ''; showNewForm = false;
    loadNote(note);
    if (folder) expandedFolders = new Set([...expandedFolders, folder]);
    selectedFolder = folder || null;
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
    const toRename = $notes.filter((n) => (n.folder ?? '') === oldFolder);
    for (const note of toRename) {
      const updated = await api.saveNote({ ...note, folder: newFolder });
      notes.update((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
      if (currentNote?.id === updated.id) currentNote = { ...currentNote, folder: newFolder };
    }
    expandedFolders = new Set([...expandedFolders].map((f) => (f === oldFolder ? newFolder : f)));
    if (selectedFolder === oldFolder) selectedFolder = newFolder;
  }

  // ── Delete folder ──────────────────────────────────────────────────────────

  async function deleteFolderNotes(folder: string) {
    confirmDeleteFolder = null;
    const toDelete = $notes.filter((n) => (n.folder ?? '') === folder);
    for (const note of toDelete) await api.deleteNote(note.id);
    notes.update((ns) => ns.filter((n) => (n.folder ?? '') !== folder));
    if (toDelete.find((n) => n.id === $selectedNoteId)) { selectedNoteId.set(null); currentNote = null; }
    if (selectedFolder === folder) selectedFolder = null;
  }

  async function moveFolderToRoot(folder: string) {
    confirmDeleteFolder = null;
    const toMove = $notes.filter((n) => (n.folder ?? '') === folder);
    for (const note of toMove) {
      const updated = await api.saveNote({ ...note, folder: '' });
      notes.update((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
      if (currentNote?.id === updated.id) currentNote = { ...currentNote, folder: '' };
    }
    if (selectedFolder === folder) selectedFolder = null;
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
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.TopBar]: false,
        [CrepeFeature.Latex]: false,
      },
    });
    c.on((api) => {
      api.markdownUpdated((_, markdown) => {
        currentMarkdown = stripAssetUrls(markdown, currentNote?.folder ?? '');
        if (currentNote) scheduleSave();
      });
    });
    void c.create().then(() => {
      crepe = c;
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
    if (saveTimer) { clearTimeout(saveTimer); void saveCurrentNote(); }
    void crepe?.destroy();
  });
</script>

<div class="docs">
  <!-- ── Folder + note sidebar ─────────────────────────────────────────── -->
  <aside class="note-list">
    <div class="note-list-header">
      <span class="section-title">Documents</span>
      <button class="icon-btn" onclick={() => (showNewForm = !showNewForm)} title="New document">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    {#if showNewForm}
      <div class="new-note-form">
        <input
          class="note-input" placeholder="Document title…" bind:value={newTitle}
          onkeydown={(e) => e.key === 'Enter' && createNote()}
        />
        <input class="note-input" placeholder="Folder (optional)" bind:value={newFolder} list="folder-list" />
        <datalist id="folder-list">
          {#each allFolders.filter(Boolean) as f}<option value={f}>{f}</option>{/each}
        </datalist>
        <div class="form-row">
          <button class="btn-create" onclick={createNote}>Create</button>
          <button class="btn-cancel" onclick={() => (showNewForm = false)}>✕</button>
        </div>
      </div>
    {/if}

    <!-- "All" shortcut — also a drop target for root -->
    <button
      class="folder-all {selectedFolder === null ? 'active' : ''} {dragTarget === '' ? 'drag-over' : ''}"
      onclick={() => (selectedFolder = null)}
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
      {#each allFolders as folder}
        {@const folderNotes = $notes.filter((n) => (n.folder ?? '') === folder)}
        {@const isExpanded = expandedFolders.has(folder)}
        {@const isSelected = selectedFolder === folder}

        <div
          class="folder-row {dragTarget === folder ? 'drag-over' : ''}"
          role="listitem"
          ondragover={(e) => onDragOver(e, folder)}
          ondragleave={(e) => onDragLeave(e, folder)}
          ondrop={(e) => onDrop(e, folder)}
        >
          {#if renamingFolder === folder}
            <input
              class="note-input rename-inline"
              bind:value={renameFolderValue}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitRenameFolder(folder);
                if (e.key === 'Escape') renamingFolder = null;
              }}
              onblur={() => commitRenameFolder(folder)}
            />
          {:else}
            <button
              class="folder-btn {isSelected ? 'active' : ''}"
              onclick={() => { selectedFolder = folder; toggleFolder(folder); confirmDeleteFolder = null; }}
            >
              <span class="folder-chevron">{isExpanded ? '▾' : '▸'}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="{isSelected ? '#6366f1' : 'none'}" stroke="{isSelected ? '#6366f1' : '#9ca3af'}" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="folder-name">{folder || 'Uncategorized'}</span>
              <span class="count">{folderNotes.length}</span>
            </button>
            <div class="folder-actions">
              <button class="micro-btn" onclick={() => startRenameFolder(folder)} title="Rename folder">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              {#if confirmDeleteFolder === folder}
                <button class="micro-btn warning" onclick={() => moveFolderToRoot(folder)} title="Move notes to root">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                </button>
                <button class="micro-btn danger" onclick={() => deleteFolderNotes(folder)} title="Delete all notes">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
                <button class="micro-btn" onclick={() => (confirmDeleteFolder = null)} title="Cancel">✕</button>
              {:else}
                <button class="micro-btn danger" onclick={() => (confirmDeleteFolder = folder)} title="Delete folder">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

        {#if confirmDeleteFolder === folder}
          <div class="folder-delete-hint">
            Move to root or delete all?
          </div>
        {/if}

        {#if isExpanded}
          <ul class="note-items indented">
            {#each folderNotes as note (note.id)}
              <li
                class="note-item {$selectedNoteId === note.id ? 'active' : ''} {draggedNoteId === note.id ? 'dragging' : ''}"
                draggable="true"
                ondragstart={(e) => onDragStart(e, note.id)}
                ondragend={() => { draggedNoteId = null; }}
              >
                {#if renamingNoteId === note.id}
                  <input
                    class="note-input rename-inline"
                    bind:value={renameNoteValue}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') commitRenameNote(note);
                      if (e.key === 'Escape') renamingNoteId = null;
                    }}
                    onblur={() => commitRenameNote(note)}
                  />
                {:else}
                  <button class="note-item-select" onclick={() => { selectedNoteId.set(note.id); loadNote(note); }}>
                    <div class="note-item-title">
                      {#if note.pinned}<span class="pin">📌</span>{/if}
                      {note.title || 'Untitled'}
                    </div>
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
            {/each}
          </ul>
        {/if}
      {/each}
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
          <select
            class="folder-select"
            value={currentNote.folder ?? ''}
            onchange={(e) => currentNote && moveToFolder(currentNote, (e.target as HTMLSelectElement).value)}
            title="Move to folder"
          >
            <option value="">No folder</option>
            {#each allFolders.filter(Boolean) as f}<option value={f}>{f}</option>{/each}
          </select>
        </div>
        <div class="toolbar-right">
          {#if saving}<span class="saving-indicator">saving…</span>{/if}
        </div>
      </div>
    {/if}

    <div class="milkdown-wrapper" class:hidden={!currentNote} bind:this={editorEl}></div>

    {#if !currentNote}
      <div class="no-doc">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2d2d3d" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>Select a document or create a new one</p>
        <button class="btn-primary" onclick={() => (showNewForm = true)}>New document</button>
      </div>
    {/if}

    {#if currentNote}
      <div class="editor-hint">
        Task syntax: <code>- [ ] Title #tag @YYYY-MM-DD !high</code> — auto-syncs to Tasks.
      </div>
    {/if}
  </div>
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

  .note-items { list-style: none; }
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

  .folder-select {
    background: #1e1e2e; border: 1px solid #2d2d3d; border-radius: 6px;
    color: #9ca3af; padding: 3px 8px; font-size: 0.75rem; outline: none; cursor: pointer;
    max-width: 120px;
  }
  .folder-select:focus { border-color: #6366f1; }

  .saving-indicator { font-size: 0.72rem; color: #64748b; }

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

  @media (max-width: 600px) {
    .note-list { width: 100%; min-width: unset; max-height: 180px; border-right: none; border-bottom: 1px solid #1e1e2e; }
    .docs { flex-direction: column; }
  }
</style>
