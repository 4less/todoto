<script lang="ts">
  import { projects, activeProjectId, todos } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Project } from '$lib/types';
  import {
    PROJECT_ICONS, PROJECT_COLORS, projectIconSvg,
    DEFAULT_PROJECT_ICON, DEFAULT_PROJECT_COLOR,
  } from '$lib/projectIcons';

  let { collapsed = false, onApply }: {
    collapsed?: boolean;
    onApply: (project: Project) => void;
  } = $props();

  // Move the modal to <body> so it escapes the mobile drawer's transform,
  // which would otherwise act as the containing block for position: fixed.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { if (node.parentNode) node.parentNode.removeChild(node); } };
  }

  // ── Editor modal state ──────────────────────────────────────────────────────
  let editorOpen = $state(false);
  let editId = $state<string | null>(null); // null = creating new
  let fName = $state('');
  let fTags = $state<string[]>([]);
  let fIcon = $state(DEFAULT_PROJECT_ICON);
  let fColor = $state(DEFAULT_PROJECT_COLOR);
  let tagInput = $state('');

  let allTags = $derived(
    [...new Set($todos.flatMap((t) => t.tags))].sort().filter((tag) => tag !== 'other')
  );
  let canSave = $derived(fName.trim().length > 0 && fTags.length > 0);

  function openNew() {
    editId = null;
    fName = '';
    fTags = [];
    fIcon = DEFAULT_PROJECT_ICON;
    fColor = DEFAULT_PROJECT_COLOR;
    tagInput = '';
    editorOpen = true;
  }

  function openEdit(p: Project, e: MouseEvent) {
    e.stopPropagation();
    editId = p.id;
    fName = p.name;
    fTags = [...p.tags];
    fIcon = p.icon || DEFAULT_PROJECT_ICON;
    fColor = p.color || DEFAULT_PROJECT_COLOR;
    tagInput = '';
    editorOpen = true;
  }

  function closeEditor() { editorOpen = false; }

  function toggleTag(tag: string) {
    fTags = fTags.includes(tag) ? fTags.filter((t) => t !== tag) : [...fTags, tag];
  }

  function addTypedTags() {
    const parts = tagInput.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    for (const p of parts) if (!fTags.includes(p)) fTags = [...fTags, p];
    tagInput = '';
  }

  async function persist(next: Project[]) {
    projects.set(next);
    await api.saveProjects(next);
  }

  async function save() {
    if (!canSave) return;
    const name = fName.trim();
    if (editId) {
      await persist($projects.map((p) => p.id === editId
        ? { ...p, name, tags: [...fTags], icon: fIcon, color: fColor } : p));
    } else {
      const project: Project = {
        id: crypto.randomUUID(), name, tags: [...fTags], icon: fIcon, color: fColor,
      };
      await persist([...$projects, project]);
    }
    editorOpen = false;
  }

  async function remove() {
    if (!editId) return;
    await persist($projects.filter((p) => p.id !== editId));
    if ($activeProjectId === editId) activeProjectId.set(null);
    editorOpen = false;
  }
</script>

