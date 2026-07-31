<script lang="ts">
  import { whiteboards, openWhiteboardId } from '$lib/stores';
  import { api } from '$lib/api';
  import type { Whiteboard, BoardNode, BoardEdge, BoardNodeKind } from '$lib/types';
  import { BOARD_COLORS, boardColor, DEFAULT_STICKY_COLOR, DEFAULT_RECT_COLOR } from '$lib/boardColors';
  import { attachMention } from '$lib/mentions';
  import LinkedText from '$lib/components/LinkedText.svelte';

  let { boardId }: { boardId: string } = $props();

  let board = $derived($whiteboards.find((b) => b.id === boardId) ?? null);

  // ── Persistence ─────────────────────────────────────────────────────────────
  // Edits land in the store immediately (so the canvas stays responsive) and are
  // flushed to the backend on a short debounce — a drag would otherwise write the
  // whole board file on every pointer move.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function mutate(fn: (b: Whiteboard) => Whiteboard) {
    whiteboards.update((all) =>
      all.map((b) => (b.id === boardId ? { ...fn(b), updated_at: new Date().toISOString() } : b))
    );
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  async function flush() {
    saveTimer = null;
    await api.saveWhiteboards($whiteboards);
  }

  function close() {
    if (saveTimer) { clearTimeout(saveTimer); void flush(); }
    openWhiteboardId.set(null);
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────
  // Whole-board snapshots rather than inverse operations: boards are small, and
  // it keeps every edit path honest without each one having to describe its own
  // undo. Snapshots are pushed *before* a change, so `past` holds prior states.
  //
  // Continuous edits (a drag, a burst of typing) would otherwise flood the stack,
  // so they capture lazily — the first mutation of a gesture pushes one entry and
  // the rest of the gesture rides on it. See `beginGesture`.
  interface Snapshot {
    name: string;
    tags: string[];
    nodes: BoardNode[];
    edges: BoardEdge[];
  }

  const HISTORY_LIMIT = 100;
  let past = $state<Snapshot[]>([]);
  let future = $state<Snapshot[]>([]);
  // Set while a gesture is in flight and still owes the stack an entry.
  let gestureOpen = false;

  function snapshot(b: Whiteboard): Snapshot {
    return {
      name: b.name,
      tags: [...b.tags],
      nodes: b.nodes.map((n) => ({ ...n })),
      edges: b.edges.map((e) => ({ ...e })),
    };
  }

  /** Records the current board as an undo point. Call BEFORE mutating. */
  function pushHistory() {
    if (!board) return;
    past = [...past.slice(-(HISTORY_LIMIT - 1)), snapshot(board)];
    future = [];
  }

  /** Opens a coalescing gesture: the next `captureGesture()` pushes, later ones don't. */
  function beginGesture() {
    gestureOpen = true;
  }

  function captureGesture() {
    if (!gestureOpen) return;
    gestureOpen = false;
    pushHistory();
  }

  function endGesture() {
    gestureOpen = false;
  }

  function applySnapshot(s: Snapshot) {
    mutate((b) => ({
      ...b,
      name: s.name,
      tags: [...s.tags],
      nodes: s.nodes.map((n) => ({ ...n })),
      edges: s.edges.map((e) => ({ ...e })),
    }));
    // Anything the restored state doesn't contain can't stay selected or open.
    if (selectedNodeId && !s.nodes.some((n) => n.id === selectedNodeId)) selectedNodeId = null;
    if (selectedEdgeId && !s.edges.some((e) => e.id === selectedEdgeId)) selectedEdgeId = null;
    if (editingNodeId && !s.nodes.some((n) => n.id === editingNodeId)) editingNodeId = null;
  }

  function undo() {
    if (!board || past.length === 0) return;
    const prev = past[past.length - 1];
    future = [snapshot(board), ...future];
    past = past.slice(0, -1);
    applySnapshot(prev);
  }

  function redo() {
    if (!board || future.length === 0) return;
    const next = future[0];
    past = [...past, snapshot(board)];
    future = future.slice(1);
    applySnapshot(next);
  }

  // History belongs to the board being edited — never carry it to another one.
  $effect(() => {
    boardId;
    past = [];
    future = [];
    gestureOpen = false;
  });

  // ── View transform ──────────────────────────────────────────────────────────
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;

  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let canvasEl: HTMLDivElement | null = $state(null);

  function toBoard(clientX: number, clientY: number) {
    const r = canvasEl!.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }

  /** Zooms by `factor` keeping the board point under (sx, sy) — canvas-relative — fixed. */
  function zoomAt(factor: number, sx: number, sy: number) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (next === zoom) return;
    const bx = (sx - panX) / zoom;
    const by = (sy - panY) / zoom;
    zoom = next;
    panX = sx - bx * zoom;
    panY = sy - by * zoom;
  }

  function zoomButton(factor: number) {
    if (!canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  // Registered by hand rather than with `onwheel` so the listener is non-passive
  // and can cancel the browser's own scroll/pinch handling.
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /** Resets to 100% and centres the canvas on the existing content. */
  function resetView() {
    zoom = 1;
    const nodes = board?.nodes ?? [];
    if (!canvasEl || nodes.length === 0) { panX = 0; panY = 0; return; }
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h));
    const r = canvasEl.getBoundingClientRect();
    panX = r.width / 2 - (minX + maxX) / 2;
    panY = r.height / 2 - (minY + maxY) / 2;
  }

  // ── Selection / modes ───────────────────────────────────────────────────────
  let selectedNodeId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);
  let editingNodeId = $state<string | null>(null);
  let connectMode = $state(false);
  let connectFrom = $state<string | null>(null);
  // Live cursor position in board space while drawing a connection.
  let connectCursor = $state<{ x: number; y: number } | null>(null);

  let selectedNode = $derived(board?.nodes.find((n) => n.id === selectedNodeId) ?? null);

  function selectNode(id: string | null) {
    selectedNodeId = id;
    selectedEdgeId = null;
  }

  function cancelConnect() {
    connectMode = false;
    connectFrom = null;
    connectCursor = null;
  }

  function toggleConnect() {
    if (connectMode) cancelConnect();
    else { connectMode = true; connectFrom = null; connectCursor = null; }
  }

  // ── Creating nodes ──────────────────────────────────────────────────────────
  const STICKY_SIZE = { w: 180, h: 150 };
  const RECT_SIZE = { w: 220, h: 110 };

  /** Places a new node at the centre of the current viewport. */
  function addNode(kind: BoardNodeKind) {
    if (!canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    const size = kind === 'sticky' ? STICKY_SIZE : RECT_SIZE;
    const centre = toBoard(r.left + r.width / 2, r.top + r.height / 2);
    const node: BoardNode = {
      id: crypto.randomUUID(),
      kind,
      x: Math.round(centre.x - size.w / 2),
      y: Math.round(centre.y - size.h / 2),
      w: size.w,
      h: size.h,
      text: '',
      color: kind === 'sticky' ? DEFAULT_STICKY_COLOR : DEFAULT_RECT_COLOR,
    };
    pushHistory();
    mutate((b) => ({ ...b, nodes: [...b.nodes, node] }));
    selectNode(node.id);
    beginEditing(node.id);
  }

  /** Opens a node for text editing; the first keystroke becomes one undo entry. */
  function beginEditing(id: string) {
    editingNodeId = id;
    beginGesture();
  }

  function setNodeColor(id: string, color: string) {
    pushHistory();
    mutate((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === id ? { ...n, color } : n)) }));
  }

  function setNodeText(id: string, text: string) {
    captureGesture();
    mutate((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === id ? { ...n, text } : n)) }));
  }

  function deleteNode(id: string) {
    pushHistory();
    mutate((b) => ({
      ...b,
      nodes: b.nodes.filter((n) => n.id !== id),
      edges: b.edges.filter((e) => e.from !== id && e.to !== id),
    }));
    if (selectedNodeId === id) selectedNodeId = null;
    if (editingNodeId === id) editingNodeId = null;
  }

  function deleteEdge(id: string) {
    pushHistory();
    mutate((b) => ({ ...b, edges: b.edges.filter((e) => e.id !== id) }));
    if (selectedEdgeId === id) selectedEdgeId = null;
  }

  function connectNodes(from: string, to: string) {
    if (from === to) return;
    const exists = board?.edges.some((e) => e.from === from && e.to === to);
    if (exists) return;
    const edge: BoardEdge = { id: crypto.randomUUID(), from, to };
    pushHistory();
    mutate((b) => ({ ...b, edges: [...b.edges, edge] }));
  }

  // ── Pointer interaction ─────────────────────────────────────────────────────
  // One drag state covers panning, moving and resizing; `kind` says which.
  type Drag =
    | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
    | { kind: 'move'; id: string; offX: number; offY: number }
    | { kind: 'resize'; id: string; startW: number; startH: number; startX: number; startY: number };

  let drag = $state<Drag | null>(null);

  // Alignment lines shown while a snap is active; cleared when the drag ends.
  interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number; }
  let guides = $state<Guide[]>([]);

  // Pointer capture keeps a drag alive when the cursor leaves the shape (or the
  // canvas), but it also retargets the follow-up click/dblclick to the capture
  // element — which would swallow the double-click that opens a node for editing.
  // So capture is armed on pointerdown and only taken once the pointer has really
  // moved: a stationary click keeps its events on the node where they belong.
  const DRAG_THRESHOLD = 3; // px
  let pendingCapture: { pointerId: number; x: number; y: number } | null = null;

  function armCapture(e: PointerEvent) {
    pendingCapture = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function captureIfMoved(e: PointerEvent) {
    if (!pendingCapture) return;
    const dx = e.clientX - pendingCapture.x;
    const dy = e.clientY - pendingCapture.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    canvasEl?.setPointerCapture(pendingCapture.pointerId);
    pendingCapture = null;
  }

  /** Ends any in-flight drag and releases capture. Safe to call at any time. */
  function endDrag(pointerId?: number) {
    pendingCapture = null;
    guides = [];
    endGesture();
    if (pointerId !== undefined && canvasEl?.hasPointerCapture(pointerId)) {
      canvasEl.releasePointerCapture(pointerId);
    }
    drag = null;
  }

  function onCanvasPointerDown(e: PointerEvent) {
    // Only reached when the event wasn't stopped by a node — i.e. empty canvas.
    // Secondary buttons open the context menu, which swallows the matching
    // pointerup — starting a drag on one would leave it stuck on forever.
    if (e.button !== 0) return;
    if (connectMode) { cancelConnect(); return; }
    selectNode(null);
    editingNodeId = null;
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX, panY };
    armCapture(e);
  }

  function onNodePointerDown(e: PointerEvent, node: BoardNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (connectMode) {
      if (!connectFrom) {
        connectFrom = node.id;
        connectCursor = toBoard(e.clientX, e.clientY);
      } else {
        connectNodes(connectFrom, node.id);
        cancelConnect();
      }
      return;
    }
    selectNode(node.id);
    if (editingNodeId === node.id) return; // let the textarea handle the click
    editingNodeId = null;
    const p = toBoard(e.clientX, e.clientY);
    drag = { kind: 'move', id: node.id, offX: p.x - node.x, offY: p.y - node.y };
    beginGesture();
    armCapture(e);
  }

  function onResizePointerDown(e: PointerEvent, node: BoardNode) {
    e.stopPropagation();
    if (e.button !== 0 || connectMode) return;
    selectNode(node.id);
    const p = toBoard(e.clientX, e.clientY);
    drag = { kind: 'resize', id: node.id, startW: node.w, startH: node.h, startX: p.x, startY: p.y };
    beginGesture();
    armCapture(e);
  }

  const MIN_NODE = 60;

  // ── Snapping (hold Ctrl while moving or resizing) ───────────────────────────
  // Two kinds, in priority order: alignment with a nearby shape's edges/centre
  // when one is within tolerance, otherwise the background grid. Tolerance is in
  // screen pixels, so it feels the same however far you're zoomed in or out.
  const GRID = 24;
  const SNAP_TOLERANCE = 8; // px on screen

  function snapModifier(e: PointerEvent) {
    return e.ctrlKey || e.metaKey;
  }

  /** The three interesting positions of a box on one axis: near edge, centre, far edge. */
  function edgesOf(start: number, size: number) {
    return [start, start + size / 2, start + size];
  }

  function otherNodes(id: string) {
    return (board?.nodes ?? []).filter((n) => n.id !== id);
  }

  /** Smallest offset that lands any moving edge on any guide value, or null. */
  function nearestAlignment(moving: number[], guideValues: number[], tol: number): number | null {
    let best: number | null = null;
    for (const m of moving) {
      for (const t of guideValues) {
        const d = t - m;
        if (Math.abs(d) <= tol && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
    return best;
  }

  function snapToGrid(value: number) {
    return Math.round(value / GRID) * GRID - value;
  }

  function snapPosition(node: BoardNode, x: number, y: number) {
    const tol = SNAP_TOLERANCE / zoom;
    const others = otherNodes(node.id);
    const dx = nearestAlignment(edgesOf(x, node.w), others.flatMap((o) => edgesOf(o.x, o.w)), tol);
    const dy = nearestAlignment(edgesOf(y, node.h), others.flatMap((o) => edgesOf(o.y, o.h)), tol);
    return { x: x + (dx ?? snapToGrid(x)), y: y + (dy ?? snapToGrid(y)) };
  }

  function snapSize(node: BoardNode, w: number, h: number) {
    // Resizing moves the far edges only; the top-left corner stays put.
    const tol = SNAP_TOLERANCE / zoom;
    const others = otherNodes(node.id);
    const right = node.x + w;
    const bottom = node.y + h;
    const dw = nearestAlignment([right], others.flatMap((o) => edgesOf(o.x, o.w)), tol);
    const dh = nearestAlignment([bottom], others.flatMap((o) => edgesOf(o.y, o.h)), tol);
    return {
      w: Math.max(MIN_NODE, w + (dw ?? snapToGrid(right))),
      h: Math.max(MIN_NODE, h + (dh ?? snapToGrid(bottom))),
    };
  }

  /** Alignment lines to draw for a shape that has landed flush with its neighbours. */
  function alignmentGuides(id: string, x: number, y: number, w: number, h: number): Guide[] {
    const out: Guide[] = [];
    const xEdges = edgesOf(x, w);
    const yEdges = edgesOf(y, h);
    for (const o of otherNodes(id)) {
      for (const t of edgesOf(o.x, o.w)) {
        if (xEdges.some((e) => Math.abs(e - t) < 0.5)) {
          out.push({ axis: 'x', at: t, from: Math.min(y, o.y), to: Math.max(y + h, o.y + o.h) });
        }
      }
      for (const t of edgesOf(o.y, o.h)) {
        if (yEdges.some((e) => Math.abs(e - t) < 0.5)) {
          out.push({ axis: 'y', at: t, from: Math.min(x, o.x), to: Math.max(x + w, o.x + o.w) });
        }
      }
    }
    // Collapse duplicates on the same line, keeping the longest span.
    const merged = new Map<string, Guide>();
    for (const g of out) {
      const key = `${g.axis}:${g.at}`;
      const prev = merged.get(key);
      if (!prev) merged.set(key, g);
      else merged.set(key, { ...g, from: Math.min(prev.from, g.from), to: Math.max(prev.to, g.to) });
    }
    return [...merged.values()];
  }

  function onPointerMove(e: PointerEvent) {
    if (connectMode && connectFrom) connectCursor = toBoard(e.clientX, e.clientY);
    if (!drag) return;
    captureIfMoved(e);
    // Below the threshold this is still a click, not a drag — don't nudge the
    // node by a pixel of hand-jitter (and don't spend a save on it).
    if (pendingCapture) return;
    if (drag.kind === 'pan') {
      panX = drag.panX + (e.clientX - drag.startX);
      panY = drag.panY + (e.clientY - drag.startY);
      return;
    }
    const p = toBoard(e.clientX, e.clientY);
    const snapping = snapModifier(e);
    if (drag.kind === 'move') {
      const d = drag;
      const node = board?.nodes.find((n) => n.id === d.id);
      if (!node) return;
      let x = p.x - d.offX;
      let y = p.y - d.offY;
      if (snapping) ({ x, y } = snapPosition(node, x, y));
      x = Math.round(x);
      y = Math.round(y);
      if (x === node.x && y === node.y) return; // nothing actually moved
      captureGesture();
      guides = snapping ? alignmentGuides(d.id, x, y, node.w, node.h) : [];
      mutate((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)),
      }));
    } else {
      const d = drag;
      const node = board?.nodes.find((n) => n.id === d.id);
      if (!node) return;
      let w = Math.max(MIN_NODE, d.startW + (p.x - d.startX));
      let h = Math.max(MIN_NODE, d.startH + (p.y - d.startY));
      if (snapping) ({ w, h } = snapSize(node, w, h));
      w = Math.round(w);
      h = Math.round(h);
      if (w === node.w && h === node.h) return; // nothing actually resized
      captureGesture();
      guides = snapping ? alignmentGuides(d.id, node.x, node.y, w, h) : [];
      mutate((b) => ({
        ...b,
        nodes: b.nodes.map((n) => (n.id === d.id ? { ...n, w, h } : n)),
      }));
    }
  }

  function onPointerUp(e: PointerEvent) {
    endDrag(e.pointerId);
  }

  function onKeydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    const typing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    if (e.key === 'Escape') {
      if (typing) { (el as HTMLElement).blur(); editingNodeId = null; return; }
      if (connectMode) { cancelConnect(); return; }
      close();
      return;
    }
    // While typing, Ctrl+Z belongs to the textarea's own undo, not the board's.
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedNodeId) { e.preventDefault(); deleteNode(selectedNodeId); }
      else if (selectedEdgeId) { e.preventDefault(); deleteEdge(selectedEdgeId); }
    }
  }

  // ── Arrow geometry ──────────────────────────────────────────────────────────
  // Arrows run centre-to-centre, clipped to each node's border so the head lands
  // on the edge of the shape rather than inside it.
  function clipToBorder(node: BoardNode, tx: number, ty: number) {
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = Math.abs(dx) > 1e-6 ? node.w / 2 / Math.abs(dx) : Infinity;
    const sy = Math.abs(dy) > 1e-6 ? node.h / 2 / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function edgeLine(edge: BoardEdge) {
    const a = board?.nodes.find((n) => n.id === edge.from);
    const b = board?.nodes.find((n) => n.id === edge.to);
    if (!a || !b) return null;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = clipToBorder(a, bc.x, bc.y);
    const p2 = clipToBorder(b, ac.x, ac.y);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }

  let connectFromNode = $derived(board?.nodes.find((n) => n.id === connectFrom) ?? null);

  // ── Board meta editing ──────────────────────────────────────────────────────
  let renaming = $state(false);
  let nameDraft = $state('');

  function startRename() {
    nameDraft = board?.name ?? '';
    renaming = true;
  }
  function commitRename() {
    const name = nameDraft.trim();
    if (name && name !== board?.name) {
      pushHistory();
      mutate((b) => ({ ...b, name }));
    }
    renaming = false;
  }

  // Tags decide which project the board shows up under, so they're editable here
  // rather than being frozen to whatever the project had at creation time.
  let editingTags = $state(false);
  let tagsDraft = $state('');

  function startTagEdit() {
    tagsDraft = (board?.tags ?? []).join(', ');
    editingTags = true;
  }
  function commitTags() {
    const tags = [...new Set(
      tagsDraft.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean)
    )];
    if (tags.join(',') !== (board?.tags ?? []).join(',')) {
      pushHistory();
      mutate((b) => ({ ...b, tags }));
    }
    editingTags = false;
  }

  // The SVG layer is a fixed, generously oversized canvas offset around the
  // origin, so arrows drawn at negative coordinates aren't clipped away.
  const SVG_SPAN = 20000;
  const SVG_OFF = SVG_SPAN / 2;
