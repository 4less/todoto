<script lang="ts">
  import { Crepe, CrepeFeature } from '@milkdown/crepe';
  import { replaceAll } from '@milkdown/utils';
  import { diffLines } from 'diff';
  import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
  import { setBlockTypeCommand, codeBlockSchema } from '@milkdown/kit/preset/commonmark';
  import { Plugin, PluginKey, TextSelection, NodeSelection } from '@milkdown/kit/prose/state';
  import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import { api, saveTaskNoteImage } from '$lib/api';
  import type { Todo, CommitInfo } from '$lib/types';

  let {
    todo,
    repoPath,
    hasChildren = false,
    focusMode = false,
    onClose,
    onTodoUpdated,
  }: {
    todo: Todo;
    repoPath: string;
    hasChildren?: boolean;
    focusMode?: boolean;
    onClose: () => void;
    onTodoUpdated: (updated: Todo) => void;
  } = $props();

  // ── Asset URL helpers ──────────────────────────────────────────────────────
  // notesContent stores asset:// URLs so the live editor can display images.
  // The .md file on disk stores repo-relative paths (portable, syncs to GitHub).

  const ASSET_RE = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)(\/.*)/;

  function splitUrlTitle(raw: string): [string, string] {
    const i = raw.search(/\s+["']/);
    return i >= 0 ? [raw.slice(0, i), raw.slice(i)] : [raw.trim(), ''];
  }

  function makeImagesLoadable(content: string): string {
    if (!repoPath) return content;
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, raw) => {
      const [src, title] = splitUrlTitle(raw);
      if (src.startsWith('http') || src.startsWith('data:') || ASSET_RE.test(src)) return match;
      const abs = src.startsWith('/') ? src : `${repoPath}/${src}`;
      return `![${alt}](${convertFileSrc(abs)}${title})`;
    });
  }

  function stripAssetUrls(content: string): string {
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

  // ── Content state ──────────────────────────────────────────────────────────
  let notesContent = $state(makeImagesLoadable(todo.notes ?? ''));
  let notesSaveTimer: ReturnType<typeof setTimeout> | null = null;

  async function persistNotes() {
    const updated = await api.saveTodo({ ...todo, notes: stripAssetUrls(notesContent) || null });
    onTodoUpdated(updated);
  }

  function scheduleNotesSave() {
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => void persistNotes(), 800);
  }

  // Flush any pending save on unmount.
  $effect(() => () => {
    if (notesSaveTimer) { clearTimeout(notesSaveTimer); void persistNotes(); }
  });

  // ── Raw / WYSIWYG toggle ───────────────────────────────────────────────────
  let notesRawMode = $state(false);
  let notesEditorLoading = false;
  let notesEditorInstance: Crepe | null = null;

  function toggleNotesRaw() {
    if (!notesRawMode) {
      notesRawMode = true;
    } else {
      // Raw is the source of truth — load into editor without letting
      // Milkdown's re-serialization overwrite what the user typed.
      const loadable = makeImagesLoadable(notesContent);
      notesContent = loadable;
      if (notesEditorInstance) {
        notesEditorLoading = true;
        notesEditorInstance.editor.action(replaceAll(loadable));
        notesEditorLoading = false;
      }
      notesRawMode = false;
    }
  }

  function clearNotesContent() {
    notesContent = '';
    notesEditorInstance?.editor.action(replaceAll(''));
    scheduleNotesSave();
  }

  // ── Version history ────────────────────────────────────────────────────────
  let notesHistoryMode = $state(false);
  let notesHistoryCommits = $state<CommitInfo[]>([]);
  let notesHistorySha = $state<string | null>(null);
  let notesHistoryLoading = $state(false);
  let notesHistoryContentLoading = $state(false);
  let notesHistoryContent = $state('');
  let notesDiffMode = $state(false);

  function fmtHistoryDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function buildDiffLines(oldText: string, newText: string) {
    const chunks = diffLines(oldText, newText);
    const result: Array<{ type: 'add' | 'del' | 'ctx'; text: string }> = [];
    for (const chunk of chunks) {
      const lines = chunk.value.replace(/\n$/, '').split('\n');
      const type = chunk.added ? 'add' : chunk.removed ? 'del' : 'ctx';
      for (const text of lines) result.push({ type, text });
    }
    return result;
  }

  async function openNotesHistory() {
    notesHistoryLoading = true;
    notesHistoryMode = true;
    notesHistorySha = null;
    notesHistoryContent = '';
    notesDiffMode = false;
    notesHistoryCommits = [];
    try {
      notesHistoryCommits = await api.getNoteHistory(`task-notes/${todo.id}.md`);
    } finally {
      notesHistoryLoading = false;
    }
  }

  async function selectNotesHistoryCommit(sha: string) {
    if (!notesEditorInstance) return;
    notesHistorySha = sha;
    notesHistoryContentLoading = true;
    try {
      const raw = await api.getNoteAtCommit(`task-notes/${todo.id}.md`, sha);
      notesHistoryContent = raw;
      if (!notesDiffMode) {
        notesEditorLoading = true;
        notesEditorInstance.editor.action(replaceAll(raw));
        notesEditorLoading = false;
        notesEditorInstance.editor.action((ctx) => { ctx.get(editorViewCtx).setProps({ editable: () => false }); });
      }
    } finally {
      notesHistoryContentLoading = false;
    }
  }

  function closeNotesHistory() {
    notesDiffMode = false;
    notesHistoryContent = '';
    notesHistoryMode = false;
    notesHistorySha = null;
    notesHistoryCommits = [];
    if (notesEditorInstance) {
      notesEditorLoading = true;
      notesEditorInstance.editor.action(replaceAll(notesContent));
      notesEditorLoading = false;
      notesEditorInstance.editor.action((ctx) => { ctx.get(editorViewCtx).setProps({ editable: () => true }); });
    }
  }

  function toggleNotesDiffMode() {
    notesDiffMode = !notesDiffMode;
    if (!notesEditorInstance || !notesHistorySha) return;
    if (!notesDiffMode) {
      notesEditorLoading = true;
      notesEditorInstance.editor.action(replaceAll(notesHistoryContent));
      notesEditorLoading = false;
      notesEditorInstance.editor.action((ctx) => { ctx.get(editorViewCtx).setProps({ editable: () => false }); });
    }
  }

  // ── Raw textarea auto-resize ───────────────────────────────────────────────
  function autoResizeTextarea(el: HTMLTextAreaElement) {
    const resize = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
    resize();
    el.addEventListener('input', resize);
    return { destroy() { el.removeEventListener('input', resize); } };
  }

  // ── Editor helpers ─────────────────────────────────────────────────────────
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

  const singleLineDecoKey = new PluginKey('single-line-deco');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function installSingleLineDecoPlugin(milkCtx: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = milkCtx.get(editorViewCtx);
    const codeBlockType = codeBlockSchema.type(milkCtx);
    const plugin = new Plugin({
      key: singleLineDecoKey,
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
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let activeEl: HTMLElement | null = null;
    let activeLeaveHandler: (() => void) | null = null;

    function scheduleHide(relatedTarget: EventTarget | null) {
      if (relatedTarget === floatBtn) return;
      hideTimer = setTimeout(() => {
        floatBtn.classList.remove('visible');
        currentTarget = null;
        hideTimer = null;
      }, 600);
    }
    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function trackElement(el: HTMLElement) {
      if (el === activeEl) return;
      // Remove listener from the previous tracked element
      if (activeEl && activeLeaveHandler) {
        activeEl.removeEventListener('mouseleave', activeLeaveHandler);
      }
      activeEl = el;
      activeLeaveHandler = (e: Event) => {
        scheduleHide((e as MouseEvent).relatedTarget);
      };
      el.addEventListener('mouseleave', activeLeaveHandler as EventListener);
    }

    pm.addEventListener('mouseover', (e) => {
      const pre = (e.target as HTMLElement).closest('pre');
      if (pre instanceof HTMLElement) {
        cancelHide();
        trackElement(pre);
        show(pre.querySelector('code') ?? pre, pre);
        return;
      }
      const code = (e.target as HTMLElement).closest('code');
      if (code instanceof HTMLElement) {
        cancelHide();
        trackElement(code);
        const r = code.getBoundingClientRect();
        currentTarget = code;
        floatBtn.style.top = `${r.top + r.height / 2}px`;
        floatBtn.style.left = `${r.right + 6}px`;
        floatBtn.classList.add('visible');
      }
    });
    floatBtn.addEventListener('mouseenter', cancelHide);
    floatBtn.addEventListener('mouseleave', (e) => scheduleHide(e.relatedTarget));

    return () => { floatBtn.remove(); };
  }

  // Replaces Milkdown's single-line caption <input> with an auto-resizing <textarea>.
  function upgradeCaptionInput(inp: HTMLInputElement) {
    inp.dataset.upgraded = '1';
    const ta = document.createElement('textarea');
    ta.className = inp.className;
    ta.placeholder = inp.placeholder;
    ta.value = inp.value;

    const resize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

    // Clear any NodeSelection on the image-block BEFORE block stops propagation.
    // Listener order matters: stopImmediatePropagation kills later handlers on the
    // same element, so this must be registered first.
    ta.addEventListener('mousedown', () => {
      if (!notesEditorInstance) return;
      notesEditorInstance.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (view.state.selection instanceof NodeSelection) {
          const pos = view.state.selection.to;
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
          } catch {}
        }
      });
    });

    // Prevent ProseMirror from intercepting events while the caption is focused.
    // Must be registered AFTER the NodeSelection handler above.
    const block = (e: Event) => e.stopImmediatePropagation();
    for (const type of ['mousedown','mouseup','mousemove','pointerdown','pointerup','pointermove','click','keydown','keyup','keypress','beforeinput','compositionstart','compositionend','paste','cut','copy']) {
      ta.addEventListener(type, block);
    }

    ta.addEventListener('input', () => {
      inp.value = ta.value;
      inp.dispatchEvent(new Event('input', { bubbles: false }));
      resize();
    });
    ta.addEventListener('blur', () => {
      inp.value = ta.value;
      inp.dispatchEvent(new Event('blur', { bubbles: false }));
    });

    inp.style.display = 'none';
    inp.insertAdjacentElement('afterend', ta);
    resize();

    // When Milkdown removes the input (caption toggled off), remove the paired textarea.
    const cleanupObs = new MutationObserver(() => {
      if (!inp.isConnected) { ta.remove(); cleanupObs.disconnect(); }
    });
    if (inp.parentElement) cleanupObs.observe(inp.parentElement, { childList: true });
  }

  // ── Milkdown use: action ───────────────────────────────────────────────────
  function initNotesEditor(el: HTMLElement) {
    if (!document.getElementById('mk-h-fix')) {
      const s = document.createElement('style');
      s.id = 'mk-h-fix';
      s.textContent = '.milkdown .ProseMirror h1,.milkdown .ProseMirror h2,.milkdown .ProseMirror h3,.milkdown .ProseMirror h4,.milkdown .ProseMirror h5,.milkdown .ProseMirror h6{margin-top:0!important;padding-top:0!important}';
      document.head.appendChild(s);
    }

    let instance: Crepe | null = null;
    let destroyed = false;
    let removeFloatBtn: (() => void) | null = null;

    function headingKeyHandler(e: KeyboardEvent) {
      if (!e.ctrlKey) return;
      const promote = e.key === '=' || e.key === '+';
      const demote  = e.key === '-';
      if (!promote && !demote) return;
      e.preventDefault();
      e.stopPropagation();
      if (!instance || notesRawMode) return;
      instance.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state, dispatch } = view;
        const { from, to } = state.selection;
        const selFrom = state.selection.$from;
        const { schema } = state;
        const parent = selFrom.parent;
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
        dispatch(tr);
      });
    }
    el.addEventListener('keydown', headingKeyHandler, true);
    // Prevent drag when the caption textarea has focus — the browser would otherwise
    // walk up to the image-block's draggable="true" ancestor and move the whole block.
    el.addEventListener('dragstart', (e) => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.classList.contains('caption-input')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    const uploadImage = async (file: File) => {
      const relPath = await saveTaskNoteImage(todo.id, file);
      return repoPath ? convertFileSrc(`${repoPath}/${relPath}`) : relPath;
    };

    const c = new Crepe({
      root: el,
      defaultValue: notesContent,
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.TopBar]: false,
        [CrepeFeature.Latex]: false,
        [CrepeFeature.Table]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.CodeMirror]: false,
        [CrepeFeature.LinkTooltip]: false,
      },
      featureConfigs: {
        [CrepeFeature.ImageBlock]: { onUpload: uploadImage, blockOnUpload: uploadImage },
      },
    });

    c.on((api) => {
      api.markdownUpdated((_, markdown) => {
        // Ignore init-time callbacks and any callbacks while in raw mode.
        if (notesEditorLoading || notesRawMode) return;
        notesContent = markdown;
        scheduleNotesSave();
      });
    });

    async function insertImageBlob(blob: Blob) {
      const relPath = await saveTaskNoteImage(todo.id, blob);
      const assetUrl = repoPath ? convertFileSrc(`${repoPath}/${relPath}`) : relPath;
      c.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const nodeType = view.state.schema.nodes['image-block'];
        if (nodeType) view.dispatch(view.state.tr.replaceSelectionWith(nodeType.create({ src: assetUrl, caption: '', ratio: 1 })));
      });
    }

    async function handlePaste(e: ClipboardEvent) {
      if ((document.activeElement as HTMLElement)?.classList.contains('caption-input')) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (imgItem) {
        e.preventDefault();
        const blob = imgItem.getAsFile();
        if (blob) try { await insertImageBlob(blob); } catch {}
        return;
      }
      if (items.some((i) => i.kind === 'string')) return;
      e.preventDefault();
      try {
        const b64 = await invoke<string | null>('read_clipboard_image');
        if (!b64) return;
        const relPath = await invoke<string>('save_task_note_image', { id: todo.id, dataB64: b64, ext: 'png' });
        const assetUrl = repoPath ? convertFileSrc(`${repoPath}/${relPath}`) : relPath;
        c.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const nodeType = view.state.schema.nodes['image-block'];
          if (nodeType) view.dispatch(view.state.tr.replaceSelectionWith(nodeType.create({ src: assetUrl, caption: '', ratio: 1 })));
        });
      } catch {}
    }

    const captionObs = new MutationObserver(() => {
      el.querySelectorAll<HTMLInputElement>('input.caption-input:not([data-upgraded])').forEach(upgradeCaptionInput);
    });

    let rightAddBtn: HTMLButtonElement | null = null;
    let posHandleObs: MutationObserver | null = null;

    notesEditorLoading = true;
    void c.create().then(() => {
      if (destroyed) { notesEditorLoading = false; return; }
      instance = c;
      notesEditorInstance = c;

      const pm = el.querySelector('.ProseMirror');
      if (pm instanceof HTMLElement) {
        pm.style.paddingTop = '0';
        removeFloatBtn = attachCodeCopyButtons(pm);
      }
      patchToolbarCodeButton(c, el);
      c.editor.action((ctx) => { installSingleLineDecoPlugin(ctx); });
      notesEditorLoading = false; // clear AFTER plugin install which may fire markdownUpdated

      el.addEventListener('paste', handlePaste, true);
      captionObs.observe(el, { childList: true, subtree: true });
      el.querySelectorAll<HTMLInputElement>('input.caption-input:not([data-upgraded])').forEach(upgradeCaptionInput);

      rightAddBtn = document.createElement('button');
      rightAddBtn.className = 'mk-right-add';
      rightAddBtn.title = 'Add block below';
      rightAddBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      el.appendChild(rightAddBtn);

      const capturedBtn = rightAddBtn;
      capturedBtn.addEventListener('click', (e) => {
        e.preventDefault();
        c.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const selFrom = state.selection.$from;
          try {
            const afterPos = selFrom.depth >= 1 ? selFrom.after(1) : state.doc.content.size;
            const paragraph = state.schema.nodes.paragraph.createAndFill();
            if (!paragraph) return;
            const tr = state.tr.insert(afterPos, paragraph);
            tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
            view.dispatch(tr.scrollIntoView());
            view.dispatch(view.state.tr.insertText('/'));
            view.focus();
          } catch {}
        });
      });

      function syncTop() {
        const handle = el.querySelector<HTMLElement>('.milkdown-block-handle');
        if (!handle || handle.dataset.show !== 'true') return;
        const handleRect = handle.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        capturedBtn.style.top = `${handleRect.top - elRect.top + el.scrollTop}px`;
      }
      function tryAttach() {
        if (posHandleObs) return;
        const handle = el.querySelector<HTMLElement>('.milkdown-block-handle');
        if (!handle) return;
        posHandleObs = new MutationObserver(syncTop);
        posHandleObs.observe(handle, { attributes: true, attributeFilter: ['data-show', 'style'] });
        syncTop();
      }
      tryAttach();
      if (!posHandleObs) {
        const waitObs = new MutationObserver(() => { tryAttach(); if (posHandleObs) waitObs.disconnect(); });
        waitObs.observe(el, { childList: true, subtree: true });
      }
    });

    return {
      destroy() {
        destroyed = true;
        captionObs.disconnect();
        posHandleObs?.disconnect();
        rightAddBtn?.remove();
        removeFloatBtn?.();
        el.removeEventListener('keydown', headingKeyHandler, true);
        el.removeEventListener('paste', handlePaste, true);
        notesEditorInstance = null;
        void instance?.destroy();
        instance = null;
      },
    };
  }