<div class="projects-section {collapsed ? 'collapsed' : ''}">
  {#if !collapsed}
    <div class="projects-header">
      <span class="projects-label">Projects</span>
      <button class="add-project-btn" onclick={openNew} title="New project" aria-label="New project">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  {/if}

  {#each $projects as p (p.id)}
    <button
      class="project-item {$activeProjectId === p.id ? 'active' : ''}"
      onclick={() => onApply(p)}
      title={collapsed ? p.name : ''}
      style="--proj-color: {p.color}"
    >
      <span class="project-icon">
        {@html `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${projectIconSvg(p.icon)}</svg>`}
      </span>
      {#if !collapsed}
        <span class="project-name">{p.name}</span>
        <button class="project-edit-btn" onclick={(e) => openEdit(p, e)} title="Edit {p.name}" aria-label="Edit project">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      {/if}
    </button>
  {/each}

  {#if collapsed}
    <button class="project-item add-collapsed" onclick={openNew} title="New project" aria-label="New project">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  {/if}
</div>

{#if editorOpen}
<div use:portal>
  <div class="editor-backdrop" onclick={closeEditor} aria-hidden="true"></div>
  <div class="editor" role="dialog" aria-modal="true">
    <div class="editor-head">
      <h3>{editId ? 'Edit project' : 'New project'}</h3>
      <button class="editor-close" onclick={closeEditor} aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="editor-preview" style="--proj-color: {fColor}">
      <span class="project-icon">
        {@html `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${projectIconSvg(fIcon)}</svg>`}
      </span>
      <input class="preview-name-input" placeholder="Project name" bind:value={fName}
        onkeydown={(e) => e.key === 'Enter' && save()} />
    </div>

    <span class="field-label">Tags <span class="field-hint">(tasks with any of these show up)</span></span>
    {#if allTags.length > 0}
      <div class="tag-pool">
        {#each allTags as tag}
          <button class="tag-pick {fTags.includes(tag) ? 'on' : ''}" onclick={() => toggleTag(tag)}>#{tag}</button>
        {/each}
      </div>
    {/if}
    <div class="tag-add-row">
      <input class="text-input" placeholder="Add a tag…" bind:value={tagInput}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTypedTags(); } }} />
      <button class="tag-add-btn" onclick={addTypedTags} disabled={!tagInput.trim()}>Add</button>
    </div>
    {#if fTags.some((t) => !allTags.includes(t))}
      <div class="tag-pool">
        {#each fTags.filter((t) => !allTags.includes(t)) as tag}
          <button class="tag-pick on" onclick={() => toggleTag(tag)}>#{tag} ✕</button>
        {/each}
      </div>
    {/if}

    <span class="field-label">Icon</span>
    <div class="icon-grid">
      {#each PROJECT_ICONS as ic}
        <button class="icon-pick {fIcon === ic.key ? 'on' : ''}" onclick={() => (fIcon = ic.key)}
          style="--proj-color: {fColor}" title={ic.key} aria-label={ic.key}>
          {@html `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg>`}
        </button>
      {/each}
    </div>

    <span class="field-label">Colour</span>
    <div class="color-row">
      {#each PROJECT_COLORS as c}
        <button class="color-pick {fColor === c ? 'on' : ''}" style="background: {c}"
          onclick={() => (fColor = c)} aria-label="colour {c}"></button>
      {/each}
    </div>

    <div class="editor-actions">
      {#if editId}
        <button class="btn-delete" onclick={remove}>Delete</button>
      {/if}
      <div class="spacer"></div>
      <button class="btn-ghost" onclick={closeEditor}>Cancel</button>
      <button class="btn-save" onclick={save} disabled={!canSave}>{editId ? 'Save' : 'Create'}</button>
    </div>
  </div>
</div>
{/if}

<style>
  .projects-section { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
  .projects-section.collapsed { align-items: center; }

  .projects-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 12px 2px;
  }
  .projects-label {
    font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-7);
  }
  .add-project-btn {
    width: 22px; height: 22px; border-radius: 6px; border: none;
    background: transparent; color: var(--text-6); cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s;
  }
  .add-project-btn:hover { background: var(--border); color: var(--accent); }

  .project-item {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 10px; border: none;
    background: transparent; color: var(--text-4);
    font-size: 0.875rem; font-weight: 500; cursor: pointer;
    transition: background 0.15s, color 0.15s; text-align: left; width: 100%;
  }
  .project-item:hover { background: var(--border); color: var(--text-2); }
  .project-item.active { background: var(--accent-bg); color: var(--text-2); }
  .project-item.active .project-icon { color: var(--proj-color); }

  .project-icon { display: flex; align-items: center; color: var(--proj-color); flex-shrink: 0; }
  .project-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .project-edit-btn {
    width: 22px; height: 22px; border-radius: 6px; border: none; flex-shrink: 0;
    background: transparent; color: var(--text-7); cursor: pointer;
    display: none; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s;
  }
  .project-item:hover .project-edit-btn { display: flex; }
  .project-edit-btn:hover { background: var(--surface); color: var(--accent-lt); }

  .projects-section.collapsed .project-item { justify-content: center; padding: 9px; width: auto; }
  .add-collapsed { color: var(--text-6); }
  .add-collapsed:hover { color: var(--accent); }

  /* ── Editor modal ──────────────────────────────────────────────────────── */
  .editor-backdrop { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.5); }
  .editor {
    position: fixed; z-index: 301; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(680px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
    padding: 18px 20px 20px; display: flex; flex-direction: column; gap: 6px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.35);
  }
  .editor-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .editor-head h3 { font-size: 1.05rem; font-weight: 700; color: var(--text-1); }
  .editor-close {
    width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent;
    color: var(--text-5); cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .editor-close:hover { background: var(--border); color: var(--text-2); }

  .editor-preview {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 10px; background: var(--bg);
    border: 1px solid var(--border); margin-bottom: 6px;
  }
  .preview-name-input {
    flex: 1; min-width: 0; border: none; background: transparent; outline: none;
    font-size: 0.95rem; font-weight: 600; color: var(--text-2); font-family: inherit;
  }
  .preview-name-input::placeholder { color: var(--text-6); font-weight: 500; }

  .field-label { font-size: 0.72rem; font-weight: 600; color: var(--text-5); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  .field-hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-7); }

  .text-input {
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 8px;
    color: var(--text-2); padding: 8px 12px; font-size: 0.875rem; outline: none; width: 100%;
  }
  .text-input:focus { border-color: var(--accent); }

  .tag-pool { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-pick {
    padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.75rem; cursor: pointer; transition: all 0.12s;
  }
  .tag-pick:hover { border-color: var(--accent); color: var(--accent-ltr); }
  .tag-pick.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-lt); }

  .tag-add-row { display: flex; gap: 6px; }
  .tag-add-btn {
    padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.8rem; cursor: pointer; white-space: nowrap;
  }
  .tag-add-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-lt); }
  .tag-add-btn:disabled { opacity: 0.4; cursor: default; }

  .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, 42px); gap: 6px; }
  .icon-pick {
    aspect-ratio: 1; border-radius: 9px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-5); cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: all 0.12s;
  }
  .icon-pick:hover { border-color: var(--accent); color: var(--text-2); }
  .icon-pick.on { border-color: var(--proj-color); color: var(--proj-color); background: color-mix(in srgb, var(--proj-color) 14%, transparent); }

  .color-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .color-pick {
    width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer;
    transition: transform 0.1s;
  }
  .color-pick:hover { transform: scale(1.1); }
  .color-pick.on { border-color: var(--text-2); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px currentColor; }

  .editor-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .editor-actions .spacer { flex: 1; }
  .btn-save {
    padding: 8px 18px; border-radius: 8px; border: none;
    background: var(--accent); color: #fff; font-size: 0.875rem; cursor: pointer; transition: background 0.15s;
  }
  .btn-save:hover:not(:disabled) { background: var(--accent-dk); }
  .btn-save:disabled { opacity: 0.45; cursor: default; }
  .btn-ghost {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border-2);
    background: transparent; color: var(--text-4); font-size: 0.875rem; cursor: pointer;
  }
  .btn-ghost:hover { border-color: var(--text-8); color: var(--text-2); }
  .btn-delete {
    padding: 8px 14px; border-radius: 8px; border: 1px solid var(--red-border, var(--border-2));
    background: transparent; color: var(--red); font-size: 0.875rem; cursor: pointer;
  }
  .btn-delete:hover { background: var(--red-bg); }
</style>