</script>

<svelte:window onkeydown={onKeydown} />

{#if !board}
  <div class="missing">
    <p>This whiteboard no longer exists.</p>
    <button onclick={close}>Back</button>
  </div>
{:else}
  <div class="board">
    <header class="board-bar">
      <button class="icon-btn" onclick={close} title="Close whiteboard (Esc)" aria-label="Close whiteboard">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      </button>

      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name-input"
          bind:value={nameDraft}
          autofocus
          onblur={commitRename}
          onkeydown={(e) => { if (e.key === 'Enter') commitRename(); }}
        />
      {:else}
        <button class="name" onclick={startRename} title="Rename">{board.name}</button>
      {/if}

      {#if editingTags}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="tags-input"
          bind:value={tagsDraft}
          autofocus
          placeholder="tags, comma separated"
          onblur={commitTags}
          onkeydown={(e) => { if (e.key === 'Enter') commitTags(); }}
        />
      {:else}
        <button class="board-tags" onclick={startTagEdit} title="Edit the tags this board belongs to">
          {board.tags.length > 0 ? board.tags.map((t) => '#' + t).join(' ') : '+ tags'}
        </button>
      {/if}

      <div class="bar-tools">
        <button class="tool" onclick={() => addNode('sticky')} title="Add sticky note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><polyline points="14 21 14 14 21 14"/></svg>
          Sticky
        </button>
        <button class="tool" onclick={() => addNode('rect')} title="Add rectangle">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="13" y2="14"/></svg>
          Rectangle
        </button>
        <button
          class="tool {connectMode ? 'active' : ''}"
          onclick={toggleConnect}
          title="Connect two shapes with an arrow"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="18" y2="6"/><polyline points="11 5 19 5 19 13"/></svg>
          Connect
        </button>

        <span class="bar-sep"></span>

        <button
          class="icon-btn" onclick={undo} disabled={past.length === 0}
          title="Undo (Ctrl+Z)" aria-label="Undo"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>
        </button>
        <button
          class="icon-btn" onclick={redo} disabled={future.length === 0}
          title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/></svg>
        </button>

        <span class="bar-sep"></span>

        <button class="icon-btn" onclick={() => zoomButton(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16" y2="16"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="zoom-level" onclick={resetView} title="Reset zoom and centre content">
          {Math.round(zoom * 100)}%
        </button>
        <button class="icon-btn" onclick={() => zoomButton(1.2)} title="Zoom in" aria-label="Zoom in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16" y2="16"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>
        </button>
      </div>
    </header>

    {#if connectMode}
      <div class="hint">
        {connectFrom ? 'Now click the shape to point at.' : 'Click the shape to start the arrow from.'}
        <button class="hint-cancel" onclick={cancelConnect}>Cancel</button>
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="canvas"
      class:connecting={connectMode}
      class:panning={drag?.kind === 'pan'}
      bind:this={canvasEl}
      onpointerdown={onCanvasPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onlostpointercapture={onPointerUp}
      oncontextmenu={() => endDrag()}
      style="background-size: {GRID * zoom}px {GRID * zoom}px; background-position: {panX}px {panY}px;"
    >
      <div class="world" style="transform: translate({panX}px, {panY}px) scale({zoom}); ">
        <svg
          class="edges"
          style="left: {-SVG_OFF}px; top: {-SVG_OFF}px; width: {SVG_SPAN}px; height: {SVG_SPAN}px;"
          viewBox="{-SVG_OFF} {-SVG_OFF} {SVG_SPAN} {SVG_SPAN}"
        >
          <defs>
            <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-3)" />
            </marker>
            <marker id="wb-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>

          {#each board.edges as edge (edge.id)}
            {@const l = edgeLine(edge)}
            {#if l}
              <!-- Wide transparent stroke underneath gives the thin arrow a usable hit area. -->
              <line
                class="edge-hit"
                x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                onpointerdown={(e) => { e.stopPropagation(); selectedNodeId = null; selectedEdgeId = edge.id; }}
              />
              <line
                class="edge {selectedEdgeId === edge.id ? 'selected' : ''}"
                x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                marker-end="url(#{selectedEdgeId === edge.id ? 'wb-arrow-sel' : 'wb-arrow'})"
              />
            {/if}
          {/each}

          {#if connectFromNode && connectCursor}
            {@const p = clipToBorder(connectFromNode, connectCursor.x, connectCursor.y)}
            <line class="edge pending" x1={p.x} y1={p.y} x2={connectCursor.x} y2={connectCursor.y} marker-end="url(#wb-arrow-sel)" />
          {/if}
        </svg>

        {#each board.nodes as node (node.id)}
          {@const c = boardColor(node.color)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="node {node.kind}"
            class:selected={selectedNodeId === node.id}
            class:connect-source={connectFrom === node.id}
            style="left: {node.x}px; top: {node.y}px; width: {node.w}px; height: {node.h}px;
                   --node-fill: {c.fill}; --node-border: {c.border}; --node-ink: {c.ink};"
            onpointerdown={(e) => onNodePointerDown(e, node)}
            ondblclick={(e) => { e.stopPropagation(); if (!connectMode) { selectNode(node.id); beginEditing(node.id); } }}
          >
            {#if editingNodeId === node.id}
              <!-- svelte-ignore a11y_autofocus -->
              <textarea
                class="node-text editing"
                autofocus
                use:attachMention
                value={node.text}
                oninput={(e) => setNodeText(node.id, (e.currentTarget as HTMLTextAreaElement).value)}
                onblur={() => { if (editingNodeId === node.id) editingNodeId = null; }}
                onpointerdown={(e) => e.stopPropagation()}
              ></textarea>
            {:else}
              <div class="node-text"><LinkedText text={node.text} /></div>
              {#if !node.text}<div class="node-placeholder">Double-click to edit</div>{/if}
            {/if}

            {#if selectedNodeId === node.id && !connectMode}
              <!-- Handle is sized in screen pixels, so it stays grabbable at any zoom. -->
              <div
                class="resize-handle"
                style="width: {14 / zoom}px; height: {14 / zoom}px;"
                onpointerdown={(e) => onResizePointerDown(e, node)}
              ></div>
            {/if}
          </div>
        {/each}

        <!-- Snap guides sit above the shapes so they stay visible while dragging. -->
        {#if guides.length > 0}
          <svg
            class="guides"
            style="left: {-SVG_OFF}px; top: {-SVG_OFF}px; width: {SVG_SPAN}px; height: {SVG_SPAN}px;"
            viewBox="{-SVG_OFF} {-SVG_OFF} {SVG_SPAN} {SVG_SPAN}"
          >
            {#each guides as g (g.axis + ':' + g.at)}
              <line
                class="guide"
                style="stroke-width: {1 / zoom}px; stroke-dasharray: {6 / zoom} {4 / zoom};"
                x1={g.axis === 'x' ? g.at : g.from}
                y1={g.axis === 'x' ? g.from : g.at}
                x2={g.axis === 'x' ? g.at : g.to}
                y2={g.axis === 'x' ? g.to : g.at}
              />
            {/each}
          </svg>
        {/if}
      </div>

      {#if board.nodes.length === 0}
        <div class="empty-hint">Add a sticky note or a rectangle to get started.</div>
      {/if}

      {#if selectedNode}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="inspector" onpointerdown={(e) => e.stopPropagation()}>
          <div class="swatches">
            {#each BOARD_COLORS as c}
              <button
                class="swatch {selectedNode.color === c.key ? 'active' : ''}"
                style="background: {c.fill}; border-color: {c.border};"
                title={c.label}
                aria-label={c.label}
                onclick={() => setNodeColor(selectedNode!.id, c.key)}
              ></button>
            {/each}
          </div>
          <button class="delete-btn" onclick={() => deleteNode(selectedNode!.id)} title="Delete shape (Del)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      {:else if selectedEdgeId}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="inspector" onpointerdown={(e) => e.stopPropagation()}>
          <span class="inspector-label">Arrow</span>
          <button class="delete-btn" onclick={() => deleteEdge(selectedEdgeId!)} title="Delete arrow (Del)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .board { display: flex; flex-direction: column; height: 100%; background: var(--bg); }

  .missing {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--text-4);
  }

  /* ── Top bar ──────────────────────────────────────────────────────────────── */
  .board-bar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; flex-shrink: 0;
    background: var(--surface); border-bottom: 1px solid var(--border);
  }

  .name {
    background: transparent; border: none; padding: 2px 4px; border-radius: 6px;
    font-size: 1rem; font-weight: 600; color: var(--text-1); cursor: text;
  }
  .name:hover { background: var(--border); }

  .name-input {
    background: var(--bg); border: 1px solid var(--accent); border-radius: 6px;
    padding: 3px 8px; font-size: 1rem; font-weight: 600; color: var(--text-1);
    font-family: inherit; outline: none; min-width: 160px;
  }

  .board-tags {
    font-size: 0.75rem; color: var(--text-5); cursor: pointer;
    background: transparent; border: none; border-radius: 6px;
    padding: 3px 6px; font-family: inherit;
  }
  .board-tags:hover { background: var(--border); color: var(--text-3); }

  .tags-input {
    background: var(--bg); border: 1px solid var(--accent); border-radius: 6px;
    padding: 3px 8px; font-size: 0.75rem; color: var(--text-2);
    font-family: inherit; outline: none; min-width: 180px;
  }

  .bar-tools { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .bar-sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }

  .tool {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg);
    color: var(--text-3); font-size: 0.8rem; font-family: inherit; cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .tool:hover { background: var(--surface-alt); color: var(--text-2); }
  .tool.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }

  .icon-btn {
    width: 30px; height: 30px; border-radius: 8px; border: none;
    background: transparent; color: var(--text-4); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
  }
  .icon-btn:hover { background: var(--border); color: var(--text-2); }
  .icon-btn:disabled { opacity: 0.3; cursor: default; }
  .icon-btn:disabled:hover { background: transparent; color: var(--text-4); }

  .zoom-level {
    min-width: 52px; padding: 5px 6px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg);
    color: var(--text-4); font-size: 0.75rem; font-family: inherit;
    font-variant-numeric: tabular-nums; cursor: pointer;
  }
  .zoom-level:hover { color: var(--text-2); background: var(--surface-alt); }

  .hint {
    display: flex; align-items: center; gap: 10px; justify-content: center;
    padding: 6px 12px; flex-shrink: 0;
    background: var(--accent-bg); color: var(--accent);
    font-size: 0.78rem; border-bottom: 1px solid var(--border);
  }
  .hint-cancel {
    background: transparent; border: 1px solid var(--accent); border-radius: 6px;
    color: var(--accent); font-size: 0.72rem; font-family: inherit;
    padding: 2px 8px; cursor: pointer;
  }

  /* ── Canvas ───────────────────────────────────────────────────────────────── */
  .canvas {
    position: relative; flex: 1; overflow: hidden;
    background-color: var(--bg);
    /* Dot grid, anchored to board space (see the inline background-position /
       -size) so it pans and zooms with the content and the snap grid lines up
       with the dots you can actually see. */
    background-image: radial-gradient(var(--border-2) 1px, transparent 1px);
    cursor: grab; touch-action: none;
  }
  .canvas.panning { cursor: grabbing; }
  .canvas.connecting { cursor: crosshair; }

  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }

  .edges { position: absolute; overflow: visible; pointer-events: none; }
  .edge { stroke: var(--text-3); stroke-width: 2; fill: none; }
  .edge.selected { stroke: var(--accent); stroke-width: 2.5; }
  .edge.pending { stroke: var(--accent); stroke-dasharray: 6 4; }
  .edge-hit { stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; }

  .guides { position: absolute; overflow: visible; pointer-events: none; }
  .guide { stroke: var(--accent); fill: none; }

  /* ── Nodes ────────────────────────────────────────────────────────────────── */
  .node {
    position: absolute; box-sizing: border-box;
    display: flex; padding: 10px;
    color: var(--node-ink); cursor: move; overflow: hidden;
    user-select: none;
  }
  .node.sticky {
    background: var(--node-fill);
    border: 1px solid var(--node-border);
    border-radius: 2px;
    box-shadow: 2px 3px 8px rgba(0, 0, 0, 0.25);
  }
  .node.rect {
    background: color-mix(in srgb, var(--node-fill) 88%, transparent);
    border: 2px solid var(--node-border);
    border-radius: 8px;
    align-items: center; justify-content: center; text-align: center;
  }
  .node.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
  .node.connect-source { outline: 2px dashed var(--accent); outline-offset: 2px; }

  .node-text {
    flex: 1; min-width: 0;
    font-size: 0.9rem; line-height: 1.35;
    white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden;
  }
  .node.rect .node-text { font-weight: 500; }

  textarea.node-text {
    background: transparent; border: none; outline: none; resize: none;
    color: inherit; font-family: inherit; padding: 0;
    cursor: text; user-select: text;
  }
  .node.rect textarea.node-text { text-align: center; }

  .node-placeholder {
    position: absolute; inset: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.75rem; opacity: 0.45; pointer-events: none; text-align: center;
  }

  .resize-handle {
    position: absolute; right: -1px; bottom: -1px;
    background: var(--accent); border-radius: 3px 0 3px 0;
    cursor: nwse-resize;
  }

  /* ── Floating inspector ───────────────────────────────────────────────────── */
  .inspector {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 12px;
    background: var(--surface); border: 1px solid var(--border);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
  }
  .inspector-label { font-size: 0.78rem; color: var(--text-4); }

  .swatches { display: flex; gap: 6px; }
  .swatch {
    width: 20px; height: 20px; border-radius: 50%;
    border: 2px solid transparent; cursor: pointer; padding: 0;
    transition: transform 0.1s;
  }
  .swatch:hover { transform: scale(1.15); }
  .swatch.active { outline: 2px solid var(--accent); outline-offset: 2px; }

  .delete-btn {
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg);
    color: var(--red); cursor: pointer;
  }
  .delete-btn:hover { background: var(--red-bg); }

  .empty-hint {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-6); font-size: 0.85rem; pointer-events: none;
  }
</style>