</script>

<div class="notes-panel {hasChildren ? 'notes-panel-detached' : ''}" class:focus-panel={focusMode}>
  <div class="notes-panel-header">
    <span class="notes-panel-title">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      Notes
    </span>

    {#if notesHistoryMode}
      <select
        class="notes-history-select"
        onchange={(e) => {
          const sha = (e.target as HTMLSelectElement).value;
          if (sha) {
            void selectNotesHistoryCommit(sha);
          } else {
            notesDiffMode = false;
            notesHistoryContent = '';
            notesHistorySha = null;
            if (notesEditorInstance) {
              notesEditorLoading = true;
              notesEditorInstance.editor.action(replaceAll(notesContent));
              notesEditorLoading = false;
              notesEditorInstance.editor.action((ctx) => { ctx.get(editorViewCtx).setProps({ editable: () => true }); });
            }
          }
        }}
        disabled={notesHistoryContentLoading || notesHistoryLoading}
      >
        {#if notesHistoryLoading}
          <option value="">Loading…</option>
        {:else if notesHistoryCommits.length === 0}
          <option value="">No history</option>
        {:else}
          <option value="" selected={!notesHistorySha}>Current version</option>
          {#each notesHistoryCommits as commit}
            <option value={commit.sha} selected={notesHistorySha === commit.sha} title={commit.message}>
              {fmtHistoryDate(commit.date)}
            </option>
          {/each}
        {/if}
      </select>
    {/if}

    <div class="header-actions">
      {#if notesHistoryMode && notesHistorySha}
        <button class="notes-close-btn {notesDiffMode ? 'raw-active' : ''}" onclick={toggleNotesDiffMode} title="{notesDiffMode ? 'Show editor' : 'Show diff vs current'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="18"/><rect x="14" y="3" width="7" height="18"/></svg>
        </button>
      {/if}
      {#if notesHistoryMode}
        <button class="notes-close-btn raw-active" onclick={closeNotesHistory} title="Exit history">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
      {:else}
        <button class="notes-close-btn" onclick={clearNotesContent} title="Clear notes">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
        <button class="notes-close-btn" onclick={openNotesHistory} title="Version history">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="notes-close-btn {notesRawMode ? 'raw-active' : ''}" onclick={toggleNotesRaw} title="{notesRawMode ? 'Switch to WYSIWYG' : 'Switch to raw markdown'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>
      {/if}
      <button class="notes-close-btn" onclick={onClose} title="Close notes">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>

  {#if notesDiffMode && notesHistorySha && notesHistoryContent}
    {@const diffChunks = buildDiffLines(notesHistoryContent, stripAssetUrls(notesContent))}
    <div class="notes-diff-view">
      {#each diffChunks as line}
        <div class="diff-line diff-{line.type}">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}{line.text}</div>
      {/each}
      {#if diffChunks.every(l => l.type === 'ctx')}
        <div class="diff-identical">No differences</div>
      {/if}
    </div>
  {/if}

  <div
    class="notes-editor-wrap"
    style:display={notesRawMode && !notesHistoryMode || (notesDiffMode && !!notesHistorySha) ? 'none' : ''}
    use:initNotesEditor
  ></div>

  {#if notesRawMode && !notesHistoryMode}
    <textarea
      class="notes-raw-editor"
      bind:value={notesContent}
      oninput={scheduleNotesSave}
      spellcheck={false}
      use:autoResizeTextarea
    ></textarea>
  {/if}
</div>

<style>
  @import '@milkdown/crepe/theme/common/style.css';
  @import '@milkdown/crepe/theme/nord-dark.css';

  .notes-panel {
    background: var(--bg-deep);
    border: 1px solid var(--accent);
    border-top: none;
    border-radius: 0 0 10px 10px;
    overflow: hidden;
  }
  .notes-panel.focus-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-left: none;
    border-right: none;
    border-bottom: none;
    border-radius: 0;
  }
  .notes-panel-detached {
    border-top: 1px solid var(--accent);
    border-radius: 0 0 10px 10px;
    margin-top: 2px;
  }

  .notes-panel-header {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-deep);
  }
  .notes-panel-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.68rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--accent); flex-shrink: 0;
  }
  .header-actions { display: flex; gap: 2px; align-items: center; margin-left: auto; }

  .notes-close-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 5px;
    border: 1px solid transparent; background: transparent;
    color: var(--text-6); cursor: pointer; transition: all 0.12s;
  }
  .notes-close-btn:hover { border-color: var(--red-border); color: var(--red); background: var(--red-bg); }
  .notes-close-btn.raw-active { border-color: var(--accent); color: var(--accent-lt); background: var(--accent-bg); }
  .notes-close-btn.raw-active:hover { border-color: var(--accent-lt); color: var(--accent-ltr); background: var(--accent-bg-2); }

  .notes-history-select {
    flex: 1; min-width: 0; max-width: 200px;
    background: var(--bg); border: 1px solid var(--border-2); border-radius: 6px;
    color: var(--text-2); padding: 2px 24px 2px 8px; font-size: 0.72rem; outline: none;
    cursor: pointer; appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 6px center;
  }
  .notes-history-select:focus { border-color: var(--accent); }
  .notes-history-select:disabled { opacity: 0.5; cursor: default; }

  /* Raw textarea */
  .notes-raw-editor {
    display: block; width: 100%; min-height: 180px;
    background: transparent; border: none; outline: none;
    color: var(--text-2);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem; line-height: 1.7;
    padding: 12px 16px; resize: none; overflow: hidden;
    caret-color: var(--text-2) !important;
    box-sizing: border-box;
  }
  .focus-panel .notes-raw-editor {
    flex: 1; min-height: 0; overflow-y: auto;
  }

  /* Milkdown editor wrapper */
  .notes-editor-wrap { min-height: 140px; position: relative; }
  .focus-panel .notes-editor-wrap { flex: 1; min-height: 0; overflow-y: auto; }

  :global(.focus-panel .notes-editor-wrap .ProseMirror) {
    padding-bottom: 40px !important;
  }


  /* Milkdown theme variables */
  :global(.notes-editor-wrap .milkdown) {
    --crepe-color-background: var(--bg-deep);
    --crepe-color-surface: var(--surface);
    --crepe-color-surface-low: var(--bg);
    --crepe-color-on-background: var(--text-2);
    --crepe-color-on-surface: var(--text-2);
    --crepe-color-on-surface-variant: var(--text-3);
    --crepe-color-outline: var(--border-2);
    --crepe-color-primary: var(--accent);
    --crepe-color-secondary: var(--accent-bg);
    --crepe-color-on-secondary: var(--accent-ltr);
    --crepe-color-inline-code: var(--accent-purple);
    --crepe-color-inline-area: var(--border);
    --crepe-color-hover: var(--accent-bg);
    --crepe-color-selected: rgba(99, 102, 241, 0.45);
    --crepe-color-error: var(--red);
    --crepe-shadow-1: none;
    --crepe-shadow-2: none;
  }
  :global(.notes-editor-wrap .milkdown) { position: relative; }
  /* Hide only the drag dots (last operation-item) — + button (first) stays */
  :global(.notes-editor-wrap .milkdown-block-handle .operation-item:last-child) { display: none; }
  /* Pin the handle in the left gutter (within the 36px left padding) */
  :global(.notes-editor-wrap .milkdown-block-handle) { left: 2px !important; }

  :global(.notes-editor-wrap .ProseMirror) {
    padding: 4px 16px 12px 36px !important;
    font-size: 0.85rem; line-height: 1.65; min-height: 120px;
    outline: none; overflow-wrap: break-word; word-break: break-word;
    caret-color: var(--text-2) !important;
  }

  /* Block code */
  :global(.notes-editor-wrap .ProseMirror pre) {
    position: relative;
    background: var(--bg-deep); border: 1px solid var(--border-2);
    border-left: 3px solid var(--accent); border-radius: 6px;
    padding: 8px 14px; margin: 3px 0; overflow-x: auto;
  }
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block + .milkdown-code-block) { margin-top: 1px; }
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block.single-line pre) { padding: 4px 10px; }
  :global(.notes-editor-wrap .ProseMirror .milkdown-code-block.single-line) { margin: 2px 0; }
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block)) {
    display: flex; align-items: center; list-style: none; gap: 6px;
  }
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block)::before) {
    content: '•'; flex-shrink: 0; font-size: 1.1em; line-height: 1; color: var(--text-6);
  }
  :global(.notes-editor-wrap .ProseMirror li:has(> .milkdown-code-block) > .milkdown-code-block) {
    flex: 1; min-width: 0; margin: 0;
  }
  :global(.notes-editor-wrap .ProseMirror pre code) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem; line-height: 1.7;
    color: var(--text-2); background: none; border: none; padding: 0;
  }

  /* Copy button (floats over code blocks) */
  :global(.code-copy-btn) {
    position: fixed; display: none; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 6px;
    border: 1px solid var(--border-2); background: var(--surface-alt);
    color: var(--text-5); cursor: pointer; z-index: 9999;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  :global(.code-copy-btn.visible) { display: flex; }
  :global(.code-copy-btn:hover) { background: var(--accent-bg-2); border-color: var(--accent); color: var(--text-2); }

  /* Caption textarea (replaces Milkdown's single-line input) */
  :global(.notes-editor-wrap textarea.caption-input) {
    display: block; width: 100%; text-align: center;
    resize: none; overflow: hidden; background: transparent;
    border: none; outline: none; padding: 0; margin: 4px auto;
    font-family: inherit; font-size: inherit; color: inherit;
    line-height: 1.5; word-break: break-word;
    box-sizing: border-box; min-height: 1.5em;
  }

  /* Diff view */
  .notes-diff-view {
    flex: 1; min-height: 140px; overflow-y: auto;
    background: var(--bg-deep);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.78rem; line-height: 1.65; padding: 8px 0;
  }
  .diff-line { display: block; padding: 1px 16px; white-space: pre-wrap; word-break: break-all; }
  .diff-add { background: color-mix(in srgb, var(--green) 12%, transparent); color: var(--green); }
  .diff-del { background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); }
  .diff-ctx { color: var(--text-6); }
  .diff-identical { padding: 20px 16px; color: var(--text-7); font-size: 0.78rem; font-style: italic; }
</style>
